import { z } from 'zod';
import { notificationStateSchema } from './notifications.js';
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(s + 'T12:00:00Z');
    return !isNaN(+d) && d.toISOString().slice(0, 10) === s;
  }, 'Use a valid YYYY-MM-DD date');
export const centsSchema = z.number().int().safe().min(-100_000_000_000).max(100_000_000_000);
export const kindSchema = z.enum([
  'spending',
  'refund',
  'income',
  'transfer',
  'card_payment',
  'investment_transfer',
  'investment_trade',
]);
export const categorySchema = z.object({
  id: z.string(),
  name: z.string().trim().min(1).max(80),
  icon: z.string().max(12),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  group: z.string().max(60).default('Everyday'),
  archived: z.boolean().default(false),
});
export const accountSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(100),
  type: z.enum(['checking', 'savings', 'credit', 'investment', 'loan', 'manual']),
  currency: z.string().length(3),
  balance: centsSchema.nullable(),
  creditLimit: centsSchema.positive().nullable().optional(),
  includeInNetWorth: z.boolean().default(true),
  enabled: z.boolean().default(true),
  source: z.enum(['demo', 'manual', 'csv', 'plaid', 'bitcoin']),
  bitcoin: z
    .object({
      address: z.string().min(14).max(90),
      satoshis: z.number().int().safe().nonnegative(),
      pendingSatoshis: z.number().int().safe(),
      syncedAt: z.string().datetime(),
      historyStart: dateSchema,
      historyComplete: z.boolean(),
    })
    .optional(),
  updatedAt: z.string(),
  mask: z.string().optional(),
  connectionId: z.string().optional(),
  providerId: z.string().optional(),
  coverageStart: dateSchema.optional(),
  coverageEnd: dateSchema.optional(),
  coverageComplete: z.boolean().default(false),
});
export const splitSchema = z.object({
  id: z.string(),
  categoryId: z.string(),
  amount: centsSchema.nonnegative(),
  excluded: z.boolean().default(false),
});
export const editSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  date: dateSchema.optional(),
  categoryId: z.string().optional(),
  kind: kindSchema.optional(),
  notes: z.string().max(5000).optional(),
  recurring: z.string().max(160).optional(),
  excluded: z.boolean().optional(),
});
export const transactionSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  name: z.string().min(1).max(160),
  date: dateSchema,
  amount: centsSchema.nonnegative(),
  currency: z.string().length(3),
  kind: kindSchema,
  categoryId: z.string(),
  notes: z.string().max(5000).default(''),
  excluded: z.boolean().default(false),
  reviewed: z.boolean().default(false),
  pending: z.boolean().default(false),
  removed: z.boolean().default(false),
  source: z.enum(['demo', 'manual', 'csv', 'plaid']),
  importedAt: z.string(),
  providerId: z.string().optional(),
  pendingProviderId: z.string().nullable().optional(),
  connectionId: z.string().optional(),
  fingerprint: z.string().optional(),
  importIdentity: z.string().max(1000).optional(),
  recurring: z.string().max(160).optional(),
  tags: z.string().max(1000).optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
  edits: editSchema.default({}),
  splits: z.array(splitSchema).default([]),
});
export const budgetSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  categoryId: z.string(),
  amount: centsSchema.nonnegative(),
});
export const snapshotSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  date: dateSchema,
  balance: centsSchema,
  currency: z.string().length(3),
  source: z.enum(['demo', 'manual', 'csv', 'plaid', 'bitcoin']),
});
export const holdingSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  symbol: z.string(),
  name: z.string(),
  quantity: z.string().regex(/^\d+(\.\d{1,12})?$/),
  price: centsSchema.nonnegative().nullable(),
  marketValue: centsSchema.nonnegative().nullable(),
  costBasis: centsSchema.nonnegative().nullable(),
  currency: z.string().length(3),
  priceAt: z.string().nullable(),
  type: z.string(),
  providerId: z.string().optional(),
  source: z.enum(['demo', 'manual', 'csv', 'plaid', 'bitcoin']),
});
export const bitcoinMarketSchema = z.object({
  price: centsSchema.positive(),
  updatedAt: z.string().datetime(),
  history: z.array(z.object({ date: dateSchema, price: centsSchema.positive() })).max(10000),
});
export const ruleSchema = z.object({
  id: z.string(),
  merchant: z.string().trim().min(1).max(160),
  match: z.enum(['exact', 'contains']),
  accountId: z.string().nullable(),
  categoryId: z.string(),
  name: z.string().max(160).optional(),
});
export const investmentActivitySchema = z.object({
  id: z.string(),
  accountId: z.string(),
  date: dateSchema,
  type: z.string(),
  amount: centsSchema,
  currency: z.string().length(3),
  name: z.string(),
  securityId: z.string().nullable(),
  quantity: z.string(),
  source: z.enum(['demo', 'manual', 'plaid']),
});
export const holdingSnapshotSchema = holdingSchema.extend({
  date: dateSchema,
  holdingId: z.string(),
});
export const stateSchema = z.object({
  schemaVersion: z.literal(1),
  categories: z.array(categorySchema),
  accounts: z.array(accountSchema),
  transactions: z.array(transactionSchema),
  budgets: z.array(budgetSchema),
  snapshots: z.array(snapshotSchema),
  holdings: z.array(holdingSchema),
  holdingSnapshots: z.array(holdingSnapshotSchema).default([]),
  rules: z.array(ruleSchema),
  investmentActivity: z.array(investmentActivitySchema),
  bitcoinMarket: bitcoinMarketSchema.optional(),
  notifications: notificationStateSchema.optional(),
  settings: z.object({
    currency: z.string().length(3),
    includeExcludedCashflow: z.boolean(),
    timezone: z.string().refine((t) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: t });
        return true;
      } catch {
        return false;
      }
    }, 'Invalid time zone'),
    demo: z.boolean(),
  }),
});
export type State = z.infer<typeof stateSchema>;
export type Transaction = z.infer<typeof transactionSchema>;
export type Account = z.infer<typeof accountSchema>;
export type Category = z.infer<typeof categorySchema>;
export type Holding = z.infer<typeof holdingSchema>;
export type Rule = z.infer<typeof ruleSchema>;
export type Kind = z.infer<typeof kindSchema>;
export type Command = { type: string; payload: Record<string, unknown> };
export function validateState(value: unknown): State {
  const s = stateSchema.parse(value);
  if (s.transactions.length > 100000 || s.snapshots.length > 100000 || s.holdings.length > 100000)
    throw Error('Workspace record limit exceeded');
  for (const list of [s.transactions, s.budgets, s.snapshots, s.holdings]) {
    const sum = list.reduce(
      (n, x) =>
        n + Math.abs('amount' in x ? x.amount : 'balance' in x ? x.balance : (x.marketValue ?? 0)),
      0,
    );
    if (!Number.isSafeInteger(sum))
      throw Error('Workspace money total exceeds exact arithmetic limits');
  }
  const ids = new Set(s.accounts.map((a) => a.id));
  const cats = new Set(s.categories.map((c) => c.id));
  const wallets = s.accounts.filter((a) => a.source === 'bitcoin');
  if (wallets.length > 20) throw Error('Track up to 20 Bitcoin addresses per workspace');
  if (wallets.some((a) => !a.bitcoin || a.type !== 'investment' || a.currency !== 'USD'))
    throw Error('Bitcoin accounts require a public address and USD investment valuation');
  if (new Set(wallets.map((a) => a.bitcoin!.address)).size !== wallets.length)
    throw Error('This Bitcoin address is already tracked');
  if (s.accounts.some((a) => a.source !== 'bitcoin' && a.bitcoin))
    throw Error('Only Bitcoin accounts can contain wallet tracking data');
  for (const list of [
    s.accounts,
    s.categories,
    s.transactions,
    s.holdings,
    s.holdingSnapshots,
    s.snapshots,
    s.rules,
  ])
    if (new Set(list.map((x) => x.id)).size !== list.length) throw Error('Duplicate record IDs');
  if (new Set(s.budgets.map((b) => b.month + ':' + b.categoryId)).size !== s.budgets.length)
    throw Error('Duplicate monthly budgets');
  for (const a of s.accounts)
    if (
      a.coverageComplete &&
      (!a.coverageStart || !a.coverageEnd || a.coverageStart > a.coverageEnd)
    )
      throw Error('Complete coverage requires a valid start and end');
  for (const t of s.transactions) {
    if (new Set(t.splits.map((p) => p.id)).size !== t.splits.length)
      throw Error('Duplicate split IDs');
    if (!ids.has(t.accountId) || !cats.has(t.edits.categoryId ?? t.categoryId))
      throw Error('Transaction references a missing account or category');
    if (t.splits.length && t.splits.reduce((a, b) => a + b.amount, 0) !== t.amount)
      throw Error('Split amounts must equal the original');
    for (const p of t.splits) if (!cats.has(p.categoryId)) throw Error('Unknown split category');
  }
  for (const h of [...s.holdings, ...s.holdingSnapshots, ...s.snapshots, ...s.investmentActivity])
    if (!ids.has(h.accountId)) throw Error('Unknown account');
  for (const b of s.budgets) if (!cats.has(b.categoryId)) throw Error('Unknown budget category');
  for (const r of s.rules)
    if (!cats.has(r.categoryId) || (r.accountId && !ids.has(r.accountId)))
      throw Error('Invalid rule scope');
  return s;
}
