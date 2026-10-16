import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { readFile, mkdir } from 'node:fs/promises';
import { validateState, type State } from '../shared/core';
export interface SQL {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Database extends SQL {
  transaction<T>(fn: (tx: SQL) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export async function openDatabase(
  path = process.env.DATA_DIR ?? '.data/postgres',
): Promise<Database> {
  let db: Database;
  if (process.env.DATABASE_URL) {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
    db = {
      query: async (sql, p) => (await pool.query(sql, p)) as any,
      transaction: async (fn) => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const out = await fn({ query: async (sql, p) => (await c.query(sql, p)) as any });
          await c.query('COMMIT');
          return out;
        } catch (e) {
          await c.query('ROLLBACK');
          throw e;
        } finally {
          c.release();
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
  for (const statement of (
    await readFile(new URL('./migrations/001_initial.sql', import.meta.url), 'utf8')
  )
    .replace(/^--.*$/gm, '')
    .split(';'))
    if (statement.trim()) await db.query(statement);
  return db;
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
) {
  return db.transaction(async (tx) => {
    const r = await tx.query<{ state: State; revision: number }>(
      'SELECT state,revision FROM workspaces WHERE owner_id=$1 FOR UPDATE',
      [owner],
    );
    const row = r.rows[0];
    if (!row) throw Error('Workspace not found');
    if (revision !== undefined && row.revision !== revision)
      throw Object.assign(Error('Data changed on another device. Reload and try again.'), {
        status: 409,
      });
    const next = validateState(await fn(validateState(row.state), tx));
    await tx.query(
      'UPDATE workspaces SET state=$1,revision=revision+1,updated_at=now() WHERE owner_id=$2',
      [JSON.stringify(next), owner],
    );
    return { state: next, revision: row.revision + 1 };
  });
}
