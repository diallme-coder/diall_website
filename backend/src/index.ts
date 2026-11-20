import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { pool } from './db.js';
import { encrypt } from './crypto.js';
import { finishOAuth, logout, requireCsrf, requireSession, startOAuth } from './auth.js';
import { validateAppleCredentials, type ContactData, type ProviderCredentials } from './providers.js';
import { applySync, makeSyncPreview } from './sync-service.js';

const app = express();
app.disable('x-powered-by');
if (config.production) app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Cache-Control', 'no-store');
  if (config.production) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(express.json({ limit: '5mb', strict: true }));
app.use(cookieParser());

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
function rateLimit(limit: number, windowMs: number, namespace = 'global') {
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = `${req.ip}:${namespace}`;
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) buckets.set(key, { count: 1, resetAt: now + windowMs });
    else bucket.count++;
    const current = buckets.get(key)!;
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - current.count)));
    if (current.count > limit) {
      res.setHeader('Retry-After', String(Math.ceil((current.resetAt - now) / 1000)));
      res.status(429).json({ error: 'Too many requests. Try again later.' });
      return;
    }
    if (buckets.size > 20_000) {
      for (const [entry, value] of buckets) if (value.resetAt <= now) buckets.delete(entry);
    }
    next();
  };
}
app.use(rateLimit(300, 60_000));
app.use('/auth', rateLimit(20, 15 * 60_000, 'auth'));

app.use((req, res, next) => {
  if (config.production && !req.secure) {
    res.status(400).json({ error: 'HTTPS is required.' });
    return;
  }
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
    if (req.get('origin') !== config.origin) {
      res.status(403).json({ error: 'Request origin is not allowed.' });
      return;
    }
    if (['POST', 'PATCH', 'PUT'].includes(req.method) && req.path !== '/auth/logout'
      && req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
      res.status(415).json({ error: 'Use application/json.' });
      return;
    }
  }
  if (req.method === 'GET' && req.path.endsWith('/start') && req.get('origin') && req.get('origin') !== config.origin) {
    res.status(403).json({ error: 'Request origin is not allowed.' });
    return;
  }
  next();
});

function asyncRoute(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res)).catch(next);
  };
}

function contactData(body: unknown): ContactData {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error('Contact data must be a JSON object.'), { status: 400 });
  }
  const json = JSON.stringify(body);
  if (json.length > 3 * 1024 * 1024) throw Object.assign(new Error('Contact data is too large.'), { status: 413 });
  return JSON.parse(json) as ContactData;
}

function contactDeletedAt(data: ContactData): string | null {
  const value = data.deletedAt;
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw Object.assign(new Error('Contact deletion date is invalid.'), { status: 400 });
  }
  return value;
}

const ownedId = (value: string | undefined): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw Object.assign(new Error('Invalid resource id.'), { status: 400 });
  }
  return value;
};

app.get('/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok' });
}));

app.get('/auth/:provider/start', requireSessionOptional, asyncRoute(startOAuth));
app.get('/auth/:provider/callback', asyncRoute(finishOAuth));
app.post('/auth/logout', requireSession, requireCsrf, asyncRoute(logout));

async function requireSessionOptional(req: Request, _res: Response, next: NextFunction) {
  if (req.query.mode !== 'connect') {
    next();
    return;
  }
  await requireSession(req, _res, next);
}

app.get('/api/session', requireSession, asyncRoute(async (req, res) => {
  const account = await pool.query('SELECT id, email, created_at FROM accounts WHERE id=$1', [req.accountId]);
  res.json({ account: account.rows[0], csrfToken: req.csrfToken });
}));

app.get('/api/contacts', requireSession, asyncRoute(async (req, res) => {
  const rawLimit = Number(req.query.limit ?? 100);
  const limit = Number.isInteger(rawLimit) ? Math.min(500, Math.max(1, rawLimit)) : 100;
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
  let page: { timestamp: string; id: string } | undefined;
  if (cursor) {
    try {
      if (cursor.length > 256) throw new Error();
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
      if (decoded.length !== 2 || !Number.isFinite(Date.parse(decoded[0]!))) throw new Error();
      page = { timestamp: decoded[0]!, id: ownedId(decoded[1]!) };
    } catch {
      res.status(400).json({ error: 'Invalid contacts cursor.' });
      return;
    }
  }
  const rows = await pool.query(
    `SELECT id, data, created_at, updated_at, deleted_at,
            to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS page_timestamp
       FROM contacts
      WHERE account_id=$1
        AND ($2::timestamptz IS NULL OR (updated_at,id)<($2::timestamptz,$3::uuid))
      ORDER BY updated_at DESC,id DESC LIMIT $4`,
    [req.accountId, page?.timestamp ?? null, page?.id ?? null, limit + 1]
  );
  const hasMore = rows.rows.length > limit;
  const contacts = rows.rows.slice(0, limit).map(({ page_timestamp: _pageTimestamp, ...contact }) => contact);
  const last = rows.rows[limit - 1];
  const nextCursor = hasMore && last
    ? Buffer.from(`${last.page_timestamp}|${last.id}`).toString('base64url')
    : null;
  res.json({ contacts, nextCursor });
}));

app.post('/api/contacts', requireSession, requireCsrf, asyncRoute(async (req, res) => {
  const data = contactData(req.body?.data);
  const created = await pool.query(
    'INSERT INTO contacts(account_id,data,deleted_at) VALUES ($1,$2,$3) RETURNING id,data,created_at,updated_at',
    [req.accountId!, data, contactDeletedAt(data)]
  );
  res.status(201).json({ contact: created.rows[0] });
}));

app.post('/api/contacts/bulk', requireSession, requireCsrf, asyncRoute(async (req, res) => {
  const values = req.body?.contacts;
  if (!Array.isArray(values) || values.length < 1 || values.length > 100) {
    res.status(400).json({ error: 'Provide between 1 and 100 contacts.' });
    return;
  }
  const items = values.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw Object.assign(new Error('Each bulk contact must be an object.'), { status: 400 });
    }
    const item = value as { id?: unknown; data?: unknown; delete?: unknown };
    if (item.delete === true) {
      return { id: ownedId(typeof item.id === 'string' ? item.id : undefined), data: null, deletedAt: null, remove: true };
    }
    const data = contactData(item.data);
    return {
      id: item.id == null ? null : ownedId(typeof item.id === 'string' ? item.id : undefined),
      data,
      deletedAt: contactDeletedAt(data),
      remove: false
    };
  });
  const client = await pool.connect();
  const contacts = [];
  try {
    await client.query('BEGIN');
    for (const item of items) {
      if (item.remove) {
        const deleted = await client.query(
          'DELETE FROM contacts WHERE id=$1 AND account_id=$2 RETURNING id',
          [item.id, req.accountId!]
        );
        if (!deleted.rowCount) throw Object.assign(new Error('Contact not found.'), { status: 404 });
      } else if (item.id) {
        const updated = await client.query(
          `UPDATE contacts SET data=$1,deleted_at=$2,updated_at=now()
            WHERE id=$3 AND account_id=$4 RETURNING id,data,created_at,updated_at,deleted_at`,
          [item.data, item.deletedAt, item.id, req.accountId!]
        );
        if (!updated.rowCount) throw Object.assign(new Error('Contact not found.'), { status: 404 });
        contacts.push(updated.rows[0]);
      } else {
        const created = await client.query(
          'INSERT INTO contacts(account_id,data,deleted_at) VALUES ($1,$2,$3) RETURNING id,data,created_at,updated_at,deleted_at',
          [req.accountId!, item.data, item.deletedAt]
        );
        contacts.push(created.rows[0]);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  res.json({ contacts });
}));

app.patch('/api/contacts/:id', requireSession, requireCsrf, asyncRoute(async (req, res) => {
  const id = ownedId(req.params.id);
  const patch = contactData(req.body?.data);
  const hasDeletedAt = Object.prototype.hasOwnProperty.call(patch, 'deletedAt');
  const deletedAt = contactDeletedAt(patch);
  const updated = await pool.query(
    `UPDATE contacts
        SET data=data || $1::jsonb,
            deleted_at=CASE WHEN $4::boolean THEN $5::timestamptz ELSE deleted_at END,
            updated_at=now()
      WHERE id=$2 AND account_id=$3
      RETURNING id,data,created_at,updated_at`,
    [patch, id, req.accountId!, hasDeletedAt, deletedAt]
  );
  if (!updated.rowCount) {
    res.status(404).json({ error: 'Contact not found.' });
    return;
  }
  res.json({ contact: updated.rows[0] });
}));

app.delete('/api/contacts/:id', requireSession, requireCsrf, asyncRoute(async (req, res) => {
  const id = ownedId(req.params.id);
  if (req.query.permanent === 'true') {
    const deleted = await pool.query('DELETE FROM contacts WHERE id=$1 AND account_id=$2', [id, req.accountId!]);
    if (!deleted.rowCount) {
      res.status(404).json({ error: 'Contact not found.' });
      return;
    }
    res.status(204).end();
    return;
  }
  const result = await pool.query(
    'UPDATE contacts SET deleted_at=now(),updated_at=now() WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL',
    [id, req.accountId!]
  );
  if (!result.rowCount) {
    res.status(404).json({ error: 'Contact not found.' });
    return;
  }
  res.status(204).end();
}));

app.post('/api/contacts/:id/restore', requireSession, requireCsrf, asyncRoute(async (req, res) => {
  const id = ownedId(req.params.id);
  const result = await pool.query(
    'UPDATE contacts SET deleted_at=NULL,updated_at=now() WHERE id=$1 AND account_id=$2 AND deleted_at IS NOT NULL RETURNING id,data,created_at,updated_at',
    [id, req.accountId!]
  );
  if (!result.rowCount) {
    res.status(404).json({ error: 'Deleted contact not found.' });
    return;
  }
  res.json({ contact: result.rows[0] });
}));

app.get('/api/connections', requireSession, asyncRoute(async (req, res) => {
  const result = await pool.query(
    'SELECT id,provider,label,created_at,updated_at,cursor_valid FROM provider_connections WHERE account_id=$1 ORDER BY created_at',
    [req.accountId]
  );
  res.json({ connections: result.rows });
}));

app.post('/api/connections/apple', requireSession, requireCsrf, asyncRoute(async (req, res) => {
  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(req.hostname);
  if (!req.secure && !isLoopback) {
    res.status(400).json({ error: 'Apple credentials may only be submitted over HTTPS.' });
    return;
  }
  const username = req.body?.username;
  const appPassword = req.body?.appPassword;
  if (typeof username !== 'string' || username.length > 320 || !username.includes('@')
    || typeof appPassword !== 'string' || appPassword.length < 8 || appPassword.length > 256) {
    res.status(400).json({ error: 'Provide your Apple ID and an app-specific password.' });
    return;
  }
  const credentials: ProviderCredentials = { username, appPassword };
  const addressBookUrl = await validateAppleCredentials(credentials);
  credentials.addressBookUrl = addressBookUrl;
  const result = await pool.query(
    `INSERT INTO provider_connections(account_id,provider,label,encrypted_credentials)
     VALUES ($1,'icloud','Apple iCloud Contacts',$2) RETURNING id,provider,label,created_at,cursor_valid`,
    [req.accountId!, encrypt(credentials)]
  );
  res.status(201).json({ connection: result.rows[0] });
}));

app.delete('/api/connections/:id', requireSession, requireCsrf, asyncRoute(async (req, res) => {
  const result = await pool.query('DELETE FROM provider_connections WHERE id=$1 AND account_id=$2', [ownedId(req.params.id), req.accountId!]);
  if (!result.rowCount) {
    res.status(404).json({ error: 'Connection not found.' });
    return;
  }
  res.status(204).end();
}));

app.post('/api/connections/:id/sync/preview', requireSession, requireCsrf, asyncRoute(async (req, res) => {
  const result = await makeSyncPreview(req.accountId!, ownedId(req.params.id));
  const operations = result.preview.operations.map(({ document: _document, ...operation }) => operation);
  const conflicts = result.preview.conflicts.map(({ remoteDocument: _remoteDocument, ...conflict }) => conflict);
  res.json({ runId: result.runId, preview: { operations, conflicts, cursor: result.preview.cursor } });
}));

app.post('/api/connections/:id/sync/apply', requireSession, requireCsrf, asyncRoute(async (req, res) => {
  const runId = typeof req.body?.runId === 'string' ? ownedId(req.body.runId) : '';
  const choices = req.body?.choices ?? [];
  if (!runId || !Array.isArray(choices) || choices.length > 500
    || choices.some((item) => !item || typeof item.conflictId !== 'string'
      || (item.choice !== 'local' && item.choice !== 'remote'))) {
    res.status(400).json({ error: 'Provide a preview runId and conflict choices.' });
    return;
  }
  res.json(await applySync(req.accountId!, ownedId(req.params.id), runId, choices));
}));

app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = (error as { status?: number }).status;
  if (status && status >= 400 && status < 500) {
    res.status(status).json({ error: (error as Error).message });
    return;
  }
  console.error('Request failed:', error instanceof Error ? error.message : 'unknown error');
  res.status(500).json({ error: 'An internal error occurred.' });
});

const server = app.listen(config.port, () => console.log(`Contact API listening on ${config.port}`));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => void pool.end()));
}

export { app };
