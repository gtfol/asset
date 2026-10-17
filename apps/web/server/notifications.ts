import { Router } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { connect } from 'node:http2';
import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';
import { dailySpendingNotification, notificationPreferences, type State } from '../shared/core.js';
import { getState, mutateState, type Database, type SQL } from './db.js';
import { readToken, tokenHash } from './auth.js';

export const pushConfigured = () =>
  !!(process.env.APNS_KEY_ID && process.env.APPLE_TEAM_ID && process.env.APNS_PRIVATE_KEY);
export async function enqueueNotifications(tx: SQL, owner: string, before: State, next: State) {
  const seen = new Set((before.notifications?.items ?? []).map((n) => n.id));
  for (const n of next.notifications?.items ?? []) {
    if (seen.has(n.id)) continue;
    await tx.query(
      `INSERT INTO notification_deliveries(id,owner_id,device_id,notification_id,kind)
      SELECT $1 || ':' || id,$2,id,$3,$4 FROM notification_devices WHERE owner_id=$2
      ON CONFLICT(device_id,notification_id) DO NOTHING`,
      [randomUUID(), owner, n.id, n.kind],
    );
  }
}

export function notificationRoutes(db: Database) {
  const router = Router();
  router.get('/status', (_req, res) => res.json({ pushAvailable: pushConfigured() }));
  router.post('/devices', async (req, res) => {
    if (!pushConfigured()) {
      res
        .status(503)
        .json({
          error: 'iPhone push delivery is not configured yet. Alerts are available inside Asset.',
        });
      return;
    }
    const { state } = await getState(db, res.locals.owner);
    if (state.settings.demo) throw Error('Demo workspaces cannot register for push notifications');
    const input = z
      .object({
        token: z.string().regex(/^[a-f0-9]{64,512}$/),
        environment: z.enum(['sandbox', 'production']),
      })
      .parse(req.body);
    const session = tokenHash(readToken(req) ?? '');
    await db.transaction(async (tx) => {
      await tx.query('DELETE FROM notification_devices WHERE session_hash=$1 AND token<>$2', [
        session,
        input.token,
      ]);
      await tx.query(
        `INSERT INTO notification_devices(id,owner_id,session_hash,token,environment) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(token) DO UPDATE SET owner_id=excluded.owner_id,session_hash=excluded.session_hash,environment=excluded.environment,updated_at=now()`,
        [randomUUID(), res.locals.owner, session, input.token, input.environment],
      );
    });
    res.json({ ok: true });
  });
  router.delete('/devices', async (req, res) => {
    await db.query('DELETE FROM notification_devices WHERE owner_id=$1 AND session_hash=$2', [
      res.locals.owner,
      tokenHash(readToken(req) ?? ''),
    ]);
    res.json({ ok: true });
  });
  return router;
}

export type PushSender = (token: string, environment: string, id: string) => Promise<number>;
export function applePushSender(): PushSender {
  let authorization: Promise<string> | undefined;
  return async (token, environment, id) => {
    authorization ??= (async () => {
      const key = await importPKCS8(process.env.APNS_PRIVATE_KEY!.replace(/\\n/g, '\n'), 'ES256');
      return new SignJWT({})
        .setProtectedHeader({ alg: 'ES256', kid: process.env.APNS_KEY_ID! })
        .setIssuer(process.env.APPLE_TEAM_ID!)
        .setIssuedAt()
        .sign(key);
    })();
    const jwt = await authorization;
    return new Promise((resolve, reject) => {
      const client = connect(
        environment === 'production'
          ? 'https://api.push.apple.com'
          : 'https://api.sandbox.push.apple.com',
      );
      const timer = setTimeout(() => finish(Error('Push timeout')), 5000);
      let complete = false;
      const finish = (error?: Error, status = 500) => {
        if (complete) return;
        complete = true;
        clearTimeout(timer);
        client.destroy();
        error ? reject(error) : resolve(status);
      };
      client.on('error', finish);
      const request = client.request({
        ':method': 'POST',
        ':path': `/3/device/${token}`,
        authorization: `bearer ${jwt}`,
        'apns-topic': 'org.gtfol.asset',
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600),
        'apns-collapse-id': createHash('sha256').update(id).digest('hex'),
      });
      request.on('error', finish);
      request.on('response', (headers) => finish(undefined, Number(headers[':status'])));
      // Never expose amounts, merchants or account details on the lock screen.
      request.end(
        JSON.stringify({
          aps: {
            alert: { title: 'Asset', body: 'New financial activity. Unlock Asset to review.' },
            sound: 'default',
          },
        }),
      );
    });
  };
}

export async function notificationWorker(db: Database, deadline: number, sender?: PushSender) {
  const schedules = (
    await db.query<{ owner_id: string }>(`SELECT w.owner_id FROM workspaces w
    LEFT JOIN notification_schedule n ON n.owner_id=w.owner_id
    WHERE COALESCE((w.state->'settings'->>'demo')::boolean,false)=false
      AND (n.checked_at IS NULL OR n.checked_at < now() - interval '15 minutes')
    ORDER BY n.checked_at NULLS FIRST LIMIT 50`)
  ).rows;
  for (const { owner_id } of schedules) {
    if (Date.now() > deadline - 6000) break;
    const { state } = await getState(db, owner_id);
    if (dailySpendingNotification(state) !== state)
      await mutateState(db, owner_id, (s) => dailySpendingNotification(s));
    await db.query(
      'INSERT INTO notification_schedule(owner_id) VALUES($1) ON CONFLICT(owner_id) DO UPDATE SET checked_at=now()',
      [owner_id],
    );
  }
  if (!sender && !pushConfigured()) return 0;
  sender ??= applePushSender();
  let delivered = 0;
  while (Date.now() < deadline - 6000 && delivered < 20) {
    const job = await db.transaction(async (tx) => {
      const row = (
        await tx.query<any>(`SELECT n.*,d.token,d.environment FROM notification_deliveries n
        JOIN notification_devices d ON d.id=n.device_id AND d.owner_id=n.owner_id
        JOIN sessions s ON s.token_hash=d.session_hash AND s.expires_at>now()
        WHERE n.status='pending' AND n.available_at<=now() AND n.attempts<5
        ORDER BY n.created_at LIMIT 1 FOR UPDATE OF n SKIP LOCKED`)
      ).rows[0];
      if (row)
        await tx.query(
          "UPDATE notification_deliveries SET attempts=attempts+1,available_at=now()+interval '2 minutes' WHERE id=$1",
          [row.id],
        );
      return row;
    });
    if (!job) break;
    const { state } = await getState(db, job.owner_id);
    const event = state.notifications?.items.find((n) => n.id === job.notification_id);
    if (
      !event ||
      event.read ||
      !notificationPreferences(state)[event.kind] ||
      Date.now() - new Date(event.createdAt).getTime() > 86400000
    ) {
      await db.query("UPDATE notification_deliveries SET status='skipped' WHERE id=$1", [job.id]);
      continue;
    }
    try {
      const status = await sender(job.token, job.environment, job.notification_id);
      // Only APNs' unregistered response proves this device should be removed.
      // A bad request can instead indicate a provider or payload configuration error.
      if (status === 410)
        await db.query('DELETE FROM notification_devices WHERE id=$1', [job.device_id]);
      else if (status === 200) {
        await db.query("UPDATE notification_deliveries SET status='sent' WHERE id=$1", [job.id]);
        delivered++;
      } else if (job.attempts >= 4)
        await db.query("UPDATE notification_deliveries SET status='failed' WHERE id=$1", [job.id]);
    } catch {
      if (job.attempts >= 4)
        await db.query("UPDATE notification_deliveries SET status='failed' WHERE id=$1", [job.id]);
    }
  }
  await db.query(
    "DELETE FROM notification_deliveries WHERE created_at < now() - interval '30 days'",
  );
  return delivered;
}
