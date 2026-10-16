import { describe, expect, it } from 'vitest';
import { totals } from '../shared/core';
import { fixture, transaction } from './fixtures';
import {
  TRANSACTION_PAGE_SIZE,
  createTransactionIndex,
  filterTransactionIndex,
  nextTransactionLimit,
  transactionFilterKey,
} from '../src/transactions';

describe('transaction browsing', () => {
  it('orders effective dates and equal-date IDs consistently without modifying source records', () => {
    const raw = [
      transaction('b', 100, { date: '2024-02-12' }),
      transaction('a', 200, { date: '2024-02-12' }),
      transaction('edited', 300, {
        date: '2024-02-01',
        edits: { date: '2024-02-14', name: 'Changed name' },
      }),
      transaction('removed', 400, { removed: true }),
    ];
    const index = createTransactionIndex(raw);
    expect(index.map(({ transaction: t }) => t.id)).toEqual(['edited', 'a', 'b']);
    expect(index[0].raw).toBe(raw[2]);
    expect(index[0].raw.date).toBe('2024-02-01');
    expect(index[0].transaction.date).toBe('2024-02-14');
    expect(index[0].searchText).toContain('changed name');
    expect(raw.map((t) => t.id)).toEqual(['b', 'a', 'edited', 'removed']);
  });

  it('combines search, account, split category, calendar range, type and review filters', () => {
    const split = transaction('split', 1000, {
      name: 'Original merchant',
      notes: '',
      reviewed: false,
      edits: { name: 'Market', notes: 'Weekly SHOP', date: '2024-02-16' },
      splits: [
        { id: 'food-part', categoryId: 'food', amount: 700, excluded: false },
        { id: 'other-part', categoryId: 'other', amount: 300, excluded: false },
      ],
    });
    const index = createTransactionIndex([
      split,
      { ...split, id: 'wrong-account', accountId: 'another' },
      { ...split, id: 'reviewed', reviewed: true },
      { ...split, id: 'income', kind: 'income' },
      { ...split, id: 'old', edits: { ...split.edits, date: '2024-02-01' } },
    ]);
    expect(
      filterTransactionIndex(index, {
        search: 'SHOP',
        account: 'a',
        category: 'other',
        start: '2024-02-16',
        end: '2024-02-16',
        type: 'spending',
        review: 'unreviewed',
      }).map(({ transaction: t }) => t.id),
    ).toEqual(['split']);
    const parentOnly = createTransactionIndex([
      {
        ...split,
        amount: 300,
        splits: split.splits.filter((part) => part.categoryId === 'other'),
      },
    ]);
    expect(filterTransactionIndex(parentOnly, { category: 'food' })).toEqual([]);
  });

  it('keeps full-match split totals independent of the loaded row limit', () => {
    const state = fixture();
    state.transactions = Array.from({ length: 95 }, (_, i) =>
      transaction(String(i), 1000, {
        splits: [
          { id: `food-${i}`, categoryId: 'food', amount: 700, excluded: false },
          { id: `other-${i}`, categoryId: 'other', amount: 300, excluded: true },
        ],
      }),
    );
    const matches = filterTransactionIndex(createTransactionIndex(state.transactions), {
      category: 'food',
    });
    expect(matches.slice(0, TRANSACTION_PAGE_SIZE)).toHaveLength(80);
    expect(matches).toHaveLength(95);
    expect(
      totals(
        { ...state, transactions: matches.map((entry) => entry.raw) },
        '2024-02-01',
        '2024-02-29',
        false,
        'food',
      ).spending,
    ).toBe(66500);
  });

  it('appends complete windows without gaps or duplicates and stops at the end', () => {
    const rows = createTransactionIndex(
      Array.from({ length: 205 }, (_, i) => transaction(`row-${String(i).padStart(3, '0')}`, i)),
    );
    let limit = TRANSACTION_PAGE_SIZE;
    const first = rows.slice(0, limit).map(({ transaction: t }) => t.id);
    expect(first).toHaveLength(80);
    limit = nextTransactionLimit(limit, rows.length);
    const second = rows.slice(0, limit).map(({ transaction: t }) => t.id);
    expect(second).toHaveLength(160);
    expect(second.slice(0, first.length)).toEqual(first);
    limit = nextTransactionLimit(limit, rows.length);
    expect(limit).toBe(205);
    expect(new Set(rows.slice(0, limit).map(({ transaction: t }) => t.id)).size).toBe(205);
    expect(nextTransactionLimit(limit, rows.length)).toBe(205);
    expect(nextTransactionLimit(80, 0)).toBe(0);
    expect(nextTransactionLimit(80, 42)).toBe(42);
  });

  it('rebuilds edited and removed results without changing an earlier index', () => {
    const original = [transaction('first', 100), transaction('second', 200)];
    const oldIndex = createTransactionIndex(original);
    const changed = createTransactionIndex([
      { ...original[0], removed: true },
      { ...original[1], edits: { name: 'Updated', notes: 'New note', categoryId: 'other' } },
    ]);
    expect(changed).toHaveLength(1);
    expect(
      filterTransactionIndex(changed, { search: 'new note', category: 'other' })[0].transaction.id,
    ).toBe('second');
    expect(filterTransactionIndex(changed, { search: 'Test', category: 'food' })).toEqual([]);
    expect(oldIndex).toHaveLength(2);
    expect(oldIndex[1].transaction.name).toBe('Test');
  });

  it('uses filter values rather than object identity for a browsing window', () => {
    expect(transactionFilterKey({ search: 'MARKET', account: 'a' })).toBe(
      transactionFilterKey({ account: 'a', search: 'market', category: '' }),
    );
    expect(transactionFilterKey({ account: 'a' })).not.toBe(transactionFilterKey({ account: 'b' }));
  });
});
