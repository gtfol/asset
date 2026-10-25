import React, { useState } from 'react';
import { Check, ChevronRight } from 'lucide-react';
import { effective, money, type State, type Transaction } from '../shared/core';
import type { Run } from './App';

export function ReviewQueue({
  state,
  items,
  run,
  onOpen,
  onViewAll,
}: {
  state: State;
  items: Transaction[];
  run: Run;
  onOpen: (id: string) => void;
  onViewAll: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [undo, setUndo] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const visible = items.slice(0, 6).map(effective);
  const chosen = visible.filter((t) => selected.includes(t.id)).map((t) => t.id);
  const ids = chosen.length ? chosen : visible.map((t) => t.id);
  async function review(ids: string[], reviewed: boolean) {
    if (busy || !ids.length) return;
    setBusy(true);
    setError('');
    try {
      await run({ type: 'transactions.review', payload: { ids, reviewed } });
      setUndo(reviewed ? ids : []);
      setSelected([]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  let previousDate = '';
  return (
    <section className="card review-card" aria-label="Transactions to review">
      <div className="card-heading">
        <h3>
          To review <span className="count">{items.length}</span>
        </h3>
        <button onClick={onViewAll}>
          View all <ChevronRight size={13} />
        </button>
      </div>
      {visible.length ? (
        <div className="transaction-rows">
          {visible.map((t) => {
            const showDate = previousDate !== t.date;
            previousDate = t.date;
            const category = state.categories.find((c) => c.id === t.categoryId);
            const account = state.accounts.find((a) => a.id === t.accountId);
            return (
              <React.Fragment key={t.id}>
                {showDate && (
                  <div className="date-label">
                    {new Date(t.date + 'T12:00:00').toLocaleDateString('en-US', {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                    })}
                  </div>
                )}
                <div className="dashboard-review-row">
                  <label className="review-select">
                    <input
                      type="checkbox"
                      aria-label={`Select ${t.name} for review`}
                      checked={chosen.includes(t.id)}
                      disabled={busy}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked ? [...chosen, t.id] : chosen.filter((id) => id !== t.id),
                        )
                      }
                    />
                  </label>
                  <button className="transaction-row" onClick={() => onOpen(t.id)}>
                    <span className="row-merchant">
                      {t.name}
                      <small>
                        {account?.name}
                        {category ? ` · ${category.name}` : ''}
                        {t.pending ? ' · Pending' : ''}
                      </small>
                    </span>
                    <span className="amount">
                      {['income', 'refund'].includes(t.kind) ? '+' : ''}
                      {money(t.amount, t.currency)}
                    </span>
                  </button>
                </div>
              </React.Fragment>
            );
          })}
          <div className="card-footer review-actions">
            <span>
              {chosen.length ? `${chosen.length} selected` : `${visible.length} of ${items.length}`}
            </span>
            {chosen.length > 0 && (
              <button disabled={busy} onClick={() => setSelected([])}>
                Clear selection
              </button>
            )}
            <button
              className="border-button"
              disabled={busy}
              onClick={() => void review(ids, true)}
            >
              <Check size={14} />
              {busy ? 'Saving…' : `Review ${ids.length}${chosen.length ? ' selected' : ' shown'}`}
            </button>
          </div>
        </div>
      ) : (
        <p className="muted review-empty">All caught up.</p>
      )}
      {undo.length > 0 && (
        <div className="review-undo" role="status">
          <span>{undo.length} reviewed</span>
          <button
            disabled={busy}
            onClick={() =>
              void review(
                undo.filter((id) =>
                  state.transactions.some((t) => t.id === id && !t.removed && t.reviewed),
                ),
                false,
              )
            }
          >
            Undo
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </section>
  );
}
