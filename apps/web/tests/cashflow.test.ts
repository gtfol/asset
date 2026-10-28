import { describe, expect, it } from 'vitest';
import { cashflow, coverage } from '../shared/core';
import { fixture, transaction } from './fixtures';

describe('cash flow period and history presentation', () => {
  it('labels monthly and year-to-date amounts independently of chart selection', () => {
    const s = fixture();
    s.transactions = [
      transaction('income', 718750, { kind: 'income' }),
      transaction('spend', 584424),
      transaction('march', 10000, { date: '2024-03-01' }),
    ];
    const c = cashflow(s, 'month', '2024-02', '2024-10-28');
    expect(c.periodLabel).toBe('February 2024');
    expect(c.priorLabel).toBe('January 2024');
    expect(c.net).toBe(134326);
    expect(c.income - c.spending).toBe(c.net);
    expect(c.months[1].net).toBe(c.net);
    expect(c.months[2].spending).toBe(10000);
    expect(cashflow(s, 'year', '2024', '2024-10-28').periodLabel).toBe('2024 · through Oct 28');
  });
  it('compares recorded imported activity without claiming it is verified or missing', () => {
    const s = fixture();
    s.accounts[0].source = 'csv';
    s.accounts[0].coverageComplete = false;
    s.transactions = [transaction('jan', 10000, { date: '2024-01-15' }), transaction('feb', 15000)];
    const c = cashflow(s, 'month', '2024-02', '2024-03-01');
    expect(c.complete).toBe(false);
    expect(c.comparisonBasis).toBe('recorded');
    expect(c.comparison.spending).toBe(50);
    expect(c.comparisonText.spending).toBe('+50.0% vs January 2024 ($100.00)');
    expect(c.history[0]).toMatchObject({ status: 'unverified', firstRecorded: '2024-01-15', lastRecorded: '2024-02-15' });
    expect(c.comparisonText.spending).not.toContain('Missing');
  });
  it('distinguishes zero, no recorded history, and future periods', () => {
    const s = fixture();
    s.transactions = [transaction('feb', 10000)];
    const verified = cashflow(s, 'month', '2024-02', '2024-02-29');
    expect(verified.comparisonUnavailable.spending).toBe('zero-prior');
    expect(verified.comparisonText.spending).toContain('Percentage change does not apply from zero');
    s.accounts[0].coverageComplete = false;
    const missing = cashflow(s, 'month', '2024-02', '2024-02-29');
    expect(missing.comparisonUnavailable.spending).toBe('no-prior');
    expect(missing.comparisonText.spending).toContain('No income or spending recorded');
    const future = cashflow(s, 'month', '2024-03', '2024-02-29');
    expect(future.future).toBe(true);
    expect(future.transactionCount).toBe(0);
    expect(future.comparisonUnavailable.spending).toBe('future');
    expect(future.months[2]).toMatchObject({ future: true, spending: 0, complete: false });
  });
  it('does not let a balance-only loan invalidate bank history', () => {
    const s = fixture();
    s.accounts.push({ ...s.accounts[0], id: 'loan', type: 'loan', coverageComplete: false });
    s.transactions = [transaction('payment', 23481, { loanAccountId: 'loan' })];
    expect(coverage(s, '2024-02-01', '2024-02-29')).toBe(true);
    expect(cashflow(s, 'month', '2024-02', '2024-02-29').history.map(a => a.id)).toEqual(['a']);
    s.transactions.push(transaction('loan-interest', 500, { accountId: 'loan' }));
    expect(coverage(s, '2024-02-01', '2024-02-29')).toBe(false);
  });
  it('preserves edits, refunds, splits, exclusions and currency boundaries', () => {
    const s = fixture();
    s.transactions = [
      transaction('income', 10000, { kind: 'income' }),
      transaction('split', 3000, { splits: [
        { id: 'part1', amount: 1000, categoryId: 'food', excluded: false },
        { id: 'part2', amount: 2000, categoryId: 'other', excluded: true },
      ] }),
      transaction('refund', 200, { kind: 'refund' }),
      transaction('edited', 500, { kind: 'transfer', edits: { kind: 'spending' } }),
      transaction('transfer', 80000, { kind: 'transfer' }),
      transaction('pending', 5000, { pending: true }),
      transaction('removed', 5000, { removed: true }),
      transaction('future', 5000, { date: '2024-03-01' }),
      transaction('foreign', 5000, { currency: 'EUR' }),
    ];
    const c = cashflow(s, 'month', '2024-02', '2024-02-29');
    expect(c).toMatchObject({ income: 10000, spending: 1300, net: 8700, transactionCount: 4 });
    expect(c.months[1].net).toBe(8700);
    s.settings.includeExcludedCashflow = true;
    expect(cashflow(s, 'month', '2024-02', '2024-02-29')).toMatchObject({ spending: 3300, transactionCount: 4 });
  });
  it('keeps excluded receipts in the history description while omitting them from totals', () => {
    const s = fixture();
    s.accounts[0].coverageComplete = false;
    s.transactions = [transaction('excluded', 1000, { excluded: true })];
    const c = cashflow(s, 'month', '2024-02', '2024-03-01');
    expect(c.spending).toBe(0);
    expect(c.history[0].firstRecorded).toBe('2024-02-15');
  });
  it('compares current months through matching calendar days and reports limited coverage honestly', () => {
    const s = fixture();
    s.accounts[0].coverageStart = '2024-02-01';
    s.transactions = [transaction('jan', 10000, { date: '2024-01-15' }), transaction('late-jan', 90000, { date: '2024-01-30' }), transaction('feb', 15000)];
    const c = cashflow(s, 'month', '2024-02', '2024-02-20');
    expect(c.priorEnd).toBe('2024-01-20');
    expect(c.prior.spending).toBe(10000);
    expect(c.prior.complete).toBe(false);
    expect(c.comparisonBasis).toBe('recorded');
    expect(c.comparisonText.spending).toContain('January 2024 · through Jan 20');
    expect(cashflow(s, 'month', '2024-01', '2024-02-20').history[0].status).toBe('limited');
  });
});
