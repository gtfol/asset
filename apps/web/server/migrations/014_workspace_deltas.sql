-- Keep a bounded per-owner change journal. Old/offline clients can bootstrap from
-- the canonical workspace when their saved revision is outside this window.
CREATE TABLE workspace_changes (
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  delta jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, revision)
);
ALTER TABLE workspace_changes ENABLE ROW LEVEL SECURITY;
