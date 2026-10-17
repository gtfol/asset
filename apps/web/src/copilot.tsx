import { useMemo, useState } from 'react';
import { copilotAccounts, previewCopilot, type CopilotOptions } from '../shared/copilot';
import { money, type Command, type State } from '../shared/core';

export function CopilotImport({
  text,
  state,
  run,
  onDone,
}: {
  text: string;
  state: State;
  run: (command: Command) => Promise<unknown>;
  onDone: (count: number) => void;
}) {
  const groups = useMemo(() => copilotAccounts(text, state), [text, state]);
  const [options, setOptions] = useState<CopilotOptions>({
    currency: state.settings.currency,
    accounts: {},
  });
  const [preview, setPreview] = useState<ReturnType<typeof previewCopilot> | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <section className="import-preview">
      <h3>Copilot export</h3>
      <p className="muted">
        Accounts, categories, notes, exclusions, and recurring labels are preserved. Account
        balances and holdings are not included in this file.
      </p>
      <label>
        Currency
        <select
          value={options.currency}
          onChange={(e) => {
            setOptions({ ...options, currency: e.target.value });
            setPreview(null);
          }}
        >
          {['USD', 'CAD', 'EUR', 'GBP'].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      <div className="preview-table">
        <table>
          <thead>
            <tr>
              <th>From Copilot</th>
              <th>Import into</th>
              <th>Account type</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const selected = options.accounts[g.key] ?? { accountId: g.accountId, type: g.type };
              const update = (change: Partial<typeof selected>) => {
                setOptions({
                  ...options,
                  accounts: { ...options.accounts, [g.key]: { ...selected, ...change } },
                });
                setPreview(null);
              };
              return (
                <tr key={g.key}>
                  <td>
                    {g.name}
                    {g.mask && ` · ${g.mask}`}
                    <small className="muted"> {g.count} transactions</small>
                  </td>
                  <td>
                    <select
                      aria-label={`Destination for ${g.name} ${g.mask}`}
                      value={selected.accountId ?? ''}
                      onChange={(e) => update({ accountId: e.target.value || undefined })}
                    >
                      <option value="">Create account</option>
                      {state.accounts
                        .filter((a) => a.source !== 'bitcoin' && a.currency === options.currency)
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                            {a.mask && ` · ${a.mask}`}
                          </option>
                        ))}
                    </select>
                  </td>
                  <td>
                    <select
                      aria-label={`Type for ${g.name} ${g.mask}`}
                      disabled={!!selected.accountId}
                      value={selected.type}
                      onChange={(e) => update({ type: e.target.value as typeof selected.type })}
                    >
                      {['checking', 'savings', 'credit', 'investment', 'loan', 'manual'].map(
                        (t) => (
                          <option key={t}>{t}</option>
                        ),
                      )}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <button
        className="border-button"
        disabled={busy}
        onClick={() => {
          try {
            setPreview(previewCopilot(text, options, state));
            setError('');
          } catch (e: any) {
            setError(e.message);
          }
        }}
      >
        Preview Copilot import
      </button>
      {preview && (
        <>
          <h3>
            {preview.transactions.length.toLocaleString()} ready · {preview.updated.length} updated
            · {preview.duplicates.toLocaleString()} already imported
          </h3>
          <p className="muted">
            {preview.start} to {preview.end}. {preview.accounts.length} new accounts,{' '}
            {preview.categories.length} new categories. {preview.pending} pending transactions stay
            out of spending totals until posted.
          </p>
          <div className="preview-table">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {preview.transactions.slice(0, 8).map((t) => (
                  <tr key={t.id}>
                    <td>{t.date}</td>
                    <td>{t.name}</td>
                    <td>{t.kind}</td>
                    <td>{money(t.amount, t.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.errors.slice(0, 10).map((e) => (
            <p className="error" key={e.row}>
              Row {e.row}: {e.message}
            </p>
          ))}
          <p className="tiny muted">
            Imports are added to your existing history. Re-importing the same export skips matching
            rows. Review the account mapping to avoid separate copies of connected accounts.
          </p>
          <button
            className="primary"
            disabled={
              busy ||
              !!preview.errors.length ||
              !(preview.transactions.length + preview.updated.length)
            }
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await run({ type: 'import.copilot', payload: { text, options } });
                onDone(preview.transactions.length);
              } catch (e: any) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy
              ? 'Importing…'
              : `Import ${preview.transactions.length.toLocaleString()} transactions`}
          </button>
        </>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
