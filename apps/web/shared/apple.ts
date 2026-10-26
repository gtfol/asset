import { z } from 'zod';
import {
  accountSchema,
  centsSchema,
  dateSchema,
  transactionSchema,
  type State,
  type Transaction,
} from './schema.js';
import { applyRules } from './core.js';
import { importedMatch, preserveImportedDetails } from './account-links.js';

export const appleAccountInput = z.object({
  providerId: z.string().uuid(),
  deviceId: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  type: z.enum(['checking', 'savings', 'credit']),
  currency: z.literal('USD'),
  targetId: z.string().max(160).optional(),
  consent: z.literal(true),
});
export const appleBatchInput = z.object({
  accountId: z.string().max(160),
  deviceId: z.string().uuid(),
  sequence: z.number().int().positive(),
  transactions: z
    .array(
      z.object({
        providerId: z.string().uuid(),
        name: z.string().min(1).max(160),
        date: dateSchema,
        authorizedDate: dateSchema.optional(),
        amount: centsSchema.nonnegative(),
        currency: z.literal('USD'),
        direction: z.enum(['credit', 'debit']),
        type: z.enum(['spending', 'refund', 'income', 'transfer', 'card_payment']),
        pending: z.boolean(),
      }),
    )
    .max(500),
  deleted: z.array(z.string().uuid()).max(500),
  balances: z
    .array(
      z.object({
        providerId: z.string().uuid(),
        date: dateSchema,
        asOf: z.string().datetime(),
        balance: centsSchema,
        currency: z.literal('USD'),
      }),
    )
    .max(500)
    .default([]),
  deletedBalances: z.array(z.string().uuid()).max(500).default([]),
});
export function connectAppleAccount(
  state: State,
  input: z.infer<typeof appleAccountInput>,
  now: string,
) {
  const existing = state.accounts.find(
    (a) => a.source === 'financekit' && a.providerId === input.providerId,
  );
  if (existing) {
    if (existing.financekit?.deviceId !== input.deviceId)
      throw Error(
        'This Apple account is synced by another device. Disconnect it before changing devices.',
      );
    if (input.targetId && existing.id !== input.targetId)
      throw Error('This Apple account is already linked.');
    return existing;
  }
  let account = input.targetId ? state.accounts.find((a) => a.id === input.targetId) : undefined;
  if (
    input.targetId &&
    (!account ||
      !['csv', 'manual'].includes(account.source) ||
      account.connectionId ||
      account.currency !== input.currency ||
      ![input.type, 'manual'].includes(account.type as typeof input.type))
  )
    throw Error('Choose an unconnected imported account with the same currency and type.');
  if (
    account &&
    (state.holdings.some((h) => h.accountId === account!.id) ||
      state.investmentActivity.some((t) => t.accountId === account!.id))
  )
    throw Error('Investment accounts cannot be linked to Apple Wallet.');
  const original = account ? { ...account } : undefined;
  if (!account) {
    account = accountSchema.parse({
      id: `apple-${input.providerId}`,
      name: input.name,
      type: input.type,
      currency: input.currency,
      balance: null,
      source: 'financekit',
      updatedAt: now,
    });
    state.accounts.push(account);
  }
  Object.assign(account, {
    type: input.type,
    source: 'financekit',
    providerId: input.providerId,
    connectionId: `apple-${input.providerId}`,
    financekit: { deviceId: input.deviceId, sequence: 0, consentAt: now, original },
  });
  return account;
}
export function applyAppleBatch(
  state: State,
  input: z.infer<typeof appleBatchInput>,
  now: string,
  hash: string,
) {
  const account = state.accounts.find((a) => a.id === input.accountId && a.source === 'financekit');
  const connection = account?.financekit;
  if (!account || !connection || connection.deviceId !== input.deviceId)
    throw Error('Apple account is not linked to this device.');
  if (input.sequence === connection.sequence && hash === connection.lastBatchHash) return;
  if (input.sequence !== connection.sequence + 1)
    throw Error('Apple sync changed. Refresh and try again.');
  const seen = new Set<string>();
  for (const t of input.transactions) {
    if (seen.has(t.providerId) || input.deleted.includes(t.providerId))
      throw Error('Duplicate Apple transaction change.');
    seen.add(t.providerId);
    if (t.currency !== account.currency) throw Error('Apple transaction currency does not match.');
    const previous = state.transactions.find(
      (x) =>
        x.accountId === account.id && x.source === 'financekit' && x.providerId === t.providerId,
    );
    const provider = applyRules(
      transactionSchema.parse({
        id: `apple-${account.id}-${t.providerId}`,
        accountId: account.id,
        name: t.name,
        date: t.date,
        amount: t.amount,
        currency: t.currency,
        kind: t.type,
        categoryId: 'other',
        pending: t.pending,
        source: 'financekit',
        removed: false,
        importedAt: previous?.importedAt ?? now,
        providerId: t.providerId,
        connectionId: account.connectionId,
        raw: { authorized_date: t.authorizedDate, direction: t.direction },
      }),
      state,
    );
    const imported =
      previous || provider.pending ? undefined : importedMatch(state.transactions, provider);
    if (previous)
      Object.assign(previous, provider, {
        id: previous.id,
        edits: previous.edits,
        notes: previous.notes,
        splits: previous.splits,
        reviewed: previous.reviewed,
        excluded: previous.excluded,
        recurring: previous.recurring,
        tags: previous.tags,
        fingerprint: previous.fingerprint,
        importIdentity: previous.importIdentity,
        raw: {
          ...provider.raw,
          ...(previous.raw?.assetImported ? { assetImported: previous.raw.assetImported } : {}),
        },
      });
    else if (imported)
      Object.assign(imported, preserveImportedDetails(imported, provider), {
        raw: { ...provider.raw, assetImported: structuredClone(imported) },
      });
    else state.transactions.push(provider);
  }
  for (const id of input.deleted) {
    const t = state.transactions.find(
      (t) => t.accountId === account.id && t.source === 'financekit' && t.providerId === id,
    );
    if (t) t.removed = true;
  }
  const seenBalances = new Set<string>();
  for (const b of input.balances) {
    if (seenBalances.has(b.providerId) || input.deletedBalances.includes(b.providerId))
      throw Error('Duplicate Apple balance change.');
    seenBalances.add(b.providerId);
    if (b.currency !== account.currency) throw Error('Apple balance currency does not match.');
    const id = `apple-balance-${account.id}-${b.providerId}`;
    state.snapshots = state.snapshots.filter((s) => s.id !== id);
    state.snapshots.push({ ...b, id, accountId: account.id, source: 'financekit' });
  }
  const deleted = new Set(input.deletedBalances.map((id) => `apple-balance-${account.id}-${id}`));
  state.snapshots = state.snapshots.filter((s) => !deleted.has(s.id));
  const newest = state.snapshots
    .filter((s) => s.accountId === account.id && s.source === 'financekit')
    .sort((a, b) => (b.asOf ?? b.date).localeCompare(a.asOf ?? a.date))[0];
  account.balance = newest?.balance ?? null;
  account.updatedAt = now;
  connection.sequence = input.sequence;
  connection.lastBatchHash = hash;
  connection.syncedAt = now;
}
export function removeAppleData(state: State, accountId: string) {
  const account = state.accounts.find((a) => a.id === accountId && a.source === 'financekit');
  if (!account) throw Error('Apple account not found.');
  state.transactions = state.transactions.flatMap((t) => {
    if (t.accountId !== accountId || t.source !== 'financekit') return [t];
    const imported = transactionSchema.safeParse(t.raw?.assetImported);
    return imported.success
      ? [{ ...imported.data, edits: { ...imported.data.edits, ...t.edits } }]
      : [];
  });
  state.snapshots = state.snapshots.filter(
    (s) => !(s.accountId === accountId && s.source === 'financekit'),
  );
  const original = accountSchema.safeParse(account.financekit?.original);
  state.accounts = state.accounts.filter((a) => a.id !== accountId);
  if (original.success)
    state.accounts.push({
      ...original.data,
      name: account.name,
      includeInNetWorth: account.includeInNetWorth,
    });
  else if (state.transactions.some((t) => t.accountId === accountId))
    state.accounts.push(
      accountSchema.parse({
        id: account.id,
        name: account.name,
        type: account.type,
        currency: account.currency,
        balance: null,
        updatedAt: account.updatedAt,
        source: 'manual',
      }),
    );
  else state.rules = state.rules.filter((r) => r.accountId !== accountId);
  if (state.notifications)
    state.notifications.items = state.notifications.items.filter(
      (n) => n.accountId !== accountId && !n.transactionId?.startsWith(`apple-${accountId}-`),
    );
}
