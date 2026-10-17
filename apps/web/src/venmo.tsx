import React, { useEffect, useRef, useState } from 'react';
import { api } from './App';
import { money, type State } from '../shared/core';
import type { VenmoReceipt } from '../shared/venmo';

type Route = {
  id: string;
  accountId: string;
  sourceEmail: string;
  address: string | null;
  active: boolean;
  verificationCode: string | null;
  lastReceivedAt: string | null;
};
type Receipt = {
  id: string;
  routeId: string;
  status: string;
  reason?: string;
  subject?: string;
  text?: string;
  receipt?: VenmoReceipt;
  createdAt: string;
};
type Inbox = { configured: boolean; routes: Route[]; receipts: Receipt[] };

export function VenmoConnection({
  state,
  sessionId,
  load,
}: {
  state: State;
  sessionId: string;
  load: () => Promise<void>;
}) {
  const [data, setData] = useState<Inbox>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [email, setEmail] = useState('');
  const [account, setAccount] = useState(
    () =>
      state.accounts.find((a) => /venmo/i.test(a.name) && ['csv', 'manual'].includes(a.source))
        ?.id ?? '',
  );
  const [transfers, setTransfers] = useState(true);
  const current = useRef({ sessionId, active: true });
  current.current.sessionId = sessionId;
  useEffect(() => {
    current.current.active = true;
    let cancelled = false;
    setData(undefined);
    if (!state.settings.demo)
      api('/venmo', undefined, 'GET', sessionId)
        .then((r) => {
          if (!cancelled) setData(r);
        })
        .catch((e) => {
          if (!cancelled) setError(e.message);
        });
    return () => {
      cancelled = true;
      current.current.active = false;
    };
  }, [sessionId, state.settings.demo]);
  async function perform(path?: string, body?: unknown) {
    if (busy) return;
    const session = sessionId;
    const active = () => current.current.active && current.current.sessionId === session;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (path) await api('/venmo' + (path === '/' ? '' : path), body, 'POST', session);
      if (!active()) return;
      const next = await api('/venmo', undefined, 'GET', session);
      if (!active()) return;
      setData(next);
      if (path === '/') setAccount('');
      if (path) {
        await load();
        if (active()) setNotice('Saved.');
      }
    } catch (e) {
      if (active()) setError((e as Error).message);
    } finally {
      if (active()) setBusy(false);
    }
  }
  const accounts = state.accounts.filter(
    (a) =>
      a.type === 'checking' &&
      a.currency === 'USD' &&
      ['manual', 'csv', 'venmo'].includes(a.source) &&
      !data?.routes.some((r) => r.active && r.accountId === a.id),
  );
  return (
    <section className="connection-card">
      <h3>Venmo</h3>
      <p className="muted">
        Forward payment receipts to track Venmo payments and reimbursements. No Venmo password or
        inbox access needed.
      </p>
      {state.settings.demo ? (
        <p className="muted">Sign in to connect Venmo.</p>
      ) : (
        <>
          {data && !data.configured && (
            <p className="muted">
              Email receiving is being set up. Your imported Venmo history is available in
              Transactions.
            </p>
          )}
          {data?.configured && (
            <>
              {data.routes.map((r) => (
                <div className="venmo-route" key={r.id}>
                  <h4>
                    {state.accounts.find((a) => a.id === r.accountId)?.name ?? 'Venmo'} ·{' '}
                    {r.active ? 'Forwarding enabled' : 'Paused'}
                  </h4>
                  <p className="tiny muted">
                    Receipts for {r.sourceEmail} · Last received{' '}
                    {r.lastReceivedAt ? new Date(r.lastReceivedAt).toLocaleString() : 'not yet'}
                  </p>
                  {r.address && (
                    <>
                      <label>
                        Forwarding address
                        <input readOnly value={r.address} onFocus={(e) => e.target.select()} />
                      </label>
                      <button
                        disabled={busy}
                        onClick={() => {
                          void navigator.clipboard
                            .writeText(r.address!)
                            .then(() => setNotice('Address copied.'))
                            .catch(() => setError('Select and copy the address above.'));
                        }}
                      >
                        Copy address
                      </button>
                      <ol className="venmo-steps">
                        <li>
                          In Gmail settings, open Forwarding and POP/IMAP and add this forwarding
                          address.
                        </li>
                        <li>
                          Return here and select Refresh. Enter the confirmation code in Gmail.
                        </li>
                        <li>
                          Create a Gmail filter for mail from <strong>venmo@venmo.com</strong> and
                          forward matching messages to this address. Leave forwarding for all other
                          mail off.
                        </li>
                      </ol>
                      {r.verificationCode && (
                        <p role="status">
                          Gmail confirmation code: <strong>{r.verificationCode}</strong>
                        </p>
                      )}
                      <p className="tiny muted">
                        Other email providers can use a forwarding rule for the same sender. You can
                        manually forward older receipts from {r.sourceEmail}; they appear below for
                        review.
                      </p>
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() => void perform(`/${r.id}/pause`, {})}
                      >
                        Pause receipt forwarding
                      </button>
                    </>
                  )}
                </div>
              ))}
              <details open={!data.routes.some((r) => r.active)}>
                <summary>
                  {data.routes.length
                    ? 'Add or reconnect a Venmo account'
                    : 'Set up receipt forwarding'}
                </summary>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void perform('/', {
                      ...(account ? { accountId: account } : {}),
                      sourceEmail: email,
                      bankTransfers: transfers,
                    });
                  }}
                >
                  <label>
                    Email that receives your Venmo receipts
                    <input
                      type="email"
                      autoComplete="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </label>
                  <label>
                    Save payments to
                    <select value={account} onChange={(e) => setAccount(e.target.value)}>
                      <option value="">New Venmo account</option>
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={transfers}
                      onChange={(e) => setTransfers(e.target.checked)}
                    />
                    Treat Venmo bank funding and cash-outs as transfers
                  </label>
                  <p className="tiny muted">
                    This also updates matching bank entries already imported through Plaid. Your own
                    transaction classifications are preserved.
                  </p>
                  <button className="primary" disabled={busy}>
                    Create forwarding address
                  </button>
                </form>
              </details>
              <p className="tiny muted">
                Receipt forwarding does not sync your Venmo balance. Incoming payments start as
                reimbursements; change them to income when appropriate.
              </p>
            </>
          )}
          {data && (
            <button className="text-button" disabled={busy} onClick={() => void perform()}>
              Refresh Venmo
            </button>
          )}
          {data?.receipts
            .filter((r) => r.status === 'review')
            .map((r) => (
              <ReceiptReview
                key={r.id}
                receipt={r}
                state={state}
                accountId={data.routes.find((v) => v.id === r.routeId)?.accountId}
                busy={busy}
                perform={perform}
              />
            ))}
          {!!data?.receipts.filter((r) => r.status !== 'review').length && (
            <details>
              <summary>Recent receipts</summary>
              {data.receipts
                .filter((r) => r.status !== 'review')
                .map((r) => (
                  <p className="tiny muted" key={r.id}>
                    {new Date(r.createdAt).toLocaleString()} ·{' '}
                    {r.status === 'duplicate'
                      ? 'Matched existing transaction'
                      : r.status === 'imported'
                        ? 'Imported'
                        : 'Ignored'}
                  </p>
                ))}
            </details>
          )}
        </>
      )}
      {busy && (
        <p role="status" className="muted">
          Saving…
        </p>
      )}
      {notice && (
        <p role="status" className="muted">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </section>
  );
}

function ReceiptReview({
  receipt: r,
  state,
  accountId,
  busy,
  perform,
}: {
  receipt: Receipt;
  state: State;
  accountId?: string;
  busy: boolean;
  perform: (path?: string, body?: unknown) => Promise<void>;
}) {
  const [date, setDate] = useState(r.receipt?.date ?? '');
  const [amount, setAmount] = useState(r.receipt ? (r.receipt.amount / 100).toFixed(2) : '');
  const candidates = state.transactions.filter(
    (t) =>
      !t.removed &&
      !t.providerId &&
      ['manual', 'csv'].includes(t.source) &&
      t.accountId === accountId &&
      t.date === date &&
      t.amount === Math.round(Number(amount) * 100),
  );
  return (
    <details className="venmo-review">
      <summary>{r.subject ?? 'Receipt'} · Review needed</summary>
      <p className="muted">{r.reason}</p>
      {r.text ? (
        <>
          <pre className="venmo-preview">{r.text}</pre>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void perform(`/receipts/${r.id}/confirm`, {
                receipt: {
                  receiptId: String(f.get('receiptId') || `email:${r.id}`),
                  date,
                  amount: Math.round(Number(amount) * 100),
                  name: f.get('name'),
                  kind: f.get('kind'),
                  categoryId: f.get('categoryId'),
                  notes: f.get('notes'),
                },
                ...(f.get('existingId') ? { existingId: f.get('existingId') } : {}),
              });
            }}
          >
            <label>
              Person or merchant
              <input name="name" required maxLength={160} defaultValue={r.receipt?.name} />
            </label>
            <div className="form-grid">
              <label>
                Payment date
                <input
                  type="date"
                  required
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </label>
              <label>
                Amount (USD)
                <input
                  type="number"
                  inputMode="decimal"
                  min="0.01"
                  step="0.01"
                  required
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </label>
            </div>
            <label>
              Type
              <select name="kind" defaultValue={r.receipt?.kind ?? 'spending'}>
                <option value="spending">Payment sent</option>
                <option value="refund">Reimbursement received</option>
                <option value="income">Income received</option>
                <option value="transfer">Transfer</option>
              </select>
            </label>
            <label>
              Category
              <select name="categoryId" defaultValue={r.receipt?.categoryId ?? 'other'}>
                {state.categories
                  .filter((c) => !c.archived)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Note
              <textarea name="notes" maxLength={5000} defaultValue={r.receipt?.notes} />
            </label>
            <label>
              Venmo transaction ID (if shown)
              <input name="receiptId" maxLength={100} defaultValue={r.receipt?.receiptId} />
            </label>
            <label>
              Existing imported payment
              <select name="existingId" key={`${date}:${amount}`}>
                <option value="">Check automatically or add a new payment</option>
                {candidates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.edits.name ?? t.name} · {money(t.amount)}
                  </option>
                ))}
              </select>
            </label>
            <button disabled={busy} className="primary">
              Confirm payment
            </button>
          </form>
        </>
      ) : (
        <p className="muted">
          The receipt preview has expired. You can add the payment manually in Transactions.
        </p>
      )}
      <button
        disabled={busy}
        className="text-button"
        onClick={() => void perform(`/receipts/${r.id}/ignore`, {})}
      >
        Ignore receipt
      </button>
    </details>
  );
}
