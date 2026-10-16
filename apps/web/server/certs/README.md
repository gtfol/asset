# Supabase database certificate

`supabase-prod-ca-2021.crt` is Supabase's public production root CA certificate, downloaded without modification from:

https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt

Supabase Studio's [certificate download configuration](https://github.com/supabase/supabase/blob/master/apps/studio/hooks/custom-content/custom-content.json) identifies this URL for the production environment. This is a public trust certificate, not a credential or private key.

- Subject and issuer: `Supabase Root 2021 CA`
- Validity: April 28, 2021 through April 26, 2031
- SHA-256 fingerprint: `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`

`server/db.ts` loads this certificate only for Supabase database hosts, with certificate-chain and hostname verification enabled. URL SSL parameters are removed for those hosts because `pg` would otherwise replace the explicit TLS options. Other PostgreSQL connections retain their configured TLS behavior. `vercel.json` includes the certificate in the API function bundle.

Before Supabase rotates this CA or the certificate expires, obtain its replacement from Supabase's official download configuration, verify its provenance and fingerprint, and update the certificate and deployment regression together. Never disable certificate or hostname verification to work around a connection failure.
