import { createHash, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { bitcoinMarketSchema, type Account, type State } from '../shared/schema.js';
import { bitcoinValue, revalueBitcoin } from '../shared/bitcoin.js';
import { getState, mutateState, type Database } from './db.js';

const DAY = 86400000;
// Coinbase's BTC-USD market began in 2015. Missing earlier market prices remain unavailable.
const MARKET_START = '2015-01-01';
type Market = NonNullable<State['bitcoinMarket']>;
type AddressInfo = { satoshis: number; pendingSatoshis: number; count: number };
type Transfer = { id: string; date: string; delta: number };
export interface BitcoinProvider {
  quote(): Promise<{ price: number; updatedAt: string }>;
  prices(start: string, end: string): Promise<Market['history']>;
  address(address: string): Promise<AddressInfo>;
  transfers(address: string, after?: string): Promise<Transfer[]>;
}

// Reject private keys, seed phrases, testnet addresses, and mistyped checksums before any request.
export function bitcoinAddress(input: string): string {
  const address = input.trim();
  if (/^(bc1|BC1)/.test(address)) {
    if (address !== address.toLowerCase() && address !== address.toUpperCase())
      throw Error('Bitcoin addresses cannot mix upper and lower case');
    const a = address.toLowerCase();
    const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    const data = [...a.slice(3)].map((c) => alphabet.indexOf(c));
    const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let check = 1;
    for (const v of [3, 3, 0, 2, 3, ...data]) {
      const top = check >>> 25;
      check = ((check & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) if ((top >>> i) & 1) check ^= generators[i];
    }
    const version = data[0];
    let bits = 0,
      accumulator = 0;
    const program: number[] = [];
    for (const v of data.slice(1, -6)) {
      accumulator = ((accumulator << 5) | v) & 0xffff;
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        program.push((accumulator >>> bits) & 255);
      }
    }
    if (
      a.length > 90 ||
      data.length < 7 ||
      data.some((v) => v < 0) ||
      version > 16 ||
      check >>> 0 !== (version === 0 ? 1 : 0x2bc830a3) ||
      bits >= 5 ||
      ((accumulator << (8 - bits)) & 255) !== 0 ||
      program.length < 2 ||
      program.length > 40 ||
      (version === 0 && ![20, 32].includes(program.length))
    )
      throw Error('Enter a valid Bitcoin mainnet public address');
    return a;
  }
  if (!/^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(address))
    throw Error('Enter a Bitcoin mainnet public address, never a private key or recovery phrase');
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const c of address) n = n * 58n + BigInt(alphabet.indexOf(c));
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const bytes = Buffer.concat([
    Buffer.alloc(address.match(/^1*/)?.[0].length ?? 0),
    Buffer.from(hex, 'hex'),
  ]);
  const hash = (b: Buffer) => createHash('sha256').update(b).digest();
  if (
    bytes.length !== 25 ||
    ![0, 5].includes(bytes[0]) ||
    !hash(hash(bytes.subarray(0, 21)))
      .subarray(0, 4)
      .equals(bytes.subarray(21))
  )
    throw Error('Bitcoin address checksum is invalid');
  return address;
}

const safeInteger = z.number().int().safe().nonnegative();
export class PublicBitcoinProvider implements BitcoinProvider {
  constructor(private deadline = Date.now() + 40000) {}
  private async json(url: string): Promise<any> {
    const remaining = Math.min(10000, this.deadline - Date.now());
    if (remaining <= 0)
      throw Error('Bitcoin sync timed out. Saved balances are unchanged; try again.');
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(remaining),
        redirect: 'error',
        headers: { accept: 'application/json', 'user-agent': 'Asset/1.0' },
      });
      if (!res.ok) throw Error('provider');
      return await res.json();
    } catch {
      throw Error(
        'Bitcoin data is temporarily unavailable. Saved values are unchanged; try again.',
      );
    }
  }
  async quote() {
    const q = z
      .object({ price: z.string(), time: z.string().datetime() })
      .parse(await this.json('https://api.exchange.coinbase.com/products/BTC-USD/ticker'));
    const price = Math.round(Number(q.price) * 100);
    if (
      !Number.isSafeInteger(price) ||
      price <= 0 ||
      Math.abs(Date.now() - Date.parse(q.time)) > 15 * 60000
    )
      throw Error('Bitcoin price is stale or unavailable');
    return { price, updatedAt: q.time };
  }
  async prices(start: string, end: string) {
    const history: Market['history'] = [];
    for (let from = Date.parse(start); from < Date.parse(end); from += 290 * DAY) {
      const to = Math.min(from + 290 * DAY, Date.parse(end));
      const params = new URLSearchParams({
        granularity: '86400',
        start: new Date(from).toISOString(),
        end: new Date(to).toISOString(),
      });
      const rows = z
        .array(z.array(z.number().finite()).min(6))
        .parse(
          await this.json(`https://api.exchange.coinbase.com/products/BTC-USD/candles?${params}`),
        );
      for (const row of rows) {
        const date = new Date(row[0] * 1000).toISOString().slice(0, 10);
        const price = Math.round(row[4] * 100);
        if (date >= start && date < end && price > 0 && Number.isSafeInteger(price))
          history.push({ date, price });
      }
    }
    return [...new Map(history.map((p) => [p.date, p])).values()].sort((a, b) =>
      a.date.localeCompare(b.date),
    );
  }
  async address(address: string) {
    const stats = z.object({
      funded_txo_sum: safeInteger,
      spent_txo_sum: safeInteger,
      tx_count: safeInteger,
    });
    const r = z
      .object({ chain_stats: stats, mempool_stats: stats })
      .parse(
        await this.json(`https://blockstream.info/api/address/${encodeURIComponent(address)}`),
      );
    const satoshis = r.chain_stats.funded_txo_sum - r.chain_stats.spent_txo_sum;
    if (satoshis < 0) throw Error('Bitcoin balance is inconsistent; try again');
    return {
      satoshis,
      pendingSatoshis: r.mempool_stats.funded_txo_sum - r.mempool_stats.spent_txo_sum,
      count: r.chain_stats.tx_count,
    };
  }
  async transfers(address: string, after?: string) {
    if (after && !/^[a-f0-9]{64}$/.test(after)) throw Error('Invalid Bitcoin history cursor');
    const output = z.object({ scriptpubkey_address: z.string().optional(), value: safeInteger });
    const rows = z
      .array(
        z.object({
          txid: z.string().regex(/^[a-f0-9]{64}$/),
          status: z.object({ confirmed: z.literal(true), block_time: safeInteger }),
          vin: z.array(z.object({ prevout: output.nullable() })),
          vout: z.array(output),
        }),
      )
      .max(25)
      .parse(
        await this.json(
          `https://blockstream.info/api/address/${encodeURIComponent(address)}/txs/chain${after ? '/' + after : ''}`,
        ),
      );
    return rows.map((tx) => ({
      id: tx.txid,
      date: new Date(tx.status.block_time * 1000).toISOString().slice(0, 10),
      delta:
        tx.vout.reduce((n, o) => n + (o.scriptpubkey_address === address ? o.value : 0), 0) -
        tx.vin.reduce(
          (n, i) => n + (i.prevout?.scriptpubkey_address === address ? i.prevout.value : 0),
          0,
        ),
    }));
  }
}

export async function bitcoinMarket(
  db: Database,
  provider: BitcoinProvider,
  now = new Date(),
): Promise<Market> {
  const cached = (
    await db.query<{ payload: Market }>('SELECT payload FROM market_cache WHERE key=$1', [
      'BTC-USD',
    ])
  ).rows[0]?.payload;
  const current = bitcoinMarketSchema.safeParse(cached);
  const day = now.toISOString().slice(0, 10);
  if (
    current.success &&
    +now - Date.parse(current.data.updatedAt) < 60000 &&
    +now >= Date.parse(current.data.updatedAt)
  )
    return current.data;
  const quote = await provider.quote();
  const from = current.success ? (current.data.history.at(-1)?.date ?? MARKET_START) : MARKET_START;
  // Closed daily candles are fetched once per UTC day and shared across users.
  const history =
    current.success &&
    current.data.history.at(-1)?.date === new Date(Date.parse(day) - DAY).toISOString().slice(0, 10)
      ? current.data.history
      : [
          ...new Map(
            [
              ...(current.success ? current.data.history : []),
              ...(await provider.prices(from, day)),
            ].map((p) => [p.date, p]),
          ).values(),
        ].sort((a, b) => a.date.localeCompare(b.date));
  const market = bitcoinMarketSchema.parse({ ...quote, history });
  await db.query(
    `INSERT INTO market_cache(key,payload) VALUES($1,$2)
    ON CONFLICT(key) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()
    WHERE (market_cache.payload->>'updatedAt')::timestamptz <= (EXCLUDED.payload->>'updatedAt')::timestamptz`,
    ['BTC-USD', JSON.stringify(market)],
  );
  return market;
}

export async function walletHistory(provider: BitcoinProvider, address: string, market: Market) {
  const before = await provider.address(address);
  const start = market.history[0]?.date ?? market.updatedAt.slice(0, 10);
  const transfers: Transfer[] = [];
  let after: string | undefined,
    complete = before.count === 0;
  const seen = new Set<string>();
  // Bound provider work. Large addresses retain explicitly partial history, never invented balances.
  for (let page = 0; !complete && page < 20; page++) {
    const rows = await provider.transfers(address, after);
    if (new Set(rows.map((t) => t.id)).size !== rows.length || rows.some((t) => seen.has(t.id)))
      throw Error('Bitcoin history changed during sync; try again');
    rows.forEach((t) => seen.add(t.id));
    transfers.push(...rows);
    if (
      (rows.length < 25 || transfers.length >= before.count) &&
      transfers.length !== before.count &&
      (!rows.length || rows.at(-1)!.date >= start)
    )
      throw Error('Bitcoin transaction history is incomplete; try again');
    if (rows.length < 25 || transfers.length >= before.count || rows.at(-1)!.date < start)
      complete = true;
    if (!rows.length) break;
    after = rows.at(-1)!.id;
  }
  const afterInfo = await provider.address(address);
  if (before.satoshis !== afterInfo.satoshis || before.count !== afterInfo.count)
    throw Error(
      'A Bitcoin transaction arrived during sync. Try again to update the balance and history together.',
    );
  const cutoff = complete ? start : transfers.at(-1)!.date;
  const daily = new Map<string, number>();
  for (const t of transfers) daily.set(t.date, (daily.get(t.date) ?? 0) + t.delta);
  let balance = before.satoshis;
  const today = market.updatedAt.slice(0, 10);
  const prices = new Map(market.history.map((p) => [p.date, p.price]));
  const history: { date: string; balance: number }[] = [];
  for (let time = Date.parse(today); time >= Date.parse(cutoff); time -= DAY) {
    const date = new Date(time).toISOString().slice(0, 10);
    if (balance < 0 || !Number.isSafeInteger(balance))
      throw Error('Bitcoin history is inconsistent; try again');
    const price = date === today ? market.price : prices.get(date);
    if (price !== undefined) history.push({ date, balance: bitcoinValue(balance, price) });
    // End-of-day balances, using transfers on their UTC confirmation date.
    balance -= daily.get(date) ?? 0;
  }
  return {
    ...afterInfo,
    history: history.reverse(),
    historyStart: cutoff,
    historyComplete: complete,
  };
}

export function bitcoinRoutes(db: Database, supplied?: BitcoinProvider) {
  const router = Router();
  const active = new Set<string>();
  const attempts = new Map<string, { count: number; until: number }>();
  router.use(async (_req, res, next) => {
    try {
      const now = Date.now();
      for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
      const owner: string = res.locals.owner;
      const attempt = attempts.get(owner) ?? { count: 0, until: now + 60000 };
      if (++attempt.count > 30) {
        res.status(429).json({ error: 'Please wait a minute before requesting more Bitcoin data' });
        return;
      }
      attempts.set(owner, attempt);
      const { state } = await getState(db, res.locals.owner);
      if (state.settings.demo) throw Error('Sign in to track a real Bitcoin address');
      next();
    } catch (e) {
      next(e);
    }
  });
  router.post('/wallets', async (req, res) => {
    const { name, address: input } = z
      .object({ name: z.string().trim().min(1).max(100), address: z.string().max(100) })
      .parse(req.body);
    const address = bitcoinAddress(input);
    const { state } = await getState(db, res.locals.owner);
    if (state.accounts.some((a) => a.bitcoin?.address === address))
      throw Error('This Bitcoin address is already tracked');
    if (state.accounts.filter((a) => a.bitcoin).length >= 20)
      throw Error('Track up to 20 Bitcoin addresses per workspace');
    const provider = supplied ?? new PublicBitcoinProvider();
    const market = await bitcoinMarket(db, provider);
    const data = await walletHistory(provider, address, market);
    const id = randomUUID();
    const result = await mutateState(db, res.locals.owner, (s) => {
      const account: Account = {
        id,
        name,
        type: 'investment',
        currency: 'USD',
        balance: null,
        source: 'bitcoin',
        enabled: true,
        includeInNetWorth: true,
        updatedAt: market.updatedAt,
        coverageComplete: false,
        bitcoin: {
          address,
          satoshis: data.satoshis,
          pendingSatoshis: data.pendingSatoshis,
          syncedAt: new Date().toISOString(),
          historyStart: data.historyStart,
          historyComplete: data.historyComplete,
        },
      };
      s.accounts.push(account);
      s.snapshots.push(
        ...data.history.map((p) => ({
          ...p,
          id: `btc-${id}-${p.date}`,
          accountId: id,
          currency: 'USD',
          source: 'bitcoin' as const,
        })),
      );
      return revalueBitcoin(s, market);
    });
    res.json(result);
  });
  router.post('/refresh', async (_req, res) => {
    const { state } = await getState(db, res.locals.owner);
    if (!state.accounts.some((a) => a.bitcoin)) {
      res.json(await getState(db, res.locals.owner));
      return;
    }
    const market = await bitcoinMarket(db, supplied ?? new PublicBitcoinProvider());
    if (state.bitcoinMarket?.updatedAt === market.updatedAt) {
      res.json(await getState(db, res.locals.owner));
      return;
    }
    res.json(await mutateState(db, res.locals.owner, (s) => revalueBitcoin(s, market)));
  });
  router.post('/wallets/:id/sync', async (req, res) => {
    const owner: string = res.locals.owner;
    const key = owner + ':' + req.params.id;
    if (active.has(key)) {
      res.status(409).json({ error: 'Bitcoin sync is already running' });
      return;
    }
    active.add(key);
    try {
      const { state } = await getState(db, owner);
      const a = state.accounts.find((a) => a.id === req.params.id && a.source === 'bitcoin');
      if (!a?.bitcoin) {
        res.status(404).json({ error: 'Bitcoin address not found' });
        return;
      }
      if (Date.now() - Date.parse(a.bitcoin.syncedAt) < 60000) {
        res.json(await getState(db, owner));
        return;
      }
      const provider = supplied ?? new PublicBitcoinProvider();
      const market = await bitcoinMarket(db, provider);
      const data = await walletHistory(provider, bitcoinAddress(a.bitcoin.address), market);
      res.json(
        await mutateState(db, owner, (s) => {
          const current = s.accounts.find((x) => x.id === a.id && x.source === 'bitcoin');
          if (!current?.bitcoin || current.bitcoin.address !== a.bitcoin!.address)
            throw Error('This Bitcoin address is no longer tracked');
          if (Date.parse(current.bitcoin.syncedAt) > Date.parse(a.bitcoin!.syncedAt)) return s;
          current.bitcoin = {
            ...current.bitcoin,
            satoshis: data.satoshis,
            pendingSatoshis: data.pendingSatoshis,
            syncedAt: new Date().toISOString(),
            historyStart: data.historyStart,
            historyComplete: data.historyComplete,
          };
          const from = data.history[0]?.date;
          s.snapshots = s.snapshots.filter((p) => p.accountId !== a.id || !from || p.date < from);
          s.snapshots.push(
            ...data.history.map((p) => ({
              ...p,
              id: `btc-${a.id}-${p.date}`,
              accountId: a.id,
              currency: 'USD',
              source: 'bitcoin' as const,
            })),
          );
          return revalueBitcoin(s, market);
        }),
      );
    } finally {
      active.delete(key);
    }
  });
  return router;
}
