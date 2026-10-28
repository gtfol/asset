import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, getState, getSyncState, mutateState, type Database, type SQL } from '../server/db';
import { commandScope } from '../server/state-scope';
import { applyCommand, type Command } from '../shared/core';
import { applyStateDelta, stateDelta, applyWorkspaceUpdate, type WorkspaceUpdate } from '../shared/delta';
import { createLocalWorkspace, localCommand, receiveWorkspace, workspaceSyncPath, type LocalWorkspace } from '../shared/workspace';
import { encryptToken, syncConnection, type PlaidProvider } from '../server/plaid';
import { fixture, transaction } from './fixtures';

function traffic(db: Database) {
  let bytes = 0, largest = 0;
  const wrap = (sql: SQL): SQL => ({ query: async <T>(q: string, p?: unknown[]) => {
    const result = await sql.query<T>(q, p), size = Buffer.byteLength(JSON.stringify(result.rows));
    bytes += size; largest = Math.max(largest, size); return result;
  } });
  return { db: { ...wrap(db), transaction: <T>(fn: (tx: SQL) => Promise<T>) => db.transaction(tx => fn(wrap(tx))), close: () => db.close() } as Database,
    reset: () => { bytes = largest = 0; }, stats: () => ({ bytes, largest }) };
}
const largeState = () => {
  const s = fixture(); s.notifications = { preferences: { bankFee: true, bigExpense: true, creditUtilization: true, income: true,
    recurringPaid: true, spending: true, uncategorizedTransfer: true, venmo: true, bigExpenseAmount: 50000, creditUtilizationPercent: 30 }, items: [] };
  s.accounts[0] = { ...s.accounts[0], source: 'plaid', connectionId: 'bank', providerId: 'bank-a', mask: '1234' };
  s.transactions = Array.from({ length: 6000 }, (_, i) => transaction('old-' + i, 12345, {
    source: 'plaid', connectionId: 'bank', providerId: 'provider-' + i,
    notes: 'preserved user notes '.repeat(40), raw: { original_description: 'bank details '.repeat(15) }, reviewed: true,
    edits: { categoryId: 'food' }, date: '2020-01-01',
  }));
  return s;
};
describe('record-level sync and database egress', () => {
  let db: Database;
  beforeAll(async () => { vi.stubEnv('DATABASE_URL', undefined); vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'b'.repeat(64)); db = await openDatabase(':memory:'); }, 30000);
  beforeEach(async () => { await db.query('DELETE FROM users'); await db.query("INSERT INTO users(id,email) VALUES('owner','delta@example.invalid')"); });
  afterAll(async () => { await db.close(); vi.unstubAllEnvs(); });
  async function save(state = largeState()) {
    await db.query('INSERT INTO workspaces(owner_id,state) VALUES($1,$2)', ['owner', JSON.stringify(state)]);
  }
  async function bank() {
    await db.query(`INSERT INTO connections(id,owner_id,item_id,institution_id,institution_name,encrypted_token,product,selected_accounts,status,cursor,initial_complete,historical_complete)
      VALUES('bank','owner','item','institution','Test',$1,'transactions','["bank-a"]','healthy','cursor',true,true)`, [encryptToken('test')]);
  }
  const provider = (records: any = { added: [], modified: [], removed: [] }): PlaidProvider => ({ call: async (path) => (path === '/accounts/get'
    ? { accounts: [{ account_id: 'bank-a', name: 'Bank checking', mask: '1234', type: 'depository', subtype: 'checking', balances: { current: 1000, iso_currency_code: 'USD' } }] }
    : { ...records, next_cursor: 'next', has_more: false, transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE' }) as any });

  it('edits one transaction without fetching or returning unrelated history', async () => {
    const state = largeState(); await save(state);
    const fullBytes = Buffer.byteLength(JSON.stringify(state)), measured = traffic(db);
    const command: Command = { type: 'transaction.update', payload: { id: 'old-42', edits: { notes: 'Updated note' }, reviewed: true } };
    await mutateState(measured.db, 'owner', s => applyCommand(s, command), undefined, false, undefined, commandScope(command));
    const update = await getSyncState(measured.db, 'owner', { ownerId: 'owner', revision: 0, delta: true });
    expect(update).not.toHaveProperty('state');
    expect(measured.stats().bytes).toBeLessThan(20000);
    const stored = (await getState(db, 'owner')).state;
    expect(stored).toEqual(applyWorkspaceUpdate(state, 0, update));
    expect(stored.transactions).toHaveLength(6000);
    expect(stored.transactions[41]).toEqual(state.transactions[41]);
    expect(stored.transactions[42].edits.notes).toBe('Updated note');
    console.info('Delta edit transfer', { fullBytes, ...measured.stats(), clientBytes: Buffer.byteLength(JSON.stringify(update)) });
  });
  it('links loan payments with a small delta and keeps the link through a bank refresh', async () => {
    const state = largeState();
    state.accounts.push({ ...state.accounts[0], id: 'loan', type: 'loan', name: 'Car loan', source: 'manual', connectionId: undefined, providerId: undefined });
    await save(state); await bank(); const measured = traffic(db);
    const command: Command = { type: 'transactions.linkLoan', payload: { ids: ['old-42'], loanAccountId: 'loan' } };
    await mutateState(measured.db, 'owner', s => applyCommand(s, command), undefined, false, undefined, commandScope(command));
    const update = await getSyncState(measured.db, 'owner', { ownerId: 'owner', revision: 0, delta: true });
    expect(update).not.toHaveProperty('state');
    expect(measured.stats().bytes).toBeLessThan(20000);
    expect((await getState(db, 'owner')).state).toEqual(applyWorkspaceUpdate(state, 0, update));
    await syncConnection(db, provider({ added: [], modified: [{ transaction_id: 'provider-42', account_id: 'bank-a', name: 'Car payment', date: '2020-01-01', amount: 123.45, iso_currency_code: 'USD', pending: false }], removed: [] }), 'bank', 'owner');
    const after = (await getState(db, 'owner')).state;
    expect(after.transactions.find(t => t.id === 'old-42')?.edits.loanAccountId).toBe('loan');
    const changeType: Command = { type: 'account.save', payload: { ...after.accounts.find(a => a.id === 'loan')!, type: 'checking' } };
    await expect(mutateState(db, 'owner', s => applyCommand(s, changeType), undefined, false, undefined, commandScope(changeType))).rejects.toThrow('separate loan');
  });
  it('bank refreshes exclude old history, preserve coverage, and do not churn unchanged snapshots', async () => {
    await save(); await bank(); const measured = traffic(db);
    await syncConnection(measured.db, provider(), 'bank', 'owner');
    expect(measured.stats().bytes).toBeLessThan(20000);
    const initial = await getState(db, 'owner');
    expect(initial.state.transactions).toHaveLength(6000);
    expect(initial.state.accounts[0].coverageStart).toBe('2020-01-01');
    measured.reset(); await syncConnection(measured.db, provider(), 'bank', 'owner');
    expect((await getState(db, 'owner')).revision).toBe(initial.revision);
    expect(measured.stats().bytes).toBeLessThan(20000);
    console.info('Idle bank transfer', measured.stats());
  });
  it('preserves CSV choices, handles pending replacement/removal, and recalculates earliest coverage from unselected history', async () => {
    const state = largeState();
    state.transactions[0].date = '2019-01-01';
    state.transactions[1].recurring = 'Monthly subscription';
    state.transactions.push(transaction('csv', 985, { name: 'Coffee Shop', date: '2026-10-23', source: 'csv', reviewed: true,
      notes: 'My notes', edits: { categoryId: 'food', excluded: true } }));
    state.transactions.push(transaction('pending', 475, { date: '2026-10-23', source: 'plaid', connectionId: 'bank', providerId: 'pending-1', pending: true,
      edits: { notes: 'Keep this' }, reviewed: true }));
    await save(state); await bank(); const measured = traffic(db);
    await syncConnection(measured.db, provider({ added: [
      { transaction_id: 'coffee', account_id: 'bank-a', merchant_name: 'Coffee Shop', date: '2026-10-23', amount: 9.85, iso_currency_code: 'USD', pending: false },
      { transaction_id: 'posted-1', pending_transaction_id: 'pending-1', account_id: 'bank-a', name: 'Test', date: '2026-10-24', amount: 4.75, iso_currency_code: 'USD', pending: false },
    ], modified: [], removed: [{ transaction_id: 'provider-0' }, { transaction_id: 'pending-1' }] }), 'bank', 'owner');
    expect(measured.stats().bytes).toBeLessThan(30000);
    const next = (await getState(db, 'owner')).state;
    expect(next.transactions).toHaveLength(6002);
    expect(next.transactions.find(t => t.id === 'csv')).toMatchObject({ providerId: 'coffee', reviewed: true, notes: 'My notes', edits: { categoryId: 'food', excluded: true } });
    expect(next.transactions.find(t => t.id === 'pending')).toMatchObject({ providerId: 'posted-1', pending: false, removed: false, edits: { notes: 'Keep this' } });
    expect(next.transactions[0].removed).toBe(true);
    expect(next.accounts[0].coverageStart).toBe('2020-01-01');
  });
  it('rejects duplicate records and unsafe aggregate totals in scoped edits without altering the journal', async () => {
    await save();
    const duplicate: Command = { type: 'transaction.create', payload: transaction('old-5', 1) };
    await expect(mutateState(db, 'owner', s => applyCommand(s, duplicate), undefined, false, undefined, commandScope(duplicate))).rejects.toThrow('Duplicate');
    const unknown: Command = { type: 'transaction.update', payload: { id: 'old-5', edits: { categoryId: 'missing' } } };
    await expect(mutateState(db, 'owner', s => applyCommand(s, unknown), undefined, false, undefined, commandScope(unknown))).rejects.toThrow('missing');
    expect((await db.query('SELECT * FROM workspace_changes')).rows).toHaveLength(0);
    expect((await getState(db, 'owner')).revision).toBe(0);
    // A valid aggregate just below MAX_SAFE_INTEGER can become invalid even
    // though the one new snapshot and the scoped view are individually valid.
    await db.query(`UPDATE workspaces SET state=jsonb_set(state,'{snapshots}',(
      SELECT jsonb_agg(jsonb_build_object('id','old-snapshot-'||n,'accountId','a','date','2020-01-01',
        'balance',100000000000,'currency','USD','source','manual')) FROM generate_series(1,90071) n)) WHERE owner_id='owner'`);
    const snapshot: Command = { type: 'snapshot.save', payload: { id: 'overflow', accountId: 'a', date: '2026-10-24', balance: 100000000000, currency: 'USD', source: 'manual' } };
    await expect(mutateState(db, 'owner', s => applyCommand(s, snapshot), undefined, false, undefined, commandScope(snapshot))).rejects.toThrow('exact arithmetic');
    expect((await db.query("SELECT revision,jsonb_array_length(state->'snapshots') AS count FROM workspaces WHERE owner_id='owner'")).rows[0]).toEqual({ revision: 0, count: 90071 });
  });
  it('compares investment snapshots in Postgres and returns only IDs for identical activity', async () => {
    await save(); await bank();
    await db.query("UPDATE connections SET product='investments' WHERE id='bank'");
    const activity = Array.from({ length: 1000 }, (_, i) => ({ investment_transaction_id: 'investment-' + i, account_id: 'bank-a',
      security_id: 'stock', date: '2026-10-01', type: 'buy', amount: 10, quantity: 1, iso_currency_code: 'USD', name: 'Original investment detail '.repeat(20) }));
    const p: PlaidProvider = { call: async (path, body) => {
      if (path === '/accounts/get') return (await provider().call(path, body)) as any;
      if (path === '/investments/holdings/get') return { holdings: [], securities: [] } as any;
      const offset = (body.options as any).offset;
      return { investment_transactions: activity.slice(offset, offset + 500), total_investment_transactions: activity.length } as any;
    } };
    await syncConnection(db, p, 'bank', 'owner');
    const before = (await getState(db, 'owner')).revision, measured = traffic(db);
    await syncConnection(measured.db, p, 'bank', 'owner');
    expect((await getState(db, 'owner')).revision).toBe(before);
    expect(measured.stats().bytes).toBeLessThan(70000);
    activity[42].amount = 11;
    measured.reset(); await syncConnection(measured.db, p, 'bank', 'owner');
    const update = await getSyncState(measured.db, 'owner', { ownerId: 'owner', revision: before, delta: true });
    expect(update).not.toHaveProperty('state');
    expect('delta' in update && update.delta?.patches[0].collections.investmentActivity?.upserts).toHaveLength(1);
    expect((await getState(db, 'owner')).state.investmentActivity).toHaveLength(1000);
    expect(measured.stats().bytes).toBeLessThan(75000);
    console.info('Investment transfer', measured.stats());
  });
  it('falls back safely for journal gaps, another owner, and revisions from the future', async () => {
    await save(fixture());
    for (const currency of ['EUR', 'GBP']) {
      const cmd = { type: 'settings.save', payload: { currency } };
      await mutateState(db, 'owner', s => applyCommand(s, cmd), undefined, false, undefined, {});
    }
    expect(await getSyncState(db, 'owner', { ownerId: 'owner', revision: 0, delta: true })).toHaveProperty('delta.patches.length', 2);
    await db.query('DELETE FROM workspace_changes WHERE revision=1');
    for (const known of [{ ownerId: 'owner', revision: 0 }, { ownerId: 'other', revision: 1 }, { ownerId: 'owner', revision: 4 }])
      expect(await getSyncState(db, 'owner', { ...known, delta: true })).toHaveProperty('state');
    expect(await getSyncState(db, 'owner', { ownerId: 'owner', revision: 2, delta: true })).toEqual({ unchanged: true, revision: 2 });
  });
  it('applies deletions, new records, optional-value removal, and rule priority', () => {
    const state = fixture(), next = structuredClone(state);
    state.transactions.push(transaction('removed', 5)); next.transactions.push(transaction('new', 6));
    next.rules = [{ id: 'first', contains: 'shop', categoryId: 'food', enabled: true } as any];
    const delta = stateDelta(state, next);
    expect(applyStateDelta(state, delta)).toEqual(next);
    expect(() => applyWorkspaceUpdate(state, 2, { revision: 3, delta: { fromRevision: 1, patches: [delta] } })).toThrow('saved version');
  });
  it('replays pending creates on the server base without duplicate transactions after an acknowledgement', () => {
    const state = fixture(), owner = randomUUID();
    let doc: LocalWorkspace = { ...createLocalWorkspace(randomUUID()), owner, state };
    doc = localCommand(doc, { type: 'transaction.create', payload: transaction('first', 4) }, randomUUID());
    doc = localCommand(doc, { type: 'transaction.create', payload: transaction('second', 8) }, randomUUID());
    const first = applyCommand(state, doc.pending[0].command as Command, doc.pending[0].timestamp);
    doc = receiveWorkspace(doc, { revision: 1, delta: { fromRevision: 0, patches: [stateDelta(state, first)] } }, doc.pending[0].id);
    expect(doc.state.transactions.map(t => t.id)).toEqual(['first', 'second']); expect(doc.pending).toHaveLength(1);
    const second = applyCommand(first, doc.pending[0].command as Command, doc.pending[0].timestamp);
    doc = receiveWorkspace(doc, { revision: 2, delta: { fromRevision: 1, patches: [stateDelta(first, second)] } }, doc.pending[0].id);
    expect(doc.pending).toHaveLength(0); expect(doc.state).toEqual(second);
    const legacy = { ...doc, base: undefined, pending: [{ ...localCommand({ ...doc, pending: [] }, { type: 'settings.save', payload: { currency: 'EUR' } }, randomUUID()).pending[0] }] };
    expect(workspaceSyncPath(legacy)).not.toContain('delta=1');
  });
});
