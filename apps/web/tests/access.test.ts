import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { createApp } from '../server/app';
import { openDatabase, type Database } from '../server/db';
import { tokenHash } from '../server/auth';
import { allowedCloudEmails, assertCloudEmail, ownerCanAccess } from '../server/access';
import { challengeFor, googleWorkspace } from '../server/google';
import { enqueueStaleSyncs, enqueueSync, enqueueWebhook, processJob } from '../server/plaid';
import { notificationWorker } from '../server/notifications';
import { processVenmoEmail } from '../server/venmo';

describe('private cloud access', () => {
  let db: Database, server: Server, base: string;
  const owner = { id: 'owner-subject', email: 'owner@example.com' };
  const other = { id: 'other-subject', email: 'other@example.com' };
  let currentIdentity = owner;
  let ownerID: string, otherID: string;
  const provider = {
    configured: true,
    authorize: (_challenge: string, _redirect: string, state: string) =>
      `https://example.com/?state=${state}`,
    exchange: async () => currentIdentity,
  };
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', 'x-asset-client': 'web', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  async function login(native = false) {
    const verifier = 'a'.repeat(43);
    const start = await request(
      '/auth/google/start',
      native ? { challenge: challengeFor(verifier) } : {},
      native ? { 'x-asset-client': 'ios' } : {},
    );
    const state = new URL((await start.json()).url).searchParams.get('state');
    const callback = await request(
      `/auth/callback/google?state=${state}&code=verified`,
      undefined,
      { cookie: start.headers.get('set-cookie')?.split(';')[0] ?? '' },
    );
    return { callback, verifier };
  }
  beforeAll(async () => {
    db = await openDatabase(':memory:');
    server = createApp(db, undefined, provider).listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  }, 30000);
  beforeEach(async () => {
    vi.stubEnv('ASSET_ALLOWED_EMAILS', undefined);
    await db.query('DELETE FROM users');
    ownerID = await googleWorkspace(db, owner);
    otherID = await googleWorkspace(db, other);
    currentIdentity = owner;
    vi.stubEnv('ASSET_ALLOWED_EMAILS', owner.email);
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  });
  it('admits only exact verified Google emails and fails closed on empty or invalid configuration', async () => {
    vi.stubEnv('ASSET_ALLOWED_EMAILS', ' OWNER@example.com , owner@example.com ');
    expect(allowedCloudEmails()).toEqual([owner.email]);
    expect(await ownerCanAccess(db, ownerID)).toBe(true);
    for (const email of ['owner+alias@example.com', 'owner@example.com.evil', 'other@example.com'])
      expect(() => assertCloudEmail(email)).toThrow('limited');
    await db.query('INSERT INTO users(id,email) VALUES($1,$2)', ['legacy', 'legacy@example.com']);
    vi.stubEnv('ASSET_ALLOWED_EMAILS', 'legacy@example.com');
    expect(await ownerCanAccess(db, 'legacy')).toBe(false);
    vi.stubEnv('ASSET_ALLOWED_EMAILS', '');
    expect(await ownerCanAccess(db, ownerID)).toBe(false);
    vi.stubEnv('ASSET_ALLOWED_EMAILS', '*@example.com');
    expect(() => allowedCloudEmails()).toThrow('exact email');
  });
  it('allows owner browser login and rejects another Google identity before creating records', async () => {
    const allowed = await login();
    expect(allowed.callback.headers.get('location')).toBe('/');
    const cookie = allowed.callback.headers.get('set-cookie')!.split(';')[0];
    expect((await request('/state', undefined, { cookie })).status).toBe(200);
    currentIdentity = { id: 'new-subject', email: 'new@example.com' };
    const denied = await login();
    expect(denied.callback.headers.get('location')).toBe('/?auth_error=access_restricted');
    expect(denied.callback.headers.get('set-cookie')).not.toContain('asset_session=');
    expect((await db.query('SELECT id FROM users')).rows).toHaveLength(2);
    expect((await db.query('SELECT owner_id FROM workspaces')).rows).toHaveLength(2);
  });
  it('rejects disallowed native callbacks and pending codes after a policy change', async () => {
    currentIdentity = other;
    expect((await login(true)).callback.headers.get('location')).toBe(
      'org.gtfol.asset://auth/callback?error=access_restricted',
    );
    expect((await db.query('SELECT id FROM oauth_codes')).rows).toHaveLength(0);
    currentIdentity = owner;
    const { callback, verifier } = await login(true);
    const code = new URL(callback.headers.get('location')!).searchParams.get('code');
    vi.stubEnv('ASSET_ALLOWED_EMAILS', other.email);
    const denied = await request(
      '/auth/google/exchange',
      { code, verifier },
      { 'x-asset-client': 'ios' },
    );
    expect(denied.status).toBe(403);
    expect((await denied.json()).code).toBe('ACCESS_RESTRICTED');
    expect((await db.query('SELECT owner_id FROM sessions')).rows).toHaveLength(0);
  });
  it('blocks old cookie and bearer sessions without deleting stored workspaces', async () => {
    for (const id of [ownerID, otherID])
      await db.query(
        "INSERT INTO sessions(token_hash,owner_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
        [tokenHash(id), id],
      );
    const sessions: Record<string, string>[] = [
      { cookie: `asset_session=${otherID}` },
      { authorization: `Bearer ${otherID}` },
    ];
    for (const headers of sessions) {
      const denied = await request('/state', undefined, headers);
      expect(denied.status).toBe(403);
      expect((await denied.json()).code).toBe('ACCESS_RESTRICTED');
      expect(
        (await request('/command', { type: 'account.create', payload: {} }, headers)).status,
      ).toBe(403);
    }
    expect(
      (await request('/state', undefined, { authorization: `Bearer ${ownerID}` })).status,
    ).toBe(200);
    expect((await db.query('SELECT owner_id FROM workspaces')).rows).toHaveLength(2);
  });
  it('disables hosted demo creation even without an allowlist', async () => {
    expect((await request('/auth/demo', {})).status).toBe(410);
    vi.stubEnv('ASSET_ALLOWED_EMAILS', undefined);
    vi.stubEnv('NODE_ENV', 'production');
    expect((await request('/auth/demo', {})).status).toBe(410);
    expect((await db.query('SELECT id FROM users')).rows).toHaveLength(2);
  });
  it('leaves disallowed Plaid jobs unclaimed and ignores their webhook updates', async () => {
    await db.query(
      `INSERT INTO connections(id,owner_id,item_id,institution_id,institution_name,encrypted_token,product,status)
      VALUES('blocked',$1,'blocked-item','bank','Bank','unused','transactions','healthy')`,
      [otherID],
    );
    await enqueueStaleSyncs(db);
    expect((await db.query('SELECT * FROM sync_jobs')).rows).toHaveLength(0);
    await enqueueSync(db, 'blocked');
    const factory = vi.fn();
    expect(await processJob(db, factory)).toBe(false);
    expect(factory).not.toHaveBeenCalled();
    await enqueueWebhook(
      db,
      Buffer.from(
        JSON.stringify({
          item_id: 'blocked-item',
          webhook_code: 'ERROR',
          error: { error_code: 'ITEM_LOGIN_REQUIRED' },
        }),
      ),
    );
    expect(
      (await db.query("SELECT status FROM connections WHERE id='blocked'")).rows[0].status,
    ).toBe('healthy');
    expect((await db.query('SELECT attempts FROM sync_jobs')).rows[0].attempts).toBe(0);
    // The same queued job becomes eligible when its owner is allowed again.
    vi.stubEnv('ASSET_ALLOWED_EMAILS', other.email);
    factory.mockRejectedValue(Error('synthetic provider unavailable'));
    expect(await processJob(db, factory)).toBe(true);
    expect(factory).toHaveBeenCalledWith(otherID);
  });
  it('skips disallowed receipt processing and notification schedules', async () => {
    await processVenmoEmail(db, { owner_id: otherID } as any, {} as any);
    expect((await db.query('SELECT id FROM venmo_receipts')).rows).toHaveLength(0);
    await notificationWorker(db, Date.now() + 15000);
    expect((await db.query('SELECT owner_id FROM notification_schedule')).rows).toEqual([
      { owner_id: ownerID },
    ]);
  });
});
