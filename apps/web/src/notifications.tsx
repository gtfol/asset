import { useState } from 'react';
import {
  notificationKinds,
  notificationLabels,
  notificationPreferences,
  parseMoney,
  type State,
} from '../shared/core';
import { Modal } from './components';
import type { Run } from './App';

export function NotificationPreferences({ state, run }: { state: State; run: Run }) {
  const p = notificationPreferences(state);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (payload: Record<string, unknown>) => {
    setBusy(true);
    setError('');
    try {
      await run({ type: 'notifications.preferences', payload });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <h3>Notifications</h3>
      <p className="muted tiny">
        Alerts appear in Asset after new activity syncs. Imported history does not send alerts.
        iPhone push delivery can be enabled in the iOS app when available.
      </p>
      {notificationKinds.map((kind) => (
        <label className="notification-setting" key={kind}>
          <span>{notificationLabels[kind]}</span>
          <input
            type="checkbox"
            role="switch"
            checked={p[kind]}
            disabled={busy}
            onChange={(e) => void save({ [kind]: e.target.checked })}
          />
        </label>
      ))}
      <div className="form-grid">
        <label>
          Big expense threshold ({state.settings.currency})
          <input
            key={p.bigExpenseAmount}
            type="number"
            min="1"
            step="0.01"
            defaultValue={p.bigExpenseAmount / 100}
            disabled={busy}
            onBlur={(e) => {
              try {
                const amount = parseMoney(e.target.value);
                if (amount !== p.bigExpenseAmount) void save({ bigExpenseAmount: amount });
              } catch (e: any) {
                setError(e.message);
              }
            }}
          />
        </label>
        <label>
          Credit utilization threshold (%)
          <input
            key={p.creditUtilizationPercent}
            type="number"
            min="1"
            max="100"
            defaultValue={p.creditUtilizationPercent}
            disabled={busy}
            onBlur={(e) => {
              const value = Number(e.target.value);
              if (value !== p.creditUtilizationPercent)
                void save({ creditUtilizationPercent: value });
            }}
          />
        </label>
      </div>
      <p className="tiny muted">
        Credit alerts need a reported credit limit. Recurring alerts follow payments labeled
        recurring, including labels imported from Copilot. Spending updates arrive once daily after
        7 pm in your workspace’s time zone. Venmo alerts begin when new Venmo activity is received.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}

export function NotificationsDialog({
  state,
  run,
  onClose,
  onOpen,
}: {
  state: State;
  run: Run;
  onClose: () => void;
  onOpen: (transactionId?: string, accountId?: string) => void;
}) {
  const items = state.notifications?.items ?? [];
  const [error, setError] = useState('');
  const read = async (ids: string[]) => {
    try {
      await run({ type: 'notifications.read', payload: { ids } });
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <Modal title="Notifications" onClose={onClose}>
      {items.some((n) => !n.read) && (
        <button
          className="text-button"
          onClick={() => void read(items.filter((n) => !n.read).map((n) => n.id))}
        >
          Mark all read
        </button>
      )}
      {!items.length && (
        <p className="muted">
          You’re up to date. New activity alerts will appear here after your accounts sync.
        </p>
      )}
      <div className="notification-list">
        {items.map((n) => (
          <button
            className="notification-item"
            key={n.id}
            onClick={async () => {
              await read([n.id]);
              onOpen(n.transactionId, n.accountId);
            }}
          >
            <span className={n.read ? 'muted' : ''}>
              {n.title}
              {!n.read && <span className="notification-dot" aria-label="Unread" />}
            </span>
            <span>{n.body}</span>
            <time className="muted tiny">{new Date(n.createdAt).toLocaleString()}</time>
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </Modal>
  );
}
