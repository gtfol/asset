import { Router } from 'express';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { emptyState } from '../shared/core.js';
import { createDemo } from '../shared/demo.js';
import { newSession, tokenHash } from './auth.js';
import type { Database } from './db.js';
import { publicOrigin } from './hosting.js';

export interface GoogleIdentity {
  id: string;
  email: string;
}
export interface GoogleProvider {
  configured: boolean;
  authorize(challenge: string, redirect: string, state: string): string;
  exchange(code: string, verifier: string, redirect: string): Promise<GoogleIdentity>;
}
export const challengeFor = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url');
const secret = () => randomBytes(32).toString('base64url');
const failure = (message: string, status = 401) => Object.assign(Error(message), { status });

const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
export async function verifyGoogleIdentity(
  token: string,
  clientID: string,
  nonce: string,
  keys: JWTVerifyGetKey = googleKeys,
): Promise<GoogleIdentity> {
  const { payload } = await jwtVerify(token, keys, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: clientID,
    algorithms: ['RS256'],
    requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
    maxTokenAge: '5 minutes',
    clockTolerance: 5,
  });
  if (
    payload.nonce !== nonce ||
    payload.email_verified !== true ||
    (payload.azp && payload.azp !== clientID)
  )
    throw failure('Google sign-in could not be verified');
  return {
    id: z.string().min(1).max(255).parse(payload.sub),
    email: z.email().parse(payload.email),
  };
}

export class GoogleOAuth implements GoogleProvider {
  private clientID = process.env.GOOGLE_CLIENT_ID ?? '';
  private clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? '';
  get configured() {
    return !!(this.clientID && this.clientSecret);
  }
  authorize(challenge: string, redirect: string, state: string) {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: this.clientID,
      redirect_uri: redirect,
      response_type: 'code',
      prompt: 'select_account',
      scope: 'openid email profile',
      state,
      nonce: challenge,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }
  async exchange(code: string, verifier: string, redirect: string): Promise<GoogleIdentity> {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        code_verifier: verifier,
        redirect_uri: redirect,
        grant_type: 'authorization_code',
        client_id: this.clientID,
        client_secret: this.clientSecret,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw failure('Google sign-in could not be completed. Please try again.');
    const session = await response.json();
    if (typeof session.id_token !== 'string') throw failure('Invalid sign-in response');
    return verifyGoogleIdentity(session.id_token, this.clientID, challengeFor(verifier));
  }
}

export async function googleWorkspace(db: Database, identity: GoogleIdentity) {
  return db.transaction(async (tx) => {
    const existing = (await tx.query('SELECT id FROM users WHERE google_subject=$1', [identity.id]))
      .rows[0];
    if (existing) return existing.id as string;
    const state = emptyState();
    state.categories = createDemo().categories;
    const id = randomUUID();
    // Email collisions with legacy accounts must not transfer ownership of financial data.
    const created = await tx.query(
      'INSERT INTO users(id,email,google_subject) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id',
      [id, identity.email.toLowerCase(), identity.id],
    );
    if (!created.rows[0]) {
      const sameIdentity = (
        await tx.query('SELECT id FROM users WHERE google_subject=$1', [identity.id])
      ).rows[0];
      if (sameIdentity) return sameIdentity.id as string;
      throw failure('An existing workspace needs account migration. Contact team@gtfol.dev.', 409);
    }
    await tx.query('INSERT INTO workspaces(owner_id,state) VALUES($1,$2)', [
      id,
      JSON.stringify(state),
    ]);
    return id;
  });
}

export function googleRoutes(db: Database, provider: GoogleProvider) {
  const router = Router();
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production' || process.env.VERCEL === '1',
    path: '/api/auth',
  };
  router.get('/config', (_req, res) => res.json({ google: provider.configured }));
  router.post('/google/start', async (req, res) => {
    if (!provider.configured) throw failure('Google sign-in is not configured yet.', 503);
    const client = req.header('x-asset-client') === 'ios' ? 'ios' : 'web';
    const challenge =
      client === 'ios'
        ? z
            .string()
            .regex(/^[A-Za-z0-9_-]{43}$/)
            .parse(req.body.challenge)
        : null;
    const flow = secret(),
      verifier = secret();
    const redirect = new URL('/api/auth/callback/google', publicOrigin(req)).toString();
    await db.transaction(async (tx) => {
      await tx.query('DELETE FROM oauth_flows WHERE expires_at<now()');
      await tx.query('DELETE FROM oauth_codes WHERE expires_at<now()');
      await tx.query(
        "INSERT INTO oauth_flows(id,verifier,client,native_challenge,redirect_uri,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')",
        [tokenHash(flow), verifier, client, challenge, redirect],
      );
    });
    if (client === 'web') res.cookie('asset_oauth', flow, { ...cookieOptions, maxAge: 600000 });
    res.json({ url: provider.authorize(challengeFor(verifier), redirect, flow) });
  });
  router.get('/callback/google', async (req, res) => {
    const flow = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const cookie = req.headers.cookie
      ?.split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('asset_oauth='))
      ?.slice(12);
    let client = 'web';
    try {
      const stored = (await db.query('SELECT * FROM oauth_flows WHERE id=$1', [tokenHash(flow)]))
        .rows[0];
      if (!stored || (stored.client === 'web' && cookie !== flow))
        throw failure('Invalid sign-in state');
      client = stored.client;
      const consumed = (
        await db.query('DELETE FROM oauth_flows WHERE id=$1 AND expires_at>now() RETURNING id', [
          tokenHash(flow),
        ])
      ).rows[0];
      if (!consumed || !code || req.query.error) throw failure('Sign-in was not completed');
      const identity = await provider.exchange(code, stored.verifier, stored.redirect_uri);
      const owner = await googleWorkspace(db, identity);
      if (client === 'ios') {
        const exchange = secret();
        await db.query(
          "INSERT INTO oauth_codes(id,owner_id,challenge,expires_at) VALUES($1,$2,$3,now()+interval '1 minute')",
          [tokenHash(exchange), owner, stored.native_challenge],
        );
        res.redirect(303, `org.gtfol.asset://auth/callback?code=${encodeURIComponent(exchange)}`);
      } else {
        await newSession(db, owner, res);
        res.clearCookie('asset_oauth', cookieOptions);
        res.redirect(303, '/');
      }
    } catch {
      res.clearCookie('asset_oauth', cookieOptions);
      res.redirect(
        303,
        client === 'ios'
          ? 'org.gtfol.asset://auth/callback?error=auth_failed'
          : '/?auth_error=google_sign_in_failed',
      );
    }
  });
  router.post('/google/exchange', async (req, res) => {
    if (req.header('x-asset-client') !== 'ios') throw failure('Native sign-in required');
    const { code, verifier } = z
      .object({
        code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        verifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
      })
      .parse(req.body);
    const row = (
      await db.query(
        'DELETE FROM oauth_codes WHERE id=$1 AND challenge=$2 AND expires_at>now() RETURNING owner_id',
        [tokenHash(code), challengeFor(verifier)],
      )
    ).rows[0];
    if (!row) throw failure('Sign-in expired. Please try again.');
    res.json({ token: await newSession(db, row.owner_id, res) });
  });
  return router;
}
