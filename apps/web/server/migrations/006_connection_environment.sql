-- Every Item created before Production support belongs to Sandbox. Keep retained
-- Sandbox history on its original connection when an owner moves to Production.
ALTER TABLE connections ADD COLUMN environment text NOT NULL DEFAULT 'sandbox'
  CHECK (environment IN ('production','sandbox'));
ALTER TABLE connections DROP CONSTRAINT connections_owner_id_institution_id_product_key;
ALTER TABLE connections ADD CONSTRAINT connections_owner_institution_product_environment_key
  UNIQUE(owner_id,institution_id,product,environment);
INSERT INTO schema_migrations(version) VALUES(6) ON CONFLICT DO NOTHING;
