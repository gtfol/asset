import { describe, expect, it } from 'vitest';
import { applyCommand, fingerprint, previewAccountLink, previewHistoryMatches, importedMatch, validateState } from '../shared/core';
import { importCopilot, previewCopilot } from '../shared/copilot';
import { applyProviderRecords, type Connection } from '../server/plaid';
import { fixture, transaction } from './fixtures';

function accounts() {
  const s = fixture();
  s.accounts[0] = { ...s.accounts[0], name: 'My checking', source: 'csv', balance: null, mask: '1234' };
  s.accounts.push({ ...s.accounts[0], id: 'bank', source: 'plaid', name: 'Bank checking', balance: 42500, connectionId: 'c', providerId: 'p', coverageStart: '2024-01-01' });
  return s;
}
const link = { type: 'import.link-accounts', payload: { links: [{ importedId: 'a', connectedId: 'bank' }] } };
describe('linking imported accounts', () => {
  it('keeps imported identity and user metadata with the provider balance and future updates', () => {
    const s = accounts();
    const original = transaction('csv', 1200, { source: 'csv', name: 'Coffee Shop', importIdentity: 'copilot:one', notes: 'Shared', excluded: true, recurring: 'Coffee', tags: 'Friends', reviewed: true });
    s.transactions = [original, transaction('old', 500, { source: 'csv', date: '2020-02-02' }), transaction('live', 1200, { source: 'plaid', accountId: 'bank', name: 'COFFEE SHOP', categoryId: 'other', connectionId: 'c', providerId: 't1' })];
    s.snapshots = [{ id: 'snapshot', accountId: 'bank', date: '2024-02-15', balance: 42500, currency: 'USD', source: 'plaid' }];
    const preview = previewAccountLink(s, 'a', 'bank');
    expect(preview.pairs).toHaveLength(1);
    const next = applyCommand(s, link);
    expect(s.accounts).toHaveLength(2);
    expect(next.accounts).toHaveLength(1);
    expect(next.accounts[0]).toMatchObject({ id: 'a', name: 'My checking', source: 'plaid', providerId: 'p', balance: 42500 });
    expect(next.transactions).toHaveLength(2);
    expect(next.transactions.find(t => t.id === 'csv')).toMatchObject({ source: 'plaid', accountId: 'a', providerId: 't1', notes: 'Shared', recurring: 'Coffee', tags: 'Friends', importIdentity: 'copilot:one', reviewed: true, edits: { categoryId: 'food', excluded: true } });
    expect(next.snapshots[0].accountId).toBe('a');
    applyProviderRecords(next, { id: 'c', historical_complete: true } as Connection, { added: [], modified: [{ transaction_id: 't1', account_id: 'p', name: 'COFFEE SHOP', date: '2024-02-15', amount: 12, pending: false }], removed: [] });
    expect(next.transactions).toHaveLength(2);
    expect(next.transactions.find(t => t.id === 'csv')!.edits.categoryId).toBe('food');
    expect(next.accounts[0].coverageStart).toBe('2024-02-15');
    expect(validateState(next)).toBeTruthy();
  });
  it('matches repeated equal purchases one-to-one and leaves uncertain descriptions separate', () => {
    const s = accounts();
    s.transactions = [transaction('one', 1000, { source: 'csv', name: 'Shop' }), transaction('two', 1000, { source: 'csv', name: 'Shop' }), transaction('other', 1000, { source: 'csv', name: 'Elsewhere' }), transaction('bank-one', 1000, { accountId: 'bank', source: 'plaid', name: 'SHOP', providerId: 'p1' }), transaction('bank-two', 1000, { accountId: 'bank', source: 'plaid', name: 'SHOP', providerId: 'p2' }), transaction('unrelated', 1000, { accountId: 'bank', source: 'plaid', name: 'Unrelated', providerId: 'p3' })];
    expect(previewAccountLink(s, 'a', 'bank')).toMatchObject({ possible: 1, pairs: [{ importedId: 'one', providerId: 'bank-one' }, { importedId: 'two', providerId: 'bank-two' }] });
    expect(applyCommand(s, link).transactions).toHaveLength(4);
  });
  it('rejects cross-currency, incompatible, duplicated, and foreign mappings atomically', () => {
    const s = accounts();
    s.accounts[1].currency = 'CAD';
    expect(() => applyCommand(s, link)).toThrow('currencies');
    s.accounts[1].currency = 'USD'; s.accounts[1].type = 'credit';
    expect(() => applyCommand(s, link)).toThrow('types');
    s.accounts[1].type = 'checking';
    expect(() => applyCommand(s, { ...link, payload: { links: [...link.payload.links, ...link.payload.links] } })).toThrow('only once');
    expect(() => applyCommand(s, { ...link, payload: { links: [{ importedId: 'a', connectedId: 'another-owner' }] } })).toThrow('connected bank');
    expect(s.accounts).toHaveLength(2);
  });
  it('preserves transfer classifications and authorized dates without combining opposite purchases and refunds', () => {
    const s = accounts();
    s.transactions = [
      transaction('payment', 1000, { source: 'csv', name: 'Payment Thank You', kind: 'transfer', date: '2024-02-13' }),
      transaction('purchase', 500, { source: 'csv', name: 'Shop', kind: 'spending' }),
      transaction('bank-payment', 1000, { source: 'plaid', accountId: 'bank', providerId: 'p1', name: 'Payment Thank You-Mobile', kind: 'refund', raw: { authorized_date: '2024-02-13' } }),
      transaction('bank-refund', 500, { source: 'plaid', accountId: 'bank', providerId: 'p2', name: 'Shop', kind: 'refund' }),
    ];
    const next = applyCommand(s, link);
    expect(next.transactions).toHaveLength(3);
    expect(next.transactions.find(t => t.id === 'payment')!.edits).toMatchObject({ kind: 'transfer', date: '2024-02-13' });
    expect(next.transactions.some(t => t.id === 'purchase')).toBe(true);
    expect(next.transactions.some(t => t.id === 'bank-refund')).toBe(true);
  });
  it('preserves Copilot replay protection and rewrites moved provider fingerprints', () => {
    const csv = 'date,name,amount,status,category,excluded,type,account,account mask\n2024-02-15,Shop,12,posted,Food,false,regular,My checking,1234';
    let s = importCopilot(fixture(), csv, { currency: 'USD', accounts: {} });
    const imported = s.accounts.find(a => a.source === 'csv')!;
    s.accounts.push({ ...imported, id: 'bank', source: 'plaid', providerId: 'p', connectionId: 'c', balance: 1000 });
    const bank = transaction('bank-t', 1200, { accountId: 'bank', name: 'Shop', source: 'plaid', providerId: 'tx', connectionId: 'c' });
    bank.fingerprint = fingerprint(bank); s.transactions.push(bank);
    s = applyCommand(s, { type: 'import.link-accounts', payload: { links: [{ importedId: imported.id, connectedId: 'bank' }] } });
    const preview = previewCopilot(csv, { currency: 'USD', accounts: {} }, s);
    expect(preview.transactions).toHaveLength(0);
    expect(preview.accounts).toHaveLength(0);
    expect(preview.duplicates).toBe(1);
    expect(s.transactions).toHaveLength(1);
  });
});

describe('matching previously synced history', () => {
  function history() {
    const s = accounts();
    s.accounts = [{ ...s.accounts[1], id: 'a' }];
    s.transactions = [
      transaction('csv', 6074, { name: 'Safeway', source: 'csv', date: '2024-02-13', reviewed: true,
        importIdentity: 'copilot:["account","2024-02-13","Safeway",6074,"spending"]:1',
        categoryId: 'food', notes: 'My note', excluded: true, tags: 'Groceries' }),
      transaction('bank', 6074, { name: 'SAFEWAY', source: 'plaid', providerId: 't1', connectionId: 'c',
        categoryId: 'other', raw: { amount: 60.74 } }),
    ];
    return s;
  }
  it('matches shifted posting dates, preserves CSV decisions, and attaches future syncs to one row', () => {
    const s = history();
    const pairs = previewHistoryMatches(s);
    expect(pairs).toEqual([{ importedId: 'csv', providerId: 'bank' }]);
    const next = applyCommand(s, { type: 'import.reconcile-history', payload: { pairs } });
    expect(next.transactions).toHaveLength(1);
    expect(next.transactions[0]).toMatchObject({ id: 'csv', providerId: 't1', reviewed: true, notes: 'My note',
      tags: 'Groceries', edits: { name: 'Safeway', date: '2024-02-13', excluded: true, categoryId: 'food' } });
    expect(next.accounts).toEqual(s.accounts);
    expect(previewHistoryMatches(next)).toEqual([]);
    expect(() => applyCommand(next, { type: 'import.reconcile-history', payload: { pairs } })).toThrow('Matches changed');
    applyProviderRecords(next, { id: 'c', historical_complete: true } as Connection, { added: [], modified: [{
      transaction_id: 't1', account_id: 'p', name: 'SAFEWAY STORE', date: '2024-02-15', amount: 60.74, pending: false,
    }], removed: [] });
    expect(next.transactions).toHaveLength(1);
    expect(next.transactions[0].reviewed).toBe(true);
    expect(next.transactions[0].edits.categoryId).toBe('food');
  });
  it('ignores opposite-direction transfers, unrelated merchants, changed amounts and distant dates', () => {
    const s = history();
    for (const change of [{ name: 'Other shop' }, { amount: 6075 }, { date: '2024-02-21' }, { accountId: 'other' }, { currency: 'CAD' }]) {
      const copy = structuredClone(s); Object.assign(copy.transactions[1], change);
      expect(previewHistoryMatches(copy)).toEqual([]);
    }
    s.transactions[0].kind = 'transfer';
    s.transactions[1].kind = 'transfer'; s.transactions[1].raw = { amount: -60.74 };
    expect(previewHistoryMatches(s)).toEqual([]);
    expect(importedMatch(s.transactions, s.transactions[1])).toBeUndefined();
  });
  it('recognizes cleaned ACH descriptions without matching amount alone', () => {
    const s = history();
    s.transactions[0].name = 'Citi Autopay Payment Lin Co'; s.transactions[0].kind = 'transfer';
    s.transactions[1].name = 'CITI AUTOPAY DES:PAYMENT ID:XXXXXXXX50038 INDN:ALLEN LIN CO ID:CITICARDAP WEB';
    s.transactions[1].kind = 'card_payment';
    expect(previewHistoryMatches(s)).toHaveLength(1);
    s.transactions[1].name = 'CITI CASH PAYMENT';
    expect(previewHistoryMatches(s)).toHaveLength(0);
  });
  it('leaves repeated purchases ambiguous on either side and preserves manually edited bank rows', () => {
    const s = history();
    const duplicate = { ...s.transactions[0], id: 'csv2', date: '2024-02-14' };
    s.transactions.push(duplicate);
    expect(previewHistoryMatches(s)).toEqual([]);
    s.transactions.pop();
    s.transactions.push({ ...s.transactions[1], id: 'bank2', providerId: 't2' });
    expect(previewHistoryMatches(s)).toEqual([]);
    expect(importedMatch(s.transactions, s.transactions[1])).toBeUndefined();
    s.transactions.pop(); s.transactions[1].edits = { categoryId: 'food' };
    expect(previewHistoryMatches(s)).toEqual([]);
    s.transactions[1].edits = {}; s.transactions[1].pending = true;
    expect(previewHistoryMatches(s)).toEqual([]);
  });
  it('reconciles new bank activity on arrival and rejects forged or repeated pair IDs atomically', () => {
    const s = history();
    const incoming = s.transactions.pop()!;
    expect(importedMatch(s.transactions, incoming)?.id).toBe('csv');
    s.transactions.push(incoming);
    const pair = previewHistoryMatches(s)[0];
    expect(() => applyCommand(s, { type: 'import.reconcile-history', payload: { pairs: [pair, pair] } })).toThrow('Matches changed');
    expect(() => applyCommand(s, { type: 'import.reconcile-history', payload: { pairs: [{ ...pair, providerId: 'foreign' }] } })).toThrow('Matches changed');
    expect(s.transactions).toHaveLength(2);
  });
});
