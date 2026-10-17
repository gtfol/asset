CREATE TABLE notification_devices (
  id text PRIMARY KEY, owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_hash text NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  token text NOT NULL UNIQUE, environment text NOT NULL CHECK(environment IN ('sandbox','production')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notification_deliveries (
  id text PRIMARY KEY, owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES notification_devices(id) ON DELETE CASCADE,
  notification_id text NOT NULL, kind text NOT NULL,
  status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(device_id,notification_id)
);
CREATE INDEX notification_pending ON notification_deliveries(status,available_at);
CREATE TABLE notification_schedule(owner_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, checked_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE notification_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_schedule ENABLE ROW LEVEL SECURITY;
