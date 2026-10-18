-- A second factor is required before FinanceKit data can enter a workspace.
CREATE TABLE account_security (
  owner_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  encrypted_secret text NOT NULL,
  recovery_hash text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  setup_expires_at timestamptz NOT NULL,
  last_step bigint NOT NULL DEFAULT -1,
  attempts integer NOT NULL DEFAULT 0,
  attempt_window timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sessions ADD COLUMN verified_at timestamptz;
ALTER TABLE account_security ENABLE ROW LEVEL SECURITY;
