CREATE TABLE IF NOT EXISTS market_cache (
  key text PRIMARY KEY,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE market_cache ENABLE ROW LEVEL SECURITY;
