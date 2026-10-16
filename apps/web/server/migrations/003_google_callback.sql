-- Preserve databases initialized during early local OAuth development.
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_subject text UNIQUE;
ALTER TABLE oauth_flows ADD COLUMN IF NOT EXISTS redirect_uri text;
INSERT INTO schema_migrations(version) VALUES(3) ON CONFLICT DO NOTHING;
