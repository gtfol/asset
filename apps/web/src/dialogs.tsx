import React, { useState } from 'react';
import { X, Check, Plus, Split, Download, Upload } from 'lucide-react';
import {
  effective,
  money,
  parseMoney,
  today,
  backup,
  validateState,
  type State,
  type Transaction,
  type Category,
  type Command,
} from '../shared/core';
import { parseCSV, previewCSV, exportCSV, type CSVOptions } from '../shared/csv';
import { categoryIcons, categoryIconKey } from '../shared/category-icons';
import { Modal, Badge, Status, Empty } from './components';
import { api, type Run } from './App';
import { transactionKinds, transactionKindLabel } from './labels';
const uid = () => crypto.randomUUID();
function ErrorText({ error }: { error: string }) {
  return error ? (
    <p className="form-error" role="alert">
      {error}
    </p>
  ) : null;
}
function CategorySelect({
  state,
  name = 'categoryId',
  value,
  onChange,
}: {
  state: State;
  name?: string;
  value: string;
  onChange?: (v: string) => void;
}) {
  return (
    <select name={name} value={value} onChange={(e) => onChange?.(e.target.value)}>
      {state.categories
        .filter((c) => !c.archived || c.id === value)
        .map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
    </select>
  );
}
export function TransactionEditor({
  transaction,
  state,
  run,
  onClose,
}: {
  transaction: Transaction;
  state: State;
  run: Run;
  onClose: () => void;
}) {
  const t = effective(transaction),
    [draft, setDraft] = useState({ ...t }),
    [error, setError] = useState(''),
    [splitting, setSplitting] = useState(false),
    [reconciling, setReconciling] = useState(false),
    [parts, setParts] = useState(
      t.splits.length
        ? t.splits
        : [
            { id: uid(), categoryId: t.categoryId, amount: t.amount, excluded: false },
            { id: uid(), categoryId: 'other', amount: 0, excluded: false },
          ],
    ),
    [rule, setRule] = useState(false),
    [scope, setScope] = useState('account'),
    [busy, setBusy] = useState(false);
  const total = parts.reduce((a, p) => a + p.amount, 0);
  const conflict = t.raw?.asset_split_conflict === true;
  const targetAmount = reconciling
    ? Math.abs(parseMoney(Number(t.raw?.amount).toFixed(2)))
    : t.amount;
  async function save() {
    setBusy(true);
    try {
      await run({
        type: 'transaction.update',
        payload: {
          id: t.id,
          edits: {
            name: draft.name,
            date: draft.date,
            categoryId: draft.categoryId,
            kind: draft.kind,
            notes: draft.notes,
            excluded: draft.excluded,
          },
          reviewed: draft.reviewed,
        },
      });
      if (rule)
        await run({
          type: 'rule.save',
          payload: {
            id: uid(),
            merchant: t.name,
            match: 'exact',
            accountId: scope === 'account' ? t.accountId : null,
            categoryId: draft.categoryId,
          },
        });
      onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside className="transaction-inspector" aria-label="Transaction detail">
      <header>
        <span>Transaction detail</span>
        <button className="icon-button" aria-label="Close transaction details" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div className="inspector-body">
        <div className="detail-heading">
          <select
            aria-label="Transaction type"
            value={draft.kind}
            onChange={(e) => setDraft({ ...draft, kind: e.target.value as any })}
          >
            {transactionKinds.map((k) => (
              <option key={k} value={k}>
                {transactionKindLabel(k)}
              </option>
            ))}
          </select>
          {t.pending && <Status status="Pending" />}
        </div>
        <label>
          Date
          <input
            type="date"
            value={draft.date}
            onChange={(e) => setDraft({ ...draft, date: e.target.value })}
          />
        </label>
        <label>
          Name
          <input
            className="name-input"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <strong className="detail-number">{money(t.amount, t.currency)}</strong>
        <p className="muted">{state.accounts.find((a) => a.id === t.accountId)?.name}</p>
        <div className="divider" />
        <label>
          Category
          <CategorySelect
            state={state}
            value={draft.categoryId}
            onChange={(v) => setDraft({ ...draft, categoryId: v })}
          />
        </label>
        <label>
          Notes
          <textarea
            rows={4}
            placeholder="Add a note…"
            value={draft.notes}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          />
        </label>
        <label className="check-label">
          <input
            type="checkbox"
            checked={draft.excluded}
            onChange={(e) => setDraft({ ...draft, excluded: e.target.checked })}
          />
          Exclude from budget
        </label>
        <label className="check-label">
          <input
            type="checkbox"
            checked={draft.reviewed}
            onChange={(e) => setDraft({ ...draft, reviewed: e.target.checked })}
          />
          Reviewed
        </label>
        {draft.categoryId !== t.categoryId && (
          <div className="rule-option">
            <label className="check-label">
              <input type="checkbox" checked={rule} onChange={(e) => setRule(e.target.checked)} />
              Create a rule for “{t.name}”
            </label>
            {rule && (
              <select
                aria-label="Rule scope"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
              >
                <option value="account">Exact merchant · this account only</option>
                <option value="all">Exact merchant · all accounts</option>
              </select>
            )}
            <p className="tiny muted">Applies to future imports. Manual corrections always win.</p>
          </div>
        )}
        {conflict && (
          <div className="warning">
            <p>
              The provider amount changed to{' '}
              {money(Math.abs(parseMoney(Number(t.raw?.amount).toFixed(2))), t.currency)}. Your
              saved {money(t.amount, t.currency)} split is preserved until you reconcile it.
            </p>
            <button
              className="border-button"
              onClick={() => {
                setReconciling(true);
                setSplitting(true);
              }}
            >
              Reconcile changed amount
            </button>
          </div>
        )}
        <button className="border-button full" onClick={() => setSplitting(!splitting)}>
          <Split size={15} />
          {t.splits.length ? 'Edit splits' : 'Split transaction'}
        </button>
        {splitting && (
          <div className="split-editor">
            {parts.map((p, i) => (
              <div key={p.id}>
                <CategorySelect
                  state={state}
                  value={p.categoryId}
                  onChange={(v) =>
                    setParts(parts.map((x, j) => (j === i ? { ...x, categoryId: v } : x)))
                  }
                />
                <input
                  aria-label={`Split ${i + 1} amount`}
                  type="number"
                  step=".01"
                  min="0"
                  value={p.amount / 100}
                  onChange={(e) =>
                    setParts(
                      parts.map((x, j) =>
                        j === i ? { ...x, amount: Math.round(Number(e.target.value) * 100) } : x,
                      ),
                    )
                  }
                />
                <button
                  aria-label={`Remove split ${i + 1}`}
                  onClick={() => setParts(parts.filter((_, j) => i !== j))}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              className="text-button"
              onClick={() =>
                setParts([...parts, { id: uid(), categoryId: 'other', amount: 0, excluded: false }])
              }
            >
              + Add split
            </button>
            <p className={total === targetAmount ? 'positive' : 'negative'}>
              {money(targetAmount - total, t.currency)} left to allocate
              {reconciling ? ' to the new amount' : ''}
            </p>
            <button
              className="border-button full"
              disabled={total !== targetAmount || parts.length < 2 || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await run({
                    type: reconciling ? 'transaction.reconcile' : 'transaction.split',
                    payload: { id: t.id, splits: parts },
                  });
                  setSplitting(false);
                  setReconciling(false);
                } catch (e: any) {
                  setError(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {reconciling ? 'Accept new amount and splits' : 'Save splits'}
            </button>
          </div>
        )}
        <details className="original-info">
          <summary>Original import information</summary>
          <p>
            {transaction.name}
            <br />
            {transaction.date} · {money(transaction.amount, transaction.currency)}
            <br />
            {transaction.source} · imported {transaction.importedAt}
          </p>
        </details>
        <ErrorText error={error} />
      </div>
      <footer>
        <button className="border-button" onClick={onClose}>
          Cancel
        </button>
        <button className="primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </footer>
    </aside>
  );
}
export function ManualTransaction({
  state,
  run,
  onClose,
}: {
  state: State;
  run: Run;
  onClose: () => void;
}) {
  const [error, setError] = useState(''),
    [category, setCategory] = useState('other');
  return (
    <Modal title="Add a transaction" onClose={onClose}>
      {state.accounts.length === 0 ? (
        <Empty title="Add an account first">
          Close this dialog, open Accounts, and add a manual account.
        </Empty>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            try {
              const a = state.accounts.find((a) => a.id === f.get('accountId'))!;
              await run({
                type: 'transaction.create',
                payload: {
                  id: uid(),
                  name: f.get('name'),
                  date: f.get('date'),
                  amount: parseMoney(String(f.get('amount'))),
                  kind: f.get('kind'),
                  accountId: a.id,
                  currency: a.currency,
                  categoryId: category,
                  source: 'manual',
                  importedAt: new Date().toISOString(),
                  notes: f.get('notes'),
                  reviewed: false,
                },
              });
              onClose();
            } catch (e: any) {
              setError(e.message);
            }
          }}
        >
          <label>
            Name
            <input name="name" required autoFocus placeholder="Merchant or description" />
          </label>
          <div className="form-grid">
            <label>
              Amount
              <input name="amount" inputMode="decimal" required placeholder="0.00" />
            </label>
            <label>
              Date
              <input name="date" type="date" defaultValue={today()} required />
            </label>
          </div>
          <label>
            Type
            <select name="kind">
              {transactionKinds.map((k) => (
                <option key={k} value={k}>
                  {transactionKindLabel(k)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Account
            <select name="accountId">
              {state.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.currency}
                </option>
              ))}
            </select>
          </label>
          <label>
            Category
            <CategorySelect state={state} value={category} onChange={setCategory} />
          </label>
          <label>
            Notes
            <textarea name="notes" />
          </label>
          <ErrorText error={error} />
          <div className="form-actions">
            <button type="button" className="border-button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary">Add transaction</button>
          </div>
        </form>
      )}
    </Modal>
  );
}
export function CategoryEditor({
  state,
  run,
  id,
  month,
  onClose,
}: {
  state: State;
  run: Run;
  id?: string;
  month: string;
  onClose: () => void;
}) {
  const c = state.categories.find((c) => c.id === id),
    [error, setError] = useState('');
  return (
    <Modal title={c ? 'Edit category' : 'New category'} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          try {
            await run({
              type: 'category.save',
              payload: {
                id: c?.id ?? uid(),
                name: f.get('name'),
                icon: f.get('icon'),
                color: f.get('color'),
                group: f.get('group'),
                archived: f.get('archived') === 'on',
              },
            });
            onClose();
          } catch (e: any) {
            setError(e.message);
          }
        }}
      >
        <label>
          Name
          <input name="name" defaultValue={c?.name} required />
        </label>
        <div className="form-grid">
          <label>
            Icon
            <select name="icon" defaultValue={categoryIconKey(c)}>
              {categoryIcons.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Chart color
            <input name="color" type="color" defaultValue={c?.color ?? '#7c8da7'} />
          </label>
        </div>
        <label>
          Group
          <input name="group" defaultValue={c?.group ?? 'Everyday'} required />
        </label>
        {c && (
          <label className="check-label">
            <input name="archived" type="checkbox" defaultChecked={c.archived} />
            Archive category
          </label>
        )}
        <p className="tiny muted">
          Archived categories retain their transactions and historical budgets. Set the {month}{' '}
          budget from category detail.
        </p>
        <ErrorText error={error} />
        <div className="form-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary">Save category</button>
        </div>
      </form>
    </Modal>
  );
}
export function AccountEditor({
  state,
  run,
  id,
  onClose,
}: {
  state: State;
  run: Run;
  id?: string;
  onClose: () => void;
}) {
  const a = state.accounts.find((a) => a.id === id),
    [error, setError] = useState('');
  return (
    <Modal title={a ? 'Edit account' : 'Add manual account'} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          try {
            await run({
              type: 'account.save',
              payload: {
                ...a,
                id: a?.id ?? uid(),
                name: f.get('name'),
                type: a?.source === 'plaid' ? a.type : f.get('type'),
                currency: a?.source === 'plaid' ? a.currency : f.get('currency'),
                balance: a?.source === 'plaid' ? a.balance : parseMoney(String(f.get('balance'))),
                includeInNetWorth: f.get('included') === 'on',
                enabled: a?.enabled ?? true,
                source: a?.source ?? 'manual',
                updatedAt: new Date().toISOString(),
                coverageComplete:
                  a?.source === 'plaid' ? a.coverageComplete : f.get('complete') === 'on',
                ...(a?.source === 'plaid'
                  ? {}
                  : {
                      coverageStart: f.get('coverageStart') || undefined,
                      coverageEnd: f.get('coverageEnd') || undefined,
                    }),
              },
            });
            onClose();
          } catch (e: any) {
            setError(e.message);
          }
        }}
      >
        <label>
          Name
          <input name="name" defaultValue={a?.name} required />
        </label>
        <label>
          Type
          <select name="type" disabled={a?.source === 'plaid'} defaultValue={a?.type ?? 'checking'}>
            {['checking', 'savings', 'credit', 'investment', 'loan', 'manual'].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <div className="form-grid">
          <label>
            Balance
            <input
              name="balance"
              disabled={a?.source === 'plaid'}
              inputMode="decimal"
              defaultValue={(a?.balance ?? 0) / 100}
              required
            />
          </label>
          <label>
            Currency
            <select
              name="currency"
              disabled={a?.source === 'plaid'}
              defaultValue={a?.currency ?? 'USD'}
            >
              {['USD', 'CAD', 'EUR', 'GBP'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
        </div>
        <p className="tiny muted">
          Enter debt as a positive amount owed. Account balances are separate from transaction
          totals.
        </p>
        <label className="check-label">
          <input name="included" type="checkbox" defaultChecked={a?.includeInNetWorth ?? true} />
          Include in net worth
        </label>
        {a?.source !== 'plaid' && (
          <>
            <div className="form-grid">
              <label>
                History starts
                <input name="coverageStart" type="date" defaultValue={a?.coverageStart} />
              </label>
              <label>
                History ends
                <input name="coverageEnd" type="date" defaultValue={a?.coverageEnd} />
              </label>
            </div>
            <label className="check-label">
              <input name="complete" type="checkbox" defaultChecked={a?.coverageComplete} />I have
              entered all activity in this date range
            </label>
          </>
        )}
        <ErrorText error={error} />
        <div className="form-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary">Save account</button>
        </div>
      </form>
    </Modal>
  );
}
export function HoldingEditor({
  state,
  run,
  id,
  onClose,
}: {
  state: State;
  run: Run;
  id?: string;
  onClose: () => void;
}) {
  const h = state.holdings.find((h) => h.id === id),
    [error, setError] = useState(''),
    accounts = state.accounts.filter((a) => a.type === 'investment');
  return (
    <Modal title={h ? 'Edit holding' : 'Add a holding'} onClose={onClose}>
      {accounts.length === 0 ? (
        <Empty title="Add an investment account first">
          Create a manual investment account from Accounts.
        </Empty>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            try {
              const a = accounts.find((a) => a.id === f.get('accountId'))!;
              await run({
                type: 'holding.save',
                payload: {
                  id: h?.id ?? uid(),
                  accountId: a.id,
                  symbol: f.get('symbol'),
                  name: f.get('name'),
                  quantity: f.get('quantity'),
                  price: f.get('price') ? parseMoney(String(f.get('price'))) : null,
                  marketValue: f.get('value') ? parseMoney(String(f.get('value'))) : null,
                  costBasis: f.get('basis') ? parseMoney(String(f.get('basis'))) : null,
                  currency: a.currency,
                  priceAt: f.get('date') || null,
                  type: f.get('type'),
                  source: 'manual',
                },
              });
              onClose();
            } catch (e: any) {
              setError(e.message);
            }
          }}
        >
          <div className="form-grid">
            <label>
              Ticker
              <input name="symbol" defaultValue={h?.symbol} required />
            </label>
            <label>
              Quantity
              <input
                name="quantity"
                defaultValue={h?.quantity ?? '0'}
                inputMode="decimal"
                required
              />
            </label>
          </div>
          <label>
            Security name
            <input name="name" defaultValue={h?.name} required />
          </label>
          <label>
            Account
            <select name="accountId" defaultValue={h?.accountId}>
              {accounts.map((a) => (
                <option value={a.id} key={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <div className="form-grid">
            <label>
              Price
              <input name="price" defaultValue={h?.price == null ? '' : h.price / 100} />
            </label>
            <label>
              Market value
              <input
                name="value"
                defaultValue={h?.marketValue == null ? '' : h.marketValue / 100}
              />
            </label>
            <label>
              Cost basis
              <input name="basis" defaultValue={h?.costBasis == null ? '' : h.costBasis / 100} />
            </label>
            <label>
              Price date
              <input name="date" type="date" defaultValue={h?.priceAt?.slice(0, 10)} />
            </label>
          </div>
          <label>
            Asset type
            <select name="type" defaultValue={h?.type ?? 'Equity'}>
              {['Equity', 'ETF', 'Fixed income', 'Cash', 'Other'].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <p className="tiny muted">
            Leave unknown values empty. Adding a holding does not silently change its account
            balance.
          </p>
          <ErrorText error={error} />
          <div className="form-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary">Save holding</button>
          </div>
        </form>
      )}
    </Modal>
  );
}
export function ImportDialog({
  state,
  run,
  onClose,
}: {
  state: State;
  run: Run;
  onClose: () => void;
}) {
  const [text, setText] = useState(''),
    [headers, setHeaders] = useState<string[]>([]),
    [error, setError] = useState(''),
    [options, setOptions] = useState<CSVOptions>({
      mapping: { date: 'date', name: 'name', amount: 'amount' },
      dateFormat: 'YYYY-MM-DD',
      amountConvention: 'outflow-positive',
      currency: state.settings.currency,
      accountId: state.accounts[0]?.id ?? '',
    }),
    [preview, setPreview] = useState<ReturnType<typeof previewCSV> | null>(null),
    [done, setDone] = useState<number | null>(null);
  const update = (p: Partial<CSVOptions>) => {
    setOptions({ ...options, ...p });
    setPreview(null);
  };
  return (
    <Modal title="Import transactions" onClose={onClose} wide>
      {done !== null ? (
        <div className="import-report">
          <Check size={32} />
          <h2>{done} transactions imported</h2>
          <p>All new rows are waiting in To Review. Duplicate rows were skipped.</p>
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      ) : (
        <>
          <p className="muted">
            Choose a CSV, map its columns, and review the results before importing.
          </p>
          <label className="file-drop">
            <Upload size={25} />
            <span>Choose a CSV file</span>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={async (e) => {
                try {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  if (file.size > 10 * 1024 * 1024) throw Error('Choose a file smaller than 10 MB');
                  const text = await file.text(),
                    parsed = parseCSV(text);
                  setText(text);
                  setHeaders(parsed.headers);
                  setPreview(null);
                  setError('');
                  const lookup = (names: string[]) =>
                    parsed.headers.find((h) => names.includes(h.toLowerCase())) ?? '';
                  setOptions({
                    ...options,
                    mapping: {
                      date: lookup(['date', 'transaction date']),
                      name: lookup(['name', 'merchant', 'description']),
                      amount: lookup(['amount']),
                      category: lookup(['category']),
                      type: lookup(['type']),
                      currency: lookup(['currency']),
                    },
                  });
                } catch (e: any) {
                  setError(e.message);
                }
              }}
            />
          </label>
          {headers.length > 0 && (
            <>
              <div className="form-grid">
                {(['date', 'name', 'amount', 'category', 'type', 'currency'] as const).map(
                  (key) => (
                    <label key={key}>
                      {key}
                      {['date', 'name', 'amount'].includes(key) ? ' *' : ' (optional)'}
                      <select
                        value={options.mapping[key] ?? ''}
                        onChange={(e) =>
                          update({ mapping: { ...options.mapping, [key]: e.target.value } })
                        }
                      >
                        <option value="">Select column</option>
                        {headers.map((h) => (
                          <option key={h}>{h}</option>
                        ))}
                      </select>
                    </label>
                  ),
                )}
              </div>
              <div className="form-grid">
                <label>
                  Date convention
                  <select
                    value={options.dateFormat}
                    onChange={(e) => update({ dateFormat: e.target.value as any })}
                  >
                    {['YYYY-MM-DD', 'MM/DD/YYYY', 'DD/MM/YYYY'].map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Amount convention
                  <select
                    value={options.amountConvention}
                    onChange={(e) => update({ amountConvention: e.target.value as any })}
                  >
                    <option value="outflow-positive">Positive = spending; negative = income</option>
                    <option value="outflow-negative">Negative = spending; positive = income</option>
                  </select>
                </label>
                <label>
                  Account
                  <select
                    value={options.accountId}
                    onChange={(e) => update({ accountId: e.target.value })}
                  >
                    <option value="">Choose account</option>
                    {state.accounts.map((a) => (
                      <option value={a.id} key={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Default currency
                  <select
                    value={options.currency}
                    onChange={(e) => update({ currency: e.target.value })}
                  >
                    {['USD', 'CAD', 'EUR', 'GBP'].map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="tiny muted">
                Decimal point: “.” · optional thousands separator: “,”. A mapped type overrides the
                sign convention. In the CSV Type column, use <code>refund</code> for refunds and{' '}
                <code>transfer</code> or <code>card_payment</code> for your own money movements.
              </p>
              <button
                className="border-button"
                onClick={() => {
                  try {
                    setPreview(previewCSV(text, options, state));
                    setError('');
                  } catch (e: any) {
                    setError(e.message);
                  }
                }}
              >
                Preview import
              </button>
            </>
          )}
          {preview && (
            <div className="import-preview">
              <h3>
                {preview.transactions.length} ready · {preview.duplicates} duplicates ·{' '}
                {preview.errors.length} errors
              </h3>
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
                        <td>{transactionKindLabel(t.kind)}</td>
                        <td>{money(t.amount, t.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.errors.length > 0 && (
                <div className="warning">
                  <b>Invalid rows will not be imported.</b>
                  {preview.errors.slice(0, 10).map((e) => (
                    <p key={e.row}>
                      Row {e.row}: {e.message}
                    </p>
                  ))}
                </div>
              )}
              <p className="tiny muted">
                Preview shows up to 8 rows. The button imports all {preview.transactions.length}{' '}
                valid, nonduplicate rows. New history does not automatically establish complete
                account coverage.
              </p>
              <button
                className="primary"
                disabled={preview.transactions.length === 0}
                onClick={async () => {
                  try {
                    await run({
                      type: 'import.commit',
                      payload: { transactions: preview.transactions },
                    });
                    setDone(preview.transactions.length);
                  } catch (e: any) {
                    setError(e.message);
                  }
                }}
              >
                Import {preview.transactions.length} valid rows
              </button>
            </div>
          )}
          <ErrorText error={error} />
        </>
      )}
    </Modal>
  );
}
function download(name: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function SettingsDialog({
  state,
  run,
  onClose,
}: {
  state: State;
  run: Run;
  onClose: () => void;
}) {
  const [restore, setRestore] = useState<State | null>(null),
    [confirm, setConfirm] = useState(''),
    [error, setError] = useState(''),
    [theme, setTheme] = useState(localStorage.getItem('asset-theme') ?? 'light');
  return (
    <Modal title="Settings & data" onClose={onClose}>
      <label className="theme-control">
        Appearance
        <select
          value={theme}
          onChange={(e) => {
            const value = e.target.value;
            setTheme(value);
            localStorage.setItem('asset-theme', value);
            document.documentElement.dataset.theme = value;
          }}
        >
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <section>
        <h3>Your data</h3>
        <p className="tiny">
          <a href="/third-party-notices.txt" target="_blank" rel="noreferrer">
            Third-party licenses
          </a>
        </p>
        <p className="muted">
          Backups preserve transactions, splits, budgets, accounts, holdings, history, rules, and
          settings. Connection secrets are never exported.
        </p>
        <div className="button-row">
          <button
            className="border-button"
            onClick={() =>
              download(`asset-backup-${today()}.json`, JSON.stringify(backup(state), null, 2))
            }
          >
            <Download size={15} />
            Full backup
          </button>
          <button
            className="border-button"
            onClick={() => download('asset-transactions.csv', exportCSV(state), 'text/csv')}
          >
            <Download size={15} />
            Export CSV
          </button>
        </div>
        <p className="tiny muted">
          CSV is a readable transaction export; use a full backup to preserve splits, notes, review
          state, and all other records exactly.
        </p>
        <label>
          Restore full backup
          <input
            type="file"
            accept=".json,application/json"
            onChange={async (e) => {
              try {
                const f = e.target.files?.[0];
                if (!f) return;
                if (f.size > 12 * 1024 * 1024) throw Error('Backup exceeds 12 MB');
                const parsed = JSON.parse(await f.text());
                if (parsed.format !== 'asset-backup' || parsed.version !== 1)
                  throw Error('Not an Asset v1 backup');
                const next = validateState(parsed.state);
                if (next.settings.demo !== state.settings.demo)
                  throw Error('Keep demo data and private data in separate workspaces');
                setRestore(next);
              } catch (e: any) {
                setError(e.message);
              }
            }}
          />
        </label>
        {restore && (
          <div className="warning">
            <b>Replace this workspace?</b>
            <p>
              {restore.transactions.length} transactions, {restore.accounts.length} accounts, and{' '}
              {restore.categories.length} categories. Current data will be replaced; a backup of it
              will download first.
            </p>
            <label>
              Type RESTORE to confirm
              <input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
            <button
              disabled={confirm !== 'RESTORE'}
              className="border-button"
              onClick={async () => {
                try {
                  download('asset-before-restore.json', JSON.stringify(backup(state), null, 2));
                  await run({ type: 'backup.restore', payload: { state: restore } });
                  setRestore(null);
                  setConfirm('');
                } catch (e: any) {
                  setError(e.message);
                }
              }}
            >
              Back up current data and restore
            </button>
          </div>
        )}
      </section>
      <div className="divider" />
      <h3>Reporting currency</h3>
      <select
        aria-label="Reporting currency"
        value={state.settings.currency}
        onChange={(e) =>
          void run({ type: 'settings.save', payload: { currency: e.target.value } }).catch(() => {})
        }
      >
        {['USD', 'CAD', 'EUR', 'GBP'].map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
      <p className="tiny muted">
        Other currencies remain visible on their accounts and transactions; totals never assume an
        exchange rate.
      </p>
      <div className="divider" />
      <h3>Category rules</h3>
      {state.rules.map((r) => (
        <div className="rule-row" key={r.id}>
          <span>
            <b>{r.merchant}</b>
            <small>
              {r.match} ·{' '}
              {r.accountId
                ? state.accounts.find((a) => a.id === r.accountId)?.name
                : 'All accounts'}{' '}
              → {state.categories.find((c) => c.id === r.categoryId)?.name}
            </small>
          </span>
          <button
            onClick={() => void run({ type: 'rule.delete', payload: { id: r.id } }).catch(() => {})}
          >
            Remove
          </button>
        </div>
      ))}
      {state.rules.length === 0 && (
        <p className="muted">Create a rule when correcting a transaction category.</p>
      )}
      <p className="tiny muted">Your data is not sent to analytics or AI services.</p>
      <ErrorText error={error} />
    </Modal>
  );
}
export { ConnectionsDialog } from './connections';
