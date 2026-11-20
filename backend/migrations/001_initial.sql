CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_unique ON accounts (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS identities (
  provider text NOT NULL CHECK (provider IN ('google', 'microsoft')),
  subject text NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS identities_account_idx ON identities(account_id);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash bytea PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_account_idx ON sessions(account_id);

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash bytea PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('google', 'microsoft')),
  mode text NOT NULL CHECK (mode IN ('login', 'connect')),
  account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  nonce text NOT NULL,
  encrypted_verifier bytea NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX IF NOT EXISTS contacts_account_active_idx ON contacts(account_id, updated_at) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS provider_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google', 'microsoft', 'icloud')),
  label text NOT NULL,
  encrypted_credentials bytea NOT NULL,
  sync_cursor text,
  cursor_valid boolean NOT NULL DEFAULT false,
  sync_lock_run_id uuid,
  sync_locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_connections_owner_idx ON provider_connections(account_id);

CREATE TABLE IF NOT EXISTS provider_links (
  connection_id uuid NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  base_data jsonb NOT NULL,
  etag text,
  remote_document jsonb,
  PRIMARY KEY (connection_id, contact_id),
  UNIQUE (connection_id, external_id)
);
CREATE INDEX IF NOT EXISTS provider_links_contact_idx ON provider_links(contact_id);

CREATE TABLE IF NOT EXISTS sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  preview jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applying', 'applied')),
  expires_at timestamptz NOT NULL,
  applied_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sync_runs_owner_idx ON sync_runs(account_id, connection_id, expires_at);
