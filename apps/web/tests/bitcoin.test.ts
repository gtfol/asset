import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { Response } from 'express';
import {
  bitcoinAddress,
  bitcoinMarket,
  walletHistory,
  PublicBitcoinProvider,
  type BitcoinProvider,
} from '../server/bitcoin';
import { bitcoinValue, revalueBitcoin } from '../shared/bitcoin';
import { applyCommand, netWorth, backup, validateState } from '../shared/core';
import { fixture } from './fixtures';
import { openDatabase, getState, type Database } from '../server/db';
import { newSession } from '../server/auth';
import { createApp } from '../server/app';

const address = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const market = {
  price: 10000000,
  updatedAt: '2026-10-17T12:00:00.000Z',
  history: [
    { date: '2026-10-14', price: 8000000 },
    { date: '2026-10-15', price: 9000000 },
    { date: '2026-10-16', price: 9500000 },
  ],
};
const provider = (): BitcoinProvider => ({
  quote: vi.fn(async () => ({ price: market.price, updatedAt: new Date().toISOString() })),
  prices: vi.fn(async () => market.history),
  address: vi.fn(async () => ({ satoshis: 150000000, pendingSatoshis: -1000, count: 2 })),
  transfers: vi.fn(async () => [
    { id: 'a'.repeat(64), date: '2026-10-17', delta: -50000000 },
    { id: 'b'.repeat(64), date: '2026-10-15', delta: 200000000 },
  ]),
});
describe('Bitcoin address and valuation', () => {
  it('validates mainnet checksums and rejects keys, phrases, testnet and URLs', () => {
    expect(bitcoinAddress(' ' + address + ' ')).toBe(address);
    expect(bitcoinAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe(
      '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
    );
    for (const input of [
      address.slice(0, -1) + 'U',
      'https://localhost/admin',
      'tb1qtest',
      'secret recovery phrase',
      'K' + '1'.repeat(51),
    ])
      expect(() => bitcoinAddress(input)).toThrow();
  });
  it('validates native SegWit and Taproot checksums from BIP 350', () => {
    for (const address of [
      'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4',
      'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',
      'bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs',
    ])
      expect(bitcoinAddress(address)).toBe(address.toLowerCase());
    for (const address of [
      'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd',
      'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh',
      'bc1pw5dgrnzv',
      'bc1gmk9yu',
    ])
      expect(() => bitcoinAddress(address)).toThrow();
  });
  it('rounds with exact satoshi arithmetic', () => {
    expect(bitcoinValue(1, 50000000)).toBe(1);
    expect(bitcoinValue(123456789, 8151287)).toBe(10063317);
    expect(() => bitcoinValue(-1, 100)).toThrow();
  });
  it('reconstructs historical quantities and excludes pending transfers', async () => {
    const data = await walletHistory(provider(), address, market);
    expect(data.history).toEqual([
      { date: '2026-10-14', balance: 0 },
      { date: '2026-10-15', balance: 18000000 },
      { date: '2026-10-16', balance: 19000000 },
      { date: '2026-10-17', balance: 15000000 },
    ]);
    expect(data.pendingSatoshis).toBe(-1000);
    expect(data.historyComplete).toBe(true);
  });
  it('does not backfill missing historical prices with the current price', async () => {
    const data = await walletHistory(provider(), address, {
      ...market,
      history: [market.history[0], market.history[2]],
    });
    expect(data.history.map((p) => p.date)).not.toContain('2026-10-15');
  });
  it('values Bitcoin bought six years ago using historical quantity and price', async () => {
    const p = provider();
    p.address = async () => ({ satoshis: 100000000, pendingSatoshis: 0, count: 1 });
    p.transfers = async () => [{ id: 'c'.repeat(64), date: '2020-10-17', delta: 100000000 }];
    const data = await walletHistory(p, address, {
      ...market,
      history: [
        { date: '2020-10-16', price: 1100000 },
        { date: '2020-10-17', price: 1150000 },
        { date: '2022-10-17', price: 1900000 },
        ...market.history,
      ],
    });
    expect(data.history.find((p) => p.date === '2020-10-16')?.balance).toBe(0);
    expect(data.history.find((p) => p.date === '2020-10-17')?.balance).toBe(1150000);
    expect(data.history.find((p) => p.date === '2022-10-17')?.balance).toBe(1900000);
  });
  it('rejects a chain change during paging and incomplete provider history', async () => {
    const p = provider();
    p.address = vi
      .fn()
      .mockResolvedValueOnce({ satoshis: 100, pendingSatoshis: 0, count: 2 })
      .mockResolvedValueOnce({ satoshis: 200, pendingSatoshis: 0, count: 3 });
    await expect(walletHistory(p, address, market)).rejects.toThrow('arrived during sync');
    const broken = provider();
    broken.transfers = async () => [];
    await expect(walletHistory(broken, address, market)).rejects.toThrow('incomplete');
  });
  it('pages busy addresses and marks truncated history as partial', async () => {
    const p = provider();
    p.address = async () => ({ satoshis: 100000000, pendingSatoshis: 0, count: 600 });
    let page = 0;
    p.transfers = async () =>
      Array.from({ length: 25 }, (_, i) => ({
        id: `${page}:${i}`,
        date: '2026-10-16',
        delta: 1,
      })).map((t, i) => {
        if (i === 24) page++;
        return t;
      });
    const data = await walletHistory(p, address, market);
    expect(page).toBe(20);
    expect(data.historyComplete).toBe(false);
    expect(data.historyStart).toBe('2026-10-16');
  });
  it('uses candles close, excludes current-day buckets and requests bounded ranges', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new globalThis.Response(
        JSON.stringify([
          [Date.parse('2026-10-16') / 1000, 1, 2, 3, 80000, 4],
          [Date.parse('2026-10-17') / 1000, 1, 2, 3, 90000, 4],
        ]),
        { status: 200 },
      ),
    );
    try {
      expect(await new PublicBitcoinProvider().prices('2026-10-16', '2026-10-17')).toEqual([
        { date: '2026-10-16', price: 8000000 },
      ]);
      expect(String(fetcher.mock.calls[0][0])).toContain('granularity=86400');
    } finally {
      fetcher.mockRestore();
    }
  });
});

describe('Bitcoin authenticated lifecycle', () => {
  let db: Database, server: Server, base: string, token: string, other: string;
  const p = provider();
  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', undefined);
    vi.stubEnv('VERCEL', undefined);
    db = await openDatabase(':memory:');
    for (const id of ['owner', 'other']) {
      await db.query('INSERT INTO users(id,email) VALUES($1,$2)', [id, `${id}@example.invalid`]);
      await db.query('INSERT INTO workspaces(owner_id,state) VALUES($1,$2)', [
        id,
        JSON.stringify(fixture()),
      ]);
    }
    token = await newSession(db, 'owner', { cookie() {} } as unknown as Response);
    other = await newSession(db, 'other', { cookie() {} } as unknown as Response);
    server = createApp(db, undefined, undefined, p).listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as any).port}/api/bitcoin`;
  }, 30000);
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    vi.unstubAllEnvs();
  });
  const request = (path: string, body = {}, auth = token) =>
    fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-asset-client': 'web',
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      },
      body: JSON.stringify(body),
    });
  it('loads the full price range once, then caches and extends closed daily prices', async () => {
    const prices = provider();
    prices.quote = vi.fn(async () => ({ price: market.price, updatedAt: market.updatedAt }));
    prices.prices = vi.fn(async () => market.history);
    await bitcoinMarket(db, prices, new Date(market.updatedAt));
    expect(prices.prices).toHaveBeenCalledWith('2015-01-01', '2026-10-17');
    await bitcoinMarket(db, prices, new Date('2026-10-17T12:00:30Z'));
    expect(prices.quote).toHaveBeenCalledTimes(1);
    prices.quote = vi.fn(async () => ({
      price: market.price,
      updatedAt: '2026-10-17T12:02:00.000Z',
    }));
    await bitcoinMarket(db, prices, new Date('2026-10-17T12:02:00Z'));
    expect(prices.prices).toHaveBeenCalledTimes(1);
    prices.quote = vi.fn(async () => ({
      price: market.price,
      updatedAt: '2026-10-18T12:00:00.000Z',
    }));
    prices.prices = vi.fn(async () => [{ date: '2026-10-17', price: 10000000 }]);
    const next = await bitcoinMarket(db, prices, new Date('2026-10-18T12:00:00Z'));
    expect(prices.prices).toHaveBeenCalledWith('2026-10-16', '2026-10-18');
    expect(next.history).toHaveLength(4);
    await db.query('DELETE FROM market_cache');
  });
  it('requires authentication, adds a wallet, blocks duplicates and isolates owners', async () => {
    expect((await request('/wallets', { name: 'Wallet', address }, '')).status).toBe(401);
    const added = await request('/wallets', { name: 'Wallet', address });
    expect(added.status).toBe(200);
    const { state } = await added.json();
    const wallet = state.accounts.find((a: any) => a.bitcoin);
    expect(wallet.balance).toBe(15000000);
    expect(state.transactions).toHaveLength(0);
    expect(netWorth(state).total).toBe(15100000);
    expect((await request('/wallets', { name: 'Duplicate', address })).status).toBe(400);
    expect((await request(`/wallets/${wallet.id}/sync`, {}, other)).status).toBe(404);
    expect((await getState(db, 'other')).state.accounts).toHaveLength(1);
    expect(() =>
      applyCommand(state, { type: 'account.save', payload: { ...wallet, balance: 1 } }),
    ).not.toThrow();
    expect(
      applyCommand(state, {
        type: 'account.save',
        payload: { ...wallet, balance: 1 },
      }).accounts.find((a) => a.id === wallet.id)?.balance,
    ).toBe(15000000);
    const holding = state.holdings.find((h: any) => h.accountId === wallet.id);
    expect(() =>
      applyCommand(state, { type: 'holding.save', payload: { ...holding, source: 'manual' } }),
    ).toThrow();
    expect(
      validateState(backup(state).state).accounts.find((a) => a.id === wallet.id)?.bitcoin?.address,
    ).toBe(address);
    const stopped = applyCommand(state, { type: 'bitcoin.disconnect', payload: { id: wallet.id } });
    expect(stopped.accounts.find((a) => a.id === wallet.id)?.source).toBe('manual');
    expect(netWorth(stopped).total).toBe(netWorth(state).total);
    const copy = structuredClone(state);
    revalueBitcoin(copy, { ...market, updatedAt: '2000-01-01T00:00:00.000Z', price: 1 });
    expect(copy.accounts.find((a: any) => a.id === wallet.id)?.balance).toBe(wallet.balance);
  });
});
