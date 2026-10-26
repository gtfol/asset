import { describe, expect, it } from 'vitest';
import { applyCommand, applyRules, categorySuggestion, dailyReview } from '../shared/core';
import { fixture, transaction } from './fixtures';

describe('daily review', () => {
  it('reviews only the visible day and batch, then advances without losing hidden records', () => {
    const state = fixture();
    state.transactions = Array.from({ length: 8 }, (_, i) =>
      transaction(`today-${i}`, 100, { date: '2024-02-15' }),
    );
    state.transactions.push(
      transaction('yesterday', 200, { date: '2024-02-14' }),
      transaction('removed', 200, { removed: true }),
      transaction('done', 200, { reviewed: true }),
    );
    const batch = dailyReview(state);
    expect(batch.total).toBe(9);
    expect(batch.dayCount).toBe(8);
    expect(batch.items).toHaveLength(6);
    const ids = batch.items.map((t) => t.id);
    const reviewed = applyCommand(state, {
      type: 'transactions.review',
      payload: { ids, reviewed: true },
    });
    expect(dailyReview(reviewed).items.map((t) => t.id)).toEqual(['today-6', 'today-7']);
    const undone = applyCommand(reviewed, {
      type: 'transactions.review',
      payload: { ids, reviewed: false },
    });
    expect(dailyReview(undone)).toEqual(batch);
  });
  it('groups by the edited date, with a stable order for equal dates', () => {
    const state = fixture();
    state.transactions = [
      transaction('b', 100, { edits: { date: '2024-02-16' } }),
      transaction('a', 100, { date: '2024-02-16' }),
      transaction('older', 100),
    ];
    expect(dailyReview(state).items.map((t) => t.id)).toEqual(['a', 'b']);
  });
});
describe('merchant categorization', () => {
  const state = () => {
    const s = fixture();
    for (const [id, name] of [
      ['groceries', 'Groceries'],
      ['restaurants', 'Restaurants'],
      ['transport', 'Transportation'],
      ['shopping', 'Shops'],
      ['work', 'Work Expenses'],
    ])
      s.categories.push({
        id,
        name,
        icon: id,
        color: '#2774dc',
        group: 'Everyday',
        archived: false,
      });
    return s;
  };
  it('uses specific merchant matches, including delivery versus rides', () => {
    const s = state();
    for (const [name, category] of [
      ['Safeway #123', 'groceries'],
      ['Uber Eats', 'restaurants'],
      ['Uber', 'transport'],
      ['Tesla Supercharger US', 'transport'],
      ['Depop* P.depop.com', 'shopping'],
      ['Porkbun.com', 'work'],
    ]) {
      expect(applyRules(transaction(name, 100, { name, categoryId: 'other' }), s).categoryId).toBe(
        category,
      );
    }
    expect(categorySuggestion(s, transaction('unknown', 100, { categoryId: 'other' }))).toBeNull();
  });
  it('preserves imported categories, corrections, splits and non-spending classifications', () => {
    const s = state(),
      base = transaction('safe', 100, { name: 'Safeway', categoryId: 'food' });
    expect(applyRules(base, s).categoryId).toBe('food');
    expect(
      applyRules({ ...base, categoryId: 'other', edits: { categoryId: 'food' } }, s).edits
        .categoryId,
    ).toBe('food');
    expect(categorySuggestion(s, { ...base, categoryId: 'other', kind: 'transfer' })).toBeNull();
    expect(
      categorySuggestion(s, {
        ...base,
        categoryId: 'other',
        splits: [{ id: '1', categoryId: 'food', amount: 100, excluded: false }],
      }),
    ).toBeNull();
  });
  it('learns only through an explicit scoped rule and ignores archived categories', () => {
    let s = state();
    s = applyCommand(s, {
      type: 'rule.save',
      payload: {
        id: 'remember',
        merchant: 'My merchant',
        match: 'exact',
        accountId: 'a',
        categoryId: 'shopping',
      },
    });
    const t = transaction('1', 100, { name: 'My merchant', categoryId: 'other' });
    expect(applyRules(t, s).categoryId).toBe('shopping');
    expect(applyRules({ ...t, accountId: 'different' }, s).categoryId).toBe('other');
    s.categories.find((c) => c.id === 'shopping')!.archived = true;
    expect(applyRules(t, s).categoryId).toBe('other');
  });
});
