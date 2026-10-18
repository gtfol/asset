import { useMemo, useState } from 'react';
import { money, previewHistoryMatches, type State } from '../shared/core';
import type { Run } from './App';

export function HistoryMatches({ state, run }: { state: State; run: Run }) {
  const pairs = useMemo(() => previewHistoryMatches(state), [state]);
  const [open, setOpen] = useState(false), [page, setPage] = useState(0);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const selected = pairs.filter(p => !skipped.has(p.providerId));
  const transactions = new Map(state.transactions.map(t => [t.id, t]));
  if (!pairs.length && !message) return null;
  return <section>
    <h3>Match imported history</h3>
    {message && <p role="status">{message}</p>}
    {pairs.length > 0 && <>
      <p className="muted">{pairs.length.toLocaleString()} bank transactions match imported history by account, amount, and description, with dates up to seven days apart. Combining them keeps your imported categories, notes, exclusions, and review status.</p>
      {!open ? <button className="border-button" onClick={() => setOpen(true)}>Review matches</button> : <>
        <div className="preview-table"><table>
          <thead><tr><th>Match</th><th>Imported / bank</th><th>Amount</th></tr></thead>
          <tbody>{pairs.slice(page * 20, (page + 1) * 20).map(pair => {
            const imported = transactions.get(pair.importedId)!, bank = transactions.get(pair.providerId)!;
            const account = state.accounts.find(a => a.id === imported.accountId)!;
            return <tr key={pair.providerId}>
              <td><input type="checkbox" aria-label={`Combine ${imported.edits.name ?? imported.name} on ${imported.edits.date ?? imported.date}`} checked={!skipped.has(pair.providerId)} onChange={e => setSkipped(previous => {
                const next = new Set(previous); if (e.target.checked) next.delete(pair.providerId); else next.add(pair.providerId); return next;
              })} /></td>
              <td><small className="muted">{account.name}{account.mask && ` · ${account.mask}`}</small><br />
                {imported.edits.name ?? imported.name} · {imported.edits.date ?? imported.date}<br />
                <span className="muted">{bank.name} · {bank.date}</span></td>
              <td>{money(imported.amount, imported.currency)}</td>
            </tr>;
          })}</tbody>
        </table></div>
        <div className="button-row">
          <button disabled={page === 0 || busy} onClick={() => setPage(page - 1)}>Previous matches</button>
          <span className="tiny muted">{page * 20 + 1}–{Math.min((page + 1) * 20, pairs.length)} of {pairs.length}</span>
          <button disabled={(page + 1) * 20 >= pairs.length || busy} onClick={() => setPage(page + 1)}>Next matches</button>
        </div>
        <p className="tiny muted">Uncertain matches and transactions edited in Asset remain separate. Account balances stay unchanged.</p>
        <button className="primary" disabled={!selected.length || busy} onClick={async () => {
          setBusy(true); setError('');
          try {
            await run({ type: 'import.reconcile-history', payload: { pairs: selected } });
            setMessage(`${selected.length.toLocaleString()} matching transactions combined.`);
            setOpen(false); setPage(0); setSkipped(new Set());
          } catch (e) { setError((e as Error).message); }
          finally { setBusy(false); }
        }}>{busy ? 'Combining…' : `Combine ${selected.length.toLocaleString()} matches`}</button>
      </>}
    </>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}
