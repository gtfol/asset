import { describe, expect, it } from 'vitest';
import { applyCommand, fingerprint, previewAccountLink, validateState } from '../shared/core';
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
