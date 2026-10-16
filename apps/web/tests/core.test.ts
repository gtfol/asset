import { describe, it, expect } from 'vitest';
import {
  today,
  emptyState,
  applyCommand,
  validateState,
  parseMoney,
  ledger,
  totals,
  dashboard,
  cashflow,
  netWorth,
  investmentOverview,
  backup,
  applyRules,
  type Transaction,
  type State,
} from '../shared/core';
import { createDemo } from '../shared/demo';
import { previewCSV, exportCSV, type CSVOptions } from '../shared/csv';
import { fixture, transaction } from './fixtures';
describe('money and date boundaries', () => {
  it('keeps reporting dates stable across timezone midnight and DST', () => {
    expect(today('America/Los_Angeles', new Date('2024-03-10T07:30:00Z'))).toBe('2024-03-09');
    expect(today('Asia/Tokyo', new Date('2024-03-10T07:30:00Z'))).toBe('2024-03-10');
  });
  it('parses integer cents without binary arithmetic drift', () => {
    expect(parseMoney('0.29')).toBe(29);
    expect(parseMoney('-1,234.56')).toBe(-123456);
    expect(() => parseMoney('1.005')).toThrow();
    expect(() => parseMoney('NaN')).toThrow();
  });
  it('rejects impossible dates, duplicate split IDs, dangling references and invalid coverage', () => {
    const s = fixture();
    s.transactions = [transaction('1', 100, { date: '2024-02-30' })];
    expect(() => validateState(s)).toThrow();
    s.transactions = [
      transaction('1', 100, {
        splits: [
          { id: 'p', categoryId: 'food', amount: 50, excluded: false },
          { id: 'p', categoryId: 'food', amount: 50, excluded: false },
        ],
      }),
    ];
    expect(() => validateState(s)).toThrow('Duplicate split');
    s.transactions = [];
    s.accounts[0].coverageStart = '2027-01-01';
    expect(() => validateState(s)).toThrow('coverage');
  });
});
describe('one accounting model', () => {
  it('category drill-down totals count only matching split parts', () => {
    const s = fixture();
    s.transactions = [
      transaction('split', 10000, {
        splits: [
          { id: 'p1', categoryId: 'food', amount: 6000, excluded: false },
          { id: 'p2', categoryId: 'other', amount: 4000, excluded: false },
        ],
      }),
    ];
    expect(totals(s, '2024-02-01', '2024-02-29', false, 'food').spending).toBe(6000);
    expect(totals(s, '2024-02-01', '2024-02-29', false, 'other').spending).toBe(4000);
    expect(totals(s, '2024-04-01', '2024-02-29').complete).toBe(false);
  });
  it('requires an exact new split before accepting a changed provider amount', () => {
    const s = fixture();
    s.transactions = [
      transaction('split', 10000, {
        raw: { amount: 120, asset_split_conflict: true },
        splits: [
          { id: 'p1', categoryId: 'food', amount: 6000, excluded: false },
          { id: 'p2', categoryId: 'other', amount: 4000, excluded: false },
        ],
      }),
    ];
    expect(() =>
      applyCommand(s, { type: 'transactions.review', payload: { ids: ['split'], reviewed: true } }),
    ).toThrow('reconcile');
    expect(() =>
      applyCommand(s, {
        type: 'transaction.reconcile',
        payload: { id: 'split', splits: s.transactions[0].splits },
      }),
    ).toThrow('new provider amount');
    const next = applyCommand(s, {
      type: 'transaction.reconcile',
      payload: {
        id: 'split',
        splits: s.transactions[0].splits.map((p) => ({ ...p, amount: 6000 })),
      },
    });
    expect(next.transactions[0]).toMatchObject({
      amount: 12000,
      reviewed: false,
      raw: { asset_split_conflict: false },
    });
    expect(totals(next, '2024-02-01', '2024-02-29').spending).toBe(12000);
    expect(s.transactions[0].amount).toBe(10000);
  });
  it('counts splits once, refunds reduce spend, transfers and pending never spend', () => {
    const s = fixture();
    s.transactions = [
      transaction('split', 10000, {
        splits: [
          { id: 'p1', categoryId: 'food', amount: 6000, excluded: false },
          { id: 'p2', categoryId: 'other', amount: 4000, excluded: true },
        ],
      }),
      transaction('refund', 2000, { kind: 'refund' }),
      transaction('income', 20000, { kind: 'income' }),
      ...['transfer', 'card_payment', 'investment_transfer', 'investment_trade'].map((kind) =>
        transaction(kind, 999999, { kind: kind as any }),
      ),
      transaction('pending', 50000, { pending: true }),
      transaction('deleted', 50000, { removed: true }),
      transaction('future', 50000, { date: '2024-03-01' }),
    ];
    expect(totals(s, '2024-02-01', '2024-02-29')).toMatchObject({
      spending: 4000,
      income: 20000,
      net: 16000,
    });
    expect(totals(s, '2024-02-01', '2024-02-29', true).spending).toBe(8000);
    expect(dashboard(s, '2024-02', '2024-02-29').spending).toBe(4000);
  });
  it('separates currencies and excludes disabled accounts consistently', () => {
    const s = fixture();
    s.transactions = [transaction('usd', 100), transaction('eur', 999, { currency: 'EUR' })];
    expect(totals(s, '2024-02-01', '2024-02-29').spending).toBe(100);
    s.accounts[0].enabled = false;
    expect(ledger(s)).toEqual([]);
    expect(netWorth(s).total).toBe(0);
  });
  it('conserves split cents and reviews only selected records', () => {
    const s = fixture();
    s.transactions = [transaction('1', 101), transaction('2', 200)];
    expect(() =>
      applyCommand(s, {
        type: 'transaction.split',
        payload: {
          id: '1',
          splits: [
            { id: 'x', categoryId: 'food', amount: 50 },
            { id: 'y', categoryId: 'other', amount: 50 },
          ],
        },
      }),
    ).toThrow();
    const next = applyCommand(s, {
      type: 'transactions.review',
      payload: { ids: ['1'], reviewed: true },
    });
    expect(next.transactions.map((t) => t.reviewed)).toEqual([true, false]);
    expect(s.transactions[0].reviewed).toBe(false);
  });
  it('uses separate category budgets for every month and keeps archive history', () => {
    let s = fixture();
    s.transactions = [transaction('1', 500)];
    s = applyCommand(s, {
      type: 'budget.save',
      payload: { month: '2024-02', categoryId: 'food', amount: 1000 },
    });
    s = applyCommand(s, {
      type: 'budget.save',
      payload: { month: '2024-03', categoryId: 'food', amount: 2000 },
    });
    s = applyCommand(s, { type: 'category.save', payload: { ...s.categories[1], archived: true } });
    expect(
      dashboard(s, '2024-02', '2024-03-01').categories.find((c) => c.id === 'food')?.budget,
    ).toBe(1000);
    expect(dashboard(s, '2024-03', '2024-03-01').budget).toBe(2000);
  });
  it('applies exact scoped rules while preserving manual category corrections', () => {
    const s = fixture();
    s.rules = [{ id: 'r', merchant: 'Test', match: 'exact', accountId: 'a', categoryId: 'other' }];
    expect(applyRules(transaction('1', 100), s).categoryId).toBe('other');
    expect(
      applyRules(transaction('1', 100, { edits: { categoryId: 'food' } }), s).edits.categoryId,
    ).toBe('food');
    expect(applyRules(transaction('1', 100, { name: 'Test Store' }), s).categoryId).toBe('food');
  });
});
describe('calendar analytics', () => {
  it('distinguishes ideal budget pace from deterministic month-end projection', () => {
    const s = fixture();
    s.transactions = [transaction('1', 10000, { date: '2024-02-01' })];
    s.budgets = [{ month: '2024-02', categoryId: 'food', amount: 29000 }];
    const d = dashboard(s, '2024-02', '2024-02-10');
    expect(d.days).toBe(29);
    expect(d.ideal).toBe(10000);
    expect(d.projection).toBe(29000);
    expect(d.points[10].actual).toBe(null);
    expect(d.points[28].ideal).toBe(29000);
    expect(dashboard(s, '2024-02', '2024-03-01').projection).toBeNull();
    s.accounts[0].coverageComplete = false;
    expect(dashboard(s, '2024-02', '2024-02-10').projection).toBeNull();
  });
  it('compares current periods through the same day with leap-day clamping', () => {
    const s = fixture();
    const c = cashflow(s, 'year', '2024', '2024-02-29');
    expect(c.priorEnd).toBe('2023-02-28');
    expect(c.end).toBe('2024-02-29');
    const m = cashflow(s, 'month', '2024-03', '2024-03-31');
    expect(m.priorEnd).toBe('2024-02-29');
    expect(c.comparison.net).toBeNull();
  });
  it('reconciles calendar-year and monthly totals, does not include future dates', () => {
    const s = createDemo('2025-12-31');
    const y = cashflow(s, 'year', '2025', '2025-12-31');
    for (const key of ['spending', 'income', 'net'] as const)
      expect(y.months.reduce((n, m) => n + m[key], 0)).toBe(y[key]);
    s.transactions.push({
      ...s.transactions[0],
      id: 'future',
      date: '2026-12-31',
      amount: 999999999,
    });
    const now = cashflow(s, 'year', '2026', '2026-10-15');
    expect(now.months[11].spending).toBe(0);
    expect(cashflow(s, 'month', '2026-12', '2026-10-15').spending).toBe(0);
  });
});
describe('balances and investments', () => {
  it('subtracts positive debt, handles credit balances, exclusions and snapshots', () => {
    let s = fixture();
    s.accounts.push({ ...s.accounts[0], id: 'card', type: 'credit', balance: 30000 });
    expect(netWorth(s).total).toBe(70000);
    s.accounts[1].balance = -500;
    expect(netWorth(s).total).toBe(100500);
    s = applyCommand(s, { type: 'account.save', payload: { ...s.accounts[0], balance: 110000 } });
    expect(s.snapshots).toHaveLength(1);
    expect(s.snapshots[0].balance).toBe(110000);
    s.accounts.find((a) => a.id === 'card')!.includeInNetWorth = false;
    expect(netWorth(s).total).toBe(110000);
  });
  it('reconciles holdings and allocation, never labels balance growth as return', () => {
    const s = createDemo('2026-10-15');
    const v = investmentOverview(s, 'all', '2026-10-15');
    expect(Object.values(v.allocation).reduce((a, b) => a + b, 0)).toBe(v.value);
    expect(v.value).toBe(v.accountBalance);
    expect(v.returnPercent).toBeNull();
    expect(v.holdings.some((h) => h.stale)).toBe(true);
    const account = investmentOverview(s, 'broker', '2026-10-15');
    expect(account.holdings.every((h) => h.accountId === 'broker')).toBe(true);
  });
});
describe('CSV and full recovery', () => {
  const opts: CSVOptions = {
    mapping: {
      date: 'date',
      name: 'name',
      amount: 'amount',
      type: 'type',
      category: 'category',
      currency: 'currency',
    },
    dateFormat: 'YYYY-MM-DD',
    amountConvention: 'outflow-positive',
    accountId: 'a',
    currency: 'USD',
  };
  it('maps conventions, reports row errors, and deduplicates repeated imports', () => {
    let s = fixture();
    const csv =
      'date,name,amount,type,category,currency\n2024-02-15,Café,12.35,spending,Food,USD\n2024-02-15,Café,12.35,spending,Food,USD\n2024-02-30,Bad,2.00,spending,Food,USD';
    const preview = previewCSV(csv, opts, s);
    expect(preview.transactions[0].amount).toBe(1235);
    expect(preview.duplicates).toBe(1);
    expect(preview.errors[0].row).toBe(4);
    s = applyCommand(s, { type: 'import.commit', payload: { transactions: preview.transactions } });
    expect(previewCSV(csv, opts, s).transactions).toHaveLength(0);
    expect(s.transactions[0].reviewed).toBe(false);
  });
  it('roundtrips transaction amounts, dates and types through CSV', () => {
    const s = fixture();
    s.transactions = [transaction('1', 1234, { kind: 'refund', name: 'Quoted, merchant' })];
    const restored = previewCSV(exportCSV(s), opts, fixture()).transactions[0];
    expect(restored).toMatchObject({
      date: '2024-02-15',
      amount: 1234,
      kind: 'refund',
      name: 'Quoted, merchant',
    });
  });
  it('keeps CSV import identity after edits and merchant rules without merging renamed matches', () => {
    let s = fixture();
    s.rules = [
      {
        id: 'rename',
        merchant: 'Original merchant',
        match: 'exact',
        accountId: 'a',
        categoryId: 'food',
        name: 'Rule name',
      },
    ];
    const csv =
      'date,name,amount,type,category,currency\n2024-02-15,Original merchant,12.34,spending,Food,USD';
    const first = previewCSV(csv, opts, s);
    s = applyCommand(s, { type: 'import.commit', payload: { transactions: first.transactions } });
    expect(s.transactions[0].name).toBe('Rule name');
    expect(previewCSV(csv, opts, s).duplicates).toBe(1);
    s = applyCommand(s, {
      type: 'transaction.update',
      payload: { id: s.transactions[0].id, edits: { name: 'Other merchant', date: '2024-02-16' } },
    });
    expect(previewCSV(csv, opts, s).duplicates).toBe(1);
    const repeated = applyCommand(s, {
      type: 'import.commit',
      payload: { transactions: first.transactions },
    });
    expect(repeated.transactions).toHaveLength(1);
    const distinct = previewCSV(
      csv.replace('Original merchant', 'Other merchant').replace('2024-02-15', '2024-02-16'),
      opts,
      s,
    );
    expect(distinct.transactions).toHaveLength(1);
    expect(distinct.duplicates).toBe(0);
    const restored = applyCommand(s, {
      type: 'backup.restore',
      payload: { state: backup(s).state },
    });
    expect(previewCSV(csv, opts, restored).duplicates).toBe(1);
  });
  it('restores full state, excludes raw provider metadata and separates demo/private', () => {
    const s = createDemo('2026-10-15');
    s.transactions[0].raw = { sensitive: 'do not export' };
    const b = backup(s);
    expect(JSON.stringify(b)).not.toContain('do not export');
    const next = applyCommand(s, { type: 'backup.restore', payload: { state: b.state } });
    expect(dashboard(next, '2026-10', '2026-10-15')).toEqual(dashboard(s, '2026-10', '2026-10-15'));
    expect(next.transactions.map((t) => t.splits)).toEqual(s.transactions.map((t) => t.splits));
    expect(() =>
      applyCommand(fixture(), { type: 'backup.restore', payload: { state: b.state } }),
    ).toThrow('Demo and private');
  });
});
