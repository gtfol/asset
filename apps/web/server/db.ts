import { PGlite } from '@electric-sql/pglite';
import { attachDatabasePool } from '@vercel/functions';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { checkServerIdentity } from 'node:tls';
import { validateState, type State } from '../shared/core.js';
import { stateDelta, hasDelta, type StateDelta } from '../shared/delta.js';
import { scopedCollections, scopedStateSQL, type StateScope } from './state-scope.js';
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
export async function getSyncState(db: SQL, owner: string, known?: { ownerId: string; revision: number; delta?: boolean }) {
  if (!known) return getState(db, owner);
  if (known.delta) {
    // State and journal are read in one snapshot. A gap (migration, bulk import,
    // expired history) falls back to a full bootstrap, never an incomplete delta.
    const { rows } = await db.query<{ state: State | null; revision: number; patches: StateDelta[] | null }>(
      `SELECT w.revision,
        CASE WHEN w.owner_id=$2 AND (w.revision=$3 OR (j.count=w.revision-$3 AND j.bytes<=2000000)) THEN NULL ELSE w.state END AS state,
        CASE WHEN w.owner_id=$2 AND w.revision>$3 AND j.count=w.revision-$3 AND j.bytes<=2000000 THEN j.patches ELSE NULL END AS patches
      FROM workspaces w LEFT JOIN LATERAL (
        SELECT count(*)::integer AS count,sum(octet_length(delta::text)) AS bytes,jsonb_agg(delta ORDER BY revision) AS patches
        FROM workspace_changes WHERE owner_id=w.owner_id AND revision>$3 AND revision<=w.revision
      ) j ON true WHERE w.owner_id=$1`, [owner, known.ownerId, known.revision],
    );
    const row = rows[0];
    if (!row) throw Error('Workspace not found');
    if (row.state) return { state: validateState(row.state), revision: row.revision };
    if (row.patches) return { delta: { fromRevision: known.revision, patches: row.patches }, revision: row.revision };
    return { unchanged: true as const, revision: row.revision };
  }
  // Compare inside Postgres: an unchanged JSON document must not cross the database connection.
  // Include the owner because two different workspaces can have the same revision.
  const { rows } = await db.query<{ state: State | null; revision: number }>(
    `SELECT CASE WHEN owner_id=$2 AND revision=$3 THEN NULL ELSE state END AS state,revision
     FROM workspaces WHERE owner_id=$1`, [owner, known.ownerId, known.revision],
  );
  const row = rows[0];
  if (!row) throw Error('Workspace not found');
  return row.state === null ? { unchanged: true as const, revision: row.revision }
    : { state: validateState(row.state), revision: row.revision };
}

async function recordDelta(tx: SQL, owner: string, revision: number, delta: StateDelta) {
  const json = JSON.stringify(delta);
  // Bound retained history to ~64 MB/owner even for large imports. A skipped
  // oversized commit is an intentional journal gap, requiring a full bootstrap.
  if (Buffer.byteLength(json) <= 256 * 1024) await tx.query(
    'INSERT INTO workspace_changes(owner_id,revision,delta) VALUES($1,$2,$3)', [owner, revision, json]);
  await tx.query('DELETE FROM workspace_changes WHERE owner_id=$1 AND revision<=$2', [owner, revision - 256]);
}

async function saveDelta(tx: SQL, owner: string, delta: StateDelta) {
  const arrays = Object.keys(delta.collections).map(collection => {
    const key = (row: string) => collection === 'budgets'
      ? `(${row}->>'month') || ':' || (${row}->>'categoryId')` : `${row}->>'id'`;
    const updates = `($2::jsonb#>'{collections,${collection},upserts}')`;
    const removed = `($2::jsonb#>'{collections,${collection},removed}')`;
    return `'${collection}', COALESCE((
      SELECT jsonb_agg(record ORDER BY ordinal) FROM (
        SELECT COALESCE(u.record,b.record) AS record,b.ordinal
        FROM jsonb_array_elements(COALESCE(state->'${collection}','[]'::jsonb)) WITH ORDINALITY b(record,ordinal)
        LEFT JOIN jsonb_array_elements(${updates}) u(record) ON (${key('u.record')})=(${key('b.record')})
        WHERE NOT (${removed} ? (${key('b.record')}))
        UNION ALL
        SELECT u.record,jsonb_array_length(COALESCE(state->'${collection}','[]'::jsonb))+u.ordinal
        FROM jsonb_array_elements(${updates}) WITH ORDINALITY u(record,ordinal)
        WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(state->'${collection}','[]'::jsonb)) b(record)
          WHERE (${key('b.record')})=(${key('u.record')}))
      ) records),'[]'::jsonb)`;
  });
  await tx.query(`UPDATE workspaces SET state=(state - $3::text[]) || ($2::jsonb->'values')
    ${arrays.length ? `|| jsonb_build_object(${arrays.join(',')})` : ''},
    revision=revision+1,updated_at=now() WHERE owner_id=$1`, [owner, JSON.stringify(delta), delta.unset]);
  // Partial validation checks new records/references in JS. Check aggregate limits
  // inside Postgres without downloading all records to the application server.
  const { rows } = await tx.query<{ valid: boolean }>(`SELECT
    ${process.env.VERCEL === '1' ? 'octet_length(state::text)<=32000000 AND' : ''}
    jsonb_array_length(state->'transactions')<=100000 AND jsonb_array_length(state->'snapshots')<=100000
    AND jsonb_array_length(state->'holdings')<=100000 AND
    ${['transactions', 'budgets', 'snapshots', 'holdings'].map(c =>
      `(SELECT COALESCE(sum(abs(COALESCE((r->>'${c === 'snapshots' ? 'balance' : c === 'holdings' ? 'marketValue' : 'amount'}')::numeric,0))),0)<=9007199254740991 FROM jsonb_array_elements(state->'${c}') r)`).join(' AND ')}
    AS valid FROM workspaces WHERE owner_id=$1`, [owner]);
  if (!rows[0]?.valid) throw Error('Workspace record or exact arithmetic limit exceeded');
}

export async function mutateState(
  db: Database,
  owner: string,
  fn: (state: State, tx: SQL) => Promise<State> | State,
  revision?: number,
  quiet = false,
  operation?: { id: string; hash: string },
  scope?: StateScope,
) {
  return db.transaction(async (tx) => {
    // Lock before selecting the scoped view. All writers share this owner lock.
    if (scope) await tx.query('SELECT revision FROM workspaces WHERE owner_id=$1 FOR UPDATE', [owner]);
    const r = await tx.query<{ state: State; revision: number }>(
      scope ? `SELECT ${scopedStateSQL()} AS state,revision FROM workspaces WHERE owner_id=$1`
        : 'SELECT state,revision FROM workspaces WHERE owner_id=$1 FOR UPDATE',
      scope ? [owner, JSON.stringify(scope)] : [owner],
    );
    const row = r.rows[0];
    if (!row) throw Error('Workspace not found');
    if (scope) for (const collection of scopedCollections) {
      (row.state as any)[collection] = (row.state[collection] as any[]).map(record => {
        const key = record._asset_known, known = scope[collection]?.known;
        if (key === undefined) return record;
        if (!known || !Object.hasOwn(known, key)) throw Error('Bank update could not verify a saved record');
        return known[key];
      });
    }
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
    const delta = stateDelta(before, next);
    const changed = hasDelta(delta);
    if (changed) {
      await enqueueNotifications(tx, owner, before, next);
      if (scope) await saveDelta(tx, owner, delta);
      else await tx.query(
        'UPDATE workspaces SET state=$1,revision=revision+1,updated_at=now() WHERE owner_id=$2',
        [JSON.stringify(next), owner],
      );
      await recordDelta(tx, owner, row.revision + 1, delta);
    }
    if (operation) await tx.query('INSERT INTO workspace_operations(owner_id,id,hash) VALUES($1,$2,$3)', [owner, operation.id, operation.hash]);
    return { state: next, revision: row.revision + Number(changed) };
  });
}
