import type { State, Transaction } from './schema.js';

const normalizedName = (name: string) => name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const family = (kind: Transaction['kind']) => ['transfer', 'card_payment', 'investment_transfer'].includes(kind) ? 'transfer' : kind;
const compatibleKind = (left: Transaction['kind'], right: Transaction['kind']) => {
  const a = family(left), b = family(right);
  // A user's transfer classification often differs from the provider's refund/
  // spending classification. Merchant, amount, account and date must still match.
  if (a === b || a === 'transfer' || b === 'transfer') return true;
  return ['income', 'refund'].includes(a) && ['income', 'refund'].includes(b);
};
const providerNames = (t: Transaction) => [t.name, t.raw?.name, t.raw?.merchant_name, t.raw?.original_description].filter((s): s is string => typeof s === 'string').map(normalizedName);

// Copilot keeps the purchase date and a cleaned description; banks often send
// the posting date and ACH reference fields. Never use amount/date alone.
const nameWords = (name: string) => name.normalize('NFKD').toLowerCase()
  .replace(/\b(?:id|indn|des|co|ppd|web|pmt|info|inc|llc|com)\b/g, ' ')
  .replace(/[^a-z ]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !/^x+$/.test(w));
function matchingDescription(imported: Transaction, provider: Transaction) {
  const name = normalizedName(imported.edits.name ?? imported.name);
  return [provider.name, provider.raw?.name, provider.raw?.merchant_name, provider.raw?.original_description]
    .filter((s): s is string => typeof s === 'string').some(description => {
      const other = normalizedName(description);
      if (name.length >= 4 && other.length >= 4 && (name.startsWith(other) || other.startsWith(name))) return true;
      const a = nameWords(imported.edits.name ?? imported.name), b = nameWords(description);
      // Require at least two descriptive words, in order, with the same first
      // word. This tolerates bank IDs without equating unrelated merchants.
      if (a.length < 2 || a[0] !== b[0]) return false;
      let cursor = 0;
      return a.every(word => {
        const index = b.indexOf(word, cursor);
        cursor = index + 1;
        return index >= 0;
      });
    });
}
function compatibleDirection(imported: Transaction, provider: Transaction) {
  if (!imported.importIdentity?.startsWith('copilot:') || typeof provider.raw?.amount !== 'number') return true;
  try {
    const original = JSON.parse(imported.importIdentity.slice(8, imported.importIdentity.lastIndexOf(':')));
    return Math.sign(original[3]) === Math.sign(provider.raw.amount);
  } catch { return false; }
}
function historyCandidate(imported: Transaction, provider: Transaction) {
  if (imported.removed || imported.providerId || imported.source !== 'csv' || !imported.importIdentity ||
    provider.pending || provider.raw?.asset_split_conflict || imported.raw?.asset_split_conflict ||
    imported.accountId !== provider.accountId || imported.currency !== provider.currency ||
    imported.amount !== provider.amount || !compatibleKind(imported.edits.kind ?? imported.kind, provider.kind) ||
    !compatibleDirection(imported, provider)) return false;
  const date = imported.edits.date ?? imported.date;
  const difference = Math.abs(Date.parse(date) - Date.parse(provider.date)) / 86_400_000;
  return difference <= 7 && matchingDescription(imported, provider);
}

export function importedMatch(candidates: Transaction[], provider: Transaction): Transaction | undefined {
  const names = providerNames(provider);
  const dates = [provider.date, provider.raw?.authorized_date];
  const eligible = candidates.filter(t => !t.removed && !t.providerId &&
    ['csv', 'manual'].includes(t.source) && t.accountId === provider.accountId &&
    t.currency === provider.currency && t.amount === provider.amount &&
    compatibleKind(t.kind, provider.kind) && compatibleDirection(t, provider) && dates.includes(t.date));
  const exact = eligible.filter(t => names.includes(normalizedName(t.name)));
  if (exact.length) return exact[0]; // Pair identical purchases one-to-one, never collapse a whole group.
  const partial = eligible.filter(t => {
    const name = normalizedName(t.name);
    return name.length >= 4 && names.some(n => n.length >= 4 && (n.startsWith(name) || name.startsWith(n)));
  });
  if (partial.length === 1) return partial[0];
  const historical = candidates.filter(t => historyCandidate(t, provider));
  if (historical.length !== 1) return undefined;
  // Another bank record may be competing for this same historical purchase.
  if (candidates.some(t => t.id !== provider.id && t.source === 'plaid' && !t.removed &&
    !t.importIdentity && historyCandidate(historical[0], t))) return undefined;
  return historical[0];
}

export function previewHistoryMatches(state: State) {
  const imported = state.transactions.filter(t => t.source === 'csv' && t.importIdentity && !t.providerId && !t.removed);
  const providers = state.transactions.filter(t => t.source === 'plaid' && t.providerId && !t.importIdentity && !t.removed && !t.pending);
  const edges = providers.map(provider => ({ provider, candidates: imported.filter(t => historyCandidate(t, provider)) }));
  const uses = new Map<string, number>();
  for (const edge of edges) for (const t of edge.candidates) uses.set(t.id, (uses.get(t.id) ?? 0) + 1);
  return edges.flatMap(({ provider, candidates }) => !provider.reviewed && !Object.keys(provider.edits).length && !provider.splits.length && !provider.notes &&
    candidates.length === 1 && uses.get(candidates[0].id) === 1
    ? [{ importedId: candidates[0].id, providerId: provider.id }] : []);
}

export function reconcileHistory(state: State, pairs: { importedId: string; providerId: string }[]): State {
  const available = new Set(previewHistoryMatches(state).map(p => `${p.importedId}|${p.providerId}`));
  if (new Set(pairs.map(p => p.importedId)).size !== pairs.length || new Set(pairs.map(p => p.providerId)).size !== pairs.length ||
    pairs.some(p => !available.has(`${p.importedId}|${p.providerId}`))) throw Error('Matches changed. Refresh and review again.');
  const originals = new Map(state.transactions.map(t => [t.id, t]));
  const byImported = new Map(pairs.map(p => [p.importedId, p.providerId]));
  const byProvider = new Map(pairs.map(p => [p.providerId, p.importedId]));
  return {
    ...state,
    transactions: state.transactions.filter(t => !byProvider.has(t.id)).map(t => {
      const providerId = byImported.get(t.id);
      return providerId ? preserveImportedDetails(t, originals.get(providerId)!) : t;
    }),
    ...(state.notifications ? { notifications: { ...state.notifications,
      items: state.notifications.items.map(n => ({ ...n,
        ...(n.transactionId && byProvider.has(n.transactionId) ? { transactionId: byProvider.get(n.transactionId) } : {}),
      })),
    } } : {}),
  };
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
    } else if (remaining.some(c => !c.removed && c.amount === t.amount && c.currency === t.currency && [t.date, t.raw?.authorized_date].includes(c.date) && compatibleKind(c.kind, t.kind))) possible++;
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
        ...(t.loanAccountId ? { loanAccountId: remap(t.loanAccountId) } : {}),
        edits: { ...t.edits, ...(t.edits.loanAccountId ? { loanAccountId: remap(t.edits.loanAccountId) } : {}) },
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
