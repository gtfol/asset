CREATE TABLE workspace_operations (
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id,id)
);
ALTER TABLE workspace_operations ENABLE ROW LEVEL SECURITY;
