import { useState } from 'react';
import { previewAccountLink, type State } from '../shared/core';
import type { Run } from './App';

export function AccountLinks({ state, run, disabled }: { state: State; run: Run; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [complete, setComplete] = useState('');
  const imported = state.accounts.filter(a => ['csv', 'manual'].includes(a.source) && !a.connectionId);
  const connected = state.accounts.filter(a => a.source === 'plaid');
  const candidates = (id: string) => {
    const source = imported.find(a => a.id === id)!;
    return connected.filter(a => a.currency === source.currency && (a.type === source.type || source.type === 'manual'));
  };
  const links = Object.entries(mapping).filter(([id, target]) => target && imported.some(a => a.id === id) && connected.some(a => a.id === target)).map(([importedId, connectedId]) => ({ importedId, connectedId }));
  let matched = 0, possible = 0, previewError = '';
  try {
    if (new Set(links.map(l => l.connectedId)).size !== links.length) throw Error('Choose each connected account only once.');
    for (const link of links) {
      const preview = previewAccountLink(state, link.importedId, link.connectedId);
      matched += preview.pairs.length; possible += preview.possible;
    }
  } catch (e) { previewError = (e as Error).message; }
  if (!imported.length || !connected.length) return complete ? <p role="status">{complete}</p> : null;
  return <section className="connection-card">
    <h3>Imported history</h3>
    <p className="tiny muted">Link CSV history to the same bank account. Your account name, categories, notes, and older transactions stay with its live balance.</p>
    {complete && <p role="status">{complete}</p>}
    {!open ? <button disabled={disabled} onClick={() => {
      setMapping(Object.fromEntries(imported.map(a => {
        const matches = candidates(a.id).filter(c => a.mask && c.mask === a.mask);
        return [a.id, matches.length === 1 ? matches[0].id : ''];
      })));
      setOpen(true); setError('');
    }}>Link imported history</button> : <>
      <div className="form-grid">
        {imported.map(a => <label key={a.id}>
          {a.name}{a.mask ? ` · ${a.mask}` : ''}
          <select aria-label={`Connected account for ${a.name} ${a.mask ?? ''}`.trim()} value={mapping[a.id] ?? ''} disabled={disabled || busy} onChange={e => setMapping({ ...mapping, [a.id]: e.target.value })}>
            <option value="">Keep separate</option>
            {candidates(a.id).map(c => <option key={c.id} value={c.id}>{c.name}{c.mask ? ` · ${c.mask}` : ''}</option>)}
          </select>
        </label>)}
      </div>
      <p>{links.length} accounts selected · {matched.toLocaleString()} matching transactions combined</p>
      {possible > 0 && <p className="tiny muted">{possible.toLocaleString()} other transactions share a date and amount but have different descriptions. They remain separate for review.</p>}
      <div className="button-row">
        <button className="primary" disabled={disabled || busy || !links.length || !!previewError} onClick={async () => {
          setBusy(true); setError('');
          try {
            await run({ type: 'import.link-accounts', payload: { links } });
            setComplete(`${links.length} accounts linked. ${matched.toLocaleString()} matching transactions combined.`);
            setMapping({}); setOpen(false);
          } catch (e) { setError((e as Error).message); }
          finally { setBusy(false); }
        }}>{busy ? 'Linking…' : 'Link selected accounts'}</button>
        <button disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {(error || previewError) && <p role="alert" className="negative">{error || previewError}</p>}
    </>}
  </section>;
}
