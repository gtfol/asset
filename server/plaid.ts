import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from 'node:crypto';
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from 'jose';
import { mutateState, type Database, type SQL } from './db';
import {
  applyRules,
  fingerprint,
  importFingerprint,
  parseMoney,
  today,
  shiftMonth,
  monthDays,
  type State,
  type Transaction,
  type Account,
} from '../shared/core';
export class PlaidError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export interface PlaidProvider {
  call<T = any>(path: string, body: Record<string, unknown>): Promise<T>;
}
export class PlaidSandbox implements PlaidProvider {
  async call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    if ((process.env.PLAID_ENV ?? 'sandbox') !== 'sandbox')
      throw new PlaidError('PRODUCTION_BLOCKED');
    if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET)
      throw new PlaidError('SANDBOX_NOT_CONFIGURED');
    for (let n = 0; n < 4; n++) {
      try {
        const response = await fetch('https://sandbox.plaid.com' + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            client_id: process.env.PLAID_CLIENT_ID,
            secret: process.env.PLAID_SECRET,
            ...body,
          }),
          signal: AbortSignal.timeout(25000),
        });
        const result = (await response.json()) as any;
        if (!response.ok) {
          const code = result.error_code ?? 'PROVIDER_ERROR';
          if ((response.status === 429 || response.status >= 500) && n < 3) {
            await new Promise((r) => setTimeout(r, 250 * 2 ** n));
            continue;
          }
          throw new PlaidError(code);
        }
        return result as T;
      } catch (e) {
        if (e instanceof PlaidError || n === 3) throw e;
        await new Promise((r) => setTimeout(r, 250 * 2 ** n));
      }
    }
    throw new PlaidError('PROVIDER_UNAVAILABLE');
  }
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
  cursor: string | null;
  selected_accounts: string[];
  status: string;
  last_synced_at: string | null;
  initial_complete: boolean;
  historical_complete: boolean;
  error_code: string | null;
};
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
      'SELECT id,institution_name,product,status,last_synced_at,initial_complete,historical_complete,error_code,selected_accounts FROM connections WHERE owner_id=$1 ORDER BY created_at',
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
  if (platform === 'ios') {
    if (!process.env.PLAID_IOS_REDIRECT_URI) throw new PlaidError('IOS_REDIRECT_URI_REQUIRED');
    params.redirect_uri = process.env.PLAID_IOS_REDIRECT_URI;
  }
  if (connectionId) {
    const c = await ownedConnection(db, connectionId, owner);
    if (c.status === 'disconnected') throw Error('Connect this institution again');
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
  const exchanged = await provider.call('/item/public_token/exchange', {
    public_token: publicToken,
  });
  const token = exchanged.access_token;
  try {
    const item = await provider.call('/item/get', { access_token: token });
    const institutionId = item.item.institution_id ?? exchanged.item_id;
    const existing = await db.query<Connection>(
      'SELECT * FROM connections WHERE owner_id=$1 AND institution_id=$2 AND product=$3',
      [owner, institutionId, product],
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
    const id = existing.rows[0]?.id ?? randomUUID();
    await db.transaction(async (tx) => {
      if (existing.rows[0]) await tx.query('DELETE FROM connections WHERE id=$1', [id]);
      await tx.query(
        'INSERT INTO connections(id,owner_id,item_id,institution_id,institution_name,encrypted_token,product,selected_accounts,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
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
        ],
      );
    });
    return id;
  } catch (e) {
    await provider.call('/item/remove', { access_token: token }).catch(() => {});
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
      name: raw.merchant_name ?? raw.name ?? 'Imported transaction',
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
      );
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
      if (old.splits.length && old.amount !== normalized.amount) {
        normalized.raw = { ...raw, asset_split_conflict: true };
        normalized.amount = old.amount;
        normalized.reviewed = false;
      }
    }
    if (pending && previous && pending.id !== previous.id) pending.removed = true;
    const index = s.transactions.findIndex((t) => t.id === normalized.id);
    const ready = applyRules(normalized, s);
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
      .filter((t) => t.accountId === a.id && !t.removed && !t.pending)
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
        if (!r.has_more) return { ...batch, cursor: next };
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
    return await mutateState(db, owner, async (s, tx) => {
      const live = await ownedConnection(tx, id, owner);
      if (
        live.cursor !== c.cursor ||
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
          name: a?.name ?? raw.name,
          type: typeMap(raw),
          currency: raw.balances.iso_currency_code ?? 'USD',
          balance: minor(raw.balances.current),
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
      if (batch) applyProviderRecords(s, live, batch);
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
        'UPDATE connections SET cursor=$1,status=$2,last_synced_at=now(),error_code=NULL WHERE id=$3 AND owner_id=$4',
        [batch?.cursor ?? c.cursor, status, id, owner],
      );
      return s;
    });
  } catch (e) {
    const code = e instanceof PlaidError ? e.code : 'SYNC_FAILED';
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
      const r = await provider.call('/webhook_verification_key/get', { key_id: header.kid });
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
  } catch {
    return false;
  }
}
export async function enqueueWebhook(db: Database, body: Buffer) {
  const event = JSON.parse(body.toString('utf8'));
  if (!event.item_id) return;
  const row = (
    await db.query<Connection>('SELECT * FROM connections WHERE item_id=$1 AND status<>$2', [
      event.item_id,
      'disconnected',
    ])
  ).rows[0];
  if (!row) return;
  const id = createHash('sha256').update(body).digest('hex');
  await db.transaction(async (tx) => {
    if (event.webhook_code === 'ERROR') {
      await tx.query('UPDATE connections SET status=$1,error_code=$2 WHERE id=$3', [
        event.error?.error_code === 'ITEM_LOGIN_REQUIRED' ? 'reauthentication_required' : 'failed',
        event.error?.error_code ?? 'ITEM_ERROR',
        row.id,
      ]);
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
    await tx.query(
      'INSERT INTO webhook_jobs(id,connection_id,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [id, row.id, JSON.stringify(event)],
    );
  });
}
export async function processJob(db: Database, provider: PlaidProvider) {
  const job = await db.transaction(async (tx) => {
    const row = (
      await tx.query(
        "SELECT j.*,c.owner_id FROM webhook_jobs j JOIN connections c ON c.id=j.connection_id WHERE j.status IN ('pending','processing') AND j.available_at<=now() ORDER BY j.created_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED",
      )
    ).rows[0];
    if (row)
      await tx.query(
        "UPDATE webhook_jobs SET status='processing',attempts=attempts+1,available_at=now()+interval '2 minutes' WHERE id=$1",
        [row.id],
      );
    return row;
  });
  if (!job) return false;
  try {
    await syncConnection(db, provider, job.connection_id, job.owner_id);
    await db.query("UPDATE webhook_jobs SET status='done' WHERE id=$1", [job.id]);
  } catch {
    await db.query(
      "UPDATE webhook_jobs SET status=$1,available_at=now()+($2 * interval '1 second') WHERE id=$3",
      [job.attempts >= 9 ? 'failed' : 'pending', Math.min(3600, 2 ** job.attempts * 10), job.id],
    );
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
  if (c.status !== 'disconnected')
    await provider.call('/item/remove', { access_token: decryptToken(c.encrypted_token) });
  return mutateState(db, owner, async (s, tx) => {
    await tx.query(
      "UPDATE connections SET encrypted_token='',status='disconnected',cursor=NULL WHERE id=$1 AND owner_id=$2",
      [id, owner],
    );
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
