import { z } from 'zod';
import type { State, Transaction } from './schema.js';
import { effective, money, today, totals } from './core.js';

export const notificationKinds = [
  'bankFee',
  'bigExpense',
  'creditUtilization',
  'income',
  'recurringPaid',
  'spending',
  'uncategorizedTransfer',
  'venmo',
] as const;
export type NotificationKind = (typeof notificationKinds)[number];
export const notificationLabels: Record<NotificationKind, string> = {
  bankFee: 'Bank fee alert',
  bigExpense: 'Big expense alert',
  creditUtilization: 'Credit utilization alert',
  income: 'Income update',
  recurringPaid: 'Recurring paid alert',
  spending: 'Spending update',
  uncategorizedTransfer: 'Uncategorized transfer alert',
  venmo: 'Venmo transaction alert',
};
export const notificationPreferencesSchema = z.object({
  bankFee: z.boolean().default(true),
  bigExpense: z.boolean().default(true),
  creditUtilization: z.boolean().default(true),
  income: z.boolean().default(true),
  recurringPaid: z.boolean().default(true),
  spending: z.boolean().default(true),
  uncategorizedTransfer: z.boolean().default(true),
  venmo: z.boolean().default(true),
  bigExpenseAmount: z.number().int().min(100).max(100_000_000).default(50_000),
  creditUtilizationPercent: z.number().int().min(1).max(100).default(30),
});
export const notificationItemSchema = z.object({
  id: z.string().max(300),
  kind: z.enum(notificationKinds),
  title: z.string().max(100),
  body: z.string().max(500),
  createdAt: z.string().datetime(),
  read: z.boolean(),
  transactionId: z.string().optional(),
  accountId: z.string().optional(),
});
export const notificationStateSchema = z.object({
  preferences: notificationPreferencesSchema,
  items: z.array(notificationItemSchema).max(200),
});
export const notificationPreferences = (s: State) =>
  notificationPreferencesSchema.parse(s.notifications?.preferences ?? {});
export type NotificationItem = z.infer<typeof notificationItemSchema>;
const normalized = (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' ');
const previousRecurring = (t: Transaction, previous: State) =>
  previous.transactions.some(
    (old) =>
      old.accountId === t.accountId &&
      !old.removed &&
      !!effective(old).recurring &&
      normalized(effective(old).name) === normalized(t.name),
  );

/** Produces alerts only for new posted activity on an existing account. Imports can opt out. */
export function updateNotifications(
  before: State,
  next: State,
  now = new Date().toISOString(),
  quiet = false,
): State {
  if (next.settings.demo) return next;
  const preferences = notificationPreferences(next);
  const items = [...(next.notifications?.items ?? [])];
  const seen = new Set(items.map((n) => n.id));
  const emit = (item: Omit<NotificationItem, 'read' | 'createdAt'>) => {
    if (!preferences[item.kind] || seen.has(item.id)) return;
    seen.add(item.id);
    items.unshift({ ...item, read: false, createdAt: now });
  };
  if (!quiet) {
    const oldAccounts = new Map(before.accounts.map((a) => [a.id, a]));
    const oldTransactions = new Map(before.transactions.map((t) => [t.id, t]));
    const asOf = today(next.settings.timezone, new Date(now));
    const cutoff = new Date(new Date(asOf + 'T12:00:00Z').getTime() - 7 * 86400000)
      .toISOString()
      .slice(0, 10);
    for (const raw of next.transactions) {
      const old = oldTransactions.get(raw.id),
        account = oldAccounts.get(raw.accountId);
      const t = effective(raw);
      if (
        !account?.enabled ||
        raw.pending ||
        raw.removed ||
        (old && !old.pending) ||
        t.date < cutoff ||
        t.date > asOf
      )
        continue;
      const base = { transactionId: t.id, accountId: t.accountId };
      const add = (kind: NotificationKind, body: string) =>
        emit({ ...base, id: `${kind}:${t.id}`, kind, title: notificationLabels[kind], body });
      const amount = money(t.amount, t.currency),
        description = `${t.name} · ${amount} · ${account.name}`;
      const pfc = raw.raw?.personal_finance_category as { primary?: string } | undefined;
      if (
        t.kind === 'spending' &&
        (pfc?.primary === 'BANK_FEES' ||
          /\b(overdraft|nsf fee|maintenance fee|monthly service fee|atm fee|wire fee|foreign transaction fee|late payment fee)\b/i.test(
            t.name,
          ))
      )
        add('bankFee', description);
      if (
        t.kind === 'spending' &&
        t.currency === next.settings.currency &&
        t.amount >= preferences.bigExpenseAmount
      )
        add('bigExpense', description);
      if (t.kind === 'income') add('income', description);
      if (t.kind === 'spending' && (t.recurring || previousRecurring(t, before)))
        add('recurringPaid', description);
      if (t.kind === 'transfer' && t.categoryId === 'other' && !t.reviewed && !t.excluded)
        add('uncategorizedTransfer', `${description}. Review this transfer.`);
      if (/\bvenmo\b/i.test(account.name + ' ' + t.name)) add('venmo', description);
    }
    for (const account of next.accounts) {
      const old = oldAccounts.get(account.id);
      if (
        !old?.enabled ||
        !account.enabled ||
        account.type !== 'credit' ||
        account.balance === null ||
        !account.creditLimit ||
        account.creditLimit <= 0
      )
        continue;
      const level = (Math.max(0, account.balance) * 100) / account.creditLimit;
      const oldLevel =
        old.balance !== null && old.creditLimit
          ? (Math.max(0, old.balance) * 100) / old.creditLimit
          : null;
      if (
        level >= preferences.creditUtilizationPercent &&
        oldLevel !== null &&
        oldLevel < preferences.creditUtilizationPercent
      )
        emit({
          id: `creditUtilization:${account.id}:${asOf}`,
          kind: 'creditUtilization',
          title: notificationLabels.creditUtilization,
          body: `${account.name} is using ${Math.round(level)}% of its reported credit limit.`,
          accountId: account.id,
        });
    }
  }
  return { ...next, notifications: { preferences, items: items.slice(0, 200) } };
}

/** One daily summary after 7 pm in the workspace's time zone. No historical catch-up. */
export function dailySpendingNotification(state: State, now = new Date().toISOString()): State {
  if (state.settings.demo || !notificationPreferences(state).spending || !state.transactions.length)
    return state;
  const date = new Date(now),
    day = today(state.settings.timezone, date);
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: state.settings.timezone,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(date),
  );
  if (hour < 19 || state.notifications?.items.some((n) => n.id === `spending:${day}`)) return state;
  const value = totals(state, day, day, false);
  if (!value.spending) return state;
  return {
    ...state,
    notifications: {
      preferences: notificationPreferences(state),
      items: [
        {
          id: `spending:${day}`,
          kind: 'spending' as const,
          title: 'Spending update',
          read: false,
          createdAt: now,
          body: `${money(value.spending, state.settings.currency)} spent today from posted activity${value.complete ? '.' : ' received so far. Some account history is incomplete.'}`,
        },
        ...(state.notifications?.items ?? []),
      ].slice(0, 200),
    },
  };
}
