import type { Account } from './schema.js';

export type InstitutionConnection = { id: string; institution_name: string };
export function accountIdentity(a: Account, connections: InstitutionConnection[] = []) {
  const institution = a.institutionName || connections.find(c => c.id === a.connectionId)?.institution_name;
  const name = institution || (a.source === 'financekit' || /^apple\s/i.test(a.name) ? 'Apple'
    : a.source === 'venmo' || /^venmo\b/i.test(a.name) ? 'Venmo'
    : a.source === 'bitcoin' ? 'Bitcoin'
    : /^citi\b/i.test(a.name) ? 'Citi'
    : a.loan?.lender === 'santander' ? 'Santander'
    : a.loan?.lender === 'synchrony' ? 'Synchrony'
    : ({ checking: 'Checking', savings: 'Savings', credit: 'Credit card', investment: 'Investments', loan: 'Loan', manual: 'Cash & other' })[a.type]);
  const brands: [RegExp, string, string][] = [
    [/bank of america/i, '#c91e3f', 'B'], [/chase|j\.p\. morgan/i, '#087bbd', 'C'],
    [/merrill/i, '#164e86', 'M'], [/fidelity/i, '#35752e', 'F'], [/ally/i, '#712c79', 'a'],
    [/citi/i, '#084576', 'c'], [/robinhood/i, '#216f4b', 'R'], [/venmo/i, '#167cba', 'V'],
    [/apple/i, '#303c53', 'A'], [/bitcoin/i, '#ae5907', '₿'], [/santander/i, '#c82734', 'S'],
    [/synchrony/i, '#725b20', 'S'],
  ];
  const brand = brands.find(([pattern]) => pattern.test(name));
  return { name, color: brand?.[1] ?? '#496287', mark: brand?.[2] ?? name.charAt(0) };
}

// Keep unvalued, explicitly excluded manual history accessible without presenting
// it as an active bank account. A connected or valued account never lands here.
export function historyOnly(a: Account) {
  return ['csv', 'manual'].includes(a.source) && a.type === 'manual' && a.balance == null && !a.includeInNetWorth;
}
export function accountBalanceLabel(a: Account) {
  return a.balance != null ? 'Balance' : a.source === 'venmo' ? 'Receipts only' : 'No balance yet';
}
export function creditUtilization(a: Account) {
  return a.type === 'credit' && a.balance != null && a.creditLimit != null && a.creditLimit > 0
    ? Math.max(0, a.balance) / a.creditLimit * 100 : null;
}
