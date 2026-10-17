import express from 'express';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Webhook } from 'svix';
import { convert } from 'html-to-text';
import { z } from 'zod';
import { getState, mutateState, type Database, type SQL } from './db.js';
import { decryptToken, encryptToken } from './plaid.js';
import { applyRules, fingerprint, type State, type Transaction } from '../shared/core.js';
import { importedMatch, preserveImportedDetails } from '../shared/account-links.js';
import {
  mailbox,
  parseVenmoReceipt,
  receiptDay,
  venmoBankTransfer,
  venmoReceiptSchema,
  type VenmoReceipt,
} from '../shared/venmo.js';

type Route = {
  id: string;
  owner_id: string;
  account_id: string;
  source_email: string;
  encrypted_token: string;
  active: boolean;
  created_at: string;
};
export interface ReceivedEmail {
  id: string;
  from: string;
  to: string[];
  received_for?: string[];
  subject: string;
  text: string | null;
  html?: string | null;
  headers: Record<string, string>;
  authentication?: { dkim?: string; dmarc?: string } | null;
  message_id: string;
}
export interface ReceivingProvider {
  get(id: string): Promise<ReceivedEmail>;
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const fail = (message: string, status = 400) => Object.assign(Error(message), { status });
function receivingDomain() {
  const domain = (process.env.VENMO_RECEIVING_DOMAIN ?? '').trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(domain) ? domain : '';
}
export function venmoReady() {
  return !!(
    receivingDomain() &&
    process.env.RESEND_API_KEY &&
    process.env.RESEND_WEBHOOK_SECRET &&
    /^[a-f\d]{64}$/i.test(process.env.TOKEN_ENCRYPTION_KEY ?? '')
  );
}
class ResendReceiving implements ReceivingProvider {
  async get(id: string): Promise<ReceivedEmail> {
    const response = await fetch(
      `https://api.resend.com/emails/receiving/${encodeURIComponent(id)}?html_format=cid`,
      {
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
        signal: AbortSignal.timeout(12000),
      },
    );
    if (!response.ok) throw fail('The email service is temporarily unavailable.', 503);
    const reader = response.body?.getReader();
    if (!reader) throw fail('The email service returned an empty response.', 503);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 1_000_000) {
        await reader.cancel();
        throw fail('The email is too large to process.', 413);
      }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
}

async function ownedRoute(db: SQL, id: string, owner: string, lock = false): Promise<Route> {
  const route = (
    await db.query<Route>(
      `SELECT * FROM venmo_routes WHERE id=$1 AND owner_id=$2${lock ? ' FOR UPDATE' : ''}`,
      [id, owner],
    )
  ).rows[0];
  if (!route) throw fail('Venmo connection not found.', 404);
  return route;
}

export function applyVenmoReceipt(
  state: State,
  accountId: string,
  receipt: VenmoReceipt,
  now: string,
  chosenId?: string,
) {
  const account = state.accounts.find((a) => a.id === accountId && a.source === 'venmo');
  if (!account) throw fail('The Venmo account is unavailable.');
  const providerId = `venmo:${receipt.receiptId}`;
  const duplicate = state.transactions.find(
    (t) => t.accountId === accountId && t.providerId === providerId,
  );
  if (duplicate) return { state, status: 'duplicate' as const, transactionId: duplicate.id };
  const transaction: Transaction = {
    id: randomUUID(),
    accountId,
    providerId,
    name: receipt.name,
    date: receipt.date,
    amount: receipt.amount,
    currency: 'USD',
    kind: receipt.kind,
    categoryId: receipt.categoryId ?? 'other',
    notes: receipt.notes,
    excluded: receipt.kind === 'transfer',
    reviewed: false,
    pending: false,
    removed: false,
    source: 'venmo',
    importedAt: now,
    edits: {},
    splits: [],
    raw: {
      name: receipt.kind === 'spending' ? `You paid ${receipt.name}` : `${receipt.name} paid you`,
      venmo_receipt_id: receipt.receiptId,
    },
  };
  if (!state.categories.some((c) => c.id === transaction.categoryId))
    throw fail('Choose an available category.');
  const original = chosenId
    ? state.transactions.find(
        (t) =>
          t.id === chosenId &&
          t.accountId === accountId &&
          !t.removed &&
          !t.providerId &&
          ['csv', 'manual'].includes(t.source) &&
          t.currency === 'USD' &&
          t.date === receipt.date &&
          t.amount === receipt.amount,
      )
    : importedMatch(state.transactions, transaction);
  if (chosenId && !original) throw fail('The selected imported transaction is unavailable.');
  transaction.fingerprint = fingerprint(transaction);
  const value = original
    ? preserveImportedDetails(original, transaction)
    : applyRules(transaction, state);
  if (original)
    state.transactions = state.transactions.map((t) => (t.id === original.id ? value : t));
  else state.transactions.push(value);
  state.transactions = state.transactions.map((t) => venmoBankTransfer(t, state));
  // Receipt amounts do not establish the wallet balance: payments can use an
  // external bank/card. Never invent a running balance from those receipts.
  return {
    state,
    status: original ? ('duplicate' as const) : ('imported' as const),
    transactionId: value.id,
  };
}

export async function processVenmoEmail(
  db: Database,
  route: Route,
  email: ReceivedEmail,
  now = new Date().toISOString(),
) {
  if (
    !email.authentication ||
    email.authentication.dkim !== 'pass' ||
    email.authentication.dmarc === 'fail'
  )
    return;
  const sender = mailbox(email.from);
  const text = (
    email.text ||
    convert(email.html ?? '', { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }] })
  ).slice(0, 100_000);
  const headers = Object.fromEntries(
    Object.entries(email.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const manual = sender === route.source_email && /^(?:fwd?|re):/i.test(email.subject);
  const confirmation =
    sender === 'forwarding-noreply@google.com' &&
    /forwarding confirmation/i.test(email.subject) &&
    text.toLowerCase().includes(route.source_email);
  if (confirmation) {
    const code = text.match(/confirmation code\s*:?\s*(\d{6,12})/i)?.[1];
    if (code)
      await db.query(
        "UPDATE venmo_routes SET verification_code=$1,verification_expires_at=now()+interval '1 hour' WHERE id=$2 AND active=true AND encrypted_token=$3",
        [encryptToken(code), route.id, route.encrypted_token],
      );
    return;
  }
  if (sender !== 'venmo@venmo.com' && !manual) return;
  if (
    !manual &&
    ![...email.to, ...(email.received_for ?? [])].some((a) => mailbox(a) === route.source_email)
  )
    return;
  const { state } = await getState(db, route.owner_id);
  const timeZone = state.settings.timezone ?? 'America/Los_Angeles';
  const parsed = parseVenmoReceipt({
    subject: email.subject,
    text,
    date: manual ? '' : headers.date,
    timeZone,
  });
  const receiptKey = parsed.receipt
    ? `receipt:${parsed.receipt.receiptId}`
    : `message:${hash(email.message_id || email.id)}`;
  let reason =
    parsed.reason ??
    (manual ? 'Confirm the original payment details from this forwarded receipt.' : '');
  const payload = {
    subject: email.subject.slice(0, 300),
    text: text.slice(0, 12000),
    receipt: parsed.receipt,
  };
  const historical =
    !parsed.receipt || parsed.receipt.date < receiptDay(String(route.created_at), timeZone)!;
  await mutateState(
    db,
    route.owner_id,
    async (s, tx) => {
      const current = await ownedRoute(tx, route.id, route.owner_id, true);
      if (!current.active || current.encrypted_token !== route.encrypted_token) return s;
      const inserted = await tx.query<{ id: string }>(
        "INSERT INTO venmo_receipts(id,route_id,email_id,receipt_key,status) VALUES($1,$2,$3,$4,'review') ON CONFLICT DO NOTHING RETURNING id",
        [randomUUID(), route.id, email.id, receiptKey],
      );
      if (!inserted.rows[0]) return s;
      let status: 'review' | 'imported' | 'duplicate' = 'review',
        transactionId: string | null = null;
      if (parsed.receipt && !manual) {
        const r = parsed.receipt;
        const probe: Transaction = {
          ...r,
          id: '',
          accountId: route.account_id,
          currency: 'USD',
          raw: {},
          source: 'venmo',
          categoryId: r.categoryId ?? 'other',
          excluded: false,
          reviewed: false,
          pending: false,
          removed: false,
          importedAt: now,
          edits: {},
          splits: [],
        };
        const match = importedMatch(s.transactions, probe);
        const possible = s.transactions.some(
          (t) =>
            !t.removed &&
            t.accountId === route.account_id &&
            t.date === r.date &&
            t.amount === r.amount,
        );
        const known = s.transactions.some(
          (t) => t.accountId === route.account_id && t.providerId === `venmo:${r.receiptId}`,
        );
        if (!match && possible && !known)
          reason =
            'A transaction with this date and amount already exists. Review before adding another.';
        else {
          const applied = applyVenmoReceipt(s, route.account_id, r, now);
          s = applied.state;
          status = applied.status;
          transactionId = applied.transactionId;
        }
      }
      await tx.query(
        'UPDATE venmo_receipts SET status=$1,reason=$2,encrypted_payload=$3,transaction_id=$4 WHERE id=$5',
        [
          status,
          reason || null,
          status === 'review' ? encryptToken(JSON.stringify(payload)) : null,
          transactionId,
          inserted.rows[0].id,
        ],
      );
      await tx.query('UPDATE venmo_routes SET last_received_at=$1 WHERE id=$2', [now, route.id]);
      return s;
    },
    undefined,
    historical,
  );
}

export function venmoWebhook(db: Database, provider: ReceivingProvider = new ResendReceiving()) {
  const router = express.Router();
  router.post('/', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
    if (!venmoReady()) {
      res.status(503).json({ error: 'Email receiving is not configured.' });
      return;
    }
    let event: any;
    try {
      if (!Buffer.isBuffer(req.body)) throw Error('Invalid body');
      new Webhook(process.env.RESEND_WEBHOOK_SECRET!).verify(req.body.toString('utf8'), {
        'svix-id': req.header('svix-id') ?? '',
        'svix-timestamp': req.header('svix-timestamp') ?? '',
        'svix-signature': req.header('svix-signature') ?? '',
      });
      event = JSON.parse(req.body.toString('utf8'));
    } catch {
      res.status(401).json({ error: 'Invalid webhook.' });
      return;
    }
    if (event.type !== 'email.received') {
      res.json({ ok: true });
      return;
    }
    const data = z
      .object({
        email_id: z.uuid(),
        to: z.array(z.string()).max(100),
        received_for: z.array(z.string()).max(100).optional(),
      })
      .parse(event.data);
    const tokens = [...data.to, ...(data.received_for ?? [])]
      .map(mailbox)
      .filter((a) => a.endsWith('@' + receivingDomain()))
      .map((a) => a.split('@')[0])
      .filter((a) => /^venmo-[a-f0-9]{48}$/.test(a));
    const matches: Route[] = [];
    for (const token of new Set(tokens)) {
      const row = (
        await db.query<Route>('SELECT * FROM venmo_routes WHERE token_hash=$1 AND active=true', [
          hash(token),
        ])
      ).rows[0];
      if (row) matches.push(row);
    }
    if (matches.length === 1) {
      const email = await provider.get(data.email_id);
      if (email.id !== data.email_id)
        throw fail('The email service returned an unexpected message.', 503);
      await processVenmoEmail(db, matches[0], email);
    }
    res.status(202).json({ accepted: true });
  });
  return router;
}

export async function purgeVenmoReviewContent(db: SQL) {
  await db.query(
    "UPDATE venmo_receipts SET encrypted_payload=NULL,reason='Receipt preview expired. Add the transaction manually if needed.' WHERE encrypted_payload IS NOT NULL AND created_at<now()-interval '7 days'",
  );
  await db.query(
    'UPDATE venmo_routes SET verification_code=NULL WHERE verification_expires_at<now()',
  );
}

export function venmoRoutes(db: Database) {
  const router = express.Router();
  router.get('/', async (_req, res) => {
    const owner = res.locals.owner;
    const routes = (
      await db.query<any>('SELECT * FROM venmo_routes WHERE owner_id=$1 ORDER BY created_at', [
        owner,
      ])
    ).rows;
    const receipts = (
      await db.query<any>(
        "SELECT r.id,r.route_id,r.status,r.reason,r.encrypted_payload,r.transaction_id,r.created_at FROM venmo_receipts r JOIN venmo_routes v ON v.id=r.route_id WHERE v.owner_id=$1 ORDER BY (r.status='review') DESC,r.created_at DESC LIMIT 50",
        [owner],
      )
    ).rows;
    res.json({
      configured: venmoReady(),
      routes: routes.map((r) => ({
        id: r.id,
        accountId: r.account_id,
        sourceEmail: r.source_email,
        active: r.active,
        address:
          r.active && receivingDomain()
            ? `${decryptToken(r.encrypted_token)}@${receivingDomain()}`
            : null,
        verificationCode:
          r.verification_code && +new Date(r.verification_expires_at) > Date.now()
            ? decryptToken(r.verification_code)
            : null,
        lastReceivedAt: r.last_received_at,
      })),
      receipts: receipts.map((r) => ({
        id: r.id,
        routeId: r.route_id,
        status: r.status,
        reason: r.reason,
        transactionId: r.transaction_id,
        createdAt: r.created_at,
        ...(r.encrypted_payload && +new Date(r.created_at) > Date.now() - 7 * 86400000
          ? JSON.parse(decryptToken(r.encrypted_payload))
          : {}),
      })),
    });
  });
  router.post('/', async (req, res) => {
    if (!venmoReady())
      throw fail('The server needs an incoming email address before Venmo can connect.', 503);
    const p = z
      .object({
        accountId: z.string().optional(),
        sourceEmail: z.email(),
        bankTransfers: z.boolean().default(true),
      })
      .parse(req.body);
    const owner = res.locals.owner,
      token = `venmo-${randomBytes(24).toString('hex')}`,
      id = randomUUID();
    await mutateState(
      db,
      owner,
      async (s, tx) => {
        if (s.settings.demo) throw fail('Sign in to connect Venmo.', 403);
        const count = (
          await tx.query<{ count: string }>('SELECT count(*) FROM venmo_routes WHERE owner_id=$1', [
            owner,
          ])
        ).rows[0];
        if (
          Number(count.count) >= 10 &&
          !(
            p.accountId &&
            (
              await tx.query('SELECT id FROM venmo_routes WHERE owner_id=$1 AND account_id=$2', [
                owner,
                p.accountId,
              ])
            ).rows.length
          )
        )
          throw fail('You can connect up to ten Venmo accounts.');
        let account = p.accountId ? s.accounts.find((a) => a.id === p.accountId) : undefined;
        if (
          p.accountId &&
          (!account ||
            !['csv', 'manual', 'venmo'].includes(account.source) ||
            account.currency !== 'USD' ||
            account.type !== 'checking')
        )
          throw fail('Choose an unconnected Venmo account in USD.');
        if (!account) {
          account = {
            id: randomUUID(),
            name: 'Venmo',
            type: 'checking',
            currency: 'USD',
            balance: null,
            enabled: true,
            includeInNetWorth: true,
            source: 'venmo',
            updatedAt: new Date().toISOString(),
            coverageComplete: false,
          };
          s.accounts.push(account);
        }
        if (
          account.source === 'venmo' &&
          (
            await tx.query(
              'SELECT id FROM venmo_routes WHERE owner_id=$1 AND account_id=$2 AND active=true',
              [owner, account.id],
            )
          ).rows.length
        )
          throw fail('This Venmo account already has a forwarding address.');
        account.source = 'venmo';
        account.venmo = { bankTransfers: p.bankTransfers };
        await tx.query(
          `INSERT INTO venmo_routes(id,owner_id,account_id,source_email,token_hash,encrypted_token) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(owner_id,account_id) DO UPDATE SET source_email=$4,token_hash=$5,encrypted_token=$6,active=true,verification_code=NULL,verification_expires_at=NULL,created_at=now()`,
          [id, owner, account.id, p.sourceEmail.toLowerCase(), hash(token), encryptToken(token)],
        );
        s.transactions = s.transactions.map((t) => venmoBankTransfer(t, s));
        return s;
      },
      undefined,
      true,
    );
    res.json({ ok: true });
  });
  router.post('/:id/pause', async (req, res) => {
    const route = await ownedRoute(db, req.params.id, res.locals.owner);
    await db.query('UPDATE venmo_routes SET active=false,verification_code=NULL WHERE id=$1', [
      route.id,
    ]);
    res.json({ ok: true });
  });
  router.post('/receipts/:id/ignore', async (req, res) => {
    await db.query(
      "UPDATE venmo_receipts SET status='ignored',encrypted_payload=NULL WHERE id=$1 AND status='review' AND route_id IN (SELECT id FROM venmo_routes WHERE owner_id=$2)",
      [req.params.id, res.locals.owner],
    );
    res.json({ ok: true });
  });
  router.post('/receipts/:id/confirm', async (req, res) => {
    const p = z
      .object({ receipt: venmoReceiptSchema, existingId: z.string().optional() })
      .parse(req.body);
    await mutateState(
      db,
      res.locals.owner,
      async (s, tx) => {
        const row = (
          await tx.query<any>(
            'SELECT r.* FROM venmo_receipts r JOIN venmo_routes v ON v.id=r.route_id WHERE r.id=$1 AND v.owner_id=$2 FOR UPDATE OF r',
            [req.params.id, res.locals.owner],
          )
        ).rows[0];
        if (!row || row.status !== 'review')
          throw fail('This receipt is no longer awaiting review.');
        const route = await ownedRoute(tx, row.route_id, res.locals.owner);
        const result = applyVenmoReceipt(
          s,
          route.account_id,
          p.receipt,
          new Date().toISOString(),
          p.existingId,
        );
        await tx.query(
          'UPDATE venmo_receipts SET status=$1,transaction_id=$2,encrypted_payload=NULL WHERE id=$3',
          [result.status, result.transactionId, row.id],
        );
        return result.state;
      },
      undefined,
      true,
    );
    res.json({ ok: true });
  });
  return router;
}
