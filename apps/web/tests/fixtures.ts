import { emptyState, type State, type Transaction } from '../shared/core';
export function fixture(): State {
  const s = emptyState();
  s.categories.push({
    id: 'food',
    name: 'Food',
    icon: '○',
    color: '#123456',
    group: 'Living',
    archived: false,
  });
  s.accounts.push({
    id: 'a',
    name: 'Checking',
    type: 'checking',
    currency: 'USD',
    balance: 100000,
    source: 'manual',
    updatedAt: '2024-02-29T12:00:00Z',
    includeInNetWorth: true,
    enabled: true,
    coverageStart: '2023-01-01',
    coverageEnd: '2026-12-31',
    coverageComplete: true,
  });
  return s;
}
export function transaction(
  id: string,
  amount: number,
  extra: Partial<Transaction> = {},
): Transaction {
  return {
    id,
    accountId: 'a',
    name: 'Test',
    amount,
    currency: 'USD',
    date: '2024-02-15',
    kind: 'spending',
    categoryId: 'food',
    notes: '',
    excluded: false,
    reviewed: false,
    pending: false,
    removed: false,
    source: 'manual',
    importedAt: '2024-02-15T12:00:00Z',
    edits: {},
    splits: [],
    ...extra,
  };
}
