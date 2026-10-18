import { z } from 'zod';
import { parseCSV } from './csv.js';
import { dateSchema, type Account, type Category, type State, type Transaction } from './schema.js';
import { fingerprint, importFingerprint, parseMoney } from './core.js';

const required = [
  'date',
  'name',
  'amount',
  'status',
  'category',
  'excluded',
  'type',
  'account',
  'account mask',
];
export const isCopilotCSV = (headers: string[]) => required.every((key) => headers.includes(key));
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const accountKey = (name: string, mask: string) => JSON.stringify([norm(name), mask.trim()]);
// Deterministic IDs survive repeated exports. Identity is also stored in full for deduplication.
function stableID(value: string) {
  let a = 2166136261,
    b = 5381;
  for (let i = 0; i < value.length; i++) {
    a = Math.imul(a ^ value.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ value.charCodeAt(i);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
export const copilotOptionsSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  markReviewed: z.boolean().optional(),
  accounts: z
    .record(
      z.string(),
      z.object({
        accountId: z.string().optional(),
        type: z.enum(['checking', 'savings', 'credit', 'investment', 'loan', 'manual']),
      }),
    )
    .default({}),
});
export type CopilotOptions = z.infer<typeof copilotOptionsSchema>;
export function copilotAccounts(text: string, state: State) {
  const { rows, headers } = parseCSV(text);
  if (!isCopilotCSV(headers)) throw Error('Choose a Copilot transaction export');
  if (rows.length > 10000) throw Error('Import at most 10,000 rows per file');
  const groups = new Map<
    string,
    {
      key: string;
      name: string;
      mask: string;
      count: number;
      accountId?: string;
      type: Account['type'];
    }
  >();
  for (const row of rows) {
    const name = row.account.trim(),
      mask = row['account mask'].trim(),
      key = accountKey(name, mask);
    if (groups.has(key)) {
      groups.get(key)!.count++;
      continue;
    }
    const exact = state.accounts.filter(
      (a) => norm(a.name) === norm(name) && (a.mask ?? '') === mask,
    );
    const existing = exact.length === 1 ? exact[0] : undefined;
    const type: Account['type'] =
      existing?.type ??
      (/card|visa|mastercard|rewards/i.test(name)
        ? 'credit'
        : /savings/i.test(name)
          ? 'savings'
          : /checking|venmo|apple\s+cash/i.test(name)
            ? 'checking'
            : 'manual');
    groups.set(key, { key, name, mask, count: 1, accountId: existing?.id, type });
  }
  return [...groups.values()];
}

export function previewCopilot(
  text: string,
  input: CopilotOptions,
  state: State,
  now = new Date().toISOString(),
) {
  const options = copilotOptionsSchema.parse(input);
  const groups = copilotAccounts(text, state);
  const { rows } = parseCSV(text);
  const accounts: Account[] = [],
    categories: Category[] = [];
  const bySource = new Map<string, Account>();
  for (const group of groups) {
    const chosen = options.accounts[group.key];
    const existingID = chosen ? chosen.accountId : group.accountId;
    let account = existingID ? state.accounts.find((a) => a.id === existingID) : undefined;
    if (existingID && !account) throw Error('An account mapping is no longer available');
    if (account?.source === 'bitcoin')
      throw Error('Bitcoin addresses cannot receive imported bank transactions');
    if (account && account.currency !== options.currency)
      throw Error('Account currency must match the import currency');
    if (!account) {
      const id = 'copilot-account-' + stableID(group.key);
      // Reusing an existing deterministic ID avoids creating another account on re-import.
      account = state.accounts.find((a) => a.id === id);
      if (!account) {
        account = {
          id,
          name: group.name,
          mask: group.mask || undefined,
          type: chosen?.type ?? group.type,
          currency: options.currency,
          balance: null,
          includeInNetWorth: true,
          enabled: true,
          source: 'csv',
          updatedAt: now,
          coverageComplete: false,
        };
        accounts.push(account);
      }
    }
    bySource.set(group.key, account);
  }
  const transactions: Transaction[] = [],
    updated: Transaction[] = [],
    errors: { row: number; message: string }[] = [];
  const occurrences = new Map<string, number>();
  const imported = new Map(
    state.transactions.filter((t) => t.importIdentity).map((t) => [t.importIdentity!, t]),
  );
  // Count matches instead of collapsing legitimate identical purchases within a file.
  const available = new Map<string, number>();
  for (const t of state.transactions.filter((t) => !t.removed && !t.importIdentity)) {
    const key = importFingerprint(t);
    available.set(key, (available.get(key) ?? 0) + 1);
  }
  let duplicates = 0,
    pending = 0;
  for (const [index, row] of rows.entries()) {
    try {
      const date = dateSchema.parse(row.date.trim());
      const name = row.name.trim();
      if (!name || name.length > 160) throw Error('Transaction name must be 1–160 characters');
      const amount = parseMoney(row.amount);
      const kind =
        row.type === 'regular'
          ? amount < 0
            ? 'refund'
            : 'spending'
          : row.type === 'income'
            ? 'income'
            : row.type === 'internal transfer'
              ? 'transfer'
              : null;
      if (!kind) throw Error('Unrecognized Copilot transaction type');
      if (!['pending', 'posted'].includes(row.status))
        throw Error('Unrecognized transaction status');
      if (!['true', 'false'].includes(row.excluded)) throw Error('Excluded must be true or false');
      const account = bySource.get(accountKey(row.account, row['account mask']))!;
      const categoryName = row.category.trim();
      const parent = row['parent category']?.trim() || 'Everyday';
      let category = [...state.categories, ...categories].find(
        (c) =>
          norm(c.name) === norm(categoryName || 'Other') && (!categoryName || c.group === parent),
      );
      if (!category) {
        category = {
          id:
            'copilot-category-' + stableID(JSON.stringify([norm(categoryName || 'Other'), parent])),
          name: categoryName || 'Other',
          group: parent,
          icon: 'other',
          color: '#92979e',
          archived: false,
        };
        categories.push(category);
      }
      const t: Transaction = {
        id: '',
        accountId: account.id,
        name,
        date,
        amount: Math.abs(amount),
        currency: options.currency,
        kind,
        categoryId: category.id,
        notes: row.note ?? '',
        // Copilot's exclusion flag describes spending budgets. Income still belongs in cash flow.
        excluded: kind !== 'income' && row.excluded === 'true',
        reviewed:
          options.markReviewed !== false &&
          row.status === 'posted' &&
          ((!!categoryName && norm(categoryName) !== 'uncategorized') ||
            kind === 'income' ||
            kind === 'transfer' ||
            row.excluded === 'true'),
        pending: row.status === 'pending',
        removed: false,
        source: 'csv',
        importedAt: now,
        recurring: row.recurring?.trim() || undefined,
        tags: row.tags?.trim() || undefined,
        edits: {},
        splits: [],
        raw: {
          copilot: {
            excluded: row.excluded === 'true',
            category: categoryName,
            status: row.status,
          },
        },
      };
      const key = fingerprint(t);
      // Status, category, notes and tags are excluded from identity, so edits don't duplicate imports.
      const identityBase = JSON.stringify([
        accountKey(row.account, row['account mask']),
        date,
        name,
        amount,
        kind,
      ]);
      const occurrence = (occurrences.get(identityBase) ?? 0) + 1;
      occurrences.set(identityBase, occurrence);
      t.importIdentity = 'copilot:' + identityBase + ':' + occurrence;
      t.id = 'copilot-' + stableID(t.importIdentity);
      const previous = imported.get(t.importIdentity);
      if (previous) {
        if (previous.pending && !t.pending && !previous.removed)
          updated.push({ ...previous, pending: false });
        else duplicates++;
        continue;
      }
      if ((available.get(key) ?? 0) > 0) {
        available.set(key, available.get(key)! - 1);
        duplicates++;
        continue;
      }
      transactions.push(t);
      if (t.pending) pending++;
    } catch (error) {
      errors.push({
        row: index + 2,
        message: error instanceof Error ? error.message : 'Invalid row',
      });
    }
  }
  return {
    accounts,
    categories,
    transactions,
    updated,
    errors,
    duplicates,
    pending,
    total: rows.length,
    start: rows.map((r) => r.date).sort()[0],
    end: rows
      .map((r) => r.date)
      .sort()
      .at(-1),
  };
}

export function importCopilot(state: State, text: string, options: CopilotOptions, now?: string): State {
  const preview = previewCopilot(text, options, state, now);
  if (preview.errors.length)
    throw Error(`Fix ${preview.errors.length} invalid rows before importing`);
  return {
    ...state,
    accounts: [...state.accounts, ...preview.accounts],
    categories: [...state.categories, ...preview.categories],
    transactions: [
      ...state.transactions.map((t) => preview.updated.find((u) => u.id === t.id) ?? t),
      ...preview.transactions,
    ],
  };
}

export function previewCopilotHistoryRepair(state: State, text: string) {
  const source = previewCopilot(
    text,
    { currency: state.settings.currency, accounts: {} },
    {
      ...state,
      accounts: [],
      transactions: [],
      categories: [],
    },
  );
  if (source.errors.length) throw Error('Fix invalid CSV rows before updating imported history');
  const byIdentity = new Map(source.transactions.map((t) => [t.importIdentity, t]));
  const reviewed: string[] = [],
    income: string[] = [];
  for (const t of state.transactions) {
    const original = byIdentity.get(t.importIdentity);
    if (!original || t.removed || t.raw?.asset_split_conflict) continue;
    if (original.reviewed && !t.pending && !t.reviewed) reviewed.push(t.id);
    if (
      original.kind === 'income' &&
      (t.edits.kind ?? t.kind) === 'income' &&
      (t.edits.excluded ?? t.excluded)
    )
      income.push(t.id);
  }
  return { reviewed, income };
}

export function repairCopilotHistory(state: State, text: string): State {
  const changes = previewCopilotHistoryRepair(state, text);
  const reviewed = new Set(changes.reviewed),
    income = new Set(changes.income);
  return {
    ...state,
    transactions: state.transactions.map((t) => ({
      ...t,
      ...(reviewed.has(t.id) ? { reviewed: true } : {}),
      ...(income.has(t.id) ? { excluded: false, edits: { ...t.edits, excluded: false } } : {}),
    })),
  };
}
