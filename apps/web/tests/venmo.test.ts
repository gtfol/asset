import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { Response } from 'express';
import { Webhook } from 'svix';
import { fixture, transaction } from './fixtures';
import { applyCommand, backup, effective, today, validateState } from '../shared/core';
import { parseVenmoReceipt, venmoBankTransfer } from '../shared/venmo';
import { applyVenmoReceipt, purgeVenmoReviewContent, type ReceivedEmail } from '../server/venmo';
import { openDatabase, getState, type Database } from '../server/db';
import { newSession } from '../server/auth';
import { createApp } from '../server/app';

const input = {
  subject: 'You paid Taylor Reed $1,024.35',
  text: 'Transaction ID: 1234567890123456\nNote\nDinner',
  date: 'Sat, 17 Oct 2026 01:30:00 +0000',
  timeZone: 'America/Los_Angeles',
};
describe('Venmo receipt interpretation', () => {
  it('reads direction, exact cents, local payment date and note', () => {
    expect(parseVenmoReceipt(input).receipt).toEqual({
      receiptId: '1234567890123456',
      name: 'Taylor Reed',
      amount: 102435,
      kind: 'spending',
      date: '2026-10-16',
      notes: 'Dinner',
    });
    expect(
      parseVenmoReceipt({ ...input, subject: 'Taylor Reed paid you $20.00' }).receipt?.kind,
    ).toBe('refund');
  });
  it('accepts multiline receipts and refuses unfamiliar or incomplete payment details', () => {
    expect(
      parseVenmoReceipt({
        ...input,
        subject: 'Venmo payment',
        text: 'You paid Taylor Reed\n$20.00\n' + input.text,
      }).receipt?.amount,
    ).toBe(2000);
    for (const subject of [
      'You paid Taylor Reed $1,0.00',
      'Taylor requested $10.00',
      'Payment failed',
      'Monthly statement',
    ])
      expect(parseVenmoReceipt({ ...input, subject }).receipt).toBeUndefined();
    expect(parseVenmoReceipt({ ...input, text: 'no transaction ID' }).receipt).toBeUndefined();
    expect(parseVenmoReceipt({ ...input, date: '' }).receipt).toBeUndefined();
  });
  it('keeps alphanumeric receipt identifiers intact for duplicate detection', () => {
    const receipt = parseVenmoReceipt({
      ...input,
      subject:
        'Taylor Reed paid $20.00 to your Venmo account. Leave it in Venmo or transfer it to your bank account.',
      text: 'Taylor Reed paid you $20.00\nTransaction ID\n1AB23456CD7890123\nSent to @example',
    }).receipt;
    expect(receipt).toMatchObject({
      receiptId: '1AB23456CD7890123',
      name: 'Taylor Reed',
      kind: 'refund',
      amount: 2000,
    });
    expect(
      parseVenmoReceipt({ ...input, text: 'Transaction ID: unavailable' }).receipt,
    ).toBeUndefined();
  });
  it('preserves imported metadata and matches one receipt only once, including removed records', () => {
    const state = fixture();
    state.accounts[0].source = 'venmo';
    const receipt = parseVenmoReceipt(input).receipt!;
    state.transactions = [
      transaction('csv-original', receipt.amount, {
        name: receipt.name,
        date: receipt.date,
        source: 'csv',
        notes: 'Keep this',
        edits: { kind: 'transfer' },
        importIdentity: 'copilot:1',
      }),
    ];
    applyVenmoReceipt(state, 'a', receipt, new Date().toISOString());
    expect(state.transactions).toHaveLength(1);
    expect(state.transactions[0].id).toBe('csv-original');
    expect(effective(state.transactions[0]).notes).toBe('Keep this');
    expect(effective(state.transactions[0]).kind).toBe('transfer');
    state.transactions[0].removed = true;
    expect(applyVenmoReceipt(state, 'a', receipt, new Date().toISOString()).status).toBe(
      'duplicate',
    );
    expect(state.transactions[0].removed).toBe(true);
    expect(validateState(backup(state).state).accounts[0].source).toBe('manual');
    expect(() => applyCommand(state, { type: 'backup.restore', payload: { state } })).toThrow(
      'disconnected',
    );
  });
  it('classifies bank funding only when enabled and preserves user edits and purchases', () => {
    const state = fixture();
    state.accounts[0].source = 'venmo';
    state.accounts[0].venmo = { bankTransfers: true };
    const funding = transaction('p', 1200, { source: 'plaid', name: 'VENMO PAYMENT' });
    expect(venmoBankTransfer(funding, state).kind).toBe('transfer');
    expect(venmoBankTransfer({ ...funding, edits: { kind: 'spending' } }, state).kind).toBe(
      'spending',
    );
    expect(venmoBankTransfer({ ...funding, name: 'VENMO CARD PURCHASE' }, state).kind).toBe(
      'spending',
    );
    state.accounts[0].venmo.bankTransfers = false;
    expect(venmoBankTransfer(funding, state).kind).toBe('spending');
  });
});

describe('Venmo receiving lifecycle', () => {
  let db: Database, server: Server, base: string, token: string, other: string;
  let route: any, address: string, mail: ReceivedEmail;
  const secret = 'whsec_' + Buffer.alloc(32, 5).toString('base64');
  const receive = vi.fn(async () => mail);
  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', undefined);
    vi.stubEnv('VERCEL', undefined);
    vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'a'.repeat(64));
    vi.stubEnv('VENMO_RECEIVING_DOMAIN', 'asset-test.resend.app');
    vi.stubEnv('RESEND_API_KEY', 'test');
    vi.stubEnv('RESEND_WEBHOOK_SECRET', secret);
    db = await openDatabase(':memory:');
    for (const id of ['owner', 'other']) {
      await db.query('INSERT INTO users(id,email) VALUES($1,$2)', [id, `${id}@example.invalid`]);
      await db.query('INSERT INTO workspaces(owner_id,state) VALUES($1,$2)', [
        id,
        JSON.stringify(fixture()),
      ]);
    }
    token = await newSession(db, 'owner', { cookie() {} } as unknown as Response);
    other = await newSession(db, 'other', { cookie() {} } as unknown as Response);
    server = createApp(db, undefined, undefined, undefined, { get: receive }).listen(
      0,
      '127.0.0.1',
    );
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  }, 30000);
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    vi.unstubAllEnvs();
  });
  const request = (
    path: string,
    body?: unknown,
    auth = token,
    extra: Record<string, string> = {},
  ) =>
    fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        'x-asset-client': 'web',
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  async function webhook(options: { address?: string; invalid?: boolean; expired?: boolean } = {}) {
    const payload = JSON.stringify({
      type: 'email.received',
      data: { email_id: mail.id, to: [options.address ?? address] },
    });
    const id = randomUUID(),
      timestamp = new Date(Date.now() - (options.expired ? 600000 : 0));
    const response = await fetch(base + '/venmo/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'svix-id': id,
        'svix-timestamp': String(Math.floor(+timestamp / 1000)),
        'svix-signature': options.invalid
          ? 'bad'
          : new Webhook(secret).sign(id, timestamp, payload),
      },
      body: payload,
    });
    return response;
  }
  async function inbox(auth = token) {
    return (await request('/venmo', undefined, auth)).json();
  }
  beforeEach(async () => {
    await db.query('DELETE FROM venmo_routes');
    await db.query('UPDATE users SET google_subject=NULL');
    const state = fixture();
    state.accounts[0].name = 'Venmo imported';
    state.accounts[0].source = 'csv';
    await db.query('UPDATE workspaces SET state=$1,revision=0 WHERE owner_id=$2', [
      JSON.stringify(state),
      'owner',
    ]);
    const created = await request('/venmo', {
      sourceEmail: 'owner@example.invalid',
      accountId: 'a',
    });
    expect(created.status).toBe(200);
    route = (await inbox()).routes[0];
    address = route.address;
    mail = {
      id: randomUUID(),
      from: 'Venmo <venmo@venmo.com>',
      to: ['owner@example.invalid'],
      subject: 'You paid Taylor Reed $20.00',
      text: input.text,
      headers: { Date: new Date().toUTCString() },
      authentication: { dkim: 'pass', dmarc: 'pass' },
      message_id: randomUUID(),
    };
    receive.mockClear();
  });
  it('uses the clean shared address only for verified source mailboxes and rejects ambiguous recipients', async () => {
    const shared = 'venmo@asset-test.resend.app';
    await webhook({ address: shared });
    expect((await inbox()).receipts).toHaveLength(0);
    await db.query('UPDATE venmo_routes SET source_verified=true WHERE id=$1', [route.id]);
    expect((await inbox()).routes[0].address).toBe(shared);
    await webhook({ address: shared });
    expect((await inbox()).receipts).toHaveLength(1);
    const count = (await getState(db, 'owner')).state.transactions.length;
    // The existing opaque address remains valid during the Gmail transition.
    await webhook();
    expect((await getState(db, 'owner')).state.transactions).toHaveLength(count);
    await request('/venmo', { sourceEmail: 'owner@example.invalid' }, other);
    await db.query('UPDATE venmo_routes SET source_verified=true WHERE owner_id=$1', ['other']);
    mail.id = randomUUID();
    mail.text = 'Transaction ID: 9876543210123456';
    await webhook({ address: shared });
    expect((await inbox(other)).receipts).toHaveLength(0);
    expect((await inbox()).receipts).toHaveLength(1);
  });
  it('does not trust an unverified claim to another user’s email address', async () => {
    await db.query("UPDATE users SET google_subject='google-owner' WHERE id='owner'");
    expect((await inbox()).routes[0].address).toBe('venmo@asset-test.resend.app');
    await request('/venmo', { sourceEmail: 'owner@example.invalid' }, other);
    await webhook({ address: 'venmo@asset-test.resend.app' });
    expect((await inbox(other)).receipts).toHaveLength(0);
    expect((await inbox()).receipts).toHaveLength(1);
    await db.query('UPDATE users SET google_subject=NULL WHERE id=$1', ['owner']);
  });
  it('keeps the existing account, encrypts routing tokens, isolates owners and checks sessions', async () => {
    expect(route.accountId).toBe('a');
    expect(address).toMatch(/^venmo-[a-f0-9]{48}@asset-test.resend.app$/);
    const raw = (await db.query('SELECT * FROM venmo_routes')).rows[0];
    expect(JSON.stringify(raw)).not.toContain(address.split('@')[0]);
    expect((await inbox(other)).routes).toHaveLength(0);
    expect((await request(`/venmo/${route.id}/pause`, {}, other)).status).toBe(404);
    expect((await request('/venmo', undefined, '', {})).status).toBe(401);
    expect(
      (await request('/venmo', undefined, token, { 'x-asset-session': 'changed' })).status,
    ).toBe(409);
    expect((await getState(db, 'owner')).state.accounts[0].balance).toBe(100000);
  });
  it('rejects invalid and expired signatures before accessing email content', async () => {
    expect((await webhook({ invalid: true })).status).toBe(401);
    expect((await webhook({ expired: true })).status).toBe(401);
    expect(receive).not.toHaveBeenCalled();
    expect(
      (await webhook({ address: 'venmo-' + 'f'.repeat(48) + '@asset-test.resend.app' })).status,
    ).toBe(202);
    expect(receive).not.toHaveBeenCalled();
  });
  it('rejects spoofed, unrelated and unauthenticated messages', async () => {
    for (const change of [
      { authentication: { dkim: 'fail', dmarc: 'pass' } },
      { authentication: undefined },
      { from: 'attacker@example.com' },
      { to: ['other@example.com'] },
    ]) {
      const original = mail;
      mail = { ...mail, ...change };
      expect((await webhook()).status).toBe(202);
      mail = original;
    }
    expect((await inbox()).receipts).toHaveLength(0);
    expect((await getState(db, 'owner')).state.transactions).toHaveLength(0);
  });
  it('imports once under concurrent delivery and generates the Venmo alert without changing balance', async () => {
    const responses = await Promise.all([webhook(), webhook()]);
    expect(responses.map((r) => r.status)).toEqual([202, 202]);
    const state = (await getState(db, 'owner')).state;
    expect(state.transactions).toHaveLength(1);
    expect(state.transactions[0].amount).toBe(2000);
    expect(state.notifications?.items.some((n) => n.kind === 'venmo')).toBe(true);
    expect(state.accounts[0].balance).toBe(100000);
    expect((await inbox()).receipts[0].text).toBeUndefined();
    mail.id = randomUUID();
    mail.message_id = randomUUID();
    await webhook();
    expect((await getState(db, 'owner')).state.transactions).toHaveLength(1);
  });
  it('queues ambiguous overlaps for review and lets the owner preserve an imported transaction', async () => {
    const state = (await getState(db, 'owner')).state;
    state.transactions = [
      transaction('old', 2000, {
        date: today(state.settings.timezone),
        name: 'Dinner with friends',
        source: 'csv',
        notes: 'Keep my note',
        importIdentity: 'original',
      }),
    ];
    await db.query('UPDATE workspaces SET state=$1 WHERE owner_id=$2', [
      JSON.stringify(state),
      'owner',
    ]);
    await webhook();
    const item = (await inbox()).receipts[0];
    expect(item.status).toBe('review');
    const parsed = {
      receiptId: '1234567890123456',
      name: 'Taylor Reed',
      amount: 2000,
      kind: 'spending',
      date: today(state.settings.timezone),
      notes: '',
    };
    expect(
      (
        await request(
          `/venmo/receipts/${item.id}/confirm`,
          { receipt: parsed, existingId: 'old' },
          other,
        )
      ).status,
    ).toBe(400);
    expect(
      (await request(`/venmo/receipts/${item.id}/confirm`, { receipt: parsed, existingId: 'old' }))
        .status,
    ).toBe(200);
    const saved = (await getState(db, 'owner')).state.transactions;
    expect(saved).toHaveLength(1);
    expect(saved[0].importIdentity).toBe('original');
    expect(effective(saved[0]).notes).toBe('Keep my note');
  });
  it('drops an old address delivery already in flight when the address is rotated', async () => {
    let deliver!: (email: ReceivedEmail) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    receive.mockImplementationOnce(
      () =>
        new Promise<ReceivedEmail>((resolve) => {
          deliver = resolve;
          started();
        }),
    );
    const pending = webhook();
    await ready;
    await request(`/venmo/${route.id}/pause`, {});
    await request('/venmo', { accountId: 'a', sourceEmail: 'owner@example.invalid' });
    deliver(mail);
    expect((await pending).status).toBe(202);
    expect((await getState(db, 'owner')).state.transactions).toHaveLength(0);
  });
  it('requires review for manual forwards and keeps historical imports quiet', async () => {
    mail.from = 'owner@example.invalid';
    mail.subject = 'Fwd: ' + mail.subject;
    await webhook();
    expect((await inbox()).receipts[0].status).toBe('review');
    expect((await getState(db, 'owner')).state.transactions).toHaveLength(0);
    mail.id = randomUUID();
    mail.message_id = randomUUID();
    mail.from = 'venmo@venmo.com';
    mail.subject = 'You paid Taylor Reed $20.00';
    mail.headers.Date = 'Sat, 17 Oct 2020 12:00:00 +0000';
    await webhook();
    expect((await getState(db, 'owner')).state.transactions).toHaveLength(1);
    expect((await getState(db, 'owner')).state.notifications?.items ?? []).toHaveLength(0);
  });
  it('shows a short-lived authenticated Gmail forwarding confirmation only to its owner', async () => {
    mail.from = 'forwarding-noreply@google.com';
    mail.subject = 'Gmail Forwarding Confirmation';
    mail.text = 'owner@example.invalid requested forwarding. Confirmation code: 123456789';
    await webhook();
    expect((await inbox()).routes[0].verificationCode).toBe('123456789');
    expect(JSON.stringify((await db.query('SELECT * FROM venmo_routes')).rows)).not.toContain(
      '123456789',
    );
    await db.query("UPDATE venmo_routes SET verification_expires_at=now()-interval '1 hour'");
    await purgeVenmoReviewContent(db);
    expect((await inbox()).routes[0].verificationCode).toBeNull();
  });
  it('supports Gmail link confirmations, encrypts them, and clears them on expiry or pause', async () => {
    const link = 'https://mail-settings.google.com/mail/vf-%5Bfixture%5D-test';
    mail.from = 'forwarding-noreply@google.com';
    mail.subject = '(Gmail Forwarding Confirmation - Receive Mail from owner@example.invalid';
    mail.text = `owner@example.invalid requested forwarding.\n${link}\nhttps://mail-settings.google.com/mail/uf-cancel`;
    await webhook();
    expect((await inbox()).routes[0]).toMatchObject({
      verificationCode: null,
      verificationUrl: link,
    });
    expect((await inbox(other)).routes).toEqual([]);
    expect(JSON.stringify((await db.query('SELECT * FROM venmo_routes')).rows)).not.toContain(link);
    await db.query("UPDATE venmo_routes SET verification_expires_at=now()-interval '1 hour'");
    expect((await inbox()).routes[0].verificationUrl).toBeNull();
    await purgeVenmoReviewContent(db);
    expect(
      (await db.query('SELECT verification_url FROM venmo_routes')).rows[0].verification_url,
    ).toBeNull();
    await webhook();
    await request(`/venmo/${route.id}/pause`, {});
    expect((await inbox()).routes[0].verificationUrl).toBeNull();
  });
  it('rejects untrusted Gmail confirmation links and unauthenticated messages', async () => {
    mail.from = 'forwarding-noreply@google.com';
    mail.subject = 'Gmail Forwarding Confirmation';
    for (const link of [
      'https://mail-settings.google.com.attacker.invalid/mail/vf-fixture',
      'http://mail-settings.google.com/mail/vf-fixture',
      'https://mail-settings.google.com/mail/uf-fixture',
    ]) {
      mail.text = `owner@example.invalid requested forwarding.\n${link}`;
      await webhook();
      expect((await inbox()).routes[0].verificationUrl).toBeNull();
    }
    mail.text = 'owner@example.invalid\nhttps://mail-settings.google.com/mail/vf-fixture';
    mail.authentication = { dkim: 'fail' };
    await webhook();
    expect((await inbox()).routes[0].verificationUrl).toBeNull();
    mail.authentication = { dkim: 'pass' };
    mail.text = 'someone-else@example.invalid\nhttps://mail-settings.google.com/mail/vf-fixture';
    await webhook();
    expect((await inbox()).routes[0].verificationUrl).toBeNull();
  });
  it('expires review content, pauses delivery, and rotates the address when resumed', async () => {
    mail.subject = 'Unrecognized receipt';
    await webhook();
    await db.query("UPDATE venmo_receipts SET created_at=now()-interval '8 days'");
    await purgeVenmoReviewContent(db);
    expect((await inbox()).receipts[0].text).toBeUndefined();
    expect((await request(`/venmo/${route.id}/pause`, {})).status).toBe(200);
    receive.mockClear();
    await webhook();
    expect(receive).not.toHaveBeenCalled();
    expect(
      (await request('/venmo', { accountId: 'a', sourceEmail: 'owner@example.invalid' })).status,
    ).toBe(200);
    expect((await inbox()).routes[0].address).not.toBe(address);
    await webhook();
    expect(receive).not.toHaveBeenCalled();
  });
  it('blocks demo connections and backup replacement with an active route', async () => {
    const { state, revision } = await getState(db, 'owner');
    expect(
      (
        await request('/command', {
          type: 'backup.restore',
          payload: { state: backup(state).state },
          revision,
        })
      ).status,
    ).toBe(400);
    state.settings.demo = true;
    await db.query('UPDATE workspaces SET state=$1 WHERE owner_id=$2', [
      JSON.stringify(state),
      'owner',
    ]);
    expect((await request('/venmo', { sourceEmail: 'owner@example.invalid' })).status).toBe(403);
  });
});
