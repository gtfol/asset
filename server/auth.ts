import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Request, Response, NextFunction } from 'express';
import type { Database } from './db';
const scrypt = promisify(scryptCallback);
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return salt + ':' + key.toString('hex');
}
export async function passwordMatches(password: string, hash: string) {
  const [salt, expected] = hash.split(':');
  if (!salt || !expected) return false;
  const got = (await scrypt(password, salt, 64)) as Buffer;
  const actual = Buffer.from(expected, 'hex');
  return got.length === actual.length && timingSafeEqual(got, actual);
}
export async function newSession(db: Database, owner: string, res: Response) {
  const token = randomBytes(32).toString('base64url');
  await db.query(
    "INSERT INTO sessions(token_hash,owner_id,expires_at) VALUES($1,$2,now()+interval '14 days')",
    [tokenHash(token), owner],
  );
  res.cookie('asset_session', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 14 * 86400000,
  });
  return token;
}
export function readToken(req: Request) {
  const bearer = req.headers.authorization?.replace(/^Bearer /, '');
  const cookie = req.headers.cookie
    ?.split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('asset_session='))
    ?.slice(14);
  return bearer ?? cookie;
}
export function authenticated(db: Database) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = readToken(req);
    if (!token) {
      res.status(401).json({ error: 'Sign in to continue' });
      return;
    }
    const row = await db.query<{ owner_id: string }>(
      'SELECT owner_id FROM sessions WHERE token_hash=$1 AND expires_at>now()',
      [tokenHash(token)],
    );
    if (!row.rows[0]) {
      res.status(401).json({ error: 'Session expired. Sign in again.' });
      return;
    }
    res.locals.owner = row.rows[0].owner_id;
    next();
  };
}
