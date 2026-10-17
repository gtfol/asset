import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { Server } from 'node:http';
import {
  applyProviderRecords,
  collectSync,
  PlaidError,
  encryptToken,
  decryptToken,
  verifyWebhook,
  enqueueWebhook,
  processJob,
  syncConnection,
  createLinkToken,
  exchangeLink,
  disconnect,
  type Connection,
  type PlaidProvider,
} from '../server/plaid';
import { openDatabase, getState, mutateState, type Database } from '../server/db';
import { createApp } from '../server/app';
import { newSession, tokenHash } from '../server/auth';
import { googleWorkspace } from '../server/google';
import type { Response } from 'express';
import { fixture, transaction } from './fixtures';
import { importFingerprint } from '../shared/core';
const c: Connection = {
  id: 'c',
  owner_id: 'owner',
  item_id: 'item',
  institution_id: 'ins',
  institution_name: 'Test institution',
  encrypted_token: '',
  product: 'transactions',
  environment: 'sandbox',
  cursor: 'old',
  selected_accounts: ['provider-a'],
  status: 'healthy',
  last_synced_at: null,
  initial_complete: true,
  historical_complete: true,
  error_code: null,
};
function raw(id = 'tx', extra: any = {}) {
  return {
    transaction_id: id,
    account_id: 'provider-a',
    name: 'Test',
    date: '2024-02-15',
    amount: 10,
    iso_currency_code: 'USD',
    pending: false,
    personal_finance_category: { primary: 'GENERAL_MERCHANDISE' },
    ...extra,
  };
}
const account = {
  account_id: 'provider-a',
  name: 'Provider account',
  type: 'depository',
  subtype: 'checking',
  balances: { current: 1000, iso_currency_code: 'USD' },
  mask: '1234',
};
function provider(fn: (path: string, body: any) => any): PlaidProvider {
  return { call: async (path, body) => fn(path, body) };
}
beforeAll(() => {
  vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'a'.repeat(64));
});
afterAll(() => vi.unstubAllEnvs());
describe('provider reconciliation', () => {
  it('accepts long bank descriptions while retaining the full original', () => {
    const s = fixture();
    s.accounts[0].connectionId = c.id;
    s.accounts[0].providerId = 'provider-a';
    const description = 'Detailed bank transfer description '.repeat(10);
    applyProviderRecords(s, c, { added: [raw('long-name', { name: description })], modified: [], removed: [] });
    const t = s.transactions.find(t => t.providerId === 'long-name')!;
    expect(t.name).toHaveLength(160);
    expect(t.raw?.name).toBe(description);
  });
  it('encrypts authenticated tokens, rejects tampering', () => {
    const cipher = encryptToken('test-access-token');
    expect(cipher).not.toContain('test-access');
    expect(decryptToken(cipher)).toBe('test-access-token');
    const parts = cipher.split('.');
    parts[2] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptToken(parts.join('.'))).toThrow();
  });
  it('restarts whole pagination from the original cursor after mutation', async () => {
    const cursors: any[] = [];
    let n = 0;
    const p = provider((path, b) => {
      cursors.push(b.cursor);
      n++;
      if (n === 2) throw new PlaidError('TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION');
      return {
        added: [raw(String(n))],
        modified: [],
        removed: [],
        next_cursor: 'cursor' + n,
        has_more: n === 1 || n === 3,
      };
    });
    const result = await collectSync(p, 'secret', 'old');
    expect(cursors).toEqual(['old', 'cursor1', 'old', 'cursor3']);
    expect(result.added.map((r) => r.transaction_id)).toEqual(['3', '4']);
    expect(result.cursor).toBe('cursor4');
  });
  it('is idempotent, replaces pending records and preserves manual corrections', () => {
    let s = fixture();
    s.accounts[0] = { ...s.accounts[0], connectionId: 'c', providerId: 'provider-a' };
    s = applyProviderRecords(s, c, {
      added: [raw('pending', { pending: true })],
      modified: [],
      removed: [],
    });
    s.transactions[0].edits = { name: 'My corrected name', categoryId: 'food', notes: 'Keep me' };
    const id = s.transactions[0].id;
    s = applyProviderRecords(s, c, {
      added: [raw('posted', { pending_transaction_id: 'pending' })],
      modified: [],
      removed: [{ transaction_id: 'pending' }],
    });
    s = applyProviderRecords(s, c, {
      added: [raw('posted', { pending_transaction_id: 'pending' })],
      modified: [],
      removed: [],
    });
    expect(s.transactions).toHaveLength(1);
    expect(s.transactions[0]).toMatchObject({
      id,
      pending: false,
      removed: false,
      edits: { name: 'My corrected name', categoryId: 'food', notes: 'Keep me' },
    });
    s = applyProviderRecords(s, c, {
      added: [],
      modified: [raw('posted', { amount: 12 })],
      removed: [],
    });
    expect(s.transactions[0].amount).toBe(1200);
    s = applyProviderRecords(s, c, {
      added: [],
      modified: [],
      removed: [{ transaction_id: 'posted' }],
    });
    expect(s.transactions[0].removed).toBe(true);
  });
  it('merges exact manual overlap and flags amount conflicts without corrupting splits', () => {
    const s = fixture();
    s.accounts[0] = { ...s.accounts[0], connectionId: 'c', providerId: 'provider-a' };
    s.transactions = [
      transaction('manual', 1000, {
        categoryId: 'other',
        splits: [
          { id: 'p1', categoryId: 'food', amount: 500, excluded: false },
          { id: 'p2', categoryId: 'other', amount: 500, excluded: false },
        ],
      }),
    ];
    applyProviderRecords(s, c, { added: [raw()], modified: [], removed: [] });
    expect(s.transactions).toHaveLength(1);
    expect(s.transactions[0].id).toBe('manual');
    applyProviderRecords(s, c, { added: [], modified: [raw('tx', { amount: 12 })], removed: [] });
    expect(s.transactions[0].amount).toBe(1000);
    expect(s.transactions[0].raw?.asset_split_conflict).toBe(true);
  });
  it('matches original CSV identity after user edits and preserves it after provider attachment', () => {
    const s = fixture();
    s.accounts[0] = { ...s.accounts[0], connectionId: 'c', providerId: 'provider-a' };
    const imported = transaction('csv-record', 1000, { source: 'csv' });
    imported.fingerprint = importFingerprint(imported);
    imported.name = 'Rule-renamed merchant';
    imported.edits = { name: 'My name', date: '2024-02-16' };
    s.transactions = [imported];
    applyProviderRecords(s, c, { added: [raw()], modified: [], removed: [] });
    expect(s.transactions).toHaveLength(1);
    expect(s.transactions[0]).toMatchObject({
      id: 'csv-record',
      source: 'plaid',
      fingerprint: imported.fingerprint,
      edits: { name: 'My name', date: '2024-02-16' },
    });
  });
  it('verifies ES256, body digest, algorithm, and issued-at window', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const key = await exportJWK(publicKey);
    const body = Buffer.from('{"item_id":"item"}');
    const p = provider(() => ({ key }));
    const jwt = await new SignJWT({
      request_body_sha256: createHash('sha256').update(body).digest('hex'),
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'fixture-key' })
      .setIssuedAt()
      .sign(privateKey);
    expect(await verifyWebhook(p, body, jwt)).toBe(true);
    expect(await verifyWebhook(p, Buffer.from('{}'), jwt)).toBe(false);
    expect(await verifyWebhook(p, body, jwt, Date.now() + 6 * 60000)).toBe(false);
    expect(await verifyWebhook(p, body, jwt, Date.now() - 60000)).toBe(false);
    expect(await verifyWebhook(p, body, 'forged')).toBe(false);
  });
});
describe('durable database and authenticated API', () => {
  let db: Database;
  let server: Server;
  let base: string;
  let path: string;
  let tokenA: string;
  let tokenB: string;
  const fake = provider((path, b) => {
    if (path === '/accounts/get') return { accounts: [account] };
    if (path === '/transactions/sync')
      return { added: [raw()], modified: [], removed: [], next_cursor: 'next', has_more: false };
    if (path === '/item/remove') return {};
    if (path === '/link/token/create') return b;
    throw Error('Unexpected endpoint ' + path);
  });
  async function request(path: string, token?: string, body?: any) {
    const r = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        'content-type': 'application/json',
        'x-asset-client': 'ios',
        ...(token ? { authorization: 'Bearer ' + token } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, data: (await r.json()) as any };
  }
  beforeAll(async () => {
    path = await mkdtemp(join(tmpdir(), 'asset-test-'));
    db = await openDatabase(path);
    await db.query('INSERT INTO users(id,email) VALUES($1,$2)', [
      'owner',
      'fixture@example.invalid',
    ]);
    await db.query('INSERT INTO workspaces(owner_id,state) VALUES($1,$2)', [
      'owner',
      JSON.stringify(fixture()),
    ]);
    await db.query(
      'INSERT INTO connections(id,owner_id,item_id,institution_id,institution_name,encrypted_token,product,selected_accounts,status,cursor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [
        'c',
        'owner',
        'item',
        'ins',
        'Test',
        encryptToken('secret'),
        'transactions',
        JSON.stringify(['provider-a']),
        'initial_loading',
        'old',
      ],
    );
    server = createApp(db, fake).listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as any).port}/api`;
    const ownerA = await googleWorkspace(db, { id: 'google-a', email: 'a@example.invalid' });
    const ownerB = await googleWorkspace(db, { id: 'google-b', email: 'b@example.invalid' });
    const cookies = { cookie() {} } as unknown as Response;
    tokenA = await newSession(db, ownerA, cookies);
    tokenB = await newSession(db, ownerB, cookies);
  }, 30000);
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    await rm(path, { recursive: true, force: true });
  }, 30000);
  it('requires login, isolates owner data, rejects cross-owner and stale writes', async () => {
    expect((await request('/state')).status).toBe(401);
    const p = { ...fixture().accounts[0], id: 'private-a' };
    expect(
      (await request('/command', tokenA, { type: 'account.save', payload: p, revision: 0 })).status,
    ).toBe(200);
    expect((await request('/state', tokenB)).data.state.accounts).toHaveLength(0);
    expect((await request('/plaid/c/sync', tokenB, {})).status).toBe(404);
    expect(
      (await request('/command', tokenA, { type: 'account.save', payload: p, revision: 0 })).status,
    ).toBe(409);
  });
  it('revokes the supplied native bearer session without relying on browser cookies', async () => {
    const owner = (
      await db.query('SELECT owner_id FROM sessions WHERE token_hash=$1', [tokenHash(tokenA)])
    ).rows[0].owner_id;
    const session = await newSession(db, owner, { cookie() {} } as unknown as Response);
    expect((await request('/state', session)).status).toBe(200);
    expect((await request('/auth/logout', session, {})).status).toBe(200);
    expect((await request('/state', session)).status).toBe(401);
    expect((await request('/state', tokenA)).status).toBe(200);
  });
  it('rolls back failed state changes and persists across reopening', async () => {
    const before = await getState(db, 'owner');
    await expect(
      mutateState(db, 'owner', (s) => ({
        ...s,
        transactions: [transaction('invalid', 100, { accountId: 'missing' })],
      })),
    ).rejects.toThrow();
    expect(await getState(db, 'owner')).toEqual(before);
    const file = await mkdtemp(join(tmpdir(), 'asset-durability-'));
    const saved = await openDatabase(file);
    await saved.query('INSERT INTO users(id,email) VALUES($1,$2)', [
      'persist',
      'persist@example.invalid',
    ]);
    await saved.close();
    const reopened = await openDatabase(file);
    expect(
      (await reopened.query('SELECT email FROM users WHERE id=$1', ['persist'])).rows[0].email,
    ).toBe('persist@example.invalid');
    await reopened.close();
    await rm(file, { recursive: true, force: true });
  }, 60000);
  it('commits cursor and records together, leaves cursor untouched on page failure', async () => {
    const broken = provider((path, b) => {
      if (path === '/accounts/get') return { accounts: [account] };
      if (b.cursor === 'old')
        return {
          added: [raw('partial')],
          modified: [],
          removed: [],
          next_cursor: 'half',
          has_more: true,
        };
      throw new PlaidError('INTERNAL_SERVER_ERROR');
    });
    await expect(syncConnection(db, broken, 'c', 'owner')).rejects.toThrow();
    expect(
      (await db.query('SELECT cursor FROM connections WHERE id=$1', ['c'])).rows[0].cursor,
    ).toBe('old');
    expect((await getState(db, 'owner')).state.transactions).toHaveLength(0);
    await syncConnection(db, fake, 'c', 'owner');
    expect(
      (await db.query('SELECT cursor FROM connections WHERE id=$1', ['c'])).rows[0].cursor,
    ).toBe('next');
    expect((await getState(db, 'owner')).state.transactions).toHaveLength(1);
    await syncConnection(db, fake, 'c', 'owner');
    expect((await getState(db, 'owner')).state.transactions).toHaveLength(1);
  });
  it('coalesces pending webhook work and keeps completion flags monotonic out of order', async () => {
    const event = Buffer.from(
      JSON.stringify({
        item_id: 'item',
        webhook_code: 'SYNC_UPDATES_AVAILABLE',
        initial_update_complete: true,
        historical_update_complete: true,
      }),
    );
    await enqueueWebhook(db, event);
    await enqueueWebhook(db, event);
    await enqueueWebhook(
      db,
      Buffer.from(
        JSON.stringify({
          item_id: 'item',
          webhook_code: 'SYNC_UPDATES_AVAILABLE',
          initial_update_complete: false,
          historical_update_complete: false,
        }),
      ),
    );
    expect((await db.query('SELECT * FROM sync_jobs')).rows).toHaveLength(1);
    expect(
      (await db.query('SELECT historical_complete FROM connections WHERE id=$1', ['c'])).rows[0]
        .historical_complete,
    ).toBe(true);
    await processJob(db, fake);
    expect((await db.query("SELECT * FROM sync_jobs WHERE status='done'")).rows).toHaveLength(1);
  });
  it('requests 730 history days and updates existing Items without adding products', async () => {
    const fresh: any = await createLinkToken(db, fake, 'owner', 'transactions');
    expect(fresh.transactions.days_requested).toBe(730);
    expect(fresh.products).toEqual(['transactions']);
    const update: any = await createLinkToken(db, fake, 'owner', 'transactions', 'c');
    expect(update.access_token).toBe('secret');
    expect(update.products).toBeUndefined();
    expect(update.update.account_selection_enabled).toBe(true);
  });
  it('rejects duplicate institution connections and revokes the redundant token', async () => {
    const calls: string[] = [];
    const p = provider((path, b) => {
      calls.push(path);
      if (path === '/item/public_token/exchange')
        return { access_token: 'redundant', item_id: 'redundant-item' };
      if (path === '/item/get') return { item: { institution_id: 'ins' } };
      if (path === '/item/remove') return {};
      throw Error('unexpected ' + path);
    });
    await expect(
      exchangeLink(db, p, 'owner', 'public', 'transactions', ['provider-a']),
    ).rejects.toThrow('DUPLICATE_CONNECTION');
    expect(calls).toContain('/item/remove');
  });
  it('requires reauthentication on login errors and marks unsupported products explicitly', async () => {
    await expect(
      syncConnection(
        db,
        provider(() => {
          throw new PlaidError('ITEM_LOGIN_REQUIRED');
        }),
        'c',
        'owner',
      ),
    ).rejects.toThrow();
    expect(
      (await db.query('SELECT status FROM connections WHERE id=$1', ['c'])).rows[0].status,
    ).toBe('reauthentication_required');
    await expect(
      syncConnection(
        db,
        provider(() => {
          throw new PlaidError('PRODUCT_NOT_SUPPORTED');
        }),
        'c',
        'owner',
      ),
    ).rejects.toThrow();
    expect(
      (await db.query('SELECT status FROM connections WHERE id=$1', ['c'])).rows[0].status,
    ).toBe('unsupported');
  });
  it('honors changed account selection without deleting financial history', async () => {
    await db.query('UPDATE connections SET selected_accounts=$1 WHERE id=$2', [
      JSON.stringify([]),
      'c',
    ]);
    await syncConnection(db, fake, 'c', 'owner');
    expect(
      (await getState(db, 'owner')).state.accounts.find((a) => a.connectionId === 'c')?.enabled,
    ).toBe(false);
    expect((await getState(db, 'owner')).state.transactions).toHaveLength(1);
    await db.query('UPDATE connections SET selected_accounts=$1 WHERE id=$2', [
      JSON.stringify(['provider-a']),
      'c',
    ]);
    await syncConnection(db, fake, 'c', 'owner');
    expect(
      (await getState(db, 'owner')).state.accounts.find((a) => a.connectionId === 'c')?.enabled,
    ).toBe(true);
  });
  it('loads separate investment pages, preserves unknown prices, snapshots holdings, and processes updates', async () => {
    await db.query(
      'INSERT INTO connections(id,owner_id,item_id,institution_id,institution_name,encrypted_token,product,selected_accounts,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        'inv',
        'owner',
        'investment-item',
        'broker',
        'Broker',
        encryptToken('inv-secret'),
        'investments',
        JSON.stringify(['provider-a']),
        'initial_loading',
      ],
    );
    const endpoints: string[] = [];
    const offsets: number[] = [];
    const p = provider((path, b) => {
      endpoints.push(path);
      if (path === '/accounts/get') return { accounts: [{ ...account, type: 'investment' }] };
      if (path === '/investments/holdings/get')
        return {
          holdings: [
            {
              account_id: 'provider-a',
              security_id: 'security',
              quantity: 4,
              institution_price: null,
              institution_value: null,
              cost_basis: 0,
              iso_currency_code: 'USD',
            },
          ],
          securities: [
            {
              security_id: 'security',
              name: 'Unknown quote',
              ticker_symbol: 'TEST',
              type: 'equity',
              close_price: null,
            },
          ],
        };
      if (path === '/investments/transactions/get') {
        offsets.push(b.options.offset);
        return {
          investment_transactions: Array.from(
            { length: b.options.offset === 0 ? 500 : 1 },
            (_, i) => ({
              investment_transaction_id: 'activity-' + (b.options.offset + i),
              account_id: 'provider-a',
              date: '2026-10-01',
              type: 'buy',
              amount: 10,
              iso_currency_code: 'USD',
              name: 'Buy',
              security_id: 'security',
              quantity: 1,
            }),
          ),
          total_investment_transactions: 501,
        };
      }
      throw Error('Unexpected endpoint ' + path);
    });
    await syncConnection(db, p, 'inv', 'owner');
    const state = (await getState(db, 'owner')).state;
    expect(offsets).toEqual([0, 500]);
    expect(endpoints).not.toContain('/transactions/sync');
    expect(state.holdings[0]).toMatchObject({
      price: null,
      marketValue: null,
      costBasis: 0,
      priceAt: null,
    });
    expect(state.investmentActivity).toHaveLength(501);
    expect(state.holdingSnapshots).toHaveLength(1);
    expect(state.transactions).toHaveLength(1);
    await enqueueWebhook(
      db,
      Buffer.from(
        JSON.stringify({
          item_id: 'investment-item',
          webhook_type: 'HOLDINGS',
          webhook_code: 'DEFAULT_UPDATE',
        }),
      ),
    );
    expect(
      (await db.query('SELECT * FROM sync_jobs WHERE connection_id=$1', ['inv'])).rows,
    ).toHaveLength(1);
  });
  it('disconnects access without deleting imported data by default', async () => {
    const before = (await getState(db, 'owner')).state.transactions.length;
    await disconnect(db, fake, 'owner', 'c');
    const row = (await db.query('SELECT * FROM connections WHERE id=$1', ['c'])).rows[0];
    expect(row.status).toBe('disconnected');
    expect(row.encrypted_token).toBe('');
    expect((await getState(db, 'owner')).state.transactions).toHaveLength(before);
  });
});
