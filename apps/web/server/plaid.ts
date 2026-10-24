import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from 'node:crypto';
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from 'jose';
import { mutateState, type Database, type SQL } from './db.js';
import { acceptedOrigins } from './hosting.js';
import { allowedCloudEmails, ownerAccessSQL, ownerCanAccess } from './access.js';
import { venmoBankTransfer } from '../shared/venmo.js';
import {
  applyRules,
  fingerprint,
  importFingerprint,
  importedMatch,
  parseMoney,
  today,
  shiftMonth,
  monthDays,
  type State,
  type Transaction,
  type Account,
} from '../shared/core.js';
export class PlaidError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
function syncErrorCode(error: unknown): string {
  if (error instanceof PlaidError) return error.code;
  const e = error as { status?: number; name?: string; code?: string; issues?: { path: unknown[]; code: string }[] };
  const code = e?.status === 413 ? 'WORKSPACE_SIZE_LIMIT'
    : e?.name === 'ZodError' ? 'SYNC_DATA_INVALID'
    : /^[0-9A-Z]{5}$/.test(e?.code ?? '') ? 'SYNC_STORAGE_FAILED' : 'SYNC_FAILED';
  console.error('Plaid sync could not be saved', {
    code,
    errorType: e?.name,
    storageCode: code === 'SYNC_STORAGE_FAILED' ? e.code : undefined,
    fields: e?.issues?.slice(0, 8).map(({ path, code }) => ({ path: path.join('.'), code })),
  });
  return code;
}
export interface PlaidProvider {
  readonly environment?: PlaidEnvironment;
  assertCurrent?(tx: SQL, owner: string): Promise<void>;
  call<T = any>(
    path: string,
    body: Record<string, unknown>,
    options?: { deadline?: number },
  ): Promise<T>;
}
export type PlaidEnvironment = 'production' | 'sandbox';
export class PlaidClient implements PlaidProvider {
  readonly environment: PlaidEnvironment;
  private readonly credentials: { clientId: string; secret: string; environment: PlaidEnvironment };
  private readonly origin: string;
  constructor(credentials: { clientId: string; secret: string; environment: PlaidEnvironment }) {
    if (!credentials?.clientId || !credentials.secret) throw new PlaidError('PLAID_NOT_CONFIGURED');
    if (credentials.environment !== 'production' && credentials.environment !== 'sandbox')
      throw new PlaidError('INVALID_PLAID_ENVIRONMENT');
    this.credentials = { ...credentials };
    this.environment = credentials.environment;
    this.origin =
      credentials.environment === 'production'
        ? 'https://production.plaid.com'
        : 'https://sandbox.plaid.com';
  }
  async call<T>(
    path: string,
    body: Record<string, unknown>,
    options: { deadline?: number } = {},
  ): Promise<T> {
    const { clientId, secret } = this.credentials;
    const deadline = options.deadline ?? Date.now() + 20000;
    const attempts = [
      '/accounts/get',
      '/transactions/sync',
      '/investments/holdings/get',
      '/investments/transactions/get',
      '/item/get',
      '/institutions/get_by_id',
      '/webhook_verification_key/get',
    ].includes(path)
      ? 2
      : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 500) throw new PlaidError('SYNC_DEADLINE');
      try {
        const response = await fetch(this.origin + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, client_id: clientId, secret }),
          signal: AbortSignal.timeout(Math.max(1, Math.min(10000, remaining - 250))),
        });
        const result = (await response.json()) as any;
        if (!response.ok) {
          const code = result.error_code ?? 'PROVIDER_ERROR';
          if ((response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            continue;
          }
          throw new PlaidError(code);
        }
        return result as T;
      } catch (error) {
        if (error instanceof PlaidError) throw error;
        if (attempt + 1 >= attempts) throw new PlaidError('PROVIDER_UNAVAILABLE');
      }
      if (deadline - Date.now() > 500) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new PlaidError('PROVIDER_UNAVAILABLE');
  }
}

const deadlineSources = new WeakMap<PlaidProvider, PlaidProvider>();
export function withPlaidDeadline(provider: PlaidProvider, deadline: number): PlaidProvider {
  const bounded: PlaidProvider = {
    ...(provider.environment ? { environment: provider.environment } : {}),
    ...(provider.assertCurrent ? { assertCurrent: provider.assertCurrent.bind(provider) } : {}),
    async call<T>(path: string, body: Record<string, unknown>, options = {}) {
      const limit = Math.min(deadline, (options as { deadline?: number }).deadline ?? deadline);
      const remaining = limit - Date.now();
      if (remaining <= 0) throw new PlaidError('SYNC_DEADLINE');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          provider.call<T>(path, body, { deadline: limit }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new PlaidError('SYNC_DEADLINE')), remaining);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
  deadlineSources.set(bounded, deadlineSources.get(provider) ?? provider);
  return bounded;
}
function encryptionKey() {
  const value = process.env.TOKEN_ENCRYPTION_KEY ?? '';
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new PlaidError('ENCRYPTION_KEY_REQUIRED');
  return Buffer.from(value, 'hex');
}
export function encryptToken(token: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((x) => x.toString('base64url')).join('.');
}
export function decryptToken(value: string) {
  const [iv, tag, data] = value.split('.').map((x) => Buffer.from(x, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}
export type Connection = {
  id: string;
  owner_id: string;
  item_id: string;
  institution_id: string;
  institution_name: string;
  encrypted_token: string;
  product: 'transactions' | 'investments';
  environment: PlaidEnvironment;
  cursor: string | null;
  selected_accounts: string[];
  status: string;
  last_synced_at: string | null;
  initial_complete: boolean;
  historical_complete: boolean;
  error_code: string | null;
};
export function assertConnectionEnvironment(provider: PlaidProvider, connection: Connection) {
  if (provider.environment !== undefined && provider.environment !== connection.environment)
    throw Object.assign(new PlaidError('PLAID_ENVIRONMENT_MISMATCH'), { status: 409 });
}
export async function ownedConnection(db: SQL, id: string, owner: string) {
  const r = await db.query<Connection>('SELECT * FROM connections WHERE id=$1 AND owner_id=$2', [
    id,
    owner,
  ]);
  if (!r.rows[0]) throw Object.assign(Error('Connection not found'), { status: 404 });
  return r.rows[0];
}
export async function listConnections(db: SQL, owner: string) {
  return (
    await db.query(
      'SELECT id,institution_name,product,environment,status,last_synced_at,initial_complete,historical_complete,error_code,selected_accounts FROM connections WHERE owner_id=$1 ORDER BY created_at',
      [owner],
    )
  ).rows;
}
export async function createLinkToken(
  db: Database,
  provider: PlaidProvider,
  owner: string,
  product: 'transactions' | 'investments',
  connectionId?: string,
  platform = 'web',
) {
  encryptionKey();
  const params: Record<string, unknown> = {
    user: { client_user_id: owner },
    client_name: 'Asset',
    country_codes: ['US', 'CA'],
    language: 'en',
  };
  if (process.env.PLAID_WEBHOOK_URL) params.webhook = process.env.PLAID_WEBHOOK_URL;
  const redirect =
    platform === 'ios' ? process.env.PLAID_IOS_REDIRECT_URI : process.env.PLAID_WEB_REDIRECT_URI;
  if (platform === 'ios' && !redirect) throw new PlaidError('IOS_REDIRECT_URI_REQUIRED');
  if (redirect) {
    const url = new URL(redirect);
    if (
      url.protocol !== 'https:' ||
      !acceptedOrigins().has(url.origin) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new PlaidError('INVALID_REDIRECT_URI');
    params.redirect_uri = url.toString();
  }
  if (connectionId) {
    const c = await ownedConnection(db, connectionId, owner);
    if (c.status === 'disconnected') throw Error('Connect this institution again');
    assertConnectionEnvironment(provider, c);
    params.access_token = decryptToken(c.encrypted_token);
    params.update = { account_selection_enabled: true };
  } else {
    params.products = [product];
    if (product === 'transactions') params.transactions = { days_requested: 730 };
  }
  return provider.call('/link/token/create', params);
}
export async function exchangeLink(
  db: Database,
  provider: PlaidProvider,
  owner: string,
  publicToken: string,
  product: 'transactions' | 'investments',
  selected: string[],
) {
  const environment = provider.environment ?? 'sandbox';
  const exchanged = await provider.call('/item/public_token/exchange', {
    public_token: publicToken,
  });
  const token = exchanged.access_token;
  try {
    const item = await provider.call('/item/get', { access_token: token });
    const institutionId = item.item.institution_id ?? exchanged.item_id;
    const existing = await db.query<Connection>(
      'SELECT * FROM connections WHERE owner_id=$1 AND institution_id=$2 AND product=$3 AND environment=$4',
      [owner, institutionId, product, environment],
    );
    if (existing.rows[0] && existing.rows[0].status !== 'disconnected')
      throw new PlaidError('DUPLICATE_CONNECTION');
    const metadata = await provider.call('/accounts/get', { access_token: token });
    const accountIds = metadata.accounts.map((a: any) => a.account_id);
    if (selected.some((id) => !accountIds.includes(id))) throw Error('Invalid account selection');
    const use = selected.length ? selected : accountIds;
    const inst = await provider.call('/institutions/get_by_id', {
      institution_id: institutionId,
      country_codes: ['US', 'CA'],
    });
    if (!inst.institution.products.includes(product)) throw new PlaidError('PRODUCT_NOT_SUPPORTED');
    return await db.transaction(async (tx) => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner]);
      await provider.assertCurrent?.(tx, owner);
      const current = (
        await tx.query<Connection>(
          'SELECT * FROM connections WHERE owner_id=$1 AND institution_id=$2 AND product=$3 AND environment=$4 FOR UPDATE',
          [owner, institutionId, product, environment],
        )
      ).rows[0];
      if (current && current.status !== 'disconnected')
        throw new PlaidError('DUPLICATE_CONNECTION');
      const id = current?.id ?? randomUUID();
      if (current) await tx.query('DELETE FROM connections WHERE id=$1', [id]);
      await tx.query(
        'INSERT INTO connections(id,owner_id,item_id,institution_id,institution_name,encrypted_token,product,selected_accounts,status,environment) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          id,
          owner,
          exchanged.item_id,
          institutionId,
          inst.institution.name,
          encryptToken(token),
          product,
          JSON.stringify(use),
          'initial_loading',
          environment,
        ],
      );
      await enqueueSync(tx, id);
      return id;
    });
  } catch (e) {
    try {
      await withPlaidDeadline(deadlineSources.get(provider) ?? provider, Date.now() + 5000).call(
        '/item/remove',
        { access_token: token },
      );
    } catch {
      console.error('Plaid Item cleanup could not be confirmed', { code: 'ITEM_CLEANUP_FAILED' });
    }
    throw e;
  }
}
const typeMap = (a: any): Account['type'] =>
  a.type === 'credit'
    ? 'credit'
    : a.type === 'loan'
      ? 'loan'
      : a.type === 'investment'
        ? 'investment'
        : a.subtype === 'savings'
          ? 'savings'
          : a.type === 'depository'
            ? 'checking'
            : 'manual';
const minor = (x: any) => (x === null || x === undefined ? null : parseMoney(Number(x).toFixed(2)));
function categoryFor(raw: any): { kind: Transaction['kind']; categoryId: string } {
  const primary = raw.personal_finance_category?.primary ?? '',
    detail = raw.personal_finance_category?.detailed ?? '';
  if (primary === 'INCOME') return { kind: 'income', categoryId: 'other' };
  if (primary.startsWith('TRANSFER') || detail.includes('CREDIT_CARD_PAYMENT'))
    return {
      kind: detail.includes('CREDIT_CARD_PAYMENT') ? 'card_payment' : 'transfer',
      categoryId: 'other',
    };
  const categoryId =
    primary === 'FOOD_AND_DRINK'
      ? detail.includes('GROCER')
        ? 'groceries'
        : detail.includes('COFFEE')
          ? 'coffee'
          : 'restaurants'
      : primary === 'TRANSPORTATION'
        ? 'transport'
        : primary === 'RENT_AND_UTILITIES'
          ? 'home'
          : primary === 'MEDICAL'
            ? 'health'
            : primary === 'TRAVEL'
              ? 'travel'
              : primary === 'ENTERTAINMENT'
                ? 'fun'
                : primary === 'GENERAL_MERCHANDISE'
                  ? 'shopping'
                  : 'other';
  return { kind: raw.amount < 0 ? 'refund' : 'spending', categoryId };
}
export function applyProviderRecords(
  s: State,
  c: Connection,
  records: { added: any[]; modified: any[]; removed: any[] },
  date = today(),
): State {
  for (const raw of [...records.added, ...records.modified]) {
    const account = s.accounts.find(
      (a) => a.providerId === raw.account_id && a.connectionId === c.id,
    );
    if (!account) continue;
    const map = categoryFor(raw);
    if (!s.categories.some((x) => x.id === map.categoryId)) map.categoryId = 'other';
    let previous = s.transactions.find(
      (t) => t.connectionId === c.id && t.providerId === raw.transaction_id,
    );
    const pending = raw.pending_transaction_id
      ? s.transactions.find(
          (t) => t.connectionId === c.id && t.providerId === raw.pending_transaction_id,
        )
      : undefined;
    const normalized: Transaction = {
      id: previous?.id ?? pending?.id ?? randomUUID(),
      accountId: account.id,
      // Provider descriptions can exceed the editable display-name limit. The full
      // original description remains in raw for provenance and reconciliation.
      name: String(raw.merchant_name || raw.name || 'Imported transaction').slice(0, 160),
      date: raw.date,
      amount: Math.abs(minor(raw.amount) ?? 0),
      currency: raw.iso_currency_code ?? account.currency,
      kind: map.kind,
      categoryId: map.categoryId,
      notes: '',
      excluded: false,
      reviewed: false,
      pending: !!raw.pending,
      removed: false,
      source: 'plaid',
      importedAt: new Date().toISOString(),
      providerId: raw.transaction_id,
      pendingProviderId: raw.pending_transaction_id ?? null,
      connectionId: c.id,
      raw,
      edits: {},
      splits: [],
    };
    if (!previous && !pending) {
      const key = fingerprint(normalized);
      previous = s.transactions.find(
        (t) =>
          !t.removed &&
          (t.source === 'csv' || t.source === 'manual') &&
          importFingerprint(t) === key,
      ) ?? importedMatch(s.transactions, normalized);
      if (previous) {
        normalized.id = previous.id;
        previous.edits = {
          name: previous.name,
          date: previous.date,
          categoryId: previous.categoryId,
          kind: previous.kind,
          notes: previous.notes,
          excluded: previous.excluded,
          ...previous.edits,
        };
      }
    }
    const old = previous ?? pending;
    normalized.fingerprint = old?.fingerprint ?? fingerprint(normalized);
    if (old) {
      normalized.edits = old.edits;
      normalized.reviewed = old.reviewed;
      normalized.splits = old.splits;
      normalized.notes = old.notes;
      normalized.excluded = old.excluded;
      normalized.recurring = old.recurring;
      normalized.tags = old.tags;
      normalized.importIdentity = old.importIdentity;
      if (old.splits.length && old.amount !== normalized.amount) {
        normalized.raw = { ...raw, asset_split_conflict: true };
        normalized.amount = old.amount;
        normalized.reviewed = false;
      }
    }
    if (pending && previous && pending.id !== previous.id) pending.removed = true;
    const index = s.transactions.findIndex((t) => t.id === normalized.id);
    const ready = venmoBankTransfer(applyRules(normalized, s), s);
    if (index < 0) s.transactions.push(ready);
    else s.transactions[index] = ready;
  }
  const replacements = new Set(
    [...records.added, ...records.modified].map((r) => r.pending_transaction_id).filter(Boolean),
  );
  for (const r of records.removed) {
    if (replacements.has(r.transaction_id)) continue;
    const t = s.transactions.find(
      (t) => t.providerId === r.transaction_id && t.connectionId === c.id,
    );
    if (t) t.removed = true;
  }
  for (const a of s.accounts.filter((a) => a.connectionId === c.id)) {
    const dates = s.transactions
      .filter((t) => t.accountId === a.id && t.connectionId === c.id && !t.removed && !t.pending)
      .map((t) => t.date)
      .sort();
    a.coverageStart = dates[0] ?? a.coverageStart;
    a.coverageEnd = date;
    a.coverageComplete = c.historical_complete && !!a.coverageStart;
  }
  return s;
}
export async function collectSync(provider: PlaidProvider, token: string, cursor: string | null) {
  for (let restart = 0; restart < 4; restart++) {
    let next = cursor;
    const batch = { added: [] as any[], modified: [] as any[], removed: [] as any[] };
    try {
      for (let page = 0; page < 1000; page++) {
        const r = await provider.call('/transactions/sync', {
          access_token: token,
          ...(next ? { cursor: next } : {}),
          count: 500,
        });
        batch.added.push(...r.added);
        batch.modified.push(...r.modified);
        batch.removed.push(...r.removed);
        next = r.next_cursor;
        if (!r.has_more)
          return { ...batch, cursor: next, updateStatus: r.transactions_update_status };
      }
      throw new PlaidError('PAGINATION_LIMIT');
    } catch (e) {
      if (
        e instanceof PlaidError &&
        e.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' &&
        restart < 3
      )
        continue;
      throw e;
    }
  }
  throw new PlaidError('SYNC_RESTART_LIMIT');
}
export async function syncConnection(
  db: Database,
  provider: PlaidProvider,
  id: string,
  owner: string,
) {
  const c = await ownedConnection(db, id, owner);
  if (c.status === 'disconnected') throw Error('Connection is disconnected');
  assertConnectionEnvironment(provider, c);
  const token = decryptToken(c.encrypted_token);
  try {
    const metadata = await provider.call('/accounts/get', { access_token: token });
    const batch =
      c.product === 'transactions' ? await collectSync(provider, token, c.cursor) : null;
    const investments =
      c.product === 'investments'
        ? await provider.call('/investments/holdings/get', { access_token: token })
        : null;
    const activity: any[] = [];
    if (investments) {
      let complete = false;
      const now = today(),
        startMonth = shiftMonth(now.slice(0, 7), -24),
        start = `${startMonth}-${String(Math.min(Number(now.slice(8)), monthDays(startMonth))).padStart(2, '0')}`;
      for (let offset = 0; offset < 100000; offset += 500) {
        const r = await provider.call('/investments/transactions/get', {
          access_token: token,
          start_date: start,
          end_date: now,
          options: { offset, count: 500 },
        });
        activity.push(...r.investment_transactions);
        if (offset + r.investment_transactions.length >= r.total_investment_transactions) {
          complete = true;
          break;
        }
        if (!r.investment_transactions.length)
          throw new PlaidError('INCOMPLETE_INVESTMENT_PAGINATION');
      }
      if (!complete) throw new PlaidError('INCOMPLETE_INVESTMENT_PAGINATION');
    }
    return await commitSync(db, c, metadata, batch, investments, activity);
  } catch (e) {
    const code = syncErrorCode(e);
    const status =
      code === 'ITEM_LOGIN_REQUIRED'
        ? 'reauthentication_required'
        : code === 'PRODUCT_NOT_SUPPORTED' || code === 'INVALID_PRODUCT'
          ? 'unsupported'
          : code === 'PRODUCT_NOT_READY'
            ? 'initial_loading'
            : 'failed';
    await db.query(
      'UPDATE connections SET status=$1,error_code=$2 WHERE id=$3 AND owner_id=$4 AND status<>$5',
      [status, code, id, owner, 'disconnected'],
    );
    throw new PlaidError(code);
  }
}

type SyncBatch = {
  added: any[];
  modified: any[];
  removed: any[];
  cursor: string | null;
  updateStatus?: string;
};
async function commitSync(
  db: Database,
  c: Connection,
  metadata: any,
  batch: SyncBatch | null,
  investments: any,
  activity: any[],
  lease?: { token: string; generation: number },
) {
  const id = c.id,
    owner = c.owner_id;
  return mutateState(
    db,
    owner,
    async (s, tx) => {
      const live = (
        await tx.query<Connection>(
          'SELECT * FROM connections WHERE id=$1 AND owner_id=$2 FOR UPDATE',
          [id, owner],
        )
      ).rows[0];
      if (!live) throw new PlaidError('SYNC_CONFLICT_RETRY');
      if (lease) await requireLease(tx, id, lease.token);
      if (
        live.cursor !== c.cursor ||
        live.environment !== c.environment ||
        live.encrypted_token !== c.encrypted_token ||
        JSON.stringify(live.selected_accounts) !== JSON.stringify(c.selected_accounts) ||
        live.status === 'disconnected'
      )
        throw new PlaidError('SYNC_CONFLICT_RETRY');
      for (const a of s.accounts.filter(
        (a) =>
          a.connectionId === id &&
          !metadata.accounts.some((raw: any) => raw.account_id === a.providerId),
      ))
        a.enabled = false;
      for (const raw of metadata.accounts) {
        let a = s.accounts.find((a) => a.connectionId === id && a.providerId === raw.account_id);
        const selected = c.selected_accounts.includes(raw.account_id);
        if (!a && !selected) continue;
        const value: Account = {
          id: a?.id ?? randomUUID(),
          name: a?.name ?? String(raw.name || 'Connected account').slice(0, 100),
          type: typeMap(raw),
          currency: raw.balances.iso_currency_code ?? 'USD',
          balance: minor(raw.balances.current),
          creditLimit: raw.balances.limit > 0 ? minor(raw.balances.limit) : null,
          includeInNetWorth: a?.includeInNetWorth ?? true,
          enabled: selected,
          source: 'plaid',
          updatedAt: new Date().toISOString(),
          mask: raw.mask ?? undefined,
          connectionId: id,
          providerId: raw.account_id,
          coverageStart: a?.coverageStart,
          coverageEnd: a?.coverageEnd,
          coverageComplete: a?.coverageComplete ?? false,
        };
        if (a) Object.assign(a, value);
        else {
          s.accounts.push(value);
          a = value;
        }
        if (a.balance !== null) {
          s.snapshots = s.snapshots.filter((p) => p.accountId !== a!.id || p.date !== today());
          s.snapshots.push({
            id: randomUUID(),
            accountId: a.id,
            date: today(),
            balance: a.balance,
            currency: a.currency,
            source: 'plaid',
          });
        }
      }
      if (batch) {
        live.initial_complete ||= [
          'INITIAL_UPDATE_COMPLETE',
          'HISTORICAL_UPDATE_COMPLETE',
        ].includes(batch.updateStatus ?? '');
        live.historical_complete ||= batch.updateStatus === 'HISTORICAL_UPDATE_COMPLETE';
        applyProviderRecords(s, live, batch);
      }
      if (investments) {
        const accountIds = new Set(
          s.accounts.filter((a) => a.connectionId === id).map((a) => a.id),
        );
        s.holdings = s.holdings.filter((h) => !accountIds.has(h.accountId));
        for (const h of investments.holdings) {
          const a = s.accounts.find((a) => a.connectionId === id && a.providerId === h.account_id);
          if (!a) continue;
          const security = investments.securities.find((x: any) => x.security_id === h.security_id);
          s.holdings.push({
            id: `${a.id}:${h.security_id}`,
            accountId: a.id,
            symbol: security?.ticker_symbol ?? '—',
            name: security?.name ?? 'Unsupported security',
            quantity: String(h.quantity ?? 0),
            price: minor(h.institution_price ?? security?.close_price),
            marketValue: minor(h.institution_value),
            costBasis: minor(h.cost_basis),
            currency: h.iso_currency_code ?? a.currency,
            priceAt: h.institution_price_as_of ?? security?.close_price_as_of ?? null,
            type: security?.type ?? 'Other',
            providerId: h.security_id,
            source: 'plaid',
          });
        }
        s.holdingSnapshots = s.holdingSnapshots.filter(
          (h) => !accountIds.has(h.accountId) || h.date !== today(),
        );
        s.holdingSnapshots.push(
          ...s.holdings
            .filter((h) => accountIds.has(h.accountId))
            .map((h) => ({ ...h, id: randomUUID(), holdingId: h.id, date: today() })),
        );
        s.investmentActivity = s.investmentActivity.filter((a) => !accountIds.has(a.accountId));
        for (const t of activity) {
          const a = s.accounts.find((a) => a.connectionId === id && a.providerId === t.account_id);
          if (a)
            s.investmentActivity.push({
              id: t.investment_transaction_id,
              accountId: a.id,
              date: t.date,
              type: t.type,
              amount: minor(t.amount) ?? 0,
              currency: t.iso_currency_code ?? a.currency,
              name: t.name,
              securityId: t.security_id ?? null,
              quantity: String(t.quantity ?? 0),
              source: 'plaid',
            });
        }
      }
      const status =
        c.product === 'investments' || live.historical_complete
          ? 'healthy'
          : live.initial_complete
            ? 'historical_loading'
            : 'initial_loading';
      await tx.query(
        'UPDATE connections SET cursor=$1,status=$2,last_synced_at=now(),error_code=NULL,initial_complete=$5,historical_complete=$6 WHERE id=$3 AND owner_id=$4',
        [
          batch?.cursor ?? c.cursor,
          status,
          id,
          owner,
          live.initial_complete,
          live.historical_complete,
        ],
      );
      if (lease) {
        await tx.query(
          `UPDATE sync_jobs SET completed_generation=$1,
            status=CASE WHEN generation>$1 THEN 'pending' ELSE 'done' END,
            available_at=now(),lease_token=NULL,lease_until=NULL,stage=NULL,attempts=0,
            last_error=NULL,updated_at=now() WHERE connection_id=$2 AND lease_token=$3`,
          [lease.generation, id, lease.token],
        );
      }
      return s;
    },
    undefined,
    !c.historical_complete,
  );
}

const jwkCache = new Map<string, { key: JWK; at: number }>();
export async function verifyWebhook(
  provider: PlaidProvider,
  body: Buffer,
  token: string,
  now = Date.now(),
) {
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg !== 'ES256' || !header.kid) return false;
    let entry = jwkCache.get(header.kid);
    if (!entry || now - entry.at > 3600000) {
      let r: any;
      try {
        r = await withPlaidDeadline(provider, Date.now() + 5000).call(
          '/webhook_verification_key/get',
          { key_id: header.kid },
        );
      } catch {
        throw new PlaidError('WEBHOOK_VERIFICATION_UNAVAILABLE');
      }
      if (r.key.expired_at) return false;
      entry = { key: r.key, at: now };
      jwkCache.set(header.kid, entry);
    }
    const key = await importJWK(entry.key, 'ES256');
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['ES256'],
      maxTokenAge: '5 min',
      currentDate: new Date(now),
      clockTolerance: 5,
    });
    if (typeof payload.iat !== 'number' || payload.iat > now / 1000 + 5) return false;
    const claimed = payload.request_body_sha256;
    if (typeof claimed !== 'string' || !/^[a-f0-9]{64}$/.test(claimed)) return false;
    const actual = createHash('sha256').update(body).digest();
    return timingSafeEqual(actual, Buffer.from(claimed, 'hex'));
  } catch (error) {
    if (error instanceof PlaidError && error.code === 'WEBHOOK_VERIFICATION_UNAVAILABLE')
      throw error;
    return false;
  }
}
export async function enqueueWebhook(db: Database, body: Buffer) {
  const event = JSON.parse(body.toString('utf8'));
  if (!event.item_id) return;
  await db.transaction(async (tx) => {
    const row = (
      await tx.query<Connection>(
        'SELECT * FROM connections WHERE item_id=$1 AND status<>$2 FOR UPDATE',
        [event.item_id, 'disconnected'],
      )
    ).rows[0];
    if (!row || !(await ownerCanAccess(tx, row.owner_id))) return;
    if (event.webhook_code === 'ERROR') {
      await tx.query('UPDATE connections SET status=$1,error_code=$2 WHERE id=$3', [
        event.error?.error_code === 'ITEM_LOGIN_REQUIRED' ? 'reauthentication_required' : 'failed',
        event.error?.error_code ?? 'ITEM_ERROR',
        row.id,
      ]);
      await tx.query(
        `UPDATE sync_jobs SET status='failed',lease_token=NULL,lease_until=NULL,stage=NULL,
          last_error=$2,updated_at=now() WHERE connection_id=$1`,
        [row.id, event.error?.error_code ?? 'ITEM_ERROR'],
      );
      return;
    }
    if (
      ![
        'SYNC_UPDATES_AVAILABLE',
        'HOLDINGS_UPDATE',
        'DEFAULT_UPDATE',
        'INITIAL_UPDATE',
        'HISTORICAL_UPDATE',
      ].includes(event.webhook_code)
    )
      return;
    await tx.query(
      'UPDATE connections SET initial_complete=initial_complete OR $1,historical_complete=historical_complete OR $2 WHERE id=$3',
      [event.initial_update_complete === true, event.historical_update_complete === true, row.id],
    );
    await enqueueSync(tx, row.id);
  });
}
export async function enqueueSync(db: SQL, connectionId: string): Promise<void> {
  await db.query(
    `INSERT INTO sync_jobs(connection_id) VALUES($1)
      ON CONFLICT(connection_id) DO UPDATE SET generation=sync_jobs.generation+1,
        status=CASE WHEN sync_jobs.status='processing' THEN 'processing' ELSE 'pending' END,
        available_at=now(),attempts=0,last_error=NULL,updated_at=now()`,
    [connectionId],
  );
}

// Call within the same transaction as account-selection or cursor changes.
export async function invalidateSync(db: SQL, connectionId: string): Promise<void> {
  await db.query(
    `UPDATE sync_jobs SET stage=NULL,lease_token=NULL,lease_until=NULL,status='pending',
      available_at=now(),attempts=0,last_error=NULL,updated_at=now() WHERE connection_id=$1`,
    [connectionId],
  );
}

export async function enqueueStaleSyncs(db: SQL): Promise<void> {
  await db.query(
    `INSERT INTO sync_jobs(connection_id)
      SELECT c.id FROM connections c LEFT JOIN sync_jobs j ON j.connection_id=c.id
      WHERE c.status IN ('healthy','initial_loading','historical_loading','failed')
        AND ${ownerAccessSQL('c.owner_id', 1)}
        AND (j.connection_id IS NULL OR
          (j.status='done' AND j.updated_at<now()-interval '2 minutes') OR
          (j.status='failed' AND j.updated_at<now()-interval '6 hours'))
        AND (c.last_synced_at IS NULL OR c.last_synced_at<now()-interval '6 hours' OR
          (c.status IN ('initial_loading','historical_loading') AND
            c.last_synced_at<now()-interval '2 minutes'))
      ON CONFLICT(connection_id) DO UPDATE SET generation=sync_jobs.generation+1,
        status='pending',available_at=now(),attempts=0,last_error=NULL,stage=NULL,updated_at=now()
      WHERE sync_jobs.status IN ('done','failed')`,
    [allowedCloudEmails()],
  );
}

type SyncStage = {
  version: 1;
  source: string;
  generation: number;
  phase: 'accounts' | 'transactions' | 'holdings' | 'activity' | 'commit';
  metadata?: any;
  batch: SyncBatch;
  investments?: any;
  activity: any[];
  offset: number;
  pages: number;
  restarts: number;
  fromDate: string;
  throughDate: string;
};
type SyncJob = {
  connection_id: string;
  owner_id: string;
  generation: number;
  attempts: number;
  stage: SyncStage | null;
  lease_token: string;
};
const connectionSource = (connection: Connection) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        connection.cursor,
        connection.encrypted_token,
        connection.selected_accounts,
        connection.item_id,
        connection.product,
        connection.environment,
      ]),
    )
    .digest('hex');
function newStage(connection: Connection, generation: number): SyncStage {
  const throughDate = today(),
    startMonth = shiftMonth(throughDate.slice(0, 7), -24);
  return {
    version: 1,
    source: connectionSource(connection),
    generation,
    phase: 'accounts',
    batch: { added: [], modified: [], removed: [], cursor: connection.cursor },
    activity: [],
    offset: 0,
    pages: 0,
    restarts: 0,
    fromDate: `${startMonth}-${String(Math.min(Number(throughDate.slice(8)), monthDays(startMonth))).padStart(2, '0')}`,
    throughDate,
  };
}
async function requireLease(tx: SQL, id: string, token: string): Promise<SyncJob> {
  const row = (
    await tx.query<SyncJob>(
      `SELECT * FROM sync_jobs WHERE connection_id=$1 AND lease_token=$2
      AND status='processing' AND lease_until>now() FOR UPDATE`,
      [id, token],
    )
  ).rows[0];
  if (!row) throw new PlaidError('SYNC_LEASE_LOST');
  return row;
}
async function saveStage(db: Database, job: SyncJob, stage: SyncStage) {
  await db.transaction(async (tx) => {
    await requireLease(tx, job.connection_id, job.lease_token);
    const connection = await ownedConnection(tx, job.connection_id, job.owner_id);
    if (connection.status === 'disconnected' || connectionSource(connection) !== stage.source)
      throw new PlaidError('SYNC_CONFLICT_RETRY');
    await tx.query(
      `UPDATE sync_jobs SET stage=$1,attempts=0,updated_at=now()
        WHERE connection_id=$2 AND lease_token=$3`,
      [JSON.stringify(stage), job.connection_id, job.lease_token],
    );
  });
}
const errorStatus = (code: string) =>
  code === 'ITEM_LOGIN_REQUIRED'
    ? 'reauthentication_required'
    : ['PRODUCT_NOT_SUPPORTED', 'INVALID_PRODUCT'].includes(code)
      ? 'unsupported'
      : code === 'PRODUCT_NOT_READY'
        ? 'initial_loading'
        : 'failed';

export async function processJob(
  db: Database,
  providerOrFactory: PlaidProvider | ((owner: string) => Promise<PlaidProvider>),
  { deadline = Date.now() + 45000 }: { deadline?: number } = {},
) {
  if (deadline - Date.now() < 5000) return false;
  const job = await db.transaction(async (tx) => {
    const row = (
      await tx.query<SyncJob>(
        `SELECT j.*,c.owner_id FROM sync_jobs j JOIN connections c ON c.id=j.connection_id
        WHERE c.status<>'disconnected' AND ${ownerAccessSQL('c.owner_id', 1)} AND
          ((j.status='pending' AND j.available_at<=now()) OR
           (j.status='processing' AND j.lease_until<=now()))
        ORDER BY j.available_at,j.created_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,
        [allowedCloudEmails()],
      )
    ).rows[0];
    if (!row) return undefined;
    if (row.attempts >= 10) {
      await tx.query(
        `UPDATE sync_jobs SET status='failed',lease_token=NULL,lease_until=NULL,
          last_error='SYNC_RETRY_EXHAUSTED',updated_at=now() WHERE connection_id=$1`,
        [row.connection_id],
      );
      return { ...row, exhausted: true };
    }
    row.lease_token = randomUUID();
    row.attempts++;
    await tx.query(
      `UPDATE sync_jobs SET status='processing',attempts=$1,lease_token=$2,
        lease_until=now()+interval '90 seconds',updated_at=now() WHERE connection_id=$3`,
      [row.attempts, row.lease_token, row.connection_id],
    );
    return { ...row, exhausted: false };
  });
  if (!job) return false;
  if (job.exhausted) {
    await db.query(
      `UPDATE connections SET status='failed',error_code='SYNC_RETRY_EXHAUSTED'
        WHERE id=$1 AND status<>'disconnected' AND EXISTS
          (SELECT 1 FROM sync_jobs WHERE connection_id=$1 AND status='failed'
            AND last_error='SYNC_RETRY_EXHAUSTED')`,
      [job.connection_id],
    );
    return true;
  }
  try {
    const c = await ownedConnection(db, job.connection_id, job.owner_id);
    if (c.status === 'disconnected') throw new PlaidError('SYNC_CONFLICT_RETRY');
    const resolved =
      typeof providerOrFactory === 'function'
        ? await providerOrFactory(job.owner_id)
        : providerOrFactory;
    // Reserve time for checkpointing/commit and acknowledgment before the function's hard limit.
    const provider = withPlaidDeadline(resolved, deadline - 3000);
    assertConnectionEnvironment(provider, c);
    const token = decryptToken(c.encrypted_token);
    let stage =
      job.stage?.version === 1 && job.stage.source === connectionSource(c)
        ? job.stage
        : newStage(c, job.generation);
    while (deadline - Date.now() > 5000) {
      if (stage.phase === 'commit') {
        await commitSync(
          db,
          c,
          stage.metadata,
          c.product === 'transactions' ? stage.batch : null,
          stage.investments,
          stage.activity,
          { token: job.lease_token, generation: stage.generation },
        );
        return true;
      }
      if (stage.phase === 'accounts') {
        stage.metadata = await provider.call('/accounts/get', { access_token: token });
        stage.phase = c.product === 'transactions' ? 'transactions' : 'holdings';
      } else if (stage.phase === 'transactions') {
        if (stage.pages >= 1000) throw new PlaidError('PAGINATION_LIMIT');
        try {
          const page = await provider.call('/transactions/sync', {
            access_token: token,
            ...(stage.batch.cursor ? { cursor: stage.batch.cursor } : {}),
            count: 500,
          });
          stage.batch.added.push(...page.added);
          stage.batch.modified.push(...page.modified);
          stage.batch.removed.push(...page.removed);
          stage.batch.cursor = page.next_cursor;
          stage.batch.updateStatus = page.transactions_update_status;
          stage.pages++;
          if (!page.has_more) stage.phase = 'commit';
        } catch (error) {
          if (
            !(error instanceof PlaidError) ||
            error.code !== 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION'
          )
            throw error;
          stage.batch = { added: [], modified: [], removed: [], cursor: c.cursor };
          stage.pages = 0;
          stage.restarts++;
          await saveStage(db, job, stage);
          if (stage.restarts > 3) throw new PlaidError('SYNC_RESTART_LIMIT');
          continue;
        }
      } else if (stage.phase === 'holdings') {
        stage.investments = await provider.call('/investments/holdings/get', {
          access_token: token,
        });
        stage.phase = 'activity';
      } else {
        if (stage.offset >= 100000) throw new PlaidError('INCOMPLETE_INVESTMENT_PAGINATION');
        const page = await provider.call('/investments/transactions/get', {
          access_token: token,
          start_date: stage.fromDate,
          end_date: stage.throughDate,
          options: { offset: stage.offset, count: 500 },
        });
        stage.activity.push(...page.investment_transactions);
        stage.offset += page.investment_transactions.length;
        if (stage.offset >= page.total_investment_transactions) stage.phase = 'commit';
        else if (!page.investment_transactions.length)
          throw new PlaidError('INCOMPLETE_INVESTMENT_PAGINATION');
      }
      await saveStage(db, job, stage);
    }
    throw new PlaidError('SYNC_DEADLINE');
  } catch (error) {
    const code = syncErrorCode(error);
    if (code === 'SYNC_LEASE_LOST') return true;
    await db.transaction(async (tx) => {
      // Match account-update/commit ordering: connection first, then its job lease.
      const connection = (
        await tx.query<Connection>(
          'SELECT * FROM connections WHERE id=$1 AND owner_id=$2 FOR UPDATE',
          [job.connection_id, job.owner_id],
        )
      ).rows[0];
      if (!connection) return;
      let held: SyncJob;
      try {
        held = await requireLease(tx, job.connection_id, job.lease_token);
      } catch (lost) {
        if (lost instanceof PlaidError && lost.code === 'SYNC_LEASE_LOST') return;
        throw lost;
      }
      const deferred = code === 'SYNC_DEADLINE' || code === 'SYNC_CONFLICT_RETRY';
      const permanent = [
        'ITEM_LOGIN_REQUIRED',
        'PRODUCT_NOT_SUPPORTED',
        'INVALID_PRODUCT',
        'PLAID_NOT_CONFIGURED',
        'INVALID_PLAID_ENVIRONMENT',
        'PLAID_ENVIRONMENT_MISMATCH',
        'ENCRYPTION_KEY_REQUIRED',
        'PAGINATION_LIMIT',
        'SYNC_RESTART_LIMIT',
        'INCOMPLETE_INVESTMENT_PAGINATION',
      ].includes(code);
      const failed = permanent || held.attempts >= 10;
      await tx.query(
        `UPDATE sync_jobs SET status=$1,available_at=now()+($2 * interval '1 second'),
          lease_token=NULL,lease_until=NULL,last_error=$3,
          stage=CASE WHEN $4 THEN NULL ELSE stage END,updated_at=now()
          WHERE connection_id=$5 AND lease_token=$6`,
        [
          failed ? 'failed' : 'pending',
          deferred && !failed ? 0 : Math.min(3600, 2 ** held.attempts * 10),
          code,
          code === 'SYNC_CONFLICT_RETRY',
          job.connection_id,
          job.lease_token,
        ],
      );
      if (!deferred && connection.status !== 'disconnected')
        await tx.query('UPDATE connections SET status=$1,error_code=$2 WHERE id=$3', [
          errorStatus(code),
          code,
          job.connection_id,
        ]);
    });
  }
  return true;
}
export async function disconnect(
  db: Database,
  provider: PlaidProvider,
  owner: string,
  id: string,
  deleteData = false,
) {
  const c = await ownedConnection(db, id, owner);
  if (c.status !== 'disconnected') {
    assertConnectionEnvironment(provider, c);
    await provider.call('/item/remove', { access_token: decryptToken(c.encrypted_token) });
  }
  return mutateState(db, owner, async (s, tx) => {
    const current = (
      await tx.query<Connection>(
        'SELECT * FROM connections WHERE id=$1 AND owner_id=$2 FOR UPDATE',
        [id, owner],
      )
    ).rows[0];
    if (!current || current.item_id !== c.item_id || current.encrypted_token !== c.encrypted_token)
      throw Object.assign(new PlaidError('CONNECTION_CHANGED_RETRY'), { status: 409 });
    await tx.query(
      "UPDATE connections SET encrypted_token='',status='disconnected',cursor=NULL WHERE id=$1 AND owner_id=$2",
      [id, owner],
    );
    await tx.query('DELETE FROM sync_jobs WHERE connection_id=$1', [id]);
    await tx.query('DELETE FROM webhook_jobs WHERE connection_id=$1', [id]);
    if (deleteData) {
      const ids = new Set(s.accounts.filter((a) => a.connectionId === id).map((a) => a.id));
      s.accounts = s.accounts.filter((a) => !ids.has(a.id));
      s.transactions = s.transactions.filter((t) => !ids.has(t.accountId));
      s.holdings = s.holdings.filter((h) => !ids.has(h.accountId));
      s.snapshots = s.snapshots.filter((p) => !ids.has(p.accountId));
      s.holdingSnapshots = s.holdingSnapshots.filter((p) => !ids.has(p.accountId));
      s.investmentActivity = s.investmentActivity.filter((t) => !ids.has(t.accountId));
      s.rules = s.rules.filter((r) => !r.accountId || !ids.has(r.accountId));
    }
    return s;
  });
}
