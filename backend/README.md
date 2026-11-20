# Contact Manager API

This TypeScript/Node backend powers the account and contact-sync UI in the repository's `index.html`. The API does not serve the static page: expose both through one HTTPS origin, routing `/api/*` and `/auth/*` to this service and `/` to the website. This is deploy-ready packaging, not deployed infrastructure.

## What it provides

- Open registration after a successful, signature/issuer/audience/nonce-validated Google or Microsoft OpenID Connect login. Accounts are keyed by provider identity; verified Google email can link to an existing account. Microsoft account identity is verified against Graph.
- Server-side, account-scoped Postgres contacts. All read, update, delete, connection and sync-run queries authorize by the authenticated account.
- HttpOnly, SameSite=Lax session cookies, CSRF tokens, exact-origin checks for mutations, request-size limits and per-process IP rate limits.
- Encrypted provider refresh tokens and encrypted iCloud Apple ID/app-specific password credentials (AES-256-GCM using `ENCRYPTION_KEY`).
- Contact sync preview, conflict selection (`local` or `remote`) and apply for Google People API, Microsoft Graph contacts delta, and iCloud CardDAV. Sync remembers provider cursors, contact IDs, etags, and the last common mapped field values. Apple CardDAV updates preserve unmapped vCard properties; app-only JSON fields are retained when remote contact fields are imported.

The shared contact fields are `firstName`, `lastName`, `displayName`, `email`, `phone`, `company`, and `notes`. Those mapped fields sync both ways. Other app-only fields remain in the local contact JSON and are not exported. Apple sync uses the first address book returned by CardDAV discovery; Microsoft currently resolves the default contacts folder by its English `Contacts` display name and reports an error if it cannot find it. Provider-specific fields outside the shared mapping are not imported, though unmapped vCard properties are retained when updating an Apple contact. The sync UI should show preview operations and require a choice for each conflict before applying. Provider writes and Postgres cannot share a distributed transaction; if an apply fails partway through, create a fresh preview and review it before retrying.

## Local setup

Requirements: Node.js 20+, npm, and PostgreSQL 13+ (the included container uses PostgreSQL 16).

```powershell
cd backend
Copy-Item .env.example .env
# Fill the environment values in .env; use a different random password/key.
npm install
npm run migrate
npm test
npm run lint
npm run build
npm start
```

Set `APP_ORIGIN` to the exact browser origin, without a trailing slash. Set `DATABASE_URL`, OAuth client credentials, matching callback URIs, and a fresh 32-byte base64 encryption key. Generate a key with `openssl rand -base64 32`; keep it in a secrets manager, never commit it. The example values are placeholders and the server fails closed if required configuration is missing. For local non-TLS development only, change `NODE_ENV` to `development`, `APP_ORIGIN` to `http://localhost:3000`, and both callback URIs to their matching localhost URLs.

Configure Google OAuth with this redirect URI (replace the example hostname):

```text
https://your-api.example/auth/google/callback
```

Enable the Google People API. The login flow requests OpenID Connect identity scopes; connecting Google Contacts separately requests `https://www.googleapis.com/auth/contacts` and offline access.

Configure a Microsoft Entra application with delegated `User.Read` and `Contacts.ReadWrite` permissions and a web redirect URI:

```text
https://your-api.example/auth/microsoft/callback
```

`MICROSOFT_TENANT_ID=common` supports Microsoft personal and work/school accounts. Narrow this to a tenant ID if the deployment should not be multi-tenant. The sign-in flow uses OIDC and validates the tenant-specific issuer; connecting contacts requests delegated `Contacts.ReadWrite` and refresh-token access.

Apple requires an Apple ID and an app-specific password created by the account owner. The API accepts it only at `POST /api/connections/apple`, verifies CardDAV discovery, and stores the credential encrypted. Never request an Apple password in chat, logs, or frontend source. Use HTTPS for any non-loopback environment.

### Container setup

Copy `.env.example` to `.env`, set secrets and a URL-safe `POSTGRES_PASSWORD` (letters, digits, hyphens or underscores), then start PostgreSQL:

```powershell
cd backend
docker compose up -d db
docker compose run --rm api node dist/src/migrate.js
docker compose up --build -d api
```

The API container listens on port 3000. Put it behind a TLS-terminating reverse proxy; set the exact public `APP_ORIGIN`, provider callback URLs and only trust the single configured proxy hop. Configure proxy/gateway distributed rate limits as well for multi-instance deployments (the built-in limiter is per process). Use managed Postgres with TLS and encrypted storage/backups for production.

### Operations and security

- Run migrations as a release step before starting the API. The migration is safe to rerun.
- Set `DATABASE_SSL=true` when the Postgres provider requires TLS.
- Back up `ENCRYPTION_KEY` separately from the database. Rotating it requires decrypting and re-encrypting each `provider_connections.encrypted_credentials` row; do not simply replace the key or saved provider connections become unreadable.
- Use a unique key per environment. Rotate OAuth client secrets through the identity providers, and revoke/disconnect lost provider credentials.
- Session cookies are `Secure` in production and tokens are stored hashed in Postgres. Do not terminate TLS at an untrusted proxy or accept traffic directly on the app port.
- Contact records and provider IDs are personal data; enable Postgres encryption at rest, restricted database access, retention/backups, monitoring and incident procedures appropriate to the deployment.
- Provider sync covers contacts in the selected Google/Microsoft default Contacts collection or discovered iCloud address book. It maps the seven fields listed above; provider-specific data outside that projection is not part of the shared contact model.

## HTTP API contract

All JSON responses use `application/json`. The frontend and API must share the exact origin for cookie authentication; there is no permissive CORS configuration. For every `POST`, `PATCH` or `DELETE`, send the `Origin` header and `X-CSRF-Token` from `GET /api/session`. Keep the session cookie browser-managed and HttpOnly; never read or copy it into JavaScript.

JSON requests are limited to 5 MB and an individual contact to 3 MB. Bulk writes are capped at 100 contacts per request; the page splits larger transfers into bounded batches.

### Authentication

| Request | Response |
|---|---|
| `GET /auth/google/start` or `/auth/microsoft/start` | Redirect to provider for open sign-up/sign-in |
| `GET /auth/{google\|microsoft}/start?mode=connect` | Authenticated account links a contacts provider; requires session cookie |
| Provider callback at the configured redirect URI | Redirects to `APP_ORIGIN/?signed_in=1` or `/?provider_connected={provider}` |
| `GET /api/session` | `200 { "account": { "id", "email", "created_at" }, "csrfToken": "..." }` |
| `POST /auth/logout` | `204`; requires origin and CSRF header |

OAuth failure is reported as an HTTP error page. Do not rely on email alone for account authorization; the backend binds sessions and records to provider identities/account IDs.

### Contacts

- `GET /api/contacts?limit=100&cursor=...` returns `{ "contacts": [{ "id", "data", "created_at", "updated_at", "deleted_at" }], "nextCursor": string|null }`. Limit is 1–500; use `nextCursor` until null. Soft-deleted contacts are included so the app can render Recently deleted and sync deletions.
- `POST /api/contacts` with `{ "data": { ...contactFields } }` returns `201 { "contact": { ... } }`.
- `PATCH /api/contacts/{id}` with `{ "data": { ...fieldsToMerge } }` returns `200 { "contact": { ... } }`. App-only fields not included in the patch remain intact.
- `POST /api/contacts/bulk` accepts 1–100 `{ "data": { ...contactFields } }` items for inserts, `{ "id": "...", "data": { ...contactFields } }` for account-scoped updates, or `{ "id": "...", "delete": true }` for permanent deletion. The whole batch is transactional and returns `{ "contacts": [...] }`.
- `DELETE /api/contacts/{id}` soft-deletes the caller's contact and returns `204`; `?permanent=true` permanently deletes it.
- `POST /api/contacts/{id}/restore` restores the caller's soft-deleted contact and returns `200 { "contact": { ... } }`.

### Provider connections and sync

- `GET /api/connections` returns safe metadata only: `{ "connections": [{ "id", "provider", "label", "created_at", "updated_at", "cursor_valid" }] }`. Provider tokens and Apple credentials are never returned.
- `POST /api/connections/apple` with `{ "username": "Apple ID", "appPassword": "app-specific password" }` returns `201 { "connection": { ...safe metadata } }`.
- `DELETE /api/connections/{id}` disconnects that account's provider and removes its sync links/previews.
- `POST /api/connections/{id}/sync/preview` returns `200 { "runId", "preview": { "operations": [...], "conflicts": [...], "cursor" } }`. Operation kinds are `import`, `export`, `baseline`, `deleteLocal`, `deleteRemote`, and `detach`. Conflicts include an `id`, `kind`, `contactId`, `local`, and (if present) `remote`.
- `POST /api/connections/{id}/sync/apply` with `{ "runId": "...", "choices": [{ "conflictId": "...", "choice": "local"|"remote" }] }` applies all automatic operations and every supplied conflict choice, returning `{ "applied": true, "imported": 0, "exported": 0, "deleted": 0 }`.

Previews expire after 30 minutes and are single-use. Every conflict requires exactly one choice. The API scopes connection and run lookups to the authenticated account. Common errors are `400` invalid input/choices, `401` no session, `403` origin/CSRF failure, `404` resource not found, `409` stale preview/contact, `413` oversized contact, and `429` rate limit.

## Validation

`npm test` exercises provider response mapping and the sync planner with mocked provider HTTP responses. The tests do not contact Google, Microsoft, Apple, or a live Postgres service; validate OAuth registration, TLS termination, provider consent and migrations in a staging environment before opening public registration.
