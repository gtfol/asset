CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS users(id text PRIMARY KEY, email text NOT NULL UNIQUE, password_hash text, demo boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
-- A versioned financial aggregate keeps calculations, imports, and user edits atomic.
-- Only the backend can access these tables; no browser Supabase keys are used.
CREATE TABLE IF NOT EXISTS workspaces(owner_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, state jsonb NOT NULL, revision integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sessions(token_hash text PRIMARY KEY, owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS connections(id text PRIMARY KEY, owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, item_id text NOT NULL UNIQUE, institution_id text NOT NULL, institution_name text NOT NULL, encrypted_token text NOT NULL, product text NOT NULL CHECK (product IN ('transactions','investments')), cursor text, selected_accounts jsonb NOT NULL DEFAULT '[]', status text NOT NULL, last_synced_at timestamptz, initial_complete boolean NOT NULL DEFAULT false, historical_complete boolean NOT NULL DEFAULT false, error_code text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,institution_id,product));
CREATE TABLE IF NOT EXISTS webhook_jobs(id text PRIMARY KEY, connection_id text NOT NULL REFERENCES connections(id) ON DELETE CASCADE, payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS webhook_pending ON webhook_jobs(status,available_at);
CREATE INDEX IF NOT EXISTS sessions_owner ON sessions(owner_id);
CREATE INDEX IF NOT EXISTS connections_owner ON connections(owner_id);
INSERT INTO schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
-- Direct client roles must never read these tables, including on Supabase.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_jobs ENABLE ROW LEVEL SECURITY;
