CREATE TABLE venmo_routes (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  source_email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  encrypted_token text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  verification_code text,
  verification_expires_at timestamptz,
  last_received_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,account_id)
);
CREATE TABLE venmo_receipts (
  id text PRIMARY KEY,
  route_id text NOT NULL REFERENCES venmo_routes(id) ON DELETE CASCADE,
  email_id text NOT NULL,
  receipt_key text NOT NULL,
  status text NOT NULL CHECK(status IN ('imported','duplicate','review','ignored')),
  reason text,
  encrypted_payload text,
  transaction_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(route_id,email_id),
  UNIQUE(route_id,receipt_key)
);
CREATE INDEX venmo_receipts_route_created ON venmo_receipts(route_id,created_at DESC);
ALTER TABLE venmo_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE venmo_receipts ENABLE ROW LEVEL SECURITY;
