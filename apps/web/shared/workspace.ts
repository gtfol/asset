import { z } from 'zod';
import { applyCommand, emptyState, validateState, type Command, type State } from './core.js';
import { defaultCategories } from './demo.js';

export function newWorkspace(): State {
  return { ...emptyState(), categories: defaultCategories() };
}

const collections = ['accounts', 'transactions', 'categories', 'budgets', 'snapshots',
  'holdings', 'holdingSnapshots', 'rules', 'investmentActivity'] as const;
const keyFor = (collection: string, row: any) => collection === 'budgets'
  ? `${row.month}:${row.categoryId}` : row.id;
const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  return ak.length === bk.length && ak.every(k => Object.hasOwn(b, k) && equal((a as any)[k], (b as any)[k]));
};
const valueSchema = z.object({ exists: z.boolean(), value: z.unknown().optional() });
export function stableJSON(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(stableJSON).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined)
    .map(k => JSON.stringify(k) + ':' + stableJSON(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export const changeSchema = z.object({
  collection: z.enum([...collections, 'settings', 'preferences']),
  key: z.string(), field: z.array(z.string().refine(k => !['__proto__', 'constructor', 'prototype'].includes(k))).max(5),
  before: valueSchema, after: valueSchema,
});
type Change = z.infer<typeof changeSchema>;
const value = (v: unknown) => v === undefined ? { exists: false } : { exists: true, value: v };
export function workspaceChanges(before: State, after: State): Change[] {
  const changes: Change[] = [];
  for (const collection of collections) {
    const a = new Map((before[collection] as any[]).map(r => [keyFor(collection, r), r]));
    const b = new Map((after[collection] as any[]).map(r => [keyFor(collection, r), r]));
    for (const key of new Set([...a.keys(), ...b.keys()])) {
      const old = a.get(key), next = b.get(key);
      // Save commands can carry the complete record. Check the complete previous
      // record so a stale form cannot overwrite an unrelated balance/category edit.
      if (!equal(old, next)) changes.push({ collection, key, field: [],
        before: value(old), after: old === undefined ? { exists: true } : value(next) });
    }
  }
  for (const collection of ['settings', 'preferences'] as const) {
    const a = collection === 'settings' ? before.settings : before.notifications?.preferences;
    const b = collection === 'settings' ? after.settings : after.notifications?.preferences;
    if (!equal(a, b)) changes.push({ collection, key: '', field: [], before: value(a), after: value(b) });
  }
  return changes;
}
export function assertWorkspaceChanges(state: State, changes: Change[]) {
  for (const c of changes) {
    let current: any = c.collection === 'settings' ? state.settings : c.collection === 'preferences'
      ? state.notifications?.preferences : (state[c.collection] as any[]).find(r => keyFor(c.collection, r) === c.key);
    for (const key of c.field) current = current && Object.hasOwn(current, key) ? current[key] : undefined;
    if (!equal(value(current), c.before) && !equal(value(current), c.after))
      throw Object.assign(Error('This change overlaps an update from another device. Your local changes are saved; resolve them in Sync.'), { status: 409, code: 'SYNC_CONFLICT' });
  }
}
export const operationSchema = z.object({
  id: z.string().uuid(),
  timestamp: z.string().datetime(),
  command: z.object({ type: z.string(), payload: z.record(z.string(), z.unknown()) }),
  changes: z.array(changeSchema).max(100000),
});
export type Operation = z.infer<typeof operationSchema>;
export type LocalWorkspace = {
  version: 1; id: string; owner: string | null; revision: number; state: State; pending: Operation[];
};
export function createLocalWorkspace(id: string): LocalWorkspace {
  return { version: 1, id, owner: null, revision: 0, state: newWorkspace(), pending: [] };
}
export function validateLocalWorkspace(input: unknown): LocalWorkspace {
  const doc = z.object({ version: z.literal(1), id: z.string().uuid(), owner: z.string().nullable(),
    revision: z.number().int().nonnegative(), state: z.unknown(), pending: z.array(operationSchema) }).parse(input);
  return { ...doc, state: validateState(doc.state) };
}
export function localCommand(doc: LocalWorkspace, command: Command, id: string): LocalWorkspace {
  const timestamp = new Date().toISOString();
  const state = applyCommand(doc.state, command, timestamp);
  const changes = workspaceChanges(doc.state, state);
  return { ...doc, state, pending: doc.owner ? [...doc.pending, { id, timestamp, command, changes }] : [] };
}
export function receiveWorkspace(doc: LocalWorkspace, remote: { state: State; revision: number }, acknowledged?: string): LocalWorkspace {
  const pending = doc.pending.filter(o => o.id !== acknowledged);
  let state = validateState(remote.state);
  for (const o of pending) state = applyCommand(state, o.command as Command, o.timestamp);
  return { ...doc, ...remote, state, pending };
}

// Sign-in adds the device's records; it never restores a backup over an existing account.
export function mergeLocalWorkspace(remote: State, input: unknown, namespace: string): State {
  const local = validateState(input);
  if (local.settings.demo || local.accounts.some(a => !['manual', 'csv'].includes(a.source)) ||
    local.transactions.some(t => !['manual', 'csv'].includes(t.source)) ||
    [...local.holdings, ...local.holdingSnapshots, ...local.snapshots].some(h => !['manual', 'csv'].includes(h.source)))
    throw Error('Only local accounts and imports can be added during sign-in');
  const result = validateState(JSON.parse(JSON.stringify(remote)));
  const rename = (id: string) => `${namespace}:${id}`;
  const categoryIDs = new Map<string, string>();
  for (const c of local.categories) {
    const match = result.categories.find(x => x.name === c.name && x.group === c.group);
    categoryIDs.set(c.id, match?.id ?? rename(c.id));
    if (!match) result.categories.push({ ...c, id: rename(c.id) });
  }
  const category = (id: string) => categoryIDs.get(id) ?? id;
  result.accounts.push(...local.accounts.map(a => ({ ...a, id: rename(a.id) })));
  result.transactions.push(...local.transactions.map(t => ({ ...t, id: rename(t.id), accountId: rename(t.accountId),
    categoryId: category(t.categoryId), edits: { ...t.edits, ...(t.edits.categoryId ? { categoryId: category(t.edits.categoryId) } : {}) },
    splits: t.splits.map(s => ({ ...s, categoryId: category(s.categoryId) })),
  })));
  for (const collection of ['holdings', 'holdingSnapshots', 'snapshots', 'investmentActivity'] as const)
    (result[collection] as any[]).push(...local[collection].map((r: any) => ({ ...r, id: rename(r.id), accountId: rename(r.accountId),
      ...(r.holdingId ? { holdingId: rename(r.holdingId) } : {}) })));
  for (const b of local.budgets) if (!result.budgets.some(x => x.month === b.month && x.categoryId === category(b.categoryId)))
    result.budgets.push({ ...b, categoryId: category(b.categoryId) });
  result.rules.push(...local.rules.map(r => ({ ...r, id: rename(r.id), categoryId: category(r.categoryId),
    ...(r.accountId ? { accountId: rename(r.accountId) } : {}) })));
  const defaults = newWorkspace();
  // Adopt device preferences only where the cloud still has its initial values.
  for (const key of Object.keys(defaults.settings) as (keyof State['settings'])[])
    if (key !== 'demo' && equal(remote.settings[key], defaults.settings[key]))
      (result.settings as any)[key] = local.settings[key];
  if (!remote.notifications?.preferences && local.notifications?.preferences)
    result.notifications = { items: remote.notifications?.items ?? [], preferences: local.notifications.preferences };
  return validateState(result);
}
export const hasLocalRecords = (state: State) => !!(state.accounts.length || state.transactions.length || state.budgets.length || state.rules.length ||
  !equal(state.categories, defaultCategories()) || !equal(state.settings, newWorkspace().settings) || state.notifications?.preferences);
