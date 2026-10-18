import { Router, type Request, type Response, type NextFunction } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Database } from './db.js';
import { readToken, tokenHash } from './auth.js';
import { encryptToken, decryptToken } from './plaid.js';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes: Buffer) {
  let bits = 0,
    value = 0,
    result = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(value >>> bits) & 31];
    }
  }
  return result + (bits ? alphabet[(value << (5 - bits)) & 31] : '');
}
export function totp(secret: string, step: number) {
  let bits = 0,
    value = 0;
  const bytes: number[] = [];
  for (const c of secret) {
    const n = alphabet.indexOf(c);
    if (n < 0) throw Error('Invalid authenticator key');
    value = (value << 5) | n;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = digest[19] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}
const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export async function verificationStatus(db: Database, owner: string, token: string) {
  const rows = await db.query<{ enabled: boolean; verified: boolean }>(
    `SELECT a.enabled, s.verified_at IS NOT NULL AS verified FROM account_security a
     JOIN sessions s ON s.owner_id=a.owner_id WHERE a.owner_id=$1 AND s.token_hash=$2`,
    [owner, tokenHash(token)],
  );
  return { enabled: rows.rows[0]?.enabled ?? false, verified: rows.rows[0]?.verified ?? false };
}
export function verificationGate(db: Database) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const status = await verificationStatus(db, res.locals.owner, readToken(req) ?? '');
    if (status.enabled && !status.verified) {
      res
        .status(403)
        .json({
          error: 'Enter your authenticator code to unlock this device.',
          code: 'DEVICE_VERIFICATION_REQUIRED',
        });
      return;
    }
    next();
  };
}
export function securityRoutes(db: Database) {
  const router = Router();
  router.get('/status', async (req, res) =>
    res.json(await verificationStatus(db, res.locals.owner, readToken(req) ?? '')),
  );
  router.post('/enroll', async (req, res) => {
    const owner = res.locals.owner;
    const secret = base32(randomBytes(20)),
      recovery = randomBytes(16).toString('hex');
    const encrypted = encryptToken(secret);
    const result = await db.query(
      `INSERT INTO account_security(owner_id,encrypted_secret,recovery_hash,setup_expires_at)
       SELECT id,$2,$3,now()+interval '10 minutes' FROM users WHERE id=$1 AND demo=false
       ON CONFLICT(owner_id) DO UPDATE SET encrypted_secret=$2,recovery_hash=$3,setup_expires_at=now()+interval '10 minutes'
       WHERE account_security.enabled=false AND account_security.setup_expires_at<now() RETURNING owner_id`,
      [owner, encrypted, tokenHash(recovery)],
    );
    if (!result.rows.length) {
      res
        .status(409)
        .json({
          error:
            'Authenticator already set up, or a setup is in progress. Keep its key or retry after ten minutes.',
        });
      return;
    }
    res.json({
      secret,
      recovery,
      uri: `otpauth://totp/Asset?secret=${secret}&issuer=Asset&digits=6&period=30`,
    });
  });
  router.post('/verify', async (req, res) => {
    const { code } = z.object({ code: z.string().trim().min(6).max(32) }).parse(req.body);
    const result = await db.transaction(async (tx) => {
      const a = (
        await tx.query(
          `SELECT *, setup_expires_at>now() AS setup_valid,
        attempt_window>now()-interval '5 minutes' AS in_window FROM account_security WHERE owner_id=$1 FOR UPDATE`,
          [res.locals.owner],
        )
      ).rows[0];
      if (!a || (!a.enabled && !a.setup_valid)) return false;
      const attempts = a.in_window ? a.attempts : 0;
      if (attempts >= 5) return false;
      const step = Math.floor(Date.now() / 30000);
      const secret = decryptToken(a.encrypted_secret);
      const matched = [step - 1, step, step + 1].find(
        (n) => n > Number(a.last_step) && same(totp(secret, n), code),
      );
      const recovered = a.enabled && a.recovery_hash && same(tokenHash(code), a.recovery_hash);
      if (matched === undefined && !recovered) {
        await tx.query(
          `UPDATE account_security SET attempts=$2,attempt_window=CASE WHEN $3 THEN attempt_window ELSE now() END WHERE owner_id=$1`,
          [res.locals.owner, attempts + 1, a.in_window],
        );
        return false;
      }
      await tx.query(
        `UPDATE account_security SET enabled=true,last_step=$2,attempts=0,
        recovery_hash=CASE WHEN $3 THEN '' ELSE recovery_hash END WHERE owner_id=$1`,
        [res.locals.owner, matched ?? Number(a.last_step), !!recovered],
      );
      await tx.query('UPDATE sessions SET verified_at=now() WHERE token_hash=$1 AND owner_id=$2', [
        tokenHash(readToken(req) ?? ''),
        res.locals.owner,
      ]);
      return true;
    });
    res
      .status(result ? 200 : 400)
      .json(
        result
          ? { verified: true }
          : {
              error: 'Code not accepted. Use a fresh code; after five attempts, wait five minutes.',
            },
      );
  });
  router.post('/recovery', async (req, res) => {
    const status = await verificationStatus(db, res.locals.owner, readToken(req) ?? '');
    if (!status.verified) {
      res.status(403).json({ error: 'Verify this device first' });
      return;
    }
    const recovery = randomBytes(16).toString('hex');
    await db.query('UPDATE account_security SET recovery_hash=$2 WHERE owner_id=$1', [
      res.locals.owner,
      tokenHash(recovery),
    ]);
    res.json({ recovery });
  });
  return router;
}
