import React, { useState } from 'react';
import { Check, ChevronRight } from 'lucide-react';
import { dailyReview, money, today, type State, type Transaction } from '../shared/core';
import { Badge } from './components';
import type { Run } from './App';

export function ReviewQueue({
  state,
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
  const [undo, setUndo] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const batch = dailyReview(state);
  const now = today(state.settings.timezone);
  const yesterday = new Date(now + 'T12:00:00Z');
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const label =
    batch.date === now
      ? 'So far today'
      : batch.date === yesterday.toISOString().slice(0, 10)
        ? 'Yesterday'
        : batch.date
          ? new Date(batch.date + 'T12:00:00').toLocaleDateString('en-US', {
              weekday: 'long',
              month: 'short',
              day: 'numeric',
            })
          : '';
  async function review(ids: string[], reviewed: boolean) {
    if (busy || !ids.length) return;
    setBusy(true);
    setError('');
    try {
      await run({ type: 'transactions.review', payload: { ids, reviewed } });
      setUndo(reviewed ? ids : []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="review-section" aria-label="Transactions to review">
      <div className="card-heading">
        <h3>
          To review <span className="count">{batch.total}</span>
        </h3>
        <button onClick={onViewAll}>
          View all <ChevronRight size={14} />
        </button>
      </div>
      <div className={'daily-review-card' + (batch.total > batch.items.length ? ' has-more' : '')}>
        {batch.items.length ? (
          <>
            <div className="review-date">
              {label}
              {batch.dayCount > 6 && (
                <small>
                  {' '}
                  · {batch.items.length} of {batch.dayCount}
                </small>
              )}
            </div>
            <div className="daily-review-rows">
              {batch.items.map((t) => (
                <button key={t.id} className="daily-review-row" onClick={() => onOpen(t.id)}>
                  <span className="review-merchant">
                    {t.name}
                    {t.pending && <small>Pending</small>}
                  </span>
                  <Badge category={state.categories.find((c) => c.id === t.categoryId)} />
                  <span
                    className={
                      'amount ' + (['income', 'refund'].includes(t.kind) ? 'positive' : '')
                    }
                  >
                    {['income', 'refund'].includes(t.kind) ? '+' : ''}
                    {money(t.amount, t.currency)}
                  </span>
                  <span className="unreviewed-dot" aria-label="Unreviewed" />
                </button>
              ))}
            </div>
            <button
              className="review-confirm"
              disabled={busy}
              onClick={() =>
                void review(
                  batch.items.map((t) => t.id),
                  true,
                )
              }
            >
              <Check size={16} />
              {busy ? 'Saving…' : 'Mark as reviewed'}
            </button>
          </>
        ) : (
          <div className="review-complete">
            <Check size={24} />
            <div>
              <h3>All caught up</h3>
              <p>Your next transactions will appear here.</p>
            </div>
          </div>
        )}
      </div>
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
