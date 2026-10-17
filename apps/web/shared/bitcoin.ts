import type { State } from './schema.js';

export const SATOSHIS_PER_BTC = 100_000_000;
export function bitcoinQuantity(satoshis: number) {
  return (satoshis / SATOSHIS_PER_BTC).toFixed(8);
}
export function bitcoinValue(satoshis: number, price: number): number {
  if (!Number.isSafeInteger(satoshis) || satoshis < 0 || !Number.isSafeInteger(price) || price <= 0)
    throw Error('Invalid Bitcoin valuation');
  const value = Number((BigInt(satoshis) * BigInt(price) + 50_000_000n) / 100_000_000n);
  if (!Number.isSafeInteger(value) || value > 100_000_000_000)
    throw Error('Bitcoin valuation exceeds the supported balance');
  return value;
}

export function revalueBitcoin(s: State, market: NonNullable<State['bitcoinMarket']>) {
  if (s.bitcoinMarket && Date.parse(s.bitcoinMarket.updatedAt) > Date.parse(market.updatedAt))
    market = s.bitcoinMarket;
  s.bitcoinMarket = market;
  for (const a of s.accounts.filter((a) => a.source === 'bitcoin' && a.bitcoin)) {
    const wallet = a.bitcoin!;
    // Pending transfers are disclosed separately; unconfirmed receipts never inflate net worth.
    a.balance = bitcoinValue(wallet.satoshis, market.price);
    a.updatedAt = market.updatedAt;
    const id = 'btc-' + a.id;
    const previous = s.holdings.find((h) => h.id === id);
    s.holdings = s.holdings.filter((h) => h.id !== id);
    s.holdings.push({
      id,
      accountId: a.id,
      symbol: 'BTC',
      name: 'Bitcoin',
      quantity: bitcoinQuantity(wallet.satoshis),
      price: market.price,
      marketValue: a.balance,
      costBasis: previous?.costBasis ?? null,
      currency: 'USD',
      priceAt: market.updatedAt,
      type: 'Cryptocurrency',
      source: 'bitcoin',
    });
    const date = market.updatedAt.slice(0, 10);
    // A quote update does not claim that a stale on-chain balance was observed today.
    if (wallet.syncedAt.slice(0, 10) === date) {
      s.snapshots = s.snapshots.filter((p) => p.accountId !== a.id || p.date !== date);
      s.snapshots.push({
        id: `btc-${a.id}-${date}`,
        accountId: a.id,
        date,
        balance: a.balance,
        currency: 'USD',
        source: 'bitcoin',
      });
    }
  }
  return s;
}
