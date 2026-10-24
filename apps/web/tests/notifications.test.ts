import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { once } from 'node:events';
import type { Server } from 'node:http';
import {
  applyCommand,
  updateNotifications,
  dailySpendingNotification,
  notificationPreferences,
  validateState,
} from '../shared/core';
import { fixture, transaction } from './fixtures';
import { openDatabase, mutateState, type Database } from '../server/db';
import { createApp } from '../server/app';
import { newSession } from '../server/auth';
import { notificationWorker } from '../server/notifications';
const now = '2026-10-17T20:00:00Z';
describe('alert rules', () => {
  it('matches the eight selected alerts and excludes pending, historical and transfer spending', () => {
    const before = fixture();
    const next = structuredClone(before);
    next.transactions = [
      transaction('fee', 3500, { name: 'Overdraft fee', date: '2026-10-17' }),
      transaction('big', 50000, { date: '2026-10-17' }),
      transaction('income', 20000, { kind: 'income', date: '2026-10-17' }),
      transaction('recurring', 1000, { recurring: 'Music', date: '2026-10-17' }),
      transaction('venmo', 4000, {
        name: 'Venmo payment',
        kind: 'transfer',
        categoryId: 'other',
        date: '2026-10-17',
      }),
      transaction('pending', 90000, { pending: true, date: '2026-10-17' }),
      transaction('history', 90000),
    ];
    const result = updateNotifications(before, next, now);
    expect(result.notifications!.items.map((n) => n.kind).sort()).toEqual(
      ['bankFee', 'bigExpense', 'income', 'recurringPaid', 'uncategorizedTransfer', 'venmo'].sort(),
    );
    expect(updateNotifications(result, result, now).notifications!.items).toHaveLength(6);
  });
  it('notifies once when pending posts, and never alerts for initial history or quiet imports', () => {
    const before = fixture();
    before.transactions = [transaction('p', 80000, { pending: true, date: '2026-10-17' })];
    const next = structuredClone(before);
    next.transactions[0].pending = false;
    expect(updateNotifications(before, next, now).notifications!.items).toHaveLength(1);
    expect(updateNotifications(before, next, now, true).notifications!.items).toHaveLength(0);
    before.accounts = [];
    expect(updateNotifications(before, next, now).notifications!.items).toHaveLength(0);
  });
  it('uses credit limits and crossing thresholds without repeated daily alerts', () => {
    const before = fixture();
    Object.assign(before.accounts[0], { type: 'credit', creditLimit: 100000, balance: 20000 });
    const next = structuredClone(before);
    next.accounts[0].balance = 30000;
    const result = updateNotifications(before, next, now);
    expect(result.notifications!.items[0]).toMatchObject({ kind: 'creditUtilization' });
    expect(updateNotifications(result, result, now).notifications!.items).toHaveLength(1);
    delete before.accounts[0].creditLimit;
    expect(updateNotifications(before, next, now).notifications!.items).toHaveLength(0);
  });
  it('respects preference changes and read state', () => {
    const before = fixture();
    const next = structuredClone(before);
    next.notifications = {
      preferences: { ...notificationPreferences(next), bigExpense: false },
      items: [],
    };
    next.transactions = [transaction('a', 100000, { date: '2026-10-17' })];
    expect(updateNotifications(before, next, now).notifications!.items).toHaveLength(0);
    next.notifications.preferences.bigExpense = true;
    const alerted = updateNotifications(before, next, now);
    const read = applyCommand(alerted, {
      type: 'notifications.read',
      payload: { ids: alerted.notifications!.items.map((n) => n.id) },
    });
    expect(read.notifications!.items[0].read).toBe(true);
  });
  it('summarizes once after 7 pm in the workspace time zone, with refunds and exclusions', () => {
    const state = fixture();
    state.settings.timezone = 'America/Los_Angeles';
    state.transactions = [
      transaction('a', 1000, { date: '2026-10-17' }),
      transaction('b', 200, { kind: 'refund', date: '2026-10-17' }),
      transaction('c', 1000, { pending: true, date: '2026-10-17' }),
    ];
    expect(dailySpendingNotification(state, now)).toBe(state);
    const next = dailySpendingNotification(state, '2026-10-18T02:00:00Z');
    expect(next.notifications!.items[0].body).toContain('$8.00');
    expect(dailySpendingNotification(next, '2026-10-18T03:00:00Z')).toBe(next);
  });
});

describe('notification storage and delivery', () => {
  let db: Database, server: Server, base: string, token: string;
  beforeAll(async () => {
    db = await openDatabase(':memory:');
    await db.query("INSERT INTO users(id,email) VALUES('alerts','alerts@test.invalid')");
    await db.query('INSERT INTO workspaces(owner_id,state) VALUES($1,$2)', [
      'alerts',
      JSON.stringify(fixture()),
    ]);
    token = await newSession(db, 'alerts', { cookie() {} } as any);
    server = createApp(db).listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  });
  it('requires authentication and reports unavailable push without credentials', async () => {
    expect((await fetch(base + '/notifications/status')).status).toBe(401);
    const response = await fetch(base + '/notifications/status', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(await response.json()).toMatchObject({ pushAvailable: false });
  });
  it('checks daily-summary metadata without reading the ledger until a summary is due', async () => {
    const state = fixture();
    state.settings.timezone = 'America/Los_Angeles';
    state.transactions = [transaction('today', 1000, { date: '2026-10-17' }), transaction('older', 2000, { date: '2020-01-01' })];
    await db.query("INSERT INTO users(id,email) VALUES('schedule','schedule@test.invalid')");
    await db.query('INSERT INTO workspaces(owner_id,state) VALUES($1,$2)', ['schedule', JSON.stringify(state)]);
    const ledgerReads: string[] = [];
    const traced: Database = {
      ...db,
      transaction: fn => db.transaction(tx => fn({ query: async (sql, params) => {
        const result = await tx.query(sql, params);
        if (sql.includes('AS state,revision') || sql.includes('SELECT state,revision')) {
          ledgerReads.push(sql);
          expect(JSON.stringify(result.rows)).not.toContain('older');
        }
        return result;
      } })),
      query: async (sql, params) => {
        if (sql.includes('SELECT state,revision')) ledgerReads.push(sql);
        return db.query(sql, params);
      },
    };
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-17T20:00:00Z'));
      await notificationWorker(traced, Date.now() + 15000);
      expect(ledgerReads).toHaveLength(0);
      vi.setSystemTime(new Date('2026-10-18T02:00:00Z'));
      await db.query("UPDATE notification_schedule SET checked_at=now()-interval '1 hour'");
      await notificationWorker(traced, Date.now() + 15000);
      expect(ledgerReads).toHaveLength(1);
      const version = (await db.query("SELECT revision FROM workspaces WHERE owner_id='schedule'")).rows[0].revision;
      await db.query("UPDATE notification_schedule SET checked_at=now()-interval '1 hour'");
      await notificationWorker(traced, Date.now() + 15000);
      expect(ledgerReads).toHaveLength(1);
      expect((await db.query("SELECT revision FROM workspaces WHERE owner_id='schedule'")).rows[0].revision).toBe(version);
    } finally { vi.useRealTimers(); }
  });
  it('enqueues atomically, delivers once, skips disabled alerts and removes devices on logout', async () => {
    const session = (
      await db.query('SELECT token_hash FROM sessions WHERE owner_id=$1', ['alerts'])
    ).rows[0].token_hash;
    await db.query(
      'INSERT INTO notification_devices(id,owner_id,session_hash,token,environment) VALUES($1,$2,$3,$4,$5)',
      ['device', 'alerts', session, 'a'.repeat(64), 'sandbox'],
    );
    const current = new Date().toISOString();
    await mutateState(db, 'alerts', (state) => ({
      ...state,
      transactions: [transaction('new', 500000, { date: current.slice(0, 10) })],
      settings: { ...state.settings, timezone: 'UTC' },
    }));
    expect((await db.query('SELECT * FROM notification_deliveries')).rows).toHaveLength(1);
    await notificationWorker(db, Date.now() + 15000, async () => 400);
    expect((await db.query('SELECT * FROM notification_devices')).rows).toHaveLength(1);
    await db.query("UPDATE notification_deliveries SET available_at=now() WHERE status='pending'");
    let sent = 0;
    await notificationWorker(db, Date.now() + 15000, async () => {
      sent++;
      return 200;
    });
    await notificationWorker(db, Date.now() + 15000, async () => {
      sent++;
      return 200;
    });
    expect(sent).toBeGreaterThanOrEqual(1);
    expect(
      (await db.query("SELECT * FROM notification_deliveries WHERE status='pending'")).rows,
    ).toHaveLength(0);
    await fetch(base + '/auth/logout', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect((await db.query('SELECT * FROM notification_devices')).rows).toHaveLength(0);
  });
});
