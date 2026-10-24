import { validateState, type State } from './schema.js';

// Rules are ordered; other collections are keyed records. Keep rules as a small
// ordered value so changing rule priority is not lost during synchronization.
export const deltaCollections = ['accounts', 'transactions', 'categories', 'budgets', 'snapshots',
  'holdings', 'holdingSnapshots', 'investmentActivity'] as const;
export type DeltaCollection = typeof deltaCollections[number];
export const recordKey = (collection: string, row: any): string => collection === 'budgets'
  ? `${row.month}:${row.categoryId}` : row.id;
export const sameValue = (a: any, b: any): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a).filter(k => a[k] !== undefined);
  return keys.length === Object.keys(b).filter(k => b[k] !== undefined).length &&
    keys.every(k => Object.hasOwn(b, k) && sameValue(a[k], b[k]));
};
export type StateDelta = {
  collections: Partial<Record<DeltaCollection, { upserts: any[]; removed: string[] }>>;
  values: Partial<Pick<State, 'settings' | 'rules' | 'notifications' | 'bitcoinMarket'>>;
  unset: ('notifications' | 'bitcoinMarket')[];
};
export function stateDelta(before: State, after: State): StateDelta {
  const delta: StateDelta = { collections: {}, values: {}, unset: [] };
  for (const collection of deltaCollections) {
    const a = new Map((before[collection] as any[]).map(r => [recordKey(collection, r), r]));
    const b = new Map((after[collection] as any[]).map(r => [recordKey(collection, r), r]));
    const upserts = [...b].filter(([key, row]) => !sameValue(a.get(key), row)).map(([, row]) => row);
    const removed = [...a.keys()].filter(key => !b.has(key));
    if (upserts.length || removed.length) delta.collections[collection] = { upserts, removed };
  }
  for (const key of ['settings', 'rules', 'notifications', 'bitcoinMarket'] as const) {
    if (sameValue(before[key], after[key])) continue;
    if (after[key] === undefined) delta.unset.push(key as 'notifications' | 'bitcoinMarket');
    else (delta.values as any)[key] = after[key];
  }
  return delta;
}
export const hasDelta = (delta: StateDelta) => !!(Object.keys(delta.collections).length || Object.keys(delta.values).length || delta.unset.length);
export function applyStateDelta(input: State, delta: StateDelta): State {
  const next = { ...input };
  for (const collection of deltaCollections) {
    const change = delta.collections[collection];
    if (!change) continue;
    const upserts = new Map(change.upserts.map(r => [recordKey(collection, r), r]));
    const removed = new Set(change.removed);
    const rows = (input[collection] as any[]).filter(r => !removed.has(recordKey(collection, r))).map(r => {
      const key = recordKey(collection, r), replacement = upserts.get(key);
      upserts.delete(key);
      return replacement ?? r;
    });
    (next as any)[collection] = [...rows, ...upserts.values()];
  }
  Object.assign(next, delta.values);
  for (const key of delta.unset) delete next[key];
  return next;
}
export type WorkspaceUpdate = {
  revision: number;
  state?: State;
  delta?: { fromRevision: number; patches: StateDelta[] };
  unchanged?: boolean;
};
export function applyWorkspaceUpdate(base: State, revision: number, remote: WorkspaceUpdate): State {
  if (remote.state) return validateState(remote.state);
  if (remote.unchanged && remote.revision === revision) return validateState(base);
  if (!remote.delta || remote.delta.fromRevision !== revision || remote.revision < revision ||
    remote.delta.patches.length !== remote.revision - revision)
    throw Error('Sync could not verify the saved version. Your local changes are preserved.');
  // Validate the final result; intermediate commits can remove then re-add records.
  return validateState(remote.delta.patches.reduce(applyStateDelta, base));
}
