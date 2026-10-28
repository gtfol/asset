import { describe, it, expect } from 'vitest';
import { accountSchema } from '../shared/schema';
import { accountIdentity, historyOnly, creditUtilization, accountBalanceLabel } from '../shared/account-presentation';
const account = accountSchema.parse({ id: 'card', name: 'My card', type: 'credit', source: 'plaid', currency: 'USD', balance: 15000, updatedAt: '2026-10-28', connectionId: 'bank', mask: '1234' });
describe('account presentation', () => {
  it('uses the account institution or matching connection, never guesses from a mask', () => {
    expect(accountIdentity(account, [{ id: 'bank', institution_name: 'Chase' }]).name).toBe('Chase');
    expect(accountIdentity({ ...account, institutionName: 'Fidelity' }).name).toBe('Fidelity');
    expect(accountIdentity(account, [{ id: 'other', institution_name: 'Chase' }]).name).toBe('Credit card');
    expect(accountIdentity({ ...account, source: 'financekit', name: 'Apple Card' }).name).toBe('Apple');
  });
  it('distinguishes missing balances from zero and only shows known utilization', () => {
    expect(accountBalanceLabel({ ...account, balance: null })).toBe('No balance yet');
    expect(accountBalanceLabel({ ...account, source: 'venmo', balance: null })).toBe('Receipts only');
    expect(accountBalanceLabel({ ...account, balance: 0 })).toBe('Balance');
    expect(creditUtilization(account)).toBe(null);
    expect(creditUtilization({ ...account, creditLimit: 100000 })).toBe(15);
    expect(creditUtilization({ ...account, creditLimit: 100000, balance: 0 })).toBe(0);
    expect(creditUtilization({ ...account, creditLimit: 100000, balance: null })).toBe(null);
  });
  it('folds only excluded, unvalued manual history, retaining connected and valued accounts', () => {
    const history = { ...account, source: 'csv' as const, type: 'manual' as const, balance: null, includeInNetWorth: false };
    expect(historyOnly(history)).toBe(true);
    expect(historyOnly({ ...history, includeInNetWorth: true })).toBe(false);
    expect(historyOnly({ ...history, balance: 0 })).toBe(false);
    expect(historyOnly({ ...history, source: 'plaid' })).toBe(false);
    expect(historyOnly({ ...history, type: 'credit' })).toBe(false);
  });
});
