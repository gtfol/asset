CREATE TABLE IF NOT EXISTS sync_jobs (
  connection_id text PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
  generation integer NOT NULL DEFAULT 1,
  completed_generation integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token text,
  lease_until timestamptz,
  stage jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sync_jobs_available ON sync_jobs(status,available_at);
ALTER TABLE sync_jobs ENABLE ROW LEVEL SECURITY;
INSERT INTO sync_jobs(connection_id)
  SELECT DISTINCT j.connection_id FROM webhook_jobs j
  JOIN connections c ON c.id=j.connection_id
  WHERE j.status IN ('pending','processing') AND c.status<>'disconnected'
  ON CONFLICT DO NOTHING;
INSERT INTO schema_migrations(version) VALUES(4) ON CONFLICT DO NOTHING;
