import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { Response } from 'express';
import { fixture, transaction } from './fixtures';
import {
  appleAccountInput,
  appleBatchInput,
  connectAppleAccount,
  applyAppleBatch,
  removeAppleData,
} from '../shared/apple';
import { validateState, effective, applyCommand, backup } from '../shared/core';
import { base32, totp } from '../server/security';
import { openDatabase, type Database } from '../server/db';
import { newSession } from '../server/auth';
import { createApp } from '../server/app';

const account = appleAccountInput.parse({
  providerId: randomUUID(),
  deviceId: randomUUID(),
  name: 'Apple Cash',
  type: 'checking',
  currency: 'USD',
  targetId: 'a',
  consent: true,
});
const now = '2026-10-17T12:00:00Z';
const entry = {
  providerId: randomUUID(),
  name: 'Coffee',
  date: '2024-02-15',
  amount: 700,
  currency: 'USD',
  direction: 'debit',
  type: 'spending',
  pending: false,
};
function batch(sequence = 1) {
  return appleBatchInput.parse({
    accountId: 'a',
    deviceId: account.deviceId,
    sequence,
    transactions: [entry],
    deleted: [],
  });
}
describe('Apple account syncing', () => {
  it('categorizes Wallet merchants and preserves a later correction on refresh', () => {
    let s = fixture();
    s.categories.push({
      id: 'groceries',
      name: 'Groceries',
      icon: 'groceries',
      color: '#258465',
      group: 'Everyday',
      archived: false,
    });
    connectAppleAccount(s, account, now);
    const receipt = { ...batch().transactions[0], name: 'Safeway #123' };
    applyAppleBatch(s, { ...batch(), transactions: [receipt] }, now, 'first');
    expect(s.transactions[0].categoryId).toBe('groceries');
    s = applyCommand(s, {
      type: 'transaction.update',
      payload: { id: s.transactions[0].id, edits: { categoryId: 'food' } },
    });
    applyAppleBatch(s, { ...batch(2), transactions: [receipt] }, now, 'second');
    expect(effective(s.transactions[0]).categoryId).toBe('food');
  });
  it('pairs imported records once, preserves edits through updates, restores original imports on deletion', () => {
    const s = fixture();
    s.accounts[0].source = 'csv';
    const original = transaction('imported', 700, {
      name: 'Coffee',
      source: 'csv',
      notes: 'Work',
      edits: { categoryId: 'food' },
      importIdentity: 'copilot-1',
    });
    s.transactions = [original];
    connectAppleAccount(s, account, now);
    applyAppleBatch(s, batch(), now, 'hash');
    expect(s.transactions).toHaveLength(1);
    expect(s.transactions[0].id).toBe('imported');
    expect(effective(s.transactions[0]).notes).toBe('Work');
    applyAppleBatch(s, batch(), now, 'hash');
    expect(s.transactions).toHaveLength(1);
    applyAppleBatch(
      s,
      { ...batch(2), transactions: [{ ...batch().transactions[0], name: 'Changed merchant' }] },
      now,
      'new',
    );
    expect(effective(s.transactions[0]).name).toBe('Coffee');
    expect(validateState(s)).toBeTruthy();
    removeAppleData(s, 'a');
    expect(s.transactions).toHaveLength(1);
    expect(s.transactions[0]).toMatchObject({
      id: 'imported',
      source: 'csv',
      name: 'Coffee',
      notes: 'Work',
    });
    expect(s.transactions[0].raw).toBeUndefined();
    expect(s.accounts[0].source).toBe('csv');
  });
  it('rejects stale batches, wrong devices, account type mismatches and malformed amounts', () => {
    const s = fixture();
    connectAppleAccount(s, account, now);
    expect(() => applyAppleBatch(s, { ...batch(), deviceId: randomUUID() }, now, 'h')).toThrow(
      'device',
    );
    expect(() => applyAppleBatch(s, batch(2), now, 'h')).toThrow('changed');
    expect(() => connectAppleAccount(fixture(), { ...account, type: 'credit' }, now)).toThrow(
      'same currency and type',
    );
    expect(() =>
      appleBatchInput.parse({ ...batch(), transactions: [{ ...entry, amount: 0.1 }] }),
    ).toThrow();
    expect(() =>
      applyCommand(s, { type: 'account.save', payload: { ...s.accounts[0], balance: 9 } }),
    ).not.toThrow();
    expect(s.accounts[0].balance).toBe(100000);
  });
  it('uses the latest booked timestamp, handles removals, and exports disconnected backups', () => {
    const s = fixture();
    connectAppleAccount(s, account, now);
    const id = randomUUID();
    applyAppleBatch(
      s,
      {
        ...batch(),
        balances: [
          { providerId: id, date: '2026-10-17', asOf: now, balance: 500, currency: 'USD' },
          {
            providerId: randomUUID(),
            date: '2026-10-17',
            asOf: '2026-10-17T11:00:00Z',
            balance: 900,
            currency: 'USD',
          },
        ],
      },
      now,
      'h',
    );
    expect(s.accounts[0].balance).toBe(500);
    applyAppleBatch(
      s,
      { ...batch(2), transactions: [], deleted: [entry.providerId], deletedBalances: [id] },
      now,
      'h2',
    );
    expect(s.transactions[0].removed).toBe(true);
    expect(s.accounts[0].balance).toBe(900);
    expect(backup(s).state.accounts[0]).toMatchObject({ source: 'manual' });
    expect(backup(s).state.accounts[0]).not.toHaveProperty('financekit');
  });
  it('does not attach pending Apple authorizations to posted CSV history', () => {
    const s = fixture();
    s.transactions = [transaction('old', 700, { source: 'csv', name: 'Coffee' })];
    connectAppleAccount(s, account, now);
    applyAppleBatch(
      s,
      { ...batch(), transactions: [{ ...batch().transactions[0], pending: true }] },
      now,
      'h',
    );
    expect(s.transactions).toHaveLength(2);
    expect(s.transactions[0].source).toBe('csv');
  });
});

describe('New-device verification and Apple API authorization', () => {
  let db: Database, server: Server, url: string, token: string, other: string;
  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', undefined);
    vi.stubEnv('VERCEL', undefined);
    vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'a'.repeat(64));
    vi.stubEnv('FINANCEKIT_ENABLED', 'true');
    db = await openDatabase(':memory:');
    for (const id of ['owner', 'other']) {
      await db.query('INSERT INTO users(id,email) VALUES($1,$2)', [id, `${id}@example.com`]);
      await db.query('INSERT INTO workspaces(owner_id,state) VALUES($1,$2)', [
        id,
        JSON.stringify(fixture()),
      ]);
    }
    token = await newSession(db, 'owner', { cookie() {} } as unknown as Response);
    other = await newSession(db, 'other', { cookie() {} } as unknown as Response);
    server = createApp(db).listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `http://127.0.0.1:${(server.address() as any).port}/api`;
  }, 30000);
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await db.close();
    vi.unstubAllEnvs();
  });
  function request(path: string, body?: unknown, auth = token) {
    return fetch(url + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        'x-asset-client': 'ios',
        authorization: `Bearer ${auth}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  it('matches the RFC 6238 SHA-1 vector', () =>
    expect(totp(base32(Buffer.from('12345678901234567890')), 1)).toBe('287082'));
  it('requires enrollment, verifies codes once, locks new sessions, and keeps workspaces isolated', async () => {
    expect((await request('/apple/connect', account)).status).toBe(403);
    const setup = await (await request('/security/enroll', {})).json();
    expect(setup.secret).toHaveLength(32);
    expect((await request('/security/enroll', {})).status).toBe(409);
    const code = totp(setup.secret, Math.floor(Date.now() / 30000));
    expect((await request('/security/verify', { code })).status).toBe(200);
    const connected = await request('/apple/connect', account);
    expect(connected.status).toBe(200);
    expect((await request('/apple/sync', batch())).status).toBe(200);
    await db.query(
      `UPDATE workspaces SET state=jsonb_set(state,'{transactions,0,edits}', $2::jsonb) WHERE owner_id=$1`,
      ['owner', JSON.stringify({ name: 'Edited coffee', notes: 'Keep on replay' })],
    );
    const reset = await request('/apple/reset', { accountId: 'a', deviceId: account.deviceId });
    expect(reset.status).toBe(200);
    expect((await reset.json()).state).toBeUndefined();
    expect((await request('/apple/sync', batch())).status).toBe(200);
    const replayed = (await (await request('/state')).json()).state.transactions[0];
    expect(effective(replayed)).toMatchObject({
      name: 'Edited coffee',
      notes: 'Keep on replay',
      removed: false,
    });
    expect((await request('/apple/disconnect', { accountId: 'a' }, other)).status).toBe(400);
    const second = await newSession(db, 'owner', { cookie() {} } as unknown as Response);
    for (const endpoint of ['/state', '/backup', '/venmo', '/apple'])
      expect((await request(endpoint, undefined, second)).status).toBe(403);
    expect((await request('/security/verify', { code }, second)).status).toBe(400);
    expect((await request('/security/verify', { code: setup.recovery }, second)).status).toBe(200);
    const third = await newSession(db, 'owner', { cookie() {} } as unknown as Response);
    expect((await request('/security/verify', { code: setup.recovery }, third)).status).toBe(400);
    expect((await request('/state', undefined, second)).status).toBe(200);
  });
});

describe('Statement-based loan records', () => {
  it('keeps loan details and balance history without treating a payment as principal', () => {
    const state = fixture();
    const next = applyCommand(state, {
      type: 'account.save',
      payload: {
        ...state.accounts[0],
        type: 'loan',
        name: 'Synchrony Pay Later',
        balance: 125000,
        loan: {
          lender: 'synchrony',
          ratePercent: 4.99,
          rateType: 'APR',
          paymentAmount: 11000,
          nextPaymentDate: '2026-11-01',
        },
      },
    });
    expect(next.accounts[0].loan?.ratePercent).toBe(4.99);
    expect(next.snapshots.at(-1)?.balance).toBe(125000);
    expect(next.transactions).toHaveLength(0);
    expect(() =>
      validateState({
        ...next,
        accounts: [
          {
            ...next.accounts[0],
            loan: { ...next.accounts[0].loan, nextPaymentDate: '2026-02-30' },
          },
        ],
      }),
    ).toThrow();
  });
});

describe('Apple sync bandwidth and balance history', () => {
  it('loads only changed transactions and balance candidates, preserving the complete ledger', async () => {
    const { getState, mutateState } = await import('../server/db');
    const { appleSyncScope } = await import('../server/apple');
    vi.stubEnv('DATABASE_URL', undefined);
    vi.stubEnv('VERCEL', undefined);
    const db = await openDatabase(':memory:');
    try {
      const s = fixture();
      s.transactions = Array.from({ length: 4000 }, (_, i) =>
        transaction(`unrelated-${i}`, 999, { notes: 'Original history '.repeat(40) }),
      );
      s.transactions.push(
        transaction('imported', 700, {
          source: 'csv',
          name: 'Coffee',
          reviewed: true,
          notes: 'Keep my note',
          edits: { categoryId: 'food', excluded: true },
        }),
      );
      connectAppleAccount(s, account, now);
      const oldID = randomUUID(),
        latestID = randomUUID();
      s.snapshots = [
        {
          id: `apple-balance-a-${oldID}`,
          accountId: 'a',
          date: '2026-10-15',
          asOf: '2026-10-15T12:00:00Z',
          balance: 500,
          currency: 'USD',
          source: 'financekit',
        },
        {
          id: `apple-balance-a-${latestID}`,
          accountId: 'a',
          date: '2026-10-16',
          asOf: '2026-10-16T12:00:00Z',
          balance: 600,
          currency: 'USD',
          source: 'financekit',
        },
      ];
      await db.query('INSERT INTO users(id,email) VALUES($1,$2)', [
        'apple-owner',
        'apple@example.com',
      ]);
      await db.query('INSERT INTO workspaces(owner_id,state) VALUES($1,$2)', [
        'apple-owner',
        JSON.stringify(validateState(s)),
      ]);
      let bytes = 0;
      const wrap = (sql: any): any => ({
        query: async (query: string, params?: unknown[]) => {
          const r = await sql.query(query, params);
          bytes += Buffer.byteLength(JSON.stringify(r.rows));
          return r;
        },
      });
      const measured = {
        ...wrap(db),
        transaction: (fn: any) => db.transaction((tx) => fn(wrap(tx))),
        close: () => db.close(),
      } as Database;
      const input = { ...batch(), deletedBalances: [latestID] };
      await mutateState(
        measured,
        'apple-owner',
        (state) => {
          applyAppleBatch(state, input, now, 'first');
          return state;
        },
        undefined,
        true,
        undefined,
        appleSyncScope(input),
      );
      expect(bytes).toBeLessThan(15000);
      const stored = await getState(db, 'apple-owner');
      const expected = structuredClone(s);
      applyAppleBatch(expected, input, now, 'first');
      expected.notifications = {
        preferences: (await import('../shared/notifications')).notificationPreferences(expected),
        items: [],
      };
      expect(stored.state).toEqual(validateState(expected));
      expect(stored.state.accounts[0].balance).toBe(500);
      expect(stored.state.transactions).toHaveLength(4001);
      expect(effective(stored.state.transactions.find((t) => t.id === 'imported')!)).toMatchObject({
        notes: 'Keep my note',
        reviewed: true,
        categoryId: 'food',
        excluded: true,
      });
      const repeat = await mutateState(
        measured,
        'apple-owner',
        (state) => {
          applyAppleBatch(state, input, now, 'first');
          return state;
        },
        undefined,
        true,
        undefined,
        appleSyncScope(input),
      );
      expect(repeat.revision).toBe(stored.revision);
      const corrected = {
        ...batch(2),
        transactions: [],
        balances: [
          {
            providerId: oldID,
            date: '2026-10-14',
            asOf: '2026-10-14T12:00:00Z',
            balance: 400,
            currency: 'USD' as const,
          },
        ],
      };
      await mutateState(
        measured,
        'apple-owner',
        (state) => {
          applyAppleBatch(state, corrected, now, 'second');
          return state;
        },
        undefined,
        true,
        undefined,
        appleSyncScope(corrected),
      );
      expect((await getState(db, 'apple-owner')).state.accounts[0].balance).toBe(400);
      console.info('Apple scoped sync result bytes', bytes);
    } finally {
      await db.close();
      vi.unstubAllEnvs();
    }
  }, 30000);
  it('rejects conflicting balance updates instead of silently overwriting them', () => {
    const s = fixture();
    connectAppleAccount(s, account, now);
    const balance = {
      providerId: randomUUID(),
      date: '2026-10-17',
      asOf: now,
      balance: 500,
      currency: 'USD' as const,
    };
    expect(() =>
      applyAppleBatch(s, { ...batch(), balances: [balance, balance] }, now, 'a'),
    ).toThrow('Duplicate Apple balance');
    expect(() =>
      applyAppleBatch(
        s,
        { ...batch(), balances: [balance], deletedBalances: [balance.providerId] },
        now,
        'b',
      ),
    ).toThrow('Duplicate Apple balance');
  });
});
