import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import pg from 'pg';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createServerlessApp } from '../api/index';
import {
  acceptedOrigins,
  publicOrigin,
  HOSTED_PAYLOAD_BYTES,
  assertHostedPayloadSize,
  jsonBodyLimit,
} from '../server/hosting';
import { databasePoolOptions, migrateDatabase, openDatabase, type Database } from '../server/db';

const servers: Server[] = [];
async function listen(app: express.Express) {
  const server = createServer(app).listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Test server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

beforeEach(() => {
  for (const name of [
    'VERCEL',
    'VERCEL_URL',
    'VERCEL_BRANCH_URL',
    'VERCEL_PROJECT_PRODUCTION_URL',
    'APP_ORIGIN',
    'DATABASE_URL',
    'PORT',
  ])
    vi.stubEnv(name, undefined);
});

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('hosted request adapter', () => {
  it('initializes once for concurrent requests, preserves API paths and raw webhook bytes', async () => {
    const ready = express();
    ready.get('/api/probe', (req, res) => res.json({ path: req.originalUrl }));
    ready.post('/api/plaid/webhook', express.raw({ type: 'application/json' }), (req, res) => {
      res.json({ raw: Buffer.isBuffer(req.body), body: req.body.toString('utf8') });
    });
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const beginning = new Promise<void>((resolve) => (started = resolve));
    const initialize = vi.fn(async () => {
      started();
      await gate;
      return ready;
    });
    const app = createServerlessApp(initialize);
    expect(typeof app.listen).toBe('function');
    expect(initialize).not.toHaveBeenCalled();
    const base = await listen(app);
    const requests = [fetch(`${base}/api/probe?a=1`), fetch(`${base}/api/probe?a=2`)];
    await beginning;
    release();
    const results = await Promise.all(requests.map(async (result) => (await result).json()));
    expect(results).toEqual([{ path: '/api/probe?a=1' }, { path: '/api/probe?a=2' }]);
    const body = '{ "item_id": "fixture",\n "webhook_code": "DEFAULT_UPDATE" }';
    const webhook = await fetch(`${base}/api/plaid/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(await webhook.json()).toEqual({ raw: true, body });
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it('returns a private retryable error and recovers after failed initialization', async () => {
    const ready = express();
    ready.get('/api/state', (_req, res) => res.json({ ready: true }));
    const initialize = vi
      .fn<() => Promise<express.Express>>()
      .mockRejectedValueOnce(Error('Internal database connection detail'))
      .mockResolvedValue(ready);
    const base = await listen(createServerlessApp(initialize));
    const failed = await fetch(`${base}/api/state`);
    expect(failed.status).toBe(503);
    expect(failed.headers.get('cache-control')).toBe('no-store');
    expect(failed.headers.get('retry-after')).toBe('5');
    expect(await failed.json()).toEqual({
      error: 'Service is temporarily unavailable. Try again shortly.',
    });
    expect(await (await fetch(`${base}/api/state`)).json()).toEqual({ ready: true });
    expect(initialize).toHaveBeenCalledTimes(2);
  });

  it('returns JSON errors before an oversized request or response reaches platform limits', async () => {
    vi.stubEnv('VERCEL', '1');
    const ready = express();
    ready.get('/api/backup', (_req, res) => {
      res.setHeader('Content-Disposition', 'attachment; filename="backup.json"');
      res.json({ data: 'x'.repeat(HOSTED_PAYLOAD_BYTES) });
    });
    const initialize = vi.fn(async () => ready);
    const base = await listen(createServerlessApp(initialize));
    const request = await fetch(`${base}/api/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: 'x'.repeat(HOSTED_PAYLOAD_BYTES) }),
    });
    expect(request.status).toBe(413);
    expect((await request.json()).error).toContain('hosted size limit');
    expect(initialize).not.toHaveBeenCalled();
    const response = await fetch(`${base}/api/backup`);
    expect(response.status).toBe(413);
    expect(response.headers.get('content-disposition')).toBeNull();
    expect((await response.json()).error).toContain('hosted size limit');
    expect(jsonBodyLimit()).toBe(HOSTED_PAYLOAD_BYTES);
    expect(() => assertHostedPayloadSize({ data: 'x'.repeat(HOSTED_PAYLOAD_BYTES) })).toThrow(
      'hosted size limit',
    );
    vi.stubEnv('VERCEL', undefined);
    expect(jsonBodyLimit()).toBe(12 * 1024 * 1024);
    expect(() => assertHostedPayloadSize({ data: 'x'.repeat(HOSTED_PAYLOAD_BYTES) })).not.toThrow();
  });
});

describe('trusted deployment origins', () => {
  it('accepts exact configured/system origins and rejects lookalike or arbitrary hosts', () => {
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('APP_ORIGIN', 'https://asset.gtfol.dev/');
    vi.stubEnv('VERCEL_URL', 'asset-deployment-team.vercel.app');
    vi.stubEnv('VERCEL_BRANCH_URL', 'asset-git-main-team.vercel.app');
    vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', 'asset-team.vercel.app');
    const origins = acceptedOrigins();
    expect(origins).toEqual(
      new Set([
        'https://asset.gtfol.dev',
        'https://asset-deployment-team.vercel.app',
        'https://asset-git-main-team.vercel.app',
        'https://asset-team.vercel.app',
      ]),
    );
    expect(origins.has('https://unrelated.vercel.app')).toBe(false);
    expect(origins.has('https://asset.gtfol.dev.attacker.invalid')).toBe(false);
    expect(publicOrigin({ headers: { host: 'asset-deployment-team.vercel.app' } })).toBe(
      'https://asset-deployment-team.vercel.app',
    );
    expect(
      publicOrigin({
        headers: {
          host: 'attacker.invalid',
          origin: 'https://attacker.invalid',
          'x-forwarded-host': 'attacker.invalid',
        },
      }),
    ).toBe('https://asset.gtfol.dev');
  });

  it('uses the canonical hosted fallback and keeps loopback aliases local', () => {
    expect(acceptedOrigins()).toEqual(new Set(['http://localhost:4317', 'http://127.0.0.1:4317']));
    vi.stubEnv('VERCEL', '1');
    expect(acceptedOrigins()).toEqual(new Set(['https://asset.gtfol.dev']));
    vi.stubEnv('APP_ORIGIN', 'https://asset.gtfol.dev/redirect');
    expect(() => acceptedOrigins()).toThrow('APP_ORIGIN');
    vi.stubEnv('APP_ORIGIN', 'http://untrusted.invalid');
    expect(() => acceptedOrigins()).toThrow('APP_ORIGIN');
  });
});

describe('hosted database initialization', () => {
  it('requires durable hosted storage and enforces verified TLS for Supabase pools', async () => {
    vi.stubEnv('VERCEL', '1');
    await expect(openDatabase(':memory:')).rejects.toThrow('DATABASE_URL is required');
    const options = databasePoolOptions(
      'postgres://fixture:fixture@aws-0-us-west-1.pooler.supabase.com:6543/postgres?sslmode=disable',
    );
    expect(new URL(options.connectionString!).searchParams.get('sslmode')).toBe('verify-full');
    expect(options.max).toBe(2);
    expect(options.idleTimeoutMillis).toBe(5000);
    expect(
      new URL(databasePoolOptions('postgres://localhost/asset').connectionString!).searchParams.has(
        'sslmode',
      ),
    ).toBe(false);
  });

  it('applies each migration once and rolls back a failed migration with its tracking row', async () => {
    const db = await openDatabase(':memory:');
    try {
      const initial = (await db.query('SELECT version FROM schema_migrations ORDER BY version'))
        .rows;
      expect(initial.map((row) => row.version)).toContain(1);
      const migration = {
        version: 1000,
        sql: 'CREATE TABLE migration_fixture(id integer); INSERT INTO migration_fixture VALUES(7);',
      };
      await migrateDatabase(db, [migration], false);
      await migrateDatabase(db, [migration], false);
      expect((await db.query('SELECT id FROM migration_fixture')).rows).toEqual([{ id: 7 }]);
      await expect(
        migrateDatabase(
          db,
          [
            {
              version: 1001,
              sql: 'CREATE TABLE migration_rolled_back(id integer); INSERT INTO missing_fixture_table VALUES(1);',
            },
          ],
          false,
        ),
      ).rejects.toThrow();
      expect(
        (await db.query('SELECT version FROM schema_migrations WHERE version=1001')).rows,
      ).toEqual([]);
      expect((await db.query("SELECT to_regclass('migration_rolled_back') AS name")).rows).toEqual([
        { name: null },
      ]);
    } finally {
      await db.close();
    }
  }, 30000);

  it('locks migrations on their transaction connection before inspecting or changing the schema', async () => {
    const queries: string[] = [];
    const tx = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      }),
    };
    const db: Database = {
      query: vi.fn(async () => {
        throw Error('Migration escaped its transaction');
      }),
      transaction: (fn) => fn(tx),
      close: async () => {},
    };
    await migrateDatabase(db, [{ version: 1, sql: 'CREATE TABLE fixture(id integer)' }], true);
    expect(queries[0]).toBe('SELECT pg_advisory_xact_lock($1,$2)');
    expect(queries[1]).toContain('CREATE TABLE IF NOT EXISTS schema_migrations');
    expect(queries.at(-1)).toContain('INSERT INTO schema_migrations');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('closes a failed remote pool so a later initialization can retry cleanly', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://localhost/asset');
    const end = vi.fn(async () => {});
    vi.spyOn(pg, 'Pool').mockImplementation(function () {
      return {
        on: vi.fn(),
        connect: async () => {
          throw Error('Fixture connection unavailable');
        },
        end,
      } as unknown as pg.Pool;
    });
    await expect(openDatabase()).rejects.toThrow('Fixture connection unavailable');
    expect(end).toHaveBeenCalledTimes(1);
  });
});
