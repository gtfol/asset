import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { Response as ExpressResponse } from 'express';
import { createApp } from '../server/app';
import { newSession } from '../server/auth';
import { openDatabase, type Database } from '../server/db';
import { googleWorkspace } from '../server/google';
import { encryptToken } from '../server/plaid';
import {
  plaidConfiguration,
  removePlaidCredentials,
  savePlaidCredentials,
  userPlaidProvider,
} from '../server/plaid-credentials';

const credentials = {
  clientId: 'client-owner-alpha',
  secret: 'secret-owner-alpha',
  environment: 'production',
};
const otherCredentials = {
  clientId: 'client-owner-bravo',
  secret: 'secret-owner-bravo',
  environment: 'production',
};
const verify = vi.fn(async () => {});

describe('per-user Plaid credentials', () => {
  let db: Database;
  let server: Server;
  let base: string;
  let owner: string;
  let other: string;
  let session: string;
  let otherSession: string;
  beforeAll(async () => {
    vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'b'.repeat(64));
    vi.stubEnv('VERCEL', undefined);
    db = await openDatabase(':memory:');
    owner = await googleWorkspace(db, { id: 'plaid-owner-alpha', email: 'alpha@example.invalid' });
    other = await googleWorkspace(db, { id: 'plaid-owner-bravo', email: 'bravo@example.invalid' });
    session = await newSession(db, owner, { cookie() {} } as unknown as ExpressResponse);
    otherSession = await newSession(db, other, { cookie() {} } as unknown as ExpressResponse);
    server = createApp(db).listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  }, 30000);
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    vi.unstubAllEnvs();
  });

  async function request(
    path: string,
    token = session,
    method = 'GET',
    body?: unknown,
    origin?: string,
  ) {
    return fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-asset-client': 'web',
        ...(origin ? { origin } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  it('validates before saving, encrypts both identifiers, and returns only masked configuration', async () => {
    await expect(
      savePlaidCredentials(db, owner, credentials, async () => {
        throw Error('invalid');
      }),
    ).rejects.toThrow('invalid');
    expect((await plaidConfiguration(db, owner)).configured).toBe(false);
    const result = await savePlaidCredentials(db, owner, credentials, verify);
    expect(result).toMatchObject({
      configured: true,
      environment: 'production',
      clientIdLast4: 'lpha',
    });
    expect(JSON.stringify(result)).not.toContain(credentials.secret);
    expect(JSON.stringify(result)).not.toContain(credentials.clientId);
    const stored = (await db.query('SELECT * FROM plaid_credentials WHERE owner_id=$1', [owner]))
      .rows[0];
    expect(stored.encrypted_config).not.toContain(credentials.secret);
    expect(stored.encrypted_config).not.toContain(credentials.clientId);
    expect((await plaidConfiguration(db, other)).configured).toBe(false);
  });

  it('isolates configuration and keeps credentials out of workspace and backup responses', async () => {
    expect((await request('/plaid/config', 'invalid')).status).toBe(401);
    const own = await (await request('/plaid/config')).json();
    const isolated = await (await request('/plaid/config', otherSession)).json();
    expect(own.configured).toBe(true);
    expect(isolated.configured).toBe(false);
    expect(
      (await request('/plaid/config', session, 'PUT', credentials, 'https://attacker.invalid'))
        .status,
    ).toBe(403);
    for (const path of ['/state', '/backup']) {
      const body = await (await request(path)).text();
      expect(body).not.toContain(credentials.secret);
      expect(body).not.toContain(credentials.clientId);
      expect(body).not.toContain('encrypted_config');
    }
    const state = await (await request('/state')).json();
    expect(state.sessionId).toMatch(/^[a-f0-9]{64}$/);
    expect(state.sessionId).not.toBe(session);
    expect(state.plaidConfigured).toBe(true);
  });

  it('refuses missing credentials and detects ciphertext moved to another owner', async () => {
    await expect(userPlaidProvider(db, other)).rejects.toThrow('Add your Plaid credentials');
    const row = (
      await db.query('SELECT encrypted_config FROM plaid_credentials WHERE owner_id=$1', [owner])
    ).rows[0];
    await db.query(
      'INSERT INTO plaid_credentials(owner_id,encrypted_config,version) VALUES($1,$2,$3)',
      [other, row.encrypted_config, 'copied'],
    );
    await expect(plaidConfiguration(db, other)).rejects.toThrow('could not be read');
    const response = await request('/state', otherSession);
    expect(response.status).toBe(200);
    expect((await response.json()).plaidConfigured).toBe(false);
    await db.query('DELETE FROM plaid_credentials WHERE owner_id=$1', [other]);
  });

  it('rejects connection operations from a changed browser session', async () => {
    const { sessionId } = await (await request('/state')).json();
    for (const [path, method] of [
      ['/plaid/config', 'GET'],
      ['/plaid/config', 'DELETE'],
      ['/plaid/link-token', 'POST'],
    ]) {
      const response = await fetch(base + path, {
        method,
        headers: {
          authorization: `Bearer ${otherSession}`,
          'x-asset-session': sessionId,
          'x-asset-client': 'web',
        },
      });
      expect(response.status).toBe(409);
    }
    const response = await fetch(base + '/plaid/config', {
      headers: { authorization: `Bearer ${session}`, 'x-asset-session': sessionId },
    });
    expect(response.status).toBe(200);
  });

  it('uses each owner’s credentials instead of global Plaid keys', async () => {
    await savePlaidCredentials(db, other, otherCredentials, verify);
    vi.stubEnv('PLAID_CLIENT_ID', 'global-must-not-be-used');
    vi.stubEnv('PLAID_SECRET', 'global-must-not-be-used');
    const calls: { url: string; body: any }[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ institutions: [] }), { status: 200 });
    });
    try {
      await (await userPlaidProvider(db, owner)).call('/institutions/get', { count: 1 });
      await (await userPlaidProvider(db, other)).call('/institutions/get', { count: 1 });
      expect(calls.map(({ url }) => url)).toEqual([
        'https://production.plaid.com/institutions/get',
        'https://production.plaid.com/institutions/get',
      ]);
      expect(calls.map(({ body }) => [body.client_id, body.secret])).toEqual([
        [credentials.clientId, credentials.secret],
        [otherCredentials.clientId, otherCredentials.secret],
      ]);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('fences in-flight exchanges when credentials change', async () => {
    const original = await userPlaidProvider(db, owner);
    await savePlaidCredentials(db, owner, otherCredentials, verify);
    await expect(db.transaction((tx) => original.assertCurrent!(tx, owner))).rejects.toThrow(
      'credentials changed',
    );
    await savePlaidCredentials(db, owner, credentials, verify);
    const current = await userPlaidProvider(db, owner);
    await expect(
      db.transaction((tx) => current.assertCurrent!(tx, owner)),
    ).resolves.toBeUndefined();
    await expect(db.transaction((tx) => current.assertCurrent!(tx, other))).rejects.toThrow(
      'owner',
    );
  });

  it('blocks replacement/removal while connected and allows them after disconnect', async () => {
    await db.query(
      'INSERT INTO connections(id,owner_id,item_id,institution_id,institution_name,encrypted_token,product,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        'byo-connection',
        owner,
        'byo-item',
        'byo-institution',
        'Fixture',
        encryptToken('fixture-item-token'),
        'transactions',
        'healthy',
      ],
    );
    await expect(savePlaidCredentials(db, owner, otherCredentials, verify)).rejects.toThrow(
      'Disconnect',
    );
    await expect(removePlaidCredentials(db, owner)).rejects.toThrow('Disconnect');
    await expect(savePlaidCredentials(db, owner, credentials, verify)).resolves.toMatchObject({
      configured: true,
    });
    await expect(
      savePlaidCredentials(db, owner, { ...credentials, secret: 'rotated-secret-alpha' }, verify),
    ).resolves.toMatchObject({ configured: true });
    expect((await request('/plaid/config', session, 'DELETE')).status).toBe(409);
    await db.query("UPDATE connections SET status='disconnected' WHERE id=$1", ['byo-connection']);
    expect((await request('/plaid/config', session, 'DELETE')).status).toBe(200);
    expect((await plaidConfiguration(db, owner)).configured).toBe(false);
    expect((await plaidConfiguration(db, other)).configured).toBe(true);
  });

  it('rejects unauthorized worker requests before queue processing', async () => {
    expect((await request('/internal/plaid-worker')).status).toBe(401);
    vi.stubEnv('CRON_SECRET', 'worker-fixture-secret'.repeat(3));
    expect((await request('/internal/plaid-worker', 'not-the-worker-secret')).status).toBe(401);
    const response = await request('/internal/plaid-worker', process.env.CRON_SECRET);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, processed: 0 });
  });

  it('validates Production credentials through institutions before the authenticated route saves them', async () => {
    const originalFetch = globalThis.fetch;
    const calls: { url: string; body: any }[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).startsWith(base)) return originalFetch(url, init);
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ institutions: [] }), { status: 200 });
    });
    try {
      const response = await request('/plaid/config', session, 'PUT', credentials);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ configured: true, environment: 'production' });
      expect(calls).toEqual([
        {
          url: 'https://production.plaid.com/institutions/get',
          body: {
            client_id: credentials.clientId,
            secret: credentials.secret,
            country_codes: ['US'],
            count: 1,
            offset: 0,
          },
        },
      ]);
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe('Plaid environment policy', () => {
  let db: Database;
  const sandbox = { ...credentials, environment: 'sandbox' };
  beforeAll(async () => {
    db = await openDatabase(':memory:');
  }, 30000);
  beforeEach(async () => {
    vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'c'.repeat(64));
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('PLAID_ALLOW_SANDBOX', undefined);
    await db.query('DELETE FROM users');
    await db.query('INSERT INTO users(id,email) VALUES($1,$2)', [
      'environment-owner',
      'environment@example.invalid',
    ]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await db.close();
  });

  it('defaults to Production and offers Sandbox only for local development or explicit opt-in', async () => {
    expect(await plaidConfiguration(db, 'environment-owner')).toMatchObject({
      configured: false,
      environment: 'production',
      supportedEnvironments: ['production'],
    });
    vi.stubEnv('VERCEL', undefined);
    expect((await plaidConfiguration(db, 'environment-owner')).supportedEnvironments).toEqual([
      'production',
    ]);
    vi.stubEnv('NODE_ENV', 'development');
    expect((await plaidConfiguration(db, 'environment-owner')).supportedEnvironments).toEqual([
      'production',
      'sandbox',
    ]);
    vi.stubEnv('VERCEL', '1');
    expect((await plaidConfiguration(db, 'environment-owner')).supportedEnvironments).toEqual([
      'production',
    ]);
    vi.stubEnv('PLAID_ALLOW_SANDBOX', 'true');
    expect((await plaidConfiguration(db, 'environment-owner')).supportedEnvironments).toEqual([
      'production',
      'sandbox',
    ]);
    await expect(
      savePlaidCredentials(db, 'environment-owner', sandbox, async () => {}),
    ).resolves.toMatchObject({ environment: 'sandbox' });
  });

  it('rejects new hosted Sandbox or invalid environments before credential verification', async () => {
    const validate = vi.fn(async () => {});
    await expect(
      savePlaidCredentials(db, 'environment-owner', sandbox, validate),
    ).rejects.toMatchObject({ status: 403 });
    for (const environment of ['development', 'https://attacker.invalid', undefined])
      await expect(
        savePlaidCredentials(db, 'environment-owner', { ...credentials, environment }, validate),
      ).rejects.toThrow();
    expect(validate).not.toHaveBeenCalled();
    expect((await plaidConfiguration(db, 'environment-owner')).configured).toBe(false);
    await expect(
      savePlaidCredentials(db, 'environment-owner', credentials, validate),
    ).resolves.toMatchObject({ environment: 'production' });
    expect(validate).toHaveBeenCalledWith(credentials);
  });

  it('preserves saved Sandbox routing and secret rotation without allowing an active environment switch', async () => {
    vi.stubEnv('PLAID_ALLOW_SANDBOX', 'true');
    await savePlaidCredentials(db, 'environment-owner', sandbox, async () => {});
    await db.query(
      'INSERT INTO connections(id,owner_id,item_id,institution_id,institution_name,encrypted_token,product,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        'old-sandbox',
        'environment-owner',
        'sandbox-item',
        'sandbox-institution',
        'Sandbox',
        encryptToken('sandbox-token'),
        'transactions',
        'healthy',
      ],
    );
    vi.stubEnv('PLAID_ALLOW_SANDBOX', undefined);
    expect(await plaidConfiguration(db, 'environment-owner')).toMatchObject({
      environment: 'sandbox',
      supportedEnvironments: ['production', 'sandbox'],
    });
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      calls.push(String(url));
      return new Response('{}', { status: 200 });
    });
    await (await userPlaidProvider(db, 'environment-owner')).call('/institutions/get', {});
    expect((await userPlaidProvider(db, 'environment-owner')).environment).toBe('sandbox');
    expect(calls).toEqual(['https://sandbox.plaid.com/institutions/get']);
    await expect(
      savePlaidCredentials(
        db,
        'environment-owner',
        { ...sandbox, secret: 'rotated-sandbox-secret' },
        async () => {},
      ),
    ).resolves.toMatchObject({ environment: 'sandbox' });
    await expect(
      savePlaidCredentials(
        db,
        'environment-owner',
        { ...sandbox, clientId: 'another-client-id' },
        async () => {},
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      savePlaidCredentials(db, 'environment-owner', credentials, async () => {}),
    ).rejects.toMatchObject({ status: 409 });
    expect((await plaidConfiguration(db, 'environment-owner')).environment).toBe('sandbox');
    await db.query("UPDATE connections SET status='disconnected' WHERE id='old-sandbox'");
    await savePlaidCredentials(db, 'environment-owner', credentials, async () => {});
    expect(await plaidConfiguration(db, 'environment-owner')).toMatchObject({
      environment: 'production',
      supportedEnvironments: ['production'],
    });
    await (await userPlaidProvider(db, 'environment-owner')).call('/institutions/get', {});
    expect((await userPlaidProvider(db, 'environment-owner')).environment).toBe('production');
    expect(calls.at(-1)).toBe('https://production.plaid.com/institutions/get');
    expect(
      (await db.query("SELECT * FROM connections WHERE id='old-sandbox'")).rows[0],
    ).toMatchObject({ item_id: 'sandbox-item', status: 'disconnected' });
  });
});
