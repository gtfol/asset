import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';
import { createHash } from 'node:crypto';
import { openDatabase, getState, mutateState, type Database } from '../server/db';
import {
  enqueueSync,
  enqueueStaleSyncs,
  enqueueWebhook,
  invalidateSync,
  processJob,
  encryptToken,
  createLinkToken,
  exchangeLink,
  disconnect,
  decryptToken,
  verifyWebhook,
  withPlaidDeadline,
  PlaidSandbox,
  PlaidError,
  type PlaidProvider,
} from '../server/plaid';
import { fixture } from './fixtures';

const account = {
  account_id: 'provider-a',
  name: 'Sandbox checking',
  type: 'depository',
  subtype: 'checking',
  balances: { current: 1000, iso_currency_code: 'USD' },
  mask: '1234',
};
const raw = (id: string, amount = 10) => ({
  transaction_id: id,
  account_id: 'provider-a',
  name: 'Sandbox transaction',
  date: '2026-10-01',
  amount,
  iso_currency_code: 'USD',
  pending: false,
});
const page = (id: string | null, cursor = 'final', extra: Record<string, unknown> = {}) => ({
  added: id ? [raw(id)] : [],
  modified: [],
  removed: [],
  next_cursor: cursor,
  has_more: false,
  transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
  ...extra,
});
const provider = (fn: (path: string, body: any) => any): PlaidProvider => ({
  call: async (path, body) => fn(path, body),
});
const event = Buffer.from(
  JSON.stringify({
    item_id: 'item',
    webhook_type: 'TRANSACTIONS',
    webhook_code: 'SYNC_UPDATES_AVAILABLE',
    initial_update_complete: true,
    historical_update_complete: true,
  }),
);
let db: Database;
async function job() {
  return (await db.query('SELECT * FROM sync_jobs WHERE connection_id=$1', ['c'])).rows[0];
}
async function connection() {
  return (await db.query('SELECT * FROM connections WHERE id=$1', ['c'])).rows[0];
}
function regular(id = 'posted') {
  return provider((path) => (path === '/accounts/get' ? { accounts: [account] } : page(id)));
}

beforeAll(async () => {
  vi.stubEnv('DATABASE_URL', undefined);
  vi.stubEnv('VERCEL', undefined);
  vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'b'.repeat(64));
  db = await openDatabase(':memory:');
}, 30000);
beforeEach(async () => {
  await db.query('DELETE FROM users');
  const state = fixture();
  state.accounts[0] = {
    ...state.accounts[0],
    connectionId: 'c',
    providerId: 'provider-a',
    source: 'plaid',
  };
  await db.query('INSERT INTO users(id,email) VALUES($1,$2)', ['owner', 'worker@example.invalid']);
  await db.query('INSERT INTO workspaces(owner_id,state) VALUES($1,$2)', [
    'owner',
    JSON.stringify(state),
  ]);
  await db.query(
    `INSERT INTO connections(id,owner_id,item_id,institution_id,institution_name,encrypted_token,
      product,selected_accounts,status,cursor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      'c',
      'owner',
      'item',
      'institution',
      'Sandbox',
      encryptToken('fixture-token'),
      'transactions',
      JSON.stringify(['provider-a']),
      'initial_loading',
      'original',
    ],
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await db.close();
  vi.unstubAllEnvs();
});

describe('resumable Plaid work', () => {
  it('coalesces pending requests but processes the same webhook body again after completion', async () => {
    await enqueueWebhook(db, event);
    await enqueueWebhook(db, event);
    expect((await db.query('SELECT * FROM sync_jobs')).rows).toHaveLength(1);
    expect((await job()).generation).toBe(2);
    await processJob(db, regular());
    expect(await job()).toMatchObject({ status: 'done', generation: 2, completed_generation: 2 });
    await enqueueWebhook(db, event);
    expect((await job()).status).toBe('pending');
    await processJob(
      db,
      provider((path) =>
        path === '/accounts/get'
          ? { accounts: [account] }
          : page(null, 'new-final', { modified: [raw('posted', 25)] }),
      ),
    );
    expect((await getState(db, 'owner')).state.transactions).toMatchObject([{ amount: 2500 }]);
    expect(await job()).toMatchObject({ status: 'done', generation: 3, completed_generation: 3 });
    expect(await connection()).toMatchObject({
      cursor: 'new-final',
      status: 'healthy',
      historical_complete: true,
    });
  });

  it('resumes saved pages without partial ledger writes and retains notifications received mid-sync', async () => {
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const deadline = clock + 45000;
    const calls: string[] = [];
    const cursors: unknown[] = [];
    const p = provider((path, body) => {
      calls.push(path);
      if (path === '/accounts/get') return { accounts: [account] };
      cursors.push(body.cursor);
      if (body.cursor === 'original') {
        clock = deadline - 4000;
        return page('first', 'page-1', { has_more: true });
      }
      return body.cursor === 'page-1' ? page('second') : page(null);
    });
    await enqueueSync(db, 'c');
    await processJob(db, p, { deadline });
    expect((await getState(db, 'owner')).state.transactions).toHaveLength(0);
    expect((await connection()).cursor).toBe('original');
    expect(await job()).toMatchObject({
      status: 'pending',
      stage: { phase: 'transactions', batch: { cursor: 'page-1' } },
    });
    await enqueueWebhook(db, event);
    await processJob(db, p, { deadline: clock + 45000 });
    expect(cursors).toEqual(['original', 'page-1']);
    expect(calls.filter((path) => path === '/accounts/get')).toHaveLength(1);
    expect((await getState(db, 'owner')).state.transactions).toHaveLength(2);
    expect(await job()).toMatchObject({
      status: 'pending',
      generation: 2,
      completed_generation: 1,
      stage: null,
    });
    await processJob(db, p, { deadline: clock + 45000 });
    expect(cursors).toEqual(['original', 'page-1', 'final']);
    expect(await job()).toMatchObject({ status: 'done', completed_generation: 2 });
  });

  it('restarts a resumed mutation from the original cursor and discards the obsolete pages', async () => {
    let clock = Date.now(),
      first = true;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const deadline = clock + 45000;
    const cursors: unknown[] = [];
    const p = provider((path, body) => {
      if (path === '/accounts/get') return { accounts: [account] };
      cursors.push(body.cursor);
      if (first) {
        first = false;
        clock = deadline - 4000;
        return page('obsolete', 'half', { has_more: true });
      }
      if (body.cursor === 'half')
        throw new PlaidError('TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION');
      return page('replacement');
    });
    await enqueueSync(db, 'c');
    await processJob(db, p, { deadline });
    await processJob(db, p, { deadline: clock + 45000 });
    expect(cursors).toEqual(['original', 'half', 'original']);
    expect((await getState(db, 'owner')).state.transactions.map((t) => t.providerId)).toEqual([
      'replacement',
    ]);
    expect((await job()).status).toBe('done');
  });

  it('fences expired workers and resolves credentials only for the claimed owner', async () => {
    let started!: () => void, release!: (value: any) => void;
    const beginning = new Promise<void>((resolve) => (started = resolve));
    const gate = new Promise((resolve) => (release = resolve));
    const owners: string[] = [];
    const first = provider((path) => {
      if (path === '/accounts/get') return { accounts: [account] };
      started();
      return gate;
    });
    await enqueueSync(db, 'c');
    const running = processJob(db, async (owner) => {
      owners.push(owner);
      return first;
    });
    await beginning;
    const idleFactory = vi.fn(async () => regular());
    expect(await processJob(db, idleFactory)).toBe(false);
    expect(idleFactory).not.toHaveBeenCalled();
    await db.query(
      "UPDATE sync_jobs SET lease_until=now()-interval '1 second' WHERE connection_id='c'",
    );
    await processJob(db, async (owner) => {
      owners.push(owner);
      return regular('winner');
    });
    release(page('stale', 'stale-cursor'));
    await running;
    expect(owners).toEqual(['owner', 'owner']);
    expect((await connection()).cursor).toBe('final');
    expect((await getState(db, 'owner')).state.transactions.map((t) => t.providerId)).toEqual([
      'winner',
    ]);
    expect(await job()).toMatchObject({ status: 'done', stage: null, lease_token: null });
  });

  it('discards staged pages when selected accounts and the cursor change', async () => {
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const deadline = clock + 45000;
    await enqueueSync(db, 'c');
    await processJob(
      db,
      provider((path) => {
        if (path === '/accounts/get') return { accounts: [account] };
        clock = deadline - 4000;
        return page('obsolete', 'half', { has_more: true });
      }),
      { deadline },
    );
    await mutateState(db, 'owner', async (state, tx) => {
      await tx.query("UPDATE connections SET selected_accounts='[]',cursor=NULL WHERE id='c'");
      await invalidateSync(tx, 'c');
      await enqueueSync(tx, 'c');
      return state;
    });
    const cursors: unknown[] = [];
    await processJob(
      db,
      provider((path, body) => {
        if (path === '/accounts/get') return { accounts: [account] };
        cursors.push(body.cursor);
        return page('fresh');
      }),
      { deadline: clock + 45000 },
    );
    expect(cursors).toEqual([undefined]);
    const state = (await getState(db, 'owner')).state;
    expect(state.transactions.map((t) => t.providerId)).toEqual(['fresh']);
    expect(state.accounts[0].enabled).toBe(false);
  });

  it('preserves an Item error against an older in-flight sync and ignores disconnected Items', async () => {
    let started!: () => void, release!: (value: any) => void;
    const beginning = new Promise<void>((resolve) => (started = resolve));
    const gate = new Promise((resolve) => (release = resolve));
    await enqueueSync(db, 'c');
    const running = processJob(
      db,
      provider((path) => {
        if (path === '/accounts/get') return { accounts: [account] };
        started();
        return gate;
      }),
    );
    await beginning;
    const errorEvent = Buffer.from(
      JSON.stringify({
        item_id: 'item',
        webhook_type: 'ITEM',
        webhook_code: 'ERROR',
        error: { error_code: 'ITEM_LOGIN_REQUIRED' },
      }),
    );
    await enqueueWebhook(db, errorEvent);
    release(page('stale'));
    await running;
    expect((await connection()).status).toBe('reauthentication_required');
    expect((await job()).status).toBe('failed');
    expect((await getState(db, 'owner')).state.transactions).toHaveLength(0);
    await db.query("UPDATE connections SET status='disconnected' WHERE id='c'");
    await db.query("DELETE FROM sync_jobs WHERE connection_id='c'");
    await enqueueWebhook(db, errorEvent);
    await enqueueWebhook(db, event);
    expect((await connection()).status).toBe('disconnected');
    expect(await job()).toBeUndefined();
  });

  it('rolls back final cursor, ledger, and acknowledgment together when data validation fails', async () => {
    await enqueueSync(db, 'c');
    await processJob(
      db,
      provider((path) =>
        path === '/accounts/get'
          ? { accounts: [account] }
          : page(null, 'invalid-final', { added: [{ ...raw('bad'), date: 'invalid-date' }] }),
      ),
    );
    expect((await getState(db, 'owner')).state.transactions).toHaveLength(0);
    expect((await connection()).cursor).toBe('original');
    expect(await job()).toMatchObject({
      status: 'pending',
      completed_generation: 0,
      stage: { phase: 'commit' },
    });
  });

  it('backs off transient failures, stops permanent failures, and bounds abandoned leases', async () => {
    await enqueueSync(db, 'c');
    await processJob(
      db,
      provider(() => {
        throw new PlaidError('PROVIDER_UNAVAILABLE');
      }),
    );
    expect(await job()).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_error: 'PROVIDER_UNAVAILABLE',
    });
    expect(await processJob(db, regular())).toBe(false);
    await db.query("UPDATE sync_jobs SET available_at=now() WHERE connection_id='c'");
    await processJob(
      db,
      provider(() => {
        throw new PlaidError('ITEM_LOGIN_REQUIRED');
      }),
    );
    expect((await job()).status).toBe('failed');
    expect((await connection()).status).toBe('reauthentication_required');
    await enqueueSync(db, 'c');
    await db.query(
      "UPDATE sync_jobs SET status='processing',attempts=10,lease_until=now()-interval '1 second' WHERE connection_id='c'",
    );
    const factory = vi.fn(async () => regular());
    await processJob(db, factory);
    expect(factory).not.toHaveBeenCalled();
    expect(await job()).toMatchObject({ status: 'failed', last_error: 'SYNC_RETRY_EXHAUSTED' });
  });

  it('resumes investment activity pages while keeping holdings and activity atomic', async () => {
    await db.query("UPDATE connections SET product='investments' WHERE id='c'");
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const deadline = clock + 45000,
      offsets: number[] = [];
    const calls: string[] = [];
    const p = provider((path, body) => {
      calls.push(path);
      if (path === '/accounts/get') return { accounts: [{ ...account, type: 'investment' }] };
      if (path === '/investments/holdings/get')
        return {
          holdings: [
            { account_id: 'provider-a', security_id: 's', quantity: 2, institution_value: 10 },
          ],
          securities: [
            { security_id: 's', ticker_symbol: 'TEST', name: 'Test holding', type: 'equity' },
          ],
        };
      const offset = body.options.offset;
      offsets.push(offset);
      if (offset === 0) clock = deadline - 4000;
      return {
        investment_transactions: [
          {
            investment_transaction_id: `trade-${offset}`,
            account_id: 'provider-a',
            date: '2026-10-01',
            type: 'buy',
            amount: 5,
            name: 'Buy',
            security_id: 's',
            quantity: 1,
          },
        ],
        total_investment_transactions: 2,
      };
    });
    await enqueueSync(db, 'c');
    await processJob(db, p, { deadline });
    expect((await getState(db, 'owner')).state.holdings).toHaveLength(0);
    await processJob(db, p, { deadline: clock + 45000 });
    expect(offsets).toEqual([0, 1]);
    expect(calls.filter((path) => path === '/investments/holdings/get')).toHaveLength(1);
    const state = (await getState(db, 'owner')).state;
    expect(state.holdings).toHaveLength(1);
    expect(state.investmentActivity).toHaveLength(2);
    expect(state.transactions).toHaveLength(0);
    expect((await job()).status).toBe('done');
  });

  it('reconciles stale connections without duplicating already-pending work', async () => {
    await enqueueSync(db, 'c');
    await processJob(db, regular());
    await db.query("UPDATE connections SET last_synced_at=now()-interval '7 hours' WHERE id='c'");
    await db.query(
      "UPDATE sync_jobs SET updated_at=now()-interval '7 hours' WHERE connection_id='c'",
    );
    await enqueueStaleSyncs(db);
    await enqueueStaleSyncs(db);
    expect(await job()).toMatchObject({ status: 'pending', generation: 2 });
  });
});

describe('provider boundaries', () => {
  it('keeps the first successful reconnect when two Link sessions finish together', async () => {
    await db.query("UPDATE connections SET status='disconnected',encrypted_token='' WHERE id='c'");
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const revoked: string[] = [];
    const p = provider(async (path, body) => {
      if (path === '/item/public_token/exchange')
        return { access_token: `token-${body.public_token}`, item_id: `item-${body.public_token}` };
      if (path === '/item/get') return { item: { institution_id: 'institution' } };
      if (path === '/accounts/get') return { accounts: [account] };
      if (path === '/institutions/get_by_id') {
        if (++arrived === 2) release();
        await barrier;
        return { institution: { name: 'Sandbox', products: ['transactions'] } };
      }
      if (path === '/item/remove') {
        revoked.push(body.access_token);
        return {};
      }
      throw Error('Unexpected endpoint');
    });
    const results = await Promise.allSettled([
      exchangeLink(db, p, 'owner', 'one', 'transactions', []),
      exchangeLink(db, p, 'owner', 'two', 'transactions', []),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.reason.code).toBe('DUPLICATE_CONNECTION');
    const saved = await connection();
    expect(saved.status).toBe('initial_loading');
    expect(await job()).toMatchObject({ status: 'pending', generation: 1 });
    expect(revoked).toHaveLength(1);
    expect(revoked).not.toContain(decryptToken(saved.encrypted_token));
  });

  it('does not let an old disconnect clear a replacement Item or its imported data', async () => {
    let started!: () => void, release!: () => void;
    const removing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const p = provider(async (path) => {
      if (path !== '/item/remove') throw Error('Unexpected endpoint');
      started();
      await barrier;
      return {};
    });
    const pending = disconnect(db, p, 'owner', 'c', true);
    await removing;
    await db.query(
      "UPDATE connections SET item_id='replacement',encrypted_token=$1,status='initial_loading' WHERE id='c'",
      [encryptToken('replacement-token')],
    );
    await enqueueSync(db, 'c');
    const before = await getState(db, 'owner');
    release();
    await expect(pending).rejects.toMatchObject({ code: 'CONNECTION_CHANGED_RETRY', status: 409 });
    expect(await connection()).toMatchObject({ item_id: 'replacement', status: 'initial_loading' });
    expect(decryptToken((await connection()).encrypted_token)).toBe('replacement-token');
    expect(await job()).toMatchObject({ status: 'pending' });
    expect(await getState(db, 'owner')).toEqual(before);
  });

  it('does not retry one-use public-token exchange after an uncertain provider response', async () => {
    const fetcher = vi.fn().mockRejectedValue(Error('Response was lost'));
    vi.stubGlobal('fetch', fetcher);
    const p = new PlaidSandbox({
      clientId: 'owner-client',
      secret: 'owner-secret',
      environment: 'sandbox',
    });
    await expect(
      p.call('/item/public_token/exchange', { public_token: 'one-use' }),
    ).rejects.toThrow('PROVIDER_UNAVAILABLE');
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher
      .mockReset()
      .mockResolvedValue(
        new Response(JSON.stringify({ error_code: 'INTERNAL_SERVER_ERROR' }), { status: 500 }),
      );
    await expect(
      p.call('/item/public_token/exchange', { public_token: 'one-use' }),
    ).rejects.toThrow('INTERNAL_SERVER_ERROR');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('allows only configured HTTPS redirect origins and keeps native OAuth setup explicit', async () => {
    vi.stubEnv('APP_ORIGIN', 'https://asset.gtfol.dev');
    vi.stubEnv('PLAID_WEB_REDIRECT_URI', undefined);
    vi.stubEnv('PLAID_IOS_REDIRECT_URI', undefined);
    const p = provider((_path, body) => body);
    expect(await createLinkToken(db, p, 'owner', 'transactions')).not.toHaveProperty(
      'redirect_uri',
    );
    vi.stubEnv('PLAID_WEB_REDIRECT_URI', 'https://asset.gtfol.dev/plaid-return');
    expect(await createLinkToken(db, p, 'owner', 'transactions')).toHaveProperty(
      'redirect_uri',
      'https://asset.gtfol.dev/plaid-return',
    );
    vi.stubEnv('PLAID_WEB_REDIRECT_URI', 'https://asset.gtfol.dev.attacker.invalid/plaid-return');
    await expect(createLinkToken(db, p, 'owner', 'transactions')).rejects.toThrow(
      'INVALID_REDIRECT_URI',
    );
    vi.stubEnv('PLAID_WEB_REDIRECT_URI', 'http://asset.gtfol.dev/plaid-return');
    await expect(createLinkToken(db, p, 'owner', 'transactions')).rejects.toThrow(
      'INVALID_REDIRECT_URI',
    );
    await expect(createLinkToken(db, p, 'owner', 'transactions', undefined, 'ios')).rejects.toThrow(
      'IOS_REDIRECT_URI_REQUIRED',
    );
  });

  it('uses injected owner credentials and applies deadlines without losing the version guard', async () => {
    vi.stubEnv('PLAID_ENV', 'production');
    const requests: any[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    await new PlaidSandbox({
      clientId: 'owner-client',
      secret: 'owner-secret',
      environment: 'sandbox',
    }).call('/accounts/get', {});
    expect(requests).toEqual([{ client_id: 'owner-client', secret: 'owner-secret' }]);
    const guard = vi.fn(async () => {});
    const bounded = withPlaidDeadline(
      { call: async () => new Promise(() => {}), assertCurrent: guard },
      Date.now() + 5,
    );
    await bounded.assertCurrent!(db, 'owner');
    expect(guard).toHaveBeenCalledWith(db, 'owner');
    await expect(bounded.call('/accounts/get', {})).rejects.toThrow('SYNC_DEADLINE');
  });

  it('distinguishes unavailable verification keys from invalid webhook signatures', async () => {
    const { privateKey } = await generateKeyPair('ES256');
    const jwt = await new SignJWT({
      request_body_sha256: createHash('sha256').update(event).digest('hex'),
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'unavailable-worker-key' })
      .setIssuedAt()
      .sign(privateKey);
    const unavailable = provider(() => {
      throw new PlaidError('PROVIDER_UNAVAILABLE');
    });
    await expect(verifyWebhook(unavailable, event, jwt)).rejects.toThrow(
      'WEBHOOK_VERIFICATION_UNAVAILABLE',
    );
    expect(await verifyWebhook(unavailable, event, 'invalid')).toBe(false);
  });

  it('queues exchange atomically and revokes a rejected exchange even after its original deadline', async () => {
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const start = clock,
      calls: string[] = [];
    const p = provider((path) => {
      calls.push(path);
      if (path === '/item/public_token/exchange')
        return { access_token: 'new-token', item_id: 'new-item' };
      if (path === '/item/get') return { item: { institution_id: 'new-institution' } };
      if (path === '/accounts/get') return { accounts: [account] };
      if (path === '/institutions/get_by_id')
        return { institution: { name: 'New institution', products: ['transactions'] } };
      if (path === '/item/remove') return {};
      throw Error('Unexpected endpoint');
    });
    p.assertCurrent = async () => {
      clock = start + 45000;
      throw new PlaidError('PLAID_CREDENTIALS_CHANGED');
    };
    await expect(
      exchangeLink(db, withPlaidDeadline(p, start + 40000), 'owner', 'public', 'transactions', []),
    ).rejects.toThrow('PLAID_CREDENTIALS_CHANGED');
    expect(calls.at(-1)).toBe('/item/remove');
    expect(
      (await db.query("SELECT * FROM connections WHERE item_id='new-item'")).rows,
    ).toHaveLength(0);
    delete p.assertCurrent;
    const id = await exchangeLink(
      db,
      withPlaidDeadline(p, clock + 40000),
      'owner',
      'public',
      'transactions',
      [],
    );
    expect(
      (await db.query('SELECT * FROM sync_jobs WHERE connection_id=$1', [id])).rows[0].status,
    ).toBe('pending');
  });
});
