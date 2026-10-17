import type { State, Transaction } from './schema.js';

const normalizedName = (name: string) => name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const family = (kind: Transaction['kind']) => ['transfer', 'card_payment', 'investment_transfer'].includes(kind) ? 'transfer' : kind;
const providerNames = (t: Transaction) => [t.name, t.raw?.name, t.raw?.merchant_name, t.raw?.original_description].filter((s): s is string => typeof s === 'string').map(normalizedName);

export function importedMatch(candidates: Transaction[], provider: Transaction): Transaction | undefined {
  const names = providerNames(provider);
  const dates = [provider.date, provider.raw?.authorized_date];
  const eligible = candidates.filter(t => !t.removed && !t.providerId &&
    ['csv', 'manual'].includes(t.source) && t.accountId === provider.accountId &&
    t.currency === provider.currency && t.amount === provider.amount &&
    family(t.kind) === family(provider.kind) && dates.includes(t.date));
  const exact = eligible.filter(t => names.includes(normalizedName(t.name)));
  if (exact.length) return exact[0]; // Pair identical purchases one-to-one, never collapse a whole group.
  const partial = eligible.filter(t => {
    const name = normalizedName(t.name);
    return name.length >= 4 && names.some(n => n.length >= 4 && (n.startsWith(name) || name.startsWith(n)));
  });
  return partial.length === 1 ? partial[0] : undefined;
}

export function preserveImportedDetails(imported: Transaction, provider: Transaction): Transaction {
  return {
    ...provider,
    id: imported.id,
    fingerprint: imported.fingerprint,
    notes: imported.notes,
    excluded: imported.excluded,
    reviewed: imported.reviewed || provider.reviewed,
    splits: imported.splits.length ? imported.splits : provider.splits,
    recurring: imported.recurring ?? provider.recurring,
    tags: imported.tags ?? provider.tags,
    importIdentity: imported.importIdentity,
    edits: {
      name: imported.name, date: imported.date, categoryId: imported.categoryId,
      kind: imported.kind, notes: imported.notes, excluded: imported.excluded,
      ...imported.edits, ...provider.edits,
    },
  };
}

export function previewAccountLink(state: State, importedId: string, connectedId: string) {
  const imported = state.accounts.find(a => a.id === importedId);
  const connected = state.accounts.find(a => a.id === connectedId);
  if (!imported || !['csv', 'manual'].includes(imported.source) || imported.connectionId)
    throw Error('Choose an unconnected imported account');
  if (!connected || connected.source !== 'plaid' || !connected.connectionId || !connected.providerId)
    throw Error('Choose a connected bank account');
  if (imported.currency !== connected.currency || (imported.type !== connected.type && imported.type !== 'manual'))
    throw Error('Account types and currencies must match');
  if (state.holdings.some(h => h.accountId === importedId) || state.investmentActivity.some(h => h.accountId === importedId))
    throw Error('Reconcile this account’s investment holdings before linking transaction history');
  const candidates = state.transactions.filter(t => t.accountId === importedId);
  const consumed = new Set<string>();
  const pairs: { importedId: string; providerId: string }[] = [];
  let possible = 0;
  for (const t of state.transactions.filter(t => t.accountId === connectedId && !t.removed)) {
    const moved = { ...t, accountId: importedId };
    const remaining = candidates.filter(t => !consumed.has(t.id));
    const match = importedMatch(remaining, moved);
    if (match) {
      consumed.add(match.id);
      pairs.push({ importedId: match.id, providerId: t.id });
    } else if (remaining.some(c => !c.removed && c.amount === t.amount && c.currency === t.currency && c.date === t.date && family(c.kind) === family(t.kind))) possible++;
  }
  return { imported, connected, pairs, possible, importedCount: candidates.filter(t => !t.removed).length };
}

export function linkImportedAccount(state: State, importedId: string, connectedId: string): State {
  const preview = previewAccountLink(state, importedId, connectedId);
  const byProvider = new Map(preview.pairs.map(p => [p.providerId, p.importedId]));
  const consumed = new Set(preview.pairs.map(p => p.importedId));
  const originals = new Map(state.transactions.map(t => [t.id, t]));
  const remap = (id: string) => id === connectedId ? importedId : id;
  const preferredDates = new Set(state.snapshots.filter(p => p.accountId === connectedId).map(p => p.date));
  return {
    ...state,
    accounts: state.accounts.filter(a => a.id !== connectedId).map(a => a.id === importedId ? {
      ...preview.connected, id: importedId, name: preview.imported.name,
      includeInNetWorth: preview.imported.includeInNetWorth,
    } : a),
    transactions: state.transactions.filter(t => !consumed.has(t.id)).map(t => {
      const originalId = byProvider.get(t.id);
      const moved = { ...t, accountId: remap(t.accountId),
        fingerprint: t.fingerprint?.startsWith(connectedId + '|')
          ? importedId + t.fingerprint.slice(connectedId.length) : t.fingerprint };
      return originalId ? preserveImportedDetails(originals.get(originalId)!, moved) : moved;
    }),
    snapshots: state.snapshots.filter(p => !(p.accountId === importedId && preferredDates.has(p.date))).map(p => ({ ...p, accountId: remap(p.accountId) })),
    holdings: state.holdings.map(h => ({ ...h, accountId: remap(h.accountId) })),
    holdingSnapshots: state.holdingSnapshots.map(h => ({ ...h, accountId: remap(h.accountId) })),
    investmentActivity: state.investmentActivity.map(h => ({ ...h, accountId: remap(h.accountId) })),
    rules: state.rules.map(r => r.accountId ? { ...r, accountId: remap(r.accountId) } : r),
    ...(state.notifications ? { notifications: {
      ...state.notifications,
      items: state.notifications.items.map(n => ({ ...n,
        ...(n.accountId ? { accountId: remap(n.accountId) } : {}),
        ...(n.transactionId && byProvider.has(n.transactionId) ? { transactionId: byProvider.get(n.transactionId) } : {}),
      })),
    } } : {}),
  };
}
