ALTER TABLE venmo_routes ADD COLUMN source_verified boolean NOT NULL DEFAULT false;
-- Confirmation messages were accepted only from authenticated Google forwarding mail
-- addressed to each route's private, unpredictable address.
UPDATE venmo_routes SET source_verified=true WHERE verification_code IS NOT NULL OR verification_url IS NOT NULL;
