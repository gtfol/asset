import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import type { Server } from 'node:http';
import { createApp } from '../server/app';
import { openDatabase, type Database } from '../server/db';
import {
  challengeFor,
  googleWorkspace,
  GoogleOAuth,
  verifyGoogleIdentity,
  type GoogleProvider,
} from '../server/google';

describe('Google sign-in', () => {
  let db: Database, server: Server, base: string;
  const identity = { id: '5c04ca4c-a637-4a58-a029-f4fcdb2f282d', email: 'google@example.invalid' };
  const exchange = vi.fn(async () => identity);
  const provider: GoogleProvider = {
    configured: true,
    exchange,
    authorize: (challenge, redirect, state) =>
      `https://auth.example/authorize?${new URLSearchParams({ challenge, redirect, state })}`,
  };
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', 'x-asset-client': 'web', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  async function start(native = false) {
    const verifier = 'v'.repeat(43);
    const response = await request(
      '/auth/google/start',
      native ? { challenge: challengeFor(verifier) } : {},
      native ? { 'x-asset-client': 'ios' } : {},
    );
    expect(response.status).toBe(200);
    const authorization = new URL((await response.json()).url);
    const callback = new URL(authorization.searchParams.get('redirect')!);
    callback.searchParams.set('code', 'google-authorization-code');
    callback.searchParams.set('state', authorization.searchParams.get('state')!);
    return {
      path: callback.pathname.replace('/api', '') + callback.search,
      cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '',
      verifier,
    };
  }
  beforeAll(async () => {
    db = await openDatabase(':memory:');
    server = createApp(db, undefined, provider).listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  }, 30000);
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it('removes email/password endpoints on the server', async () => {
    expect((await request('/auth/login', {})).status).toBe(410);
    expect((await request('/auth/register', {})).status).toBe(410);
  });
  it('rejects a callback without the browser state cookie and prevents replay', async () => {
    const flow = await start();
    const rejected = await request(flow.path);
    expect(rejected.headers.get('location')).toContain('auth_error');
    const completed = await request(flow.path, undefined, { cookie: flow.cookie });
    expect(completed.headers.get('location')).toBe('/');
    expect(completed.headers.get('set-cookie')).toContain('HttpOnly');
    expect(completed.headers.get('set-cookie')).toContain('SameSite=Strict');
    const cookie = completed.headers.get('set-cookie')!.split(';')[0];
    const state = await request('/state', undefined, { cookie });
    expect(state.status).toBe(200);
    expect((await state.json()).state.settings.demo).toBe(false);
    expect(
      (await request(flow.path, undefined, { cookie: flow.cookie })).headers.get('location'),
    ).toContain('auth_error');
  });
  it('requires native PKCE proof and accepts a one-time code only once', async () => {
    const flow = await start(true);
    const completed = await request(flow.path);
    const redirect = new URL(completed.headers.get('location')!);
    expect(redirect.protocol).toBe('org.gtfol.asset:');
    expect(redirect.searchParams.has('token')).toBe(false);
    const code = redirect.searchParams.get('code');
    const native = { 'x-asset-client': 'ios' };
    expect(
      (await request('/auth/google/exchange', { code, verifier: 'x'.repeat(43) }, native)).status,
    ).toBe(401);
    const session = await request(
      '/auth/google/exchange',
      { code, verifier: flow.verifier },
      native,
    );
    expect(session.status).toBe(200);
    const token = (await session.json()).token;
    expect((await request('/state', undefined, { authorization: `Bearer ${token}` })).status).toBe(
      200,
    );
    expect(
      (await request('/auth/google/exchange', { code, verifier: flow.verifier }, native)).status,
    ).toBe(401);
    await request('/auth/logout', {}, { authorization: `Bearer ${token}` });
    expect((await request('/state', undefined, { authorization: `Bearer ${token}` })).status).toBe(
      401,
    );
  });
  it('rejects expired flows and handles OAuth denial without an open redirect', async () => {
    const flow = await start();
    await db.query("UPDATE oauth_flows SET expires_at=now()-interval '1 second'");
    expect(
      (await request(flow.path, undefined, { cookie: flow.cookie })).headers.get('location'),
    ).toBe('/?auth_error=google_sign_in_failed');
    const denied = await start();
    const response = await request(
      denied.path + '&error=access_denied&next=https://evil.example',
      undefined,
      { cookie: denied.cookie },
    );
    expect(response.headers.get('location')).toBe('/?auth_error=google_sign_in_failed');
  });
  it('keys workspaces by verified subject and does not claim another account by email', async () => {
    const owner = await googleWorkspace(db, identity);
    expect(await googleWorkspace(db, { ...identity, email: 'changed@example.invalid' })).toBe(
      owner,
    );
    await expect(googleWorkspace(db, { ...identity, id: 'different-subject' })).rejects.toThrow(
      'migration',
    );
    await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
      'legacy',
      'legacy@example.invalid',
      'old-hash',
    ]);
    await expect(
      googleWorkspace(db, { ...identity, email: 'legacy@example.invalid', id: 'new-subject' }),
    ).rejects.toThrow('migration');
    expect(
      (await db.query('SELECT * FROM users WHERE google_subject=$1', [identity.id])).rows,
    ).toHaveLength(1);
  });
  it('validates Google signature, issuer, audience, expiry, email and nonce', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const keys = createLocalJWKSet({
      keys: [{ ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' }],
    });
    async function token(overrides: Record<string, unknown> = {}) {
      return new SignJWT({
        sub: 'google-user-id',
        email: identity.email,
        email_verified: true,
        nonce: 'expected-nonce',
        iss: 'https://accounts.google.com',
        aud: 'client-id',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
        ...overrides,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test' })
        .sign(privateKey);
    }
    expect(await verifyGoogleIdentity(await token(), 'client-id', 'expected-nonce', keys)).toEqual({
      id: 'google-user-id',
      email: identity.email,
    });
    for (const invalid of [
      { iss: 'https://evil.example' },
      { aud: 'other-client' },
      { nonce: 'other-flow' },
      { email_verified: false },
      { azp: 'other-client' },
      { exp: 1 },
      { iat: 1 },
      { sub: undefined },
    ]) {
      await expect(
        verifyGoogleIdentity(await token(invalid), 'client-id', 'expected-nonce', keys),
      ).rejects.toThrow();
    }
    const forged = await token();
    await expect(
      verifyGoogleIdentity(forged.slice(0, -8) + 'tampered', 'client-id', 'expected-nonce', keys),
    ).rejects.toThrow();
  });
  it('uses the Asset callback directly and rejects a failed Google code exchange', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'client-id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-secret');
    const google = new GoogleOAuth();
    const redirect = 'https://asset.gtfol.dev/api/auth/callback/google';
    const url = new URL(google.authorize('challenge', redirect, 'state'));
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('redirect_uri')).toBe(redirect);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('state');
    expect(url.searchParams.has('client_secret')).toBe(false);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 401 })),
    );
    await expect(google.exchange('expired', 'verifier', redirect)).rejects.toThrow('completed');
  });
});
