import type { Account, State, Transaction } from './schema.js';

export const loanLenders = {
  santander: { name: 'Santander Consumer USA', url: 'https://myaccount.santanderconsumerusa.com/' },
  synchrony: {
    name: 'Synchrony Pay Later',
    url: 'https://www.synchrony.com/quickaccess/signin/paylater',
  },
  other: { name: 'Other lender', url: null },
} as const;

const lenderPatterns = {
  santander: /\bsantander\b/i,
  synchrony: /\bsynchrony\b.*\b(?:syf[ -]?payltr|setpay|pay[ -]?later)\b/i,
  other: /$a/,
};

function isWithdrawal(t: Transaction) {
  if (t.removed || t.pending || !t.amount || ['income', 'refund', 'investment_trade'].includes(t.kind)) return false;
  if (typeof t.raw?.amount === 'number') return t.raw.amount > 0;
  if (t.importIdentity?.startsWith('copilot:')) {
    try {
      return JSON.parse(t.importIdentity.slice(8, t.importIdentity.lastIndexOf(':')))[3] > 0;
    } catch { return false; }
  }
  // Transfers without a signed source amount cannot establish payment direction.
  return t.kind === 'spending';
}

function matchReason(t: Transaction, loan: Account) {
  if (!loan.loan || loan.currency !== t.currency || loan.id === t.accountId) return null;
  const description = [t.name, t.raw?.name, t.raw?.merchant_name, t.raw?.original_description]
    .filter((v): v is string => typeof v === 'string').join(' ');
  if (!lenderPatterns[loan.loan.lender].test(description)) return null;
  const mask = loan.mask || loan.name.match(/[·•]\s*(\d{4})\s*$/)?.[1];
  if (mask && /^\d{4}$/.test(mask) && new RegExp(`\\d*${mask}(?!\\d)`).test(description))
    return 'Account reference';
  return loan.loan.paymentAmount === t.amount ? 'Lender and payment amount' : null;
}

export function loanPaymentSummary(state: State, loanAccountId: string) {
  const loans = state.accounts.filter((a) => a.type === 'loan');
  const payments: Transaction[] = [];
  const candidates: (Transaction & { matchReason: string })[] = [];
  for (const original of state.transactions) {
    const t = { ...original, ...original.edits };
    if (t.removed) continue;
    if (t.loanAccountId === loanAccountId) {
      if (!t.pending) payments.push(t);
      continue;
    }
    if (t.loanAccountId || !isWithdrawal(t)) continue;
    const matches = loans.map((loan) => ({ loan, reason: matchReason(t, loan) })).filter((m) => m.reason);
    const referenceMatches = matches.filter((m) => m.reason === 'Account reference');
    const strongest = referenceMatches.length ? referenceMatches : matches;
    if (strongest.length === 1 && strongest[0].loan.id === loanAccountId)
      candidates.push({ ...t, matchReason: strongest[0].reason! });
  }
  payments.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  candidates.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  return { payments, candidates, totalPaid: payments.reduce((sum, t) => sum + t.amount, 0) };
}
