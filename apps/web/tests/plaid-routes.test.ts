import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { Response as ExpressResponse } from 'express';
import { createApp } from '../server/app';
import { newSession } from '../server/auth';
import { getState, openDatabase, type Database } from '../server/db';
import { encryptToken, type PlaidProvider } from '../server/plaid';
import { fixture } from './fixtures';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Plaid route isolation and lifecycle', () => {
  let db: Database;
  let server: Server;
  let base: string;
  let session: string;
  const call = vi.fn<(path: string, body: Record<string, unknown>) => Promise<any>>();

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', undefined);
    vi.stubEnv('VERCEL', undefined);
    vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'c'.repeat(64));
    db = await openDatabase(':memory:');
    const provider: PlaidProvider = {
      environment: 'sandbox',
      call: (path, body) => call(path, body),
    };
    server = createApp(db, provider).listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  }, 30000);
  beforeEach(async () => {
    vi.stubEnv('VERCEL', undefined);
    vi.stubEnv('PLAID_WORKER_ENABLED', undefined);
    vi.stubEnv('CRON_SECRET', undefined);
    vi.stubEnv('APP_ORIGIN', 'https://asset.example');
    vi.stubEnv('PLAID_WEB_REDIRECT_URI', 'https://asset.example/plaid/oauth');
    vi.stubEnv('PLAID_IOS_REDIRECT_URI', 'https://asset.example/plaid/ios');
    await db.query('DELETE FROM users');
    await db.query('INSERT INTO users(id,email) VALUES($1,$2)', [
      'owner',
      'routes@example.invalid',
    ]);
    const state = fixture();
    state.accounts[0] = {
      ...state.accounts[0],
      source: 'plaid',
      connectionId: 'connection',
      providerId: 'provider-old',
    };
    await db.query('INSERT INTO workspaces(owner_id,state) VALUES($1,$2)', [
      'owner',
      JSON.stringify(state),
    ]);
    session = await newSession(db, 'owner', { cookie() {} } as unknown as ExpressResponse);
    await db.query(
      `INSERT INTO connections(id,owner_id,item_id,institution_id,institution_name,encrypted_token,
       product,selected_accounts,status,cursor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        'connection',
        'owner',
        'old-item',
        'institution',
        'Sandbox fixture',
        encryptToken('old-access'),
        'transactions',
        JSON.stringify(['provider-old']),
        'healthy',
        'old-cursor',
      ],
    );
    call.mockReset();
    call.mockImplementation(async (path: string) => {
      if (path === '/link/token/create')
        return { link_token: 'link-fixture', expiration: '2099-01-01T00:00:00Z' };
      if (path === '/accounts/get') return { accounts: [{ account_id: 'provider-old' }] };
      if (path === '/item/remove') return { removed: true };
      throw Error(`Unexpected provider call: ${path}`);
    });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    vi.unstubAllEnvs();
  });

  function request(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      platform?: 'web' | 'ios';
      token?: string;
      context?: string;
    } = {},
  ) {
    return fetch(base + path, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${options.token ?? session}`,
        'content-type': 'application/json',
        'x-asset-client': options.platform ?? 'web',
        ...(options.context === undefined ? {} : { 'x-asset-session': options.context }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }
  async function connection() {
    return (await db.query('SELECT * FROM connections WHERE id=$1', ['connection'])).rows[0];
  }
  async function replaceConnection() {
    await db.query(
      'UPDATE connections SET item_id=$1,encrypted_token=$2,selected_accounts=$3,cursor=$4 WHERE id=$5',
      [
        'new-item',
        encryptToken('new-access'),
        JSON.stringify(['provider-new']),
        'new-cursor',
        'connection',
      ],
    );
  }
  async function expectReplacementUntouched(revision: number) {
    expect(await connection()).toMatchObject({
      item_id: 'new-item',
      selected_accounts: ['provider-new'],
      cursor: 'new-cursor',
      status: 'healthy',
    });
    expect((await getState(db, 'owner')).revision).toBe(revision);
    expect((await db.query('SELECT * FROM sync_jobs')).rows).toHaveLength(0);
  }

  it('shows the callback URI actually used for each platform', async () => {
    for (const platform of ['web', 'ios'] as const) {
      const config = await (await request('/plaid/config', { platform })).json();
      expect(config.redirectUri).toBe(
        platform === 'ios'
          ? 'https://asset.example/plaid/ios'
          : 'https://asset.example/plaid/oauth',
      );
      const response = await request('/plaid/link-token', {
        platform,
        body: { product: 'transactions' },
      });
      expect(response.status).toBe(200);
      expect(call.mock.calls.at(-1)).toEqual([
        '/link/token/create',
        expect.objectContaining({ redirect_uri: config.redirectUri }),
      ]);
    }
  });

  it('allows revocation when the sync worker is unavailable', async () => {
    vi.stubEnv('VERCEL', '1');
    expect((await request('/plaid/connection/sync', { body: {} })).status).toBe(503);
    const response = await request('/plaid/connection/disconnect', { body: { deleteData: false } });
    expect(response.status).toBe(200);
    expect(call).toHaveBeenCalledWith('/item/remove', { access_token: 'old-access' });
    expect(await connection()).toMatchObject({ status: 'disconnected', encrypted_token: '' });
  });

  it('returns connection environments and blocks update metadata with a mismatched provider', async () => {
    await db.query("UPDATE connections SET environment='production' WHERE id='connection'");
    const response = await request('/plaid/connection/update-complete', {
      body: { selected: ['provider-old'] },
    });
    expect(response.status).toBe(409);
    expect(call).not.toHaveBeenCalled();
    const { connections } = await (await request('/state')).json();
    expect(connections).toMatchObject([{ id: 'connection', environment: 'production' }]);
  });

  it('does not apply delayed update-mode metadata to a replacement Item', async () => {
    const entered = deferred();
    const release = deferred();
    const revision = (await getState(db, 'owner')).revision;
    call.mockImplementation(async (path: string) => {
      expect(path).toBe('/accounts/get');
      entered.resolve();
      await release.promise;
      return { accounts: [{ account_id: 'provider-old' }] };
    });
    const pending = request('/plaid/connection/update-complete', {
      body: { selected: ['provider-old'] },
    });
    try {
      await entered.promise;
      await replaceConnection();
    } finally {
      release.resolve();
    }
    const response = await pending;
    expect(response.status).toBe(409);
    await expectReplacementUntouched(revision);
  });

  it('does not apply delayed account toggles to a replacement Item', async () => {
    const entered = deferred();
    const release = deferred();
    const originalTransaction = db.transaction.bind(db);
    const revision = (await getState(db, 'owner')).revision;
    vi.spyOn(db, 'transaction').mockImplementationOnce(async (operation) => {
      entered.resolve();
      await release.promise;
      return originalTransaction(operation);
    });
    const pending = request('/plaid/connection/accounts', { body: { selected: [] } });
    try {
      await entered.promise;
      await replaceConnection();
    } finally {
      release.resolve();
    }
    const response = await pending;
    expect(response.status).toBe(409);
    await expectReplacementUntouched(revision);
    expect((await getState(db, 'owner')).state.accounts[0].enabled).toBe(true);
  });
});
