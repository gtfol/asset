import type { Command } from '../shared/core.js';
import type { Operation } from '../shared/workspace.js';

export const scopedCollections = ['transactions', 'snapshots', 'holdings', 'holdingSnapshots', 'investmentActivity'] as const;
export type RecordFilter = {
  known?: Record<string, unknown>;
  all?: boolean;
  ids?: string[];
  amounts?: string[];
  recurring?: boolean;
  provider?: { connectionId: string; ids: string[] };
  providerIds?: string[];
  connection?: { id: string; date?: string };
  accountId?: string;
  date?: string;
  latestAppleBalance?: { accountId: string; excluding: string[] };
  effectiveDayAt?: string;
  holdingDay?: { id: string; at: string };
};
export type StateScope = Partial<Record<typeof scopedCollections[number], RecordFilter>>;

// These predicates execute inside Postgres. Unrelated history never crosses the
// database connection, even when the workspace contains years of transactions.
export function scopedStateSQL(): string {
  const projections = scopedCollections.map(collection => {
    const f = `($2::jsonb->'${collection}')`, r = 'record';
    const latestApple = collection === 'snapshots' ? `OR CASE WHEN ${f} ? 'latestAppleBalance' THEN ${r}->>'id'=(SELECT b->>'id' FROM jsonb_array_elements(state->'snapshots') b
      WHERE b->>'accountId'=${f}#>>'{latestAppleBalance,accountId}' AND b->>'source'='financekit'
        AND NOT (COALESCE(${f}#>'{latestAppleBalance,excluding}','[]'::jsonb) ? (b->>'id'))
      ORDER BY COALESCE(b->>'asOf',b->>'date') DESC LIMIT 1) ELSE false END` : '';
    const predicate = `COALESCE((${f}->>'all')::boolean,false)
      OR (${f}->'ids') ? (${r}->>'id')
      OR (${f}->'amounts') ? (${r}->>'amount')
      OR (${f}->'providerIds') ? (${r}->>'providerId')
      OR (COALESCE((${f}->>'recurring')::boolean,false) AND COALESCE(${r}#>>'{edits,recurring}',${r}->>'recurring','')<>'')
      OR (${r}->>'connectionId'=${f}#>>'{provider,connectionId}' AND (${f}#>'{provider,ids}') ? (${r}->>'providerId'))
      OR (EXISTS (SELECT 1 FROM jsonb_array_elements(state->'accounts') a WHERE a->>'id'=${r}->>'accountId' AND a->>'connectionId'=${f}#>>'{connection,id}')
        AND (${f}#>>'{connection,date}' IS NULL OR ${r}->>'date'=${f}#>>'{connection,date}'))
      OR (${r}->>'accountId'=${f}->>'accountId' AND (${f}->>'date' IS NULL OR ${r}->>'date'=${f}->>'date'))
      OR (COALESCE(${r}#>>'{edits,date}',${r}->>'date')=to_char((${f}->>'effectiveDayAt')::timestamptz AT TIME ZONE (state#>>'{settings,timezone}'),'YYYY-MM-DD'))
      OR ((${r}->>'holdingId'=${f}#>>'{holdingDay,id}' AND ${r}->>'date'=to_char((${f}#>>'{holdingDay,at}')::timestamptz AT TIME ZONE (state#>>'{settings,timezone}'),'YYYY-MM-DD'))
        OR ${r}->>'id'='holding-snapshot-' || (${f}#>>'{holdingDay,id}') || '-' || to_char((${f}#>>'{holdingDay,at}')::timestamptz AT TIME ZONE (state#>>'{settings,timezone}'),'YYYY-MM-DD'))`;
    const filtered = `${predicate} ${latestApple}`;
    return `'${collection}', COALESCE((SELECT jsonb_agg(
      CASE WHEN (${f}->'known'->(record->>'id'))=record THEN jsonb_build_object('_asset_known',record->>'id') ELSE record END
      ORDER BY ordinal) FROM jsonb_array_elements(COALESCE(state->'${collection}','[]'::jsonb)) WITH ORDINALITY AS entries(record,ordinal) WHERE ${filtered}),'[]'::jsonb)`;
  });
  return `(state - ARRAY[${scopedCollections.map(c => `'${c}'`).join(',')}]) || jsonb_build_object(${projections.join(',')})`;
}

export function commandScope(command: Command, operation?: Operation): StateScope | undefined {
  const p = command.payload, id = String(p.id ?? ''), now = operation?.timestamp ?? new Date().toISOString();
  let scope: StateScope;
  switch (command.type) {
    case 'transaction.create':
      scope = { transactions: { ids: [id], recurring: true } }; break;
    case 'transaction.update': case 'transaction.reconcile': case 'transaction.split':
      scope = { transactions: { ids: [id] } }; break;
    case 'transactions.review':
      scope = { transactions: { ids: Array.isArray(p.ids) ? p.ids.filter((v): v is string => typeof v === 'string') : [] } }; break;
    case 'account.save':
      scope = { snapshots: { ids: ['snapshot-' + id + '-' + String(p.updatedAt).slice(0, 10)], accountId: id, date: String(p.updatedAt).slice(0, 10) } }; break;
    case 'holding.save':
      scope = { holdings: { ids: [id] }, holdingSnapshots: { holdingDay: { id, at: now } } }; break;
    case 'snapshot.save':
      scope = { snapshots: { ids: [id], accountId: String(p.accountId), date: String(p.date) } }; break;
    case 'category.save': case 'budget.save': case 'rule.save': case 'rule.delete':
    case 'settings.save': case 'notifications.preferences': case 'notifications.read':
      scope = {}; break;
    case 'bitcoin.disconnect':
      scope = { holdings: { accountId: id }, snapshots: { accountId: id }, holdingSnapshots: { accountId: id } }; break;
    default:
      // Bulk imports, backup restores, and account/history reconciliation need a
      // complete view for deduplication. They are explicit, infrequent operations.
      return undefined;
  }
  // Conflict checks must see every record referenced by a queued operation,
  // including additional records touched by older versions of the client.
  for (const c of scopedCollections) {
    const ids = operation?.changes.filter(change => change.collection === c).map(change => change.key) ?? [];
    if (ids.length) scope[c] = { ...scope[c], ids: [...new Set([...(scope[c]?.ids ?? []), ...ids])] };
  }
  return scope;
}
