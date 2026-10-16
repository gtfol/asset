ALTER TABLE users ADD COLUMN IF NOT EXISTS google_subject text UNIQUE;
CREATE TABLE IF NOT EXISTS oauth_flows(id text PRIMARY KEY, verifier text NOT NULL, client text NOT NULL CHECK (client IN ('web','ios')), native_challenge text, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_codes(id text PRIMARY KEY, owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, challenge text NOT NULL, expires_at timestamptz NOT NULL);
CREATE INDEX IF NOT EXISTS oauth_flows_expiry ON oauth_flows(expires_at);
CREATE INDEX IF NOT EXISTS oauth_codes_expiry ON oauth_codes(expires_at);
ALTER TABLE oauth_flows ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_codes ENABLE ROW LEVEL SECURITY;
INSERT INTO schema_migrations(version) VALUES(2) ON CONFLICT DO NOTHING;
