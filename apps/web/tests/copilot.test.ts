import { describe, expect, it } from 'vitest';
import { applyCommand, emptyState, totals, validateState } from '../shared/core';
import { copilotAccounts, previewCopilot } from '../shared/copilot';
const header =
  'date,name,amount,status,category,parent category,excluded,tags,type,account,account mask,note,recurring';
const csv = (...rows: string[]) => [header, ...rows].join('\n');
const options = { currency: 'USD', accounts: {} };
const spend =
  '2026-10-16,Cafe,12.34,posted,Restaurants,Food & Drink,false,,regular,Card,1234,Note,';
describe('Copilot migration', () => {
  it('preserves types, signs, pending, exclusions, notes, recurring and masked accounts', () => {
    const text = csv(
      spend,
      '2026-10-16,Refund,-2.34,posted,Restaurants,Food & Drink,false,,regular,Card,1234,,',
      '2026-10-16,Salary,-5000,posted,,,true,,income,Checking,4444,,',
      '2026-10-16,Payment,120,posted,,,true,,internal transfer,Checking,4444,,',
      '2026-10-16,Music,10,pending,Subscriptions,,false,Favorite,regular,Card,9876,,Music',
    );
    const next = applyCommand(emptyState(), { type: 'import.copilot', payload: { text, options } });
    expect(next.accounts).toHaveLength(3);
    expect(next.accounts.every((a) => a.balance === null && !a.coverageComplete)).toBe(true);
    expect(next.transactions.map((t) => t.kind)).toEqual([
      'spending',
      'refund',
      'income',
      'transfer',
      'spending',
    ]);
    expect(next.transactions[0].notes).toBe('Note');
    expect(next.transactions.map((t) => t.reviewed)).toEqual([true, true, true, true, false]);
    expect(next.transactions[2]).toMatchObject({
      excluded: false,
      raw: { copilot: { excluded: true } },
    });
    expect(next.transactions[3].excluded).toBe(true);
    expect(next.transactions[4]).toMatchObject({
      recurring: 'Music',
      tags: 'Favorite',
      pending: true,
    });
    expect(totals(next, '2026-10-01', '2026-10-17')).toMatchObject({
      income: 500000,
      spending: 1000,
    });
    expect(next.notifications?.items).toEqual([]);
  });
  it('keeps uncategorized purchases pending review and allows reviewing all history manually', () => {
    const text = csv(
      spend,
      '2026-10-16,Unknown,12.34,posted,,,false,,regular,Card,1234,,',
      '2026-10-16,Ignored,12.34,posted,,,true,,regular,Card,1234,,',
      '2026-10-16,Uncategorized,12.34,posted,Uncategorized,,false,,regular,Card,1234,,',
    );
    const preview = previewCopilot(text, options, emptyState());
    expect(preview.transactions.map((t) => t.reviewed)).toEqual([true, false, true, false]);
    expect(
      previewCopilot(text, { ...options, markReviewed: false }, emptyState()).transactions.every(
        (t) => !t.reviewed,
      ),
    ).toBe(true);
    const imported = applyCommand(emptyState(), {
      type: 'import.copilot',
      payload: { text, options },
    });
    imported.transactions[0].reviewed = false;
    imported.transactions[0].edits = { excluded: true, categoryId: 'other' };
    const again = applyCommand(imported, { type: 'import.copilot', payload: { text, options } });
    expect(again.transactions).toEqual(imported.transactions);
  });
  it('preserves repeated identical purchases and skips a repeated import after edits', () => {
    const text = csv(spend, spend);
    let next = applyCommand(emptyState(), { type: 'import.copilot', payload: { text, options } });
    expect(next.transactions).toHaveLength(2);
    next.transactions[0].edits = { name: 'My cafe' };
    const preview = previewCopilot(text, options, next);
    expect(preview.duplicates).toBe(2);
    expect(preview.transactions).toHaveLength(0);
  });
  it('matches existing accounts and imported records one-to-one', () => {
    const first = applyCommand(emptyState(), {
      type: 'import.copilot',
      payload: { text: csv(spend), options },
    });
    delete first.transactions[0].importIdentity;
    expect(copilotAccounts(csv(spend), first)[0].accountId).toBe(first.accounts[0].id);
    const preview = previewCopilot(csv(spend, spend), options, first);
    expect(preview.duplicates).toBe(1);
    expect(preview.transactions).toHaveLength(1);
  });
  it('repairs old review flags and income without changing classifications or unmatched bank records', () => {
    const text = csv(spend, '2026-10-16,Salary,-5000,posted,,,true,,income,Checking,4444,,');
    const before = applyCommand(emptyState(), {
      type: 'import.copilot',
      payload: { text, options },
    });
    before.transactions.forEach((t) => {
      t.reviewed = false;
    });
    const salary = before.transactions[1];
    salary.source = 'plaid';
    salary.providerId = 'bank-id';
    salary.excluded = true;
    salary.edits = { kind: 'income', excluded: true, notes: 'Keep my note' };
    before.transactions[0].edits = { categoryId: 'other', notes: 'My category edit' };
    before.transactions.push({ ...salary, id: 'bank-only', importIdentity: undefined, edits: {} });
    const command = { type: 'import.copilotReview', payload: { text } };
    const after = applyCommand(before, command);
    expect(after.transactions.map((t) => t.reviewed)).toEqual([true, true, false]);
    expect(after.transactions[0].edits).toEqual(before.transactions[0].edits);
    expect(after.transactions[1].edits).toEqual({
      kind: 'income',
      excluded: false,
      notes: 'Keep my note',
    });
    expect(after.transactions[2]).toEqual(before.transactions[2]);
    expect(after.accounts).toEqual(before.accounts);
    expect(applyCommand(after, command)).toEqual(after);
    before.transactions[0].raw = { asset_split_conflict: true };
    expect(applyCommand(before, command).transactions[0].reviewed).toBe(false);
  });
  it('settles an imported pending row without losing user edits', () => {
    const text = csv(spend.replace('posted', 'pending'));
    const before = applyCommand(emptyState(), {
      type: 'import.copilot',
      payload: { text, options },
    });
    before.transactions[0].edits = { notes: 'My note' };
    const after = applyCommand(before, {
      type: 'import.copilot',
      payload: { text: csv(spend), options },
    });
    expect(after.transactions).toHaveLength(1);
    expect(after.transactions[0]).toMatchObject({ pending: false, edits: { notes: 'My note' } });
  });
  it('rejects invalid rows atomically, mismatched currencies and invalid mappings', () => {
    const before = emptyState();
    expect(() =>
      applyCommand(before, {
        type: 'import.copilot',
        payload: { text: csv(spend, spend.replace('12.34', 'bad')), options },
      }),
    ).toThrow('invalid rows');
    expect(before.accounts).toHaveLength(0);
    expect(
      previewCopilot(csv(spend.replace('2026-10-16', '2026-02-30')), options, before).errors,
    ).toHaveLength(1);
    const key = copilotAccounts(csv(spend), before)[0].key;
    expect(() =>
      previewCopilot(
        csv(spend),
        { currency: 'USD', accounts: { [key]: { type: 'credit', accountId: 'missing' } } },
        before,
      ),
    ).toThrow('mapping');
  });
});
