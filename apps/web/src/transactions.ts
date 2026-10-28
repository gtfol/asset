import { effective, type Transaction } from '../shared/core';

export const TRANSACTION_PAGE_SIZE = 80;
export type TransactionFilters = Record<string, string>;
export type TransactionIndexEntry = {
  raw: Transaction;
  transaction: Transaction;
  searchText: string;
};

export function createTransactionIndex(transactions: Transaction[]): TransactionIndexEntry[] {
  return transactions
    .filter((transaction) => !transaction.removed)
    .map((raw) => {
      const transaction = effective(raw);
      return {
        raw,
        transaction,
        searchText: `${transaction.name} ${transaction.notes}`.toLowerCase(),
      };
    })
    .sort((a, b) =>
      a.transaction.date === b.transaction.date
        ? a.transaction.id === b.transaction.id
          ? 0
          : a.transaction.id < b.transaction.id
            ? -1
            : 1
        : a.transaction.date > b.transaction.date
          ? -1
          : 1,
    );
}

export function filterTransactionIndex(
  index: TransactionIndexEntry[],
  filters: TransactionFilters,
): TransactionIndexEntry[] {
  const search = filters.search?.toLowerCase();
  return index.filter(
    ({ transaction: t, searchText }) =>
      (!search || searchText.includes(search)) &&
      (!filters.account || t.accountId === filters.account || t.loanAccountId === filters.account) &&
      (!filters.category ||
        (t.splits.length
          ? t.splits.some((part) => part.categoryId === filters.category)
          : t.categoryId === filters.category)) &&
      (!filters.start || t.date >= filters.start) &&
      (!filters.end || t.date <= filters.end) &&
      (!filters.type || t.kind === filters.type) &&
      (!filters.review || (filters.review === 'reviewed' ? t.reviewed : !t.reviewed)),
  );
}

export function transactionFilterKey(filters: TransactionFilters): string {
  return JSON.stringify([
    filters.search?.toLowerCase() ?? '',
    filters.account ?? '',
    filters.category ?? '',
    filters.start ?? '',
    filters.end ?? '',
    filters.type ?? '',
    filters.review ?? '',
  ]);
}

export function nextTransactionLimit(current: number, total: number): number {
  return Math.min(total, current + TRANSACTION_PAGE_SIZE);
}
