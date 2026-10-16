import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database, SQL } from './db.js';
import { decryptToken, encryptToken, PlaidSandbox, type PlaidProvider } from './plaid.js';

const credential = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export const plaidCredentialsSchema = z.object({
  clientId: credential,
  secret: credential,
  environment: z.literal('sandbox'),
});
export type PlaidCredentials = z.infer<typeof plaidCredentialsSchema>;
type StoredCredentials = { encrypted_config: string; version: string };

function failure(message: string, status: number) {
  return Object.assign(Error(message), { status });
}

export function plaidStorageReady() {
  return /^[a-f0-9]{64}$/i.test(process.env.TOKEN_ENCRYPTION_KEY ?? '');
}

export function plaidWorkerReady() {
  return (
    process.env.VERCEL !== '1' ||
    (process.env.PLAID_WORKER_ENABLED === 'true' && (process.env.CRON_SECRET?.length ?? 0) >= 32)
  );
}

async function readCredentials(db: SQL, owner: string) {
  const row = (
    await db.query<StoredCredentials>(
      'SELECT encrypted_config,version FROM plaid_credentials WHERE owner_id=$1',
      [owner],
    )
  ).rows[0];
  if (!row) return null;
  if (!plaidStorageReady()) throw failure('Secure connection storage is not available yet.', 503);
  try {
    const saved = JSON.parse(decryptToken(row.encrypted_config));
    if (saved.owner !== owner) throw Error('Credential owner mismatch');
    return { credentials: plaidCredentialsSchema.parse(saved), version: row.version };
  } catch {
    throw failure('Saved Plaid credentials could not be read. Contact team@gtfol.dev.', 503);
  }
}

export async function plaidConfiguration(db: SQL, owner: string, platform: 'web' | 'ios' = 'web') {
  const stored = await readCredentials(db, owner);
  const redirectUri =
    platform === 'ios' ? process.env.PLAID_IOS_REDIRECT_URI : process.env.PLAID_WEB_REDIRECT_URI;
  return {
    configured: !!stored,
    environment: stored?.credentials.environment ?? 'sandbox',
    ...(stored ? { clientIdLast4: stored.credentials.clientId.slice(-4) } : {}),
    supportedEnvironments: ['sandbox'] as const,
    storageReady: plaidStorageReady(),
    workerReady: plaidWorkerReady(),
    ...(redirectUri ? { redirectUri } : {}),
  };
}

export async function userPlaidProvider(db: Database, owner: string): Promise<PlaidProvider> {
  const saved = await readCredentials(db, owner);
  if (!saved) throw failure('Add your Plaid credentials in Connections first.', 409);
  const provider = new PlaidSandbox(saved.credentials);
  return {
    call: (path, body, options) => provider.call(path, body, options),
    async assertCurrent(tx, currentOwner) {
      if (currentOwner !== owner) throw failure('Connection owner does not match.', 403);
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner]);
      const row = (
        await tx.query<{ version: string }>(
          'SELECT version FROM plaid_credentials WHERE owner_id=$1',
          [owner],
        )
      ).rows[0];
      if (row?.version !== saved.version)
        throw failure('Plaid credentials changed. Start the connection again.', 409);
    },
  };
}

export async function savePlaidCredentials(
  db: Database,
  owner: string,
  input: unknown,
  verify: (credentials: PlaidCredentials) => Promise<void>,
) {
  if (!plaidStorageReady()) throw failure('Secure connection storage is not available yet.', 503);
  const credentials = plaidCredentialsSchema.parse(input);
  // Validate without creating an Item or retrieving any financial information.
  await verify(credentials);
  await db.transaction(async (tx) => {
    await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner]);
    const saved = await readCredentials(tx, owner);
    if (saved && JSON.stringify(saved.credentials) === JSON.stringify(credentials)) return;
    const active =
      (
        await tx.query(
          "SELECT id FROM connections WHERE owner_id=$1 AND status<>'disconnected' LIMIT 1",
          [owner],
        )
      ).rows.length > 0;
    if (
      active &&
      (!saved ||
        saved.credentials.clientId !== credentials.clientId ||
        saved.credentials.environment !== credentials.environment)
    )
      throw failure(
        'Disconnect your institutions before changing the Plaid client ID or environment. You can update the secret for the same client ID.',
        409,
      );
    await tx.query(
      'INSERT INTO plaid_credentials(owner_id,encrypted_config,version) VALUES($1,$2,$3) ON CONFLICT(owner_id) DO UPDATE SET encrypted_config=EXCLUDED.encrypted_config,version=EXCLUDED.version,updated_at=now()',
      [owner, encryptToken(JSON.stringify({ owner, ...credentials })), randomUUID()],
    );
  });
  return plaidConfiguration(db, owner);
}

export async function removePlaidCredentials(db: Database, owner: string) {
  await db.transaction(async (tx) => {
    await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner]);
    const active =
      (
        await tx.query(
          "SELECT id FROM connections WHERE owner_id=$1 AND status<>'disconnected' LIMIT 1",
          [owner],
        )
      ).rows.length > 0;
    if (active)
      throw failure(
        'Disconnect your institutions before removing Plaid credentials. Imported data can be kept.',
        409,
      );
    await tx.query('DELETE FROM plaid_credentials WHERE owner_id=$1', [owner]);
  });
  return plaidConfiguration(db, owner);
}
