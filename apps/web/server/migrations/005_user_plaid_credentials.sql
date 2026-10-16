CREATE TABLE IF NOT EXISTS plaid_credentials (
  owner_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  encrypted_config text NOT NULL,
  version text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE plaid_credentials ENABLE ROW LEVEL SECURITY;
