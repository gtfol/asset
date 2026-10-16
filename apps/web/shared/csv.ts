import Papa from 'papaparse';
import {
  parseMoney,
  dateSchema,
  fingerprint,
  importFingerprint,
  effective,
  type State,
  type Transaction,
  type Kind,
} from './core.js';
export type Mapping = {
  date: string;
  name: string;
  amount: string;
  category?: string;
  type?: string;
  currency?: string;
};
export type CSVOptions = {
  mapping: Mapping;
  dateFormat: 'YYYY-MM-DD' | 'MM/DD/YYYY' | 'DD/MM/YYYY';
  amountConvention: 'outflow-positive' | 'outflow-negative';
  currency: string;
  accountId: string;
};
export function parseCSV(text: string) {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (s) => s.trim(),
  });
  if (parsed.errors.length)
    throw Error(parsed.errors.map((e) => `Row ${(e.row ?? 0) + 2}: ${e.message}`).join('; '));
  return { headers: parsed.meta.fields ?? [], rows: parsed.data };
}
export function previewCSV(text: string, options: CSVOptions, state: State) {
  const { rows, headers } = parseCSV(text);
  const { mapping: m } = options;
  for (const key of [m.date, m.name, m.amount])
    if (!headers.includes(key)) throw Error('Map date, name, and amount to existing columns');
  if (!state.accounts.some((a) => a.id === options.accountId)) throw Error('Choose an account');
  if (rows.length > 10000) throw Error('Import at most 10,000 rows per file');
  const seen = new Set(state.transactions.filter((t) => !t.removed).map(importFingerprint));
  let duplicates = 0;
  const transactions: Transaction[] = [];
  const errors: { row: number; message: string }[] = [];
  rows.forEach((row, index) => {
    try {
      let date = row[m.date]?.trim();
      if (options.dateFormat !== 'YYYY-MM-DD') {
        const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(date);
        if (!match) throw Error('Date does not match the selected convention');
        date =
          options.dateFormat === 'MM/DD/YYYY'
            ? `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`
            : `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
      }
      if (!dateSchema.safeParse(date).success)
        throw Error(`Use a valid date in ${options.dateFormat} format`);
      const amount = parseMoney(row[m.amount]);
      const name = row[m.name]?.trim();
      if (!name) throw Error('Name is required');
      const currency = m.currency ? row[m.currency]?.trim().toUpperCase() : options.currency;
      if (!/^[A-Z]{3}$/.test(currency)) throw Error('Use a three-letter currency code');
      const rawKind = m.type ? row[m.type]?.trim().toLowerCase() : '';
      const valid = [
        'spending',
        'refund',
        'income',
        'transfer',
        'card_payment',
        'investment_transfer',
        'investment_trade',
      ];
      if (rawKind && !valid.includes(rawKind)) throw Error('Unknown transaction type');
      const kind = (rawKind ||
        (amount * (options.amountConvention === 'outflow-positive' ? 1 : -1) < 0
          ? 'income'
          : 'spending')) as Kind;
      const category =
        state.categories.find(
          (c) =>
            c.name.toLowerCase() === row[m.category ?? '']?.trim().toLowerCase() ||
            c.id === row[m.category ?? ''],
        )?.id ?? 'other';
      const t: Transaction = {
        id: `csv-${Date.now()}-${index}`,
        name,
        date,
        amount: Math.abs(amount),
        currency,
        kind,
        categoryId: category,
        accountId: options.accountId,
        notes: '',
        excluded: false,
        reviewed: false,
        pending: false,
        removed: false,
        source: 'csv',
        importedAt: new Date().toISOString(),
        raw: { ...row },
        edits: {},
        splits: [],
      };
      const key = fingerprint(t);
      if (seen.has(key)) {
        duplicates++;
        return;
      }
      seen.add(key);
      transactions.push({ ...t, fingerprint: key });
    } catch (e) {
      errors.push({ row: index + 2, message: e instanceof Error ? e.message : 'Invalid row' });
    }
  });
  return { transactions, errors, duplicates, total: rows.length };
}
export function exportCSV(state: State) {
  return Papa.unparse(
    state.transactions
      .filter((t) => !t.removed)
      .map((raw) => {
        const t = effective(raw);
        return {
          date: t.date,
          name: t.name,
          amount: (t.amount / 100).toFixed(2),
          currency: t.currency,
          type: t.kind,
          category: state.categories.find((c) => c.id === t.categoryId)?.name ?? t.categoryId,
          account: state.accounts.find((a) => a.id === t.accountId)?.name,
          notes: t.notes,
          excluded: t.excluded,
          reviewed: t.reviewed,
          pending: t.pending,
          splits: JSON.stringify(t.splits),
        };
      }),
    { escapeFormulae: true },
  );
}
