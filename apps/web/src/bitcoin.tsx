import React, { useState } from 'react';
import { bitcoinQuantity, money, today, type Account, type State } from '../shared/core';
import { LineChart, RangeControl, filterHistory, Modal } from './components';

export type BitcoinRequest = (path: string, body?: unknown) => Promise<void>;
export function BitcoinAdd({
  onRequest,
  onClose,
}: {
  onRequest: BitcoinRequest;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal title="Track a Bitcoin address" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          const data = new FormData(e.currentTarget);
          setBusy(true);
          setError('');
          try {
            await onRequest('/bitcoin/wallets', {
              name: data.get('name'),
              address: data.get('address'),
            });
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Name
          <input
            name="name"
            required
            maxLength={100}
            placeholder="Bitcoin savings"
            disabled={busy}
          />
        </label>
        <label>
          Public Bitcoin address
          <input
            name="address"
            required
            maxLength={90}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            placeholder="1…, 3…, or bc1…"
          />
        </label>
        <p className="tiny muted">
          Read-only tracking. Never enter a private key or recovery phrase. A wallet may use several
          receiving and change addresses; add each address you want included.
        </p>
        <p className="tiny muted">
          The public address is sent to Blockstream to retrieve its balance and history. USD prices
          come from Coinbase. No Plaid connection is used.
        </p>
        {error && (
          <p className="negative" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Loading balance and history…' : 'Track address'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function BitcoinDetail({
  account,
  state,
  onRequest,
  stop,
}: {
  account: Account;
  state: State;
  onRequest: BitcoinRequest;
  stop: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [range, setRange] = useState('1Y');
  const wallet = account.bitcoin!,
    market = state.bitcoinMarket;
  const stale = !market || Date.now() - Date.parse(market.updatedAt) > 15 * 60000;
  async function refresh() {
    setBusy(true);
    setError('');
    try {
      await onRequest(`/bitcoin/wallets/${account.id}/sync`);
      await onRequest('/bitcoin/refresh');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="divider" />
      <h3>Bitcoin address</h3>
      <p className="tiny wallet-address">{wallet.address}</p>
      <dl className="metrics">
        <dt>Confirmed balance</dt>
        <dd>{bitcoinQuantity(wallet.satoshis)} BTC</dd>
        <dt>Pending change</dt>
        <dd>
          {wallet.pendingSatoshis > 0 ? '+' : ''}
          {bitcoinQuantity(wallet.pendingSatoshis)} BTC
        </dd>
        <dt>BTC / USD</dt>
        <dd>{money(market?.price ?? null)}</dd>
      </dl>
      {stale && (
        <p className="negative tiny" role="status">
          Saved price is out of date. Refresh to update the valuation.
        </p>
      )}
      <p className="tiny muted">
        Balance checked {new Date(wallet.syncedAt).toLocaleString()}. Pending transfers are excluded
        from net worth.
      </p>
      <button className="border-button full" disabled={busy} onClick={() => void refresh()}>
        {busy ? 'Refreshing…' : 'Refresh Bitcoin'}
      </button>
      {error && (
        <p className="negative tiny" role="alert">
          {error}
        </p>
      )}
      <h3>Bitcoin price history</h3>
      <LineChart
        compact
        currency="USD"
        points={filterHistory(market?.history ?? [], range, today()).map((p) => ({
          date: p.date,
          value: p.price,
        }))}
        label="Bitcoin USD daily closing price"
      />
      <RangeControl value={range} onChange={setRange} />
      <p className="tiny muted">
        Coinbase daily closes in UTC, including available history back to 2015. Latest quote:{' '}
        {market ? new Date(market.updatedAt).toLocaleString() : 'unavailable'}. Prices refresh every
        minute while Asset is open; balances every five minutes.
      </p>
      <p className="tiny muted">
        Wallet history uses the confirmed BTC held on each date, not today’s quantity.{' '}
        {wallet.historyComplete
          ? 'Loaded history starts '
          : 'This address has extensive activity; partial history starts '}
        {wallet.historyStart}. Missing prices are omitted. Price changes are not spending or income.
        A transfer does not establish your purchase cost.
      </p>
      <button
        className="text-button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await stop();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        Stop tracking and keep saved balances
      </button>
    </>
  );
}
