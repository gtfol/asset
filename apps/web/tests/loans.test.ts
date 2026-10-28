import { describe, expect, it } from 'vitest';
import { applyCommand, effective, netWorth, totals, validateState } from '../shared/core';
import { loanPaymentSummary } from '../shared/loans';
import { mergeLocalWorkspace } from '../shared/workspace';
import { fixture, transaction } from './fixtures';
import { createTransactionIndex, filterTransactionIndex } from '../src/transactions';
function state() {
  const s = fixture();
  s.accounts.push({ ...s.accounts[0], id: 'car', name: 'Car', type: 'loan', mask: '4604', balance: 1300000,
    loan: { lender: 'santander', paymentAmount: 23481, ratePercent: 2.99, rateType: 'APR' } });
  s.transactions = [transaction('paid', 23481, { source: 'csv', name: 'Santander Billpay Lin Co', kind: 'transfer', excluded: true, reviewed: true,
    importIdentity: 'copilot:["checking","2024-02-15","Santander Billpay Lin Co",23481,"transfer"]:1',
    edits: { notes: 'Keep my note', categoryId: 'other' } })];
  return s;
}
describe('loan payment links', () => {
  it('matches a unique lender and signed payment amount, or a lender and account reference', () => {
    const s = state();
    s.transactions.push(transaction('extra', 50000, { source: 'plaid', name: 'Santander loan 29074604', raw: { amount: 500 } }));
    expect(loanPaymentSummary(s, 'car').candidates.map(t => [t.id, t.matchReason])).toEqual([
      ['extra', 'Account reference'], ['paid', 'Lender and payment amount'],
    ]);
    s.accounts.push({ ...s.accounts[1], id: 'second', mask: '1234' });
    expect(loanPaymentSummary(s, 'car').candidates.map(t => t.id)).toEqual(['extra']);
  });
  it('does not match amount alone, inbound transfers, generic credit-card payments, pending or removed entries', () => {
    const s = state();
    s.accounts[1].loan!.lender = 'synchrony';
    s.accounts[1].loan!.paymentAmount = 15708;
    s.transactions = [
      transaction('paylater', 15708, { name: 'Synchrony Bank Syf-payltr Setpay Co', raw: { amount: 157.08 } }),
      ...[
        { id: 'other', name: 'Other lender' }, { id: 'card', name: 'Synchrony credit card' },
        { id: 'incoming', kind: 'transfer', raw: { amount: -157.08 } },
        { id: 'pending', pending: true }, { id: 'removed', removed: true },
        { id: 'refund', kind: 'refund' }, { id: 'unsigned', kind: 'transfer' },
        { id: 'csv-incoming', kind: 'transfer', importIdentity: 'copilot:["a","2024-02-15","x",-15708,"transfer"]:1' },
      ].map(extra => transaction(extra.id, 15708, { name: 'Synchrony Bank Syf-payltr Setpay Co', ...extra } as any)),
    ];
    expect(loanPaymentSummary(s, 'car').candidates.map(t => t.id)).toEqual(['paylater']);
  });
  it('links without moving, duplicating, reviewing, recategorizing or changing financial totals; unlink is reversible', () => {
    const s = state(), original = s.transactions[0];
    const next = applyCommand(s, { type: 'transactions.linkLoan', payload: { loanAccountId: 'car', ids: ['paid'] } });
    expect(next.transactions).toEqual([{ ...original, edits: { ...original.edits, loanAccountId: 'car' } }]);
    expect(next.accounts).toEqual(s.accounts);
    expect(netWorth(next)).toEqual(netWorth(s));
    expect(totals(next, '2024-01-01', '2024-12-31')).toEqual(totals(s, '2024-01-01', '2024-12-31'));
    const index = createTransactionIndex(next.transactions);
    expect(filterTransactionIndex(index, { account: 'a' })).toHaveLength(1);
    expect(filterTransactionIndex(index, { account: 'car' })).toHaveLength(1);
    expect(loanPaymentSummary(next, 'car')).toMatchObject({ totalPaid: 23481, candidates: [] });
    const cleared = applyCommand(next, { type: 'transaction.update', payload: { id: 'paid', edits: { loanAccountId: null } } });
    expect(effective(cleared.transactions[0]).loanAccountId).toBeNull();
    expect(loanPaymentSummary(cleared, 'car').payments).toHaveLength(0);
  });
  it('rejects unavailable selections, invalid targets, mismatched currency, and another loan’s payments', () => {
    const s = state();
    for (const payload of [{ loanAccountId: 'a', ids: ['paid'] }, { loanAccountId: 'car', ids: ['missing'] }])
      expect(() => applyCommand(s, { type: 'transactions.linkLoan', payload })).toThrow();
    s.accounts[1].currency = 'EUR';
    expect(() => applyCommand(s, { type: 'transactions.linkLoan', payload: { loanAccountId: 'car', ids: ['paid'] } })).toThrow('same currency');
    s.accounts[1].currency = 'USD';
    s.accounts.push({ ...s.accounts[1], id: 'second' });
    s.transactions[0].edits.loanAccountId = 'second';
    expect(() => applyCommand(s, { type: 'transactions.linkLoan', payload: { loanAccountId: 'car', ids: ['paid'] } })).toThrow('another loan');
    s.accounts[2].type = 'checking';
    expect(() => validateState(s)).toThrow('separate loan');
  });
  it('preserves links when a local workspace is merged during sign-in', () => {
    const s = state(); s.transactions[0].edits.loanAccountId = 'car';
    const merged = mergeLocalWorkspace(fixture(), s, '3d85bcaf-b741-4dad-9cc3-57aa06a67a56');
    const t = merged.transactions[0];
    expect(t.edits.loanAccountId).toBe('3d85bcaf-b741-4dad-9cc3-57aa06a67a56:car');
    expect(() => validateState(merged)).not.toThrow();
  });
});
