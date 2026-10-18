import { PGlite } from '@electric-sql/pglite';
import { attachDatabasePool } from '@vercel/functions';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { checkServerIdentity } from 'node:tls';
import { validateState, type State } from '../shared/core.js';
import { assertHostedPayloadSize } from './hosting.js';
import { updateNotifications } from '../shared/notifications.js';
import { enqueueNotifications } from './notifications.js';
export interface SQL {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Database extends SQL {
  transaction<T>(fn: (tx: SQL) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export function databasePoolOptions(connectionString: string): pg.PoolConfig {
  const url = new URL(connectionString);
  const supabase =
    url.hostname.endsWith('.supabase.co') || url.hostname.endsWith('.pooler.supabase.com');
  let ssl: pg.PoolConfig['ssl'];
  if (supabase) {
    // pg's URL settings replace the ssl object, including its trusted CA and verification.
    for (const key of [
      'ssl',
      'sslmode',
      'sslcert',
      'sslkey',
      'sslrootcert',
      'sslnegotiation',
      'uselibpqcompat',
    ])
      url.searchParams.delete(key);
    ssl = {
      ca: readFileSync(new URL('./certs/supabase-prod-ca-2021.crt', import.meta.url), 'utf8'),
      rejectUnauthorized: true,
      checkServerIdentity,
    };
  }
  return {
    connectionString: supabase ? url.toString() : connectionString,
    ...(ssl ? { ssl } : {}),
    max: process.env.VERCEL === '1' ? 2 : 5,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 5000,
    allowExitOnIdle: true,
  };
}

type Migration = { version: number; sql: string };

async function readMigrations(): Promise<Migration[]> {
  const directory = new URL('./migrations/', import.meta.url);
  const files = (await readdir(directory)).filter((file) => /^\d+_[\w-]+\.sql$/.test(file));
  const migrations = await Promise.all(
    files.map(async (file) => ({
      version: Number(file.split('_')[0]),
      sql: await readFile(new URL(file, directory), 'utf8'),
    })),
  );
  migrations.sort((a, b) => a.version - b.version);
  if (
    !migrations.length ||
    new Set(migrations.map((migration) => migration.version)).size !== migrations.length
  )
    throw Error('Database migrations are missing or have duplicate versions');
  return migrations;
}

export async function migrateDatabase(db: Database, migrations: Migration[], remote: boolean) {
  await db.transaction(async (tx) => {
    // Transaction locks remain on one pooled connection, including Supabase transaction mode.
    if (remote) await tx.query('SELECT pg_advisory_xact_lock($1,$2)', [1095979860, 1296648018]);
    await tx.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const applied = new Set(
      (await tx.query<{ version: number }>('SELECT version FROM schema_migrations')).rows.map(
        ({ version }) => version,
      ),
    );
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      for (const statement of migration.sql.replace(/^--.*$/gm, '').split(';'))
        if (statement.trim()) await tx.query(statement);
      await tx.query('INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING', [
        migration.version,
      ]);
    }
  });
}

export async function openDatabase(
  path = process.env.DATA_DIR ?? '.data/postgres',
): Promise<Database> {
  let db: Database;
  const connectionString = process.env.DATABASE_URL;
  if (process.env.VERCEL === '1' && !connectionString)
    throw Error('DATABASE_URL is required for hosted storage');
  if (connectionString) {
    const pool = new pg.Pool(databasePoolOptions(connectionString));
    pool.on('error', () => console.error('An idle database connection closed unexpectedly'));
    if (process.env.VERCEL === '1') attachDatabasePool(pool);
    db = {
      query: async (sql, p) => (await pool.query(sql, p)) as any,
      transaction: async (fn) => {
        const c = await pool.connect();
        let discard = false;
        try {
          await c.query('BEGIN');
          const out = await fn({ query: async (sql, p) => (await c.query(sql, p)) as any });
          await c.query('COMMIT');
          return out;
        } catch (e) {
          try {
            await c.query('ROLLBACK');
          } catch {
            discard = true;
          }
          throw e;
        } finally {
          c.release(discard);
        }
      },
      close: () => pool.end(),
    };
  } else {
    if (path !== ':memory:') await mkdir(path, { recursive: true, mode: 0o700 });
    const local = new PGlite(path === ':memory:' ? undefined : path);
    db = {
      query: (sql, p) => local.query(sql, p) as any,
      transaction: (fn) =>
        local.transaction((tx) => fn({ query: (sql, p) => tx.query(sql, p) as any })),
      close: () => local.close(),
    };
  }
  try {
    await migrateDatabase(db, await readMigrations(), !!connectionString);
    return db;
  } catch (error) {
    await db.close().catch(() => {});
    throw error;
  }
}
export async function getState(db: SQL, owner: string) {
  const r = await db.query<{ state: State; revision: number }>(
    'SELECT state,revision FROM workspaces WHERE owner_id=$1',
    [owner],
  );
  if (!r.rows[0]) throw Error('Workspace not found');
  return { ...r.rows[0], state: validateState(r.rows[0].state) };
}
export async function mutateState(
  db: Database,
  owner: string,
  fn: (state: State, tx: SQL) => Promise<State> | State,
  revision?: number,
  quiet = false,
  operation?: { id: string; hash: string },
) {
  return db.transaction(async (tx) => {
    const r = await tx.query<{ state: State; revision: number }>(
      'SELECT state,revision FROM workspaces WHERE owner_id=$1 FOR UPDATE',
      [owner],
    );
    const row = r.rows[0];
    if (!row) throw Error('Workspace not found');
    if (operation) {
      const previous = (await tx.query<{ hash: string }>('SELECT hash FROM workspace_operations WHERE owner_id=$1 AND id=$2', [owner, operation.id])).rows[0];
      if (previous) {
        if (previous.hash !== operation.hash) throw Object.assign(Error('Sync operation changed during retry'), { status: 409 });
        return { state: validateState(row.state), revision: row.revision };
      }
    }
    if (revision !== undefined && row.revision !== revision)
      throw Object.assign(Error('Data changed on another device. Reload and try again.'), {
        status: 409,
      });
    const before = validateState(row.state);
    const next = validateState(
      updateNotifications(
        before,
        await fn(validateState(row.state), tx),
        new Date().toISOString(),
        quiet,
      ),
    );
    assertHostedPayloadSize(next);
    await enqueueNotifications(tx, owner, before, next);
    await tx.query(
      'UPDATE workspaces SET state=$1,revision=revision+1,updated_at=now() WHERE owner_id=$2',
      [JSON.stringify(next), owner],
    );
    if (operation) await tx.query('INSERT INTO workspace_operations(owner_id,id,hash) VALUES($1,$2,$3)', [owner, operation.id, operation.hash]);
    return { state: next, revision: row.revision + 1 };
  });
}
