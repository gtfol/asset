import { z } from 'zod';
import { mergeLocalWorkspace } from './workspace.js';
import { importCopilot, copilotOptionsSchema, repairCopilotHistory } from './copilot.js';
import { linkImportedAccount, reconcileHistory } from './account-links.js';
export * from './account-links.js';
import {
  notificationPreferences,
  notificationPreferencesSchema,
  updateNotifications,
} from './notifications.js';
export * from './notifications.js';
import {
  stateSchema,
  validateState,
  transactionSchema,
  editSchema,
  categorySchema,
  accountSchema,
  budgetSchema,
  holdingSchema,
  ruleSchema,
  splitSchema,
  snapshotSchema,
  type State,
  type Transaction,
  type Command,
  type Kind,
} from './schema.js';
export * from './schema.js';
export * from './bitcoin.js';
export const money = (cents: number | null, currency = 'USD') =>
  cents === null
    ? 'Unavailable'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        maximumFractionDigits: 2,
      }).format(cents / 100);
export function parseMoney(text: string): number {
  const clean = text.trim().replace(/[$,]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(clean))
    throw Error('Enter a money amount with no more than two decimals');
  const negative = clean.startsWith('-');
  const [a, b = ''] = clean.replace('-', '').split('.');
  const result = Number(a) * 100 + Number(b.padEnd(2, '0'));
  if (!Number.isSafeInteger(result)) throw Error('Amount is too large');
  return negative ? -result : result;
}
export const today = (timezone?: string, date = new Date()) => {
  if (timezone) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const p = (type: string) => parts.find((x) => x.type === type)!.value;
    return `${p('year')}-${p('month')}-${p('day')}`;
  }
  const d = date;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const monthDays = (month: string) =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
export function shiftMonth(month: string, delta: number) {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}
export const monthEnd = (month: string) => `${month}-${monthDays(month)}`;
export const effective = (t: Transaction): Transaction => ({ ...t, ...t.edits });
export const isSpending = (kind: Kind) => kind === 'spending' || kind === 'refund';
export const spendAmount = (t: { kind: Kind; amount: number }) =>
  t.kind === 'spending' ? t.amount : t.kind === 'refund' ? -t.amount : 0;
export function ledger(s: State, asOf = today(s.settings.timezone), includeExcluded = false) {
  const accounts = new Set(
    s.accounts.filter((a) => a.enabled && a.currency === s.settings.currency).map((a) => a.id),
  );
  return s.transactions
    .filter(
      (t) =>
        !t.removed && !t.pending && accounts.has(t.accountId) && t.currency === s.settings.currency,
    )
    .flatMap((t) => {
      const e = effective(t);
      if (e.date > asOf) return [];
      const parts = e.splits.length
        ? e.splits.map((p) => ({
            ...e,
            id: p.id,
            parentId: e.id,
            amount: p.amount,
            categoryId: p.categoryId,
            excluded: e.excluded || p.excluded,
          }))
        : [e];
      return parts.filter((x) => includeExcluded || !x.excluded);
    });
}
export function coverage(s: State, start: string, end: string) {
  const a = s.accounts.filter(
    (a) => a.enabled && a.currency === s.settings.currency && a.type !== 'investment',
  );
  return (
    start <= end &&
    a.length > 0 &&
    a.every(
      (a) =>
        a.coverageComplete &&
        !!a.coverageStart &&
        a.coverageStart <= start &&
        !!a.coverageEnd &&
        a.coverageEnd >= end,
    )
  );
}
export function totals(
  s: State,
  start: string,
  end: string,
  includeExcluded = s.settings.includeExcludedCashflow,
  categoryId?: string,
) {
  let income = 0,
    spending = 0;
  const categories: Record<string, number> = {};
  for (const t of ledger(s, end, includeExcluded)) {
    if (t.date < start || (categoryId && t.categoryId !== categoryId)) continue;
    if (t.kind === 'income') income += t.amount;
    const value = spendAmount(t);
    spending += value;
    if (isSpending(t.kind)) categories[t.categoryId] = (categories[t.categoryId] ?? 0) + value;
  }
  return {
    income,
    spending,
    net: income - spending,
    categories,
    complete: coverage(s, start, end),
  };
}
export function projectSpending(
  spend: number,
  elapsed: number,
  days: number,
  completeMonth = false,
) {
  if (completeMonth || elapsed <= 0 || elapsed > days) return null;
  return Math.round((spend * days) / elapsed);
}
export function dashboard(
  s: State,
  month = today(s.settings.timezone).slice(0, 7),
  asOf = today(s.settings.timezone),
) {
  const isCurrent = month === asOf.slice(0, 7),
    historical = month < asOf.slice(0, 7),
    elapsed = historical ? monthDays(month) : isCurrent ? Number(asOf.slice(8)) : 0,
    days = monthDays(month),
    end = historical ? monthEnd(month) : asOf;
  const budgets = s.budgets.filter((b) => b.month === month),
    configured = budgets.length > 0,
    budget = budgets.reduce((a, b) => a + b.amount, 0);
  const tx = ledger(s, end).filter((t) => t.date.startsWith(month));
  let running = 0;
  const points = Array.from({ length: days }, (_, i) => {
    const day = i + 1;
    running += tx
      .filter((t) => Number(t.date.slice(8)) === day)
      .reduce((a, t) => a + spendAmount(t), 0);
    return {
      day,
      date: `${month}-${String(day).padStart(2, '0')}`,
      actual: day <= elapsed ? running : null,
      ideal: configured ? Math.round((budget * day) / days) : null,
    };
  });
  const spending = tx.reduce((a, t) => a + spendAmount(t), 0),
    ideal = configured ? Math.round((budget * elapsed) / days) : null,
    complete = coverage(s, month + '-01', end);
  const categories = s.categories
    .filter((c) => !c.archived || tx.some((t) => t.categoryId === c.id))
    .map((c) => {
      const spent = tx.filter((t) => t.categoryId === c.id).reduce((a, t) => a + spendAmount(t), 0),
        b = budgets.find((b) => b.categoryId === c.id)?.amount ?? null;
      return {
        ...c,
        spent,
        budget: b,
        left: b === null ? null : b - spent,
        status:
          b === null
            ? 'No budget'
            : spent > b
              ? 'Over budget'
              : isCurrent && spent > (b * elapsed) / days
                ? 'At risk'
                : 'On pace',
      };
    })
    .sort((a, b) => b.spent - a.spent);
  return {
    month,
    asOf,
    days,
    elapsed,
    historical,
    isCurrent,
    budget: configured ? budget : null,
    spending,
    left: configured ? budget - spending : null,
    ideal,
    paceDifference: ideal === null ? null : ideal - spending,
    projection: complete ? projectSpending(spending, elapsed, days, historical) : null,
    complete,
    points,
    categories,
    netThisMonth: totals(s, month + '-01', end),
    reviewCount: s.transactions.filter((t) => !t.removed && !t.reviewed).length,
  };
}
export function cashflow(
  s: State,
  mode: 'month' | 'year',
  period: string,
  asOf = today(s.settings.timezone),
) {
  const current = mode === 'month' ? period === asOf.slice(0, 7) : period === asOf.slice(0, 4),
    start = mode === 'month' ? period + '-01' : period + '-01-01',
    end = current ? asOf : mode === 'month' ? monthEnd(period) : period + '-12-31';
  const previous = mode === 'month' ? shiftMonth(period, -1) : String(Number(period) - 1);
  const priorStart = mode === 'month' ? previous + '-01' : previous + '-01-01';
  const priorEnd = current
    ? mode === 'month'
      ? `${previous}-${String(Math.min(Number(asOf.slice(8)), monthDays(previous))).padStart(2, '0')}`
      : `${previous}-${asOf.slice(5, 7)}-${String(Math.min(Number(asOf.slice(8)), monthDays(previous + '-' + asOf.slice(5, 7)))).padStart(2, '0')}`
    : mode === 'month'
      ? monthEnd(previous)
      : previous + '-12-31';
  const actual = totals(s, start, end > asOf ? asOf : end),
    prior = totals(s, priorStart, priorEnd);
  const comparison = (key: 'income' | 'spending' | 'net') =>
    !actual.complete || !prior.complete || prior[key] === 0
      ? null
      : ((actual[key] - prior[key]) / Math.abs(prior[key])) * 100;
  const year = period.slice(0, 4),
    months = Array.from({ length: 12 }, (_, i) => {
      const month = `${year}-${String(i + 1).padStart(2, '0')}`;
      const future = month > asOf.slice(0, 7);
      return {
        month,
        future,
        ...totals(s, month + '-01', month >= asOf.slice(0, 7) ? asOf : monthEnd(month)),
      };
    });
  return {
    mode,
    period,
    start,
    end,
    priorStart,
    priorEnd,
    current,
    ...actual,
    prior,
    comparison: {
      income: comparison('income'),
      spending: comparison('spending'),
      net: comparison('net'),
    },
    months,
  };
}
export function netWorth(s: State) {
  const currency = s.settings.currency;
  const list = s.accounts.filter(
    (a) => a.enabled && a.includeInNetWorth && a.currency === currency,
  );
  let assets = 0,
    debt = 0;
  for (const a of list) {
    if (a.balance === null) continue;
    if (a.type === 'credit' || a.type === 'loan') debt += a.balance;
    else assets += a.balance;
  }
  const dates = [
    ...new Set(
      s.snapshots.filter((p) => list.some((a) => a.id === p.accountId)).map((p) => p.date),
    ),
  ].sort();
  const histories = new Map(
    list.map((a) => {
      const firstByDate = new Map<string, State['snapshots'][number]>();
      for (const p of s.snapshots)
        if (p.accountId === a.id && p.currency === currency && !firstByDate.has(p.date))
          firstByDate.set(p.date, p);
      return [a.id, [...firstByDate.values()].sort((a, b) => a.date.localeCompare(b.date))];
    }),
  );
  const positions = new Map(list.map((a) => [a.id, -1]));
  const history = dates.map((date) => {
    let v = 0;
    let known = 0;
    for (const a of list) {
      const snapshots = histories.get(a.id)!;
      let index = positions.get(a.id)!;
      while (index + 1 < snapshots.length && snapshots[index + 1].date <= date) index++;
      positions.set(a.id, index);
      const p = snapshots[index];
      if (p) {
        known++;
        v += (a.type === 'credit' || a.type === 'loan' ? -1 : 1) * p.balance;
      }
    }
    return { date, value: v, complete: known === list.length };
  });
  return {
    assets,
    debt,
    total: assets - debt,
    complete: list.every((a) => a.balance !== null),
    history,
    otherCurrencies: [
      ...new Set(s.accounts.filter((a) => a.currency !== currency).map((a) => a.currency)),
    ],
  };
}
export function investmentOverview(s: State, accountId = 'all', asOf = today(s.settings.timezone)) {
  const accounts = s.accounts.filter(
    (a) =>
      a.type === 'investment' &&
      a.enabled &&
      a.currency === s.settings.currency &&
      (accountId === 'all' || a.id === accountId),
  );
  const ids = new Set(accounts.map((a) => a.id));
  const holdings = s.holdings
    .filter((h) => ids.has(h.accountId) && h.currency === s.settings.currency)
    .map((h) => ({
      ...h,
      stale:
        !h.priceAt ||
        h.priceAt.slice(0, 10) <
          new Date(new Date(asOf + 'T12:00:00Z').getTime() - 4 * 864e5).toISOString().slice(0, 10),
      gain: h.marketValue !== null && h.costBasis !== null ? h.marketValue - h.costBasis : null,
      gainPercent:
        h.marketValue !== null && h.costBasis !== null && h.costBasis > 0
          ? ((h.marketValue - h.costBasis) / h.costBasis) * 100
          : null,
    }));
  const value = holdings.reduce((a, h) => a + (h.marketValue ?? 0), 0);
  const allocation: Record<string, number> = {};
  for (const h of holdings) allocation[h.type] = (allocation[h.type] ?? 0) + (h.marketValue ?? 0);
  const base = netWorth({
    ...s,
    accounts: s.accounts.map((a) => ({ ...a, includeInNetWorth: ids.has(a.id) })),
  });
  return {
    accounts,
    holdings,
    value,
    accountBalance: accounts.reduce((sum, a) => sum + (a.balance ?? 0), 0),
    complete: holdings.length > 0 && holdings.every((h) => h.marketValue !== null),
    allocation,
    history: base.history,
    returnPercent: null,
    returnReason:
      'Cash-flow-adjusted return needs complete dated valuations and external contribution history. Balance growth is not investment return.',
  };
}
// Merchant suggestions stay on-device/server; no transaction data is sent to an AI service.
export function categorySuggestion(
  s: State,
  transaction: Transaction,
): { categoryId: string; reason: string } | null {
  const t = effective(transaction);
  if (transaction.edits.categoryId || t.splits.length) return null;
  const name = t.name.trim().toLowerCase();
  const rule = s.rules.find(
    (r) =>
      (!r.accountId || r.accountId === t.accountId) &&
      (r.match === 'exact'
        ? name === r.merchant.trim().toLowerCase()
        : name.includes(r.merchant.trim().toLowerCase())) &&
      s.categories.some((c) => c.id === r.categoryId && !c.archived),
  );
  if (rule) return { categoryId: rule.categoryId, reason: 'Your merchant rule' };
  // Preserve provider and imported categories. Suggestions only fill uncategorized spending.
  if (t.categoryId !== 'other' || !isSpending(t.kind)) return null;
  const merchants: [RegExp, string, string[]][] = [
    [
      /\b(uber eats|doordash|grubhub|chipotle|sweetgreen|panera|restaurant|noodle|pizza)\b/,
      'restaurants',
      ['restaurants', 'dining', 'dining out'],
    ],
    [/\b(starbucks|coffee|café|cafe|peet'?s)\b/, 'coffee', ['coffee', 'coffee shops']],
    [
      /\b(whole foods|trader joe|safeway|kroger|aldi|grocery|groceries|greenmarket)\b/,
      'groceries',
      ['groceries'],
    ],
    [
      /\b(tesla supercharger|tesla charging|shell car wash|parksmart|transit|uber|lyft)\b/,
      'transport',
      ['transportation', 'transport', 'auto & transport'],
    ],
    [/\b(depop|poshmark|nordstrom|uniqlo|etsy)\b/, 'shopping', ['shops', 'shopping']],
    [
      /\b(amc|cinemark|eventbrite|seeticket|ticketmaster|netflix|spotify)\b/,
      'fun',
      ['entertainment'],
    ],
    [/\b(porkbun|namecheap|digitalocean|vercel)\b/, 'work', ['work expenses', 'business expenses']],
  ];
  for (const [pattern, icon, names] of merchants) {
    if (!pattern.test(name)) continue;
    const category =
      s.categories.find((c) => !c.archived && names.includes(c.name.toLowerCase())) ??
      s.categories.find((c) => !c.archived && (c.id === icon || c.icon === icon));
    if (category) return { categoryId: category.id, reason: 'Merchant match' };
  }
  return null;
}
export function applyRules(t: Transaction, s: State): Transaction {
  const suggestion = categorySuggestion(s, t);
  if (!suggestion) return t;
  const norm = effective(t).name.trim().toLowerCase();
  const rule = s.rules.find(
    (r) =>
      r.categoryId === suggestion.categoryId &&
      s.categories.some((c) => c.id === r.categoryId && !c.archived) &&
      (!r.accountId || r.accountId === t.accountId) &&
      (r.match === 'exact'
        ? norm === r.merchant.trim().toLowerCase()
        : norm.includes(r.merchant.trim().toLowerCase())),
  );
  return {
    ...t,
    categoryId: suggestion.categoryId,
    ...(rule?.name && !t.edits.name ? { name: rule.name } : {}),
  };
}
export function dailyReview(s: State) {
  const items = s.transactions
    .filter((t) => !t.removed && !t.reviewed)
    .map(effective)
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  const date = items[0]?.date ?? '';
  const day = items.filter((t) => t.date === date);
  const visible = day.slice(0, 6);
  return { date, total: items.length, dayCount: day.length, items: visible };
}
export const fingerprint = (t: {
  date: string;
  name: string;
  amount: number;
  accountId: string;
  kind: Kind;
  currency: string;
}) =>
  [
    t.accountId,
    t.date,
    t.amount,
    t.currency,
    t.kind,
    t.name.trim().toLowerCase().replace(/\s+/g, ' '),
  ].join('|');
// Import identity survives display-name/date edits and merchant rules.
export const importFingerprint = (t: Transaction) => t.fingerprint ?? fingerprint(t);
export function emptyState(): State {
  return {
    schemaVersion: 1,
    categories: [
      {
        id: 'other',
        name: 'Other',
        icon: 'other',
        color: '#8992a4',
        group: 'Everyday',
        archived: false,
      },
    ],
    accounts: [],
    transactions: [],
    budgets: [],
    snapshots: [],
    holdings: [],
    holdingSnapshots: [],
    rules: [],
    investmentActivity: [],
    settings: {
      currency: 'USD',
      includeExcludedCashflow: false,
      timezone: 'America/Los_Angeles',
      demo: false,
    },
  };
}
export function applyCommand(
  input: State,
  command: Command,
  now = new Date().toISOString(),
): State {
  const next = applyFinancialCommand(input, command, now);
  return validateState(
    updateNotifications(
      input,
      next,
      now,
      command.type.startsWith('import.') ||
        command.type === 'backup.restore' ||
        command.type.startsWith('notifications.'),
    ),
  );
}
function applyFinancialCommand(input: State, command: Command, now: string): State {
  const s = validateState(JSON.parse(JSON.stringify(input))),
    p = command.payload;
  const id = String(p.id ?? '');
  const transaction = () => {
    const t = s.transactions.find((t) => t.id === id);
    if (!t) throw Error('Transaction not found');
    return t;
  };
  switch (command.type) {
    case 'workspace.merge':
      return mergeLocalWorkspace(s, p.state, z.string().uuid().parse(p.id));
    case 'transaction.create': {
      const t = transactionSchema.parse(p);
      if (t.source !== 'manual') throw Error('Use the import flow');
      s.transactions.push(applyRules(t, s));
      break;
    }
    case 'transaction.update': {
      const t = transaction();
      if (p.reviewed === true && t.raw?.asset_split_conflict === true)
        throw Error(
          'Reconcile the changed provider amount before marking this transaction reviewed',
        );
      const edits = editSchema.parse(p.edits);
      t.edits = { ...t.edits, ...edits };
      if (p.reviewed !== undefined) t.reviewed = z.boolean().parse(p.reviewed);
      break;
    }
    case 'transaction.reconcile': {
      const t = transaction();
      if (t.raw?.asset_split_conflict !== true) throw Error('No amount conflict to reconcile');
      const amount = Math.abs(parseMoney(Number(t.raw.amount).toFixed(2)));
      const splits = z.array(splitSchema).min(2).parse(p.splits);
      if (splits.reduce((a, b) => a + b.amount, 0) !== amount)
        throw Error('Splits must equal the new provider amount');
      t.amount = amount;
      t.splits = splits;
      t.raw.asset_split_conflict = false;
      t.reviewed = false;
      break;
    }
    case 'transaction.split': {
      const t = transaction();
      const splits = z.array(splitSchema).min(2).parse(p.splits);
      if (splits.reduce((a, b) => a + b.amount, 0) !== t.amount)
        throw Error('Split amounts must equal the original transaction');
      t.splits = splits;
      break;
    }
    case 'transactions.review': {
      const ids = z.array(z.string()).max(10000).parse(p.ids);
      if (ids.some((id) => !s.transactions.some((t) => t.id === id && !t.removed)))
        throw Error('Selection contains unavailable transactions');
      if (
        p.reviewed === true &&
        s.transactions.some((t) => ids.includes(t.id) && t.raw?.asset_split_conflict === true)
      )
        throw Error(
          'Open the changed transaction and reconcile its splits before reviewing this selection',
        );
      for (const t of s.transactions)
        if (ids.includes(t.id)) t.reviewed = z.boolean().parse(p.reviewed);
      break;
    }
    case 'category.save': {
      const c = categorySchema.parse(p);
      const index = s.categories.findIndex((x) => x.id === c.id);
      if (index < 0) s.categories.push(c);
      else s.categories[index] = c;
      break;
    }
    case 'budget.save': {
      const b = budgetSchema.parse(p);
      s.budgets = s.budgets.filter((x) => x.month !== b.month || x.categoryId !== b.categoryId);
      s.budgets.push(b);
      break;
    }
    case 'account.save': {
      const a = accountSchema.parse(p);
      const existing = s.accounts.find((x) => x.id === a.id);
      if (existing && ['plaid', 'bitcoin', 'venmo', 'financekit'].includes(existing.source)) {
        existing.includeInNetWorth = a.includeInNetWorth;
        existing.name = a.name;
      } else {
        if (['plaid', 'bitcoin', 'venmo', 'financekit'].includes(a.source))
          throw Error('Use the connection flow to create tracked accounts');
        s.accounts = s.accounts.filter((x) => x.id !== a.id);
        s.accounts.push(a);
        if (a.balance !== null) {
          const date = a.updatedAt.slice(0, 10);
          s.snapshots = s.snapshots.filter((p) => p.accountId !== a.id || p.date !== date);
          s.snapshots.push({
            id: 'snapshot-' + a.id + '-' + date,
            accountId: a.id,
            date,
            balance: a.balance,
            currency: a.currency,
            source: a.source,
          });
        }
      }
      break;
    }
    case 'holding.save': {
      const h = holdingSchema.parse(p);
      if (
        h.source === 'plaid' ||
        h.source === 'bitcoin' ||
        s.holdings.some((x) => x.id === h.id && ['plaid', 'bitcoin'].includes(x.source)) ||
        s.accounts.some((a) => a.id === h.accountId && a.source === 'bitcoin')
      )
        throw Error('Provider holdings cannot be manually overwritten');
      s.holdings = s.holdings.filter((x) => x.id !== h.id);
      s.holdings.push(h);
      const date = today(s.settings.timezone, new Date(now));
      s.holdingSnapshots = s.holdingSnapshots.filter(
        (p) => p.holdingId !== h.id || p.date !== date,
      );
      s.holdingSnapshots.push({
        ...h,
        id: 'holding-snapshot-' + h.id + '-' + date,
        holdingId: h.id,
        date,
      });
      break;
    }
    case 'snapshot.save': {
      const snap = snapshotSchema.parse(p);
      if (
        snap.source === 'plaid' ||
        snap.source === 'bitcoin' ||
        snap.source === 'financekit' ||
        s.accounts.some(
          (a) => a.id === snap.accountId && ['bitcoin', 'financekit'].includes(a.source),
        )
      )
        throw Error('Provider snapshots are managed by sync');
      s.snapshots = s.snapshots.filter(
        (x) => x.accountId !== snap.accountId || x.date !== snap.date,
      );
      s.snapshots.push(snap);
      break;
    }
    case 'rule.save': {
      const r = ruleSchema.parse(p);
      s.rules = s.rules.filter((x) => x.id !== r.id);
      s.rules.unshift(r);
      break;
    }
    case 'rule.delete':
      s.rules = s.rules.filter((r) => r.id !== id);
      break;
    case 'bitcoin.disconnect': {
      const a = s.accounts.find((a) => a.id === id && a.source === 'bitcoin');
      if (!a) throw Error('Bitcoin address not found');
      a.source = 'manual';
      delete a.bitcoin;
      for (const h of [...s.holdings, ...s.holdingSnapshots, ...s.snapshots])
        if (h.accountId === id && h.source === 'bitcoin') h.source = 'manual';
      break;
    }
    case 'settings.save':
      s.settings = {
        ...s.settings,
        ...stateSchema.shape.settings.partial().omit({ demo: true }).parse(p),
      };
      break;
    case 'notifications.preferences':
      s.notifications = {
        items: s.notifications?.items ?? [],
        preferences: notificationPreferencesSchema.parse({ ...notificationPreferences(s), ...p }),
      };
      break;
    case 'notifications.read': {
      const ids = z.array(z.string()).max(200).parse(p.ids);
      s.notifications = {
        preferences: notificationPreferences(s),
        items: (s.notifications?.items ?? []).map((n) =>
          ids.includes(n.id) ? { ...n, read: true } : n,
        ),
      };
      break;
    }
    case 'import.link-accounts': {
      const links = z
        .array(z.object({ importedId: z.string(), connectedId: z.string() }))
        .min(1)
        .max(100)
        .parse(p.links);
      if (
        new Set(links.map((l) => l.importedId)).size !== links.length ||
        new Set(links.map((l) => l.connectedId)).size !== links.length
      )
        throw Error('Choose each account only once');
      let linked = s;
      for (const link of links)
        linked = linkImportedAccount(linked, link.importedId, link.connectedId);
      return validateState(linked);
    }
    case 'import.commit': {
      const tx = z.array(transactionSchema).max(10000).parse(p.transactions);
      const seen = new Set(s.transactions.filter((t) => !t.removed).map(importFingerprint));
      for (const t of tx) {
        if (t.source !== 'csv') throw Error('Only CSV rows can be imported here');
        const key = fingerprint(t);
        if (!seen.has(key)) {
          seen.add(key);
          s.transactions.push(applyRules({ ...t, fingerprint: key, reviewed: false }, s));
        }
      }
      break;
    }
    case 'import.copilot': {
      return validateState(
        importCopilot(
          s,
          z
            .string()
            .max(10 * 1024 * 1024)
            .parse(p.text),
          copilotOptionsSchema.parse(p.options),
          now,
        ),
      );
    }
    case 'import.reconcile-history': {
      const pairs = z
        .array(z.object({ importedId: z.string(), providerId: z.string() }))
        .max(10000)
        .parse(p.pairs);
      return validateState(reconcileHistory(s, pairs));
    }
    case 'import.copilotReview': {
      return validateState(
        repairCopilotHistory(
          s,
          z
            .string()
            .max(10 * 1024 * 1024)
            .parse(p.text),
        ),
      );
    }
    case 'backup.restore': {
      const restored = validateState(p.state);
      if (restored.accounts.some((a) => ['plaid', 'venmo', 'financekit'].includes(a.source)))
        throw Error('Restore backups with disconnected account provenance');
      if (restored.settings.demo !== s.settings.demo)
        throw Error('Demo and private data cannot be mixed');
      // Restoring history should not replay old alerts on registered devices.
      restored.notifications = { preferences: notificationPreferences(restored), items: [] };
      return restored;
    }
    default:
      throw Error('Unknown command');
  }
  return validateState(s);
}
export function backup(s: State) {
  s = validateState(s);
  return {
    format: 'asset-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    state: {
      ...s,
      accounts: s.accounts.map(({ connectionId, providerId, financekit, ...a }) => ({
        ...a,
        source: ['plaid', 'venmo', 'financekit'].includes(a.source) ? 'manual' : a.source,
      })),
      transactions: s.transactions.map(
        ({ raw, connectionId, providerId, pendingProviderId, ...t }) => ({
          ...t,
          source: ['plaid', 'venmo', 'financekit'].includes(t.source) ? 'manual' : t.source,
        }),
      ),
      snapshots: s.snapshots.map((p) => ({
        ...p,
        source: p.source === 'financekit' ? 'manual' : p.source,
      })),
      holdingSnapshots: s.holdingSnapshots.map(({ providerId, ...h }) => ({
        ...h,
        source: h.source === 'plaid' ? 'manual' : h.source,
      })),
      holdings: s.holdings.map(({ providerId, ...h }) => ({
        ...h,
        source: h.source === 'plaid' ? 'manual' : h.source,
      })),
    },
  };
}
