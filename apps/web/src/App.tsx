import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  Landmark,
  Settings,
  Plus,
  ChevronRight,
  Check,
  Search,
  Upload,
  PanelLeftClose,
  Menu,
  Wallet,
  LogOut,
  Link2,
} from 'lucide-react';
import {
  dashboard,
  netWorth,
  investmentOverview,
  cashflow,
  money,
  today,
  monthEnd,
  effective,
  spendAmount,
  totals,
  parseMoney,
  type State,
  type Transaction,
  type Command,
} from '../shared/core';
import {
  Badge,
  CategorySymbol,
  Status,
  MonthControl,
  LineChart,
  RangeControl,
  filterHistory,
  Help,
  Empty,
} from './components';
import {
  TransactionEditor,
  ManualTransaction,
  CategoryEditor,
  AccountEditor,
  HoldingEditor,
  ImportDialog,
  SettingsDialog,
  ConnectionsDialog,
} from './dialogs';
import { transactionKinds, transactionKindLabel } from './labels';
import {
  TRANSACTION_PAGE_SIZE,
  createTransactionIndex,
  filterTransactionIndex,
  transactionFilterKey,
  nextTransactionLimit,
  type TransactionIndexEntry,
} from './transactions';
import { clearPlaidAttempt } from './plaid-link';
export async function api(
  path: string,
  body?: unknown,
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE',
  sessionId?: string,
) {
  const res = await fetch('/api' + path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      'content-type': 'application/json',
      'x-asset-client': 'web',
      ...(sessionId ? { 'x-asset-session': sessionId } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.headers.get('content-type')?.includes('application/json')) {
    throw Error(
      res.status === 413
        ? 'This request is too large for the hosted app. Try a smaller import.'
        : 'Asset could not reach its server. Please try again shortly.',
    );
  }
  const data = await res.json();
  if (!res.ok) throw Object.assign(Error(data.error ?? 'Request failed'), { status: res.status });
  return data;
}
export type Run = (command: Command) => Promise<void>;
const sections = [
  'Dashboard',
  'Transactions',
  'Accounts',
  'Investments',
  'Categories',
  'Cash Flow',
] as const;
export function App() {
  const [state, setState] = useState<State | null>(null),
    [revision, setRevision] = useState(0),
    [loading, setLoading] = useState(true),
    [page, setPage] = useState('Dashboard'),
    [month, setMonth] = useState(today().slice(0, 7)),
    [modal, setModal] = useState<{ kind: string; id?: string } | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [sidebar, setSidebar] = useState(false),
    [connections, setConnections] = useState<any[]>([]),
    [configured, setConfigured] = useState(false),
    [sessionId, setSessionId] = useState(''),
    [plaidReturn, setPlaidReturn] = useState<string | undefined>(() =>
      window.location.pathname === '/plaid/oauth' ? window.location.href : undefined,
    ),
    [filters, setFilters] = useState<Record<string, string>>({});
  const openedPlaidReturn = useRef(false);
  const revisionRef = useRef(0);
  const sessionGeneration = useRef(0);
  const load = useCallback(async () => {
    const generation = sessionGeneration.current;
    try {
      const r = await api('/state');
      if (generation !== sessionGeneration.current) return;
      if (revisionRef.current === 0) setMonth(today(r.state.settings.timezone).slice(0, 7));
      setState(r.state);
      setRevision(r.revision);
      revisionRef.current = r.revision;
      setConnections(r.connections);
      setConfigured(r.plaidConfigured);
      setSessionId(r.sessionId ?? '');
    } catch (e: any) {
      if (generation === sessionGeneration.current && e.status !== 401) setError(e.message);
      if (generation === sessionGeneration.current && e.status === 401) {
        clearPlaidAttempt();
        if (window.location.pathname === '/plaid/oauth') {
          window.history.replaceState(null, '', '/');
          setPlaidReturn(undefined);
          setError('Sign in again, then restart your bank connection.');
        }
      }
    } finally {
      if (generation === sessionGeneration.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (state && plaidReturn && !openedPlaidReturn.current) {
      openedPlaidReturn.current = true;
      setModal({ kind: 'connections' });
    }
  }, [state, plaidReturn]);
  const run: Run = useCallback(
    async (command: Command) => {
      const generation = sessionGeneration.current;
      try {
        const r = await api('/command', { ...command, revision: revisionRef.current });
        if (generation !== sessionGeneration.current) throw Error('Workspace changed while saving');
        setState(r.state);
        setRevision(r.revision);
        revisionRef.current = r.revision;
        setNotice('Changes saved');
      } catch (e: any) {
        if (generation !== sessionGeneration.current) throw e;
        setError(e.message);
        if (e.status === 409) await load();
        throw e;
      }
    },
    [load],
  );
  const navigate = (name: string) => {
    setPage(name);
    window.scrollTo({ top: 0, behavior: 'instant' });
    setSelected(null);
    setSidebar(false);
  };
  const txNavigate = (filter: Record<string, string>) => {
    setFilters(filter);
    navigate('Transactions');
  };
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(t);
  }, [notice]);
  const dashboardState = page === 'Dashboard' ? state : null;
  const dashboardView = useMemo(
    () =>
      dashboardState
        ? { data: dashboard(dashboardState, month), worth: netWorth(dashboardState) }
        : null,
    [dashboardState, month],
  );
  const review = useMemo(
    () =>
      (state?.transactions ?? [])
        .filter((t) => !t.removed && !t.reviewed)
        .map((raw) => ({ raw, date: effective(raw).date }))
        .sort((a, b) => (a.date === b.date ? 0 : a.date > b.date ? -1 : 1))
        .map(({ raw }) => raw),
    [state?.transactions],
  );
  if (loading)
    return (
      <div className="boot">
        <p>Opening your workspace…</p>
      </div>
    );
  if (!state) return <Welcome onReady={load} message={error} />;
  const d = dashboardView?.data,
    worth = dashboardView?.worth,
    currency = state.settings.currency;
  const tx = selected ? state.transactions.find((t) => t.id === selected) : undefined;
  return (
    <div className="app-shell">
      <aside className={'sidebar ' + (sidebar ? 'open' : '')}>
        <div className="brand">
          asset
          <button
            className="icon-button mobile-only"
            aria-label="Close navigation"
            onClick={() => setSidebar(false)}
          >
            <PanelLeftClose size={17} />
          </button>
        </div>
        <nav aria-label="Main navigation">
          {sections.map((name) => (
            <button
              key={name}
              className={page === name ? 'active' : ''}
              aria-current={page === name ? 'page' : undefined}
              onClick={() => navigate(name)}
            >
              <span>{name}</span>
              {name === 'Transactions' && review.length > 0 && (
                <b className="nav-count">{review.length}</b>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-accounts">
          {[
            ['Cash', ['checking', 'savings']],
            ['Credit cards', ['credit']],
            ['Investments', ['investment']],
            ['Loans & other', ['loan', 'manual']],
          ].map(([label, types]) => (
            <section key={String(label)}>
              <h3>{label}</h3>
              {state.accounts
                .filter((a) => (types as string[]).includes(a.type))
                .map((a) => (
                  <button
                    key={a.id}
                    onClick={() => {
                      navigate('Accounts');
                      setSelected(a.id);
                    }}
                  >
                    <span className={'account-dot ' + a.type} />
                    <span>{a.name}</span>
                    <small>{money(a.balance, a.currency).replace(/\.00$/, '')}</small>
                  </button>
                ))}
            </section>
          ))}
        </div>
        <div className="sidebar-bottom">
          <button onClick={() => setModal({ kind: 'connections' })}>
            <Link2 size={16} />
            Connections
          </button>
          <button onClick={() => setModal({ kind: 'settings' })}>
            <Settings size={16} />
            Settings & data
          </button>
          <div className="workspace-label">
            <span className="avatar">{state.settings.demo ? 'D' : 'A'}</span>
            <span>
              {state.settings.demo ? 'Demo workspace' : 'My workspace'}
              <small>
                {state.settings.demo ? 'Synthetic data only' : 'Saved to this Asset server'}
              </small>
            </span>
            <button
              className="icon-button"
              aria-label="Sign out"
              onClick={async () => {
                await api('/auth/logout', {});
                sessionGeneration.current += 1;
                clearPlaidAttempt();
                revisionRef.current = 0;
                setSessionId('');
                setPlaidReturn(undefined);
                setState(null);
                setSelected(null);
                setModal(null);
                setNotice('');
                setError('');
              }}
            >
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <button
            className="icon-button mobile-only"
            onClick={() => setSidebar(true)}
            aria-label="Open navigation"
          >
            <Menu size={20} />
          </button>
          <h1>{page}</h1>
          <div className="topbar-actions">
            {state.settings.demo && (
              <span className="demo-pill" title="Synthetic data">
                Demo
              </span>
            )}
            <button
              className="quiet"
              aria-label="Import CSV"
              onClick={() => setModal({ kind: 'import' })}
            >
              <Upload size={15} />
              <span>Import</span>
            </button>
            <button
              className="primary small"
              aria-label={
                page === 'Accounts'
                  ? 'Add account'
                  : page === 'Categories'
                    ? 'Add category'
                    : page === 'Investments'
                      ? 'Add holding'
                      : 'Add transaction'
              }
              onClick={() =>
                setModal({
                  kind:
                    page === 'Accounts'
                      ? 'account'
                      : page === 'Categories'
                        ? 'category'
                        : page === 'Investments'
                          ? 'holding'
                          : 'manual',
                })
              }
            >
              <Plus size={16} />
              <span>
                {page === 'Accounts'
                  ? 'Account'
                  : page === 'Categories'
                    ? 'Category'
                    : page === 'Investments'
                      ? 'Holding'
                      : 'Transaction'}
              </span>
            </button>
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            {error}
            <button onClick={() => setError('')}>Dismiss</button>
          </div>
        )}
        {notice && (
          <div className="toast" role="status">
            <Check size={15} />
            {notice}
          </div>
        )}
        {page === 'Dashboard' && d && worth && (
          <div className="content">
            <div className="page-heading">
              <div></div>
              <MonthControl month={month} setMonth={setMonth} />
            </div>
            <div className="dashboard-grid">
              <section className="card spending-card">
                <div className="card-heading">
                  <h3>Monthly spending</h3>
                  <button
                    onClick={() => txNavigate({ start: month + '-01', end: monthEnd(month) })}
                  >
                    Transactions
                    <ChevronRight size={13} />
                  </button>
                </div>
                <div className="center-metric">
                  <strong>
                    {d.left === null
                      ? money(d.spending, currency)
                      : money(Math.abs(d.left), currency)}
                    <span> {d.left === null ? 'spent' : d.left >= 0 ? 'left' : 'over'}</span>
                  </strong>
                  <p>
                    {d.budget === null
                      ? 'No monthly budget set'
                      : `${money(d.budget, currency)} budgeted`}
                  </p>
                </div>
                <LineChart
                  points={d.points.map((p) => ({ date: p.date, value: p.actual, ideal: p.ideal }))}
                  forecast={d.projection}
                  currency={currency}
                  label="Actual monthly spending, ideal budget pace, and month-end estimate"
                  color="var(--accent)"
                />
                <div className="chart-legend">
                  <span>
                    <i className="legend-line actual" style={{ borderColor: 'var(--accent)' }} />
                    Actual
                  </span>
                  <span>
                    <i className="legend-line ideal" />
                    Ideal pace
                  </span>
                  {d.projection !== null && (
                    <span>
                      <i className="legend-line estimate" />
                      Estimate
                    </span>
                  )}
                </div>
                <div className="spending-footer">
                  <span className={'status ' + ((d.paceDifference ?? 0) >= 0 ? 'green' : 'amber')}>
                    {d.paceDifference === null
                      ? 'Budget not set'
                      : `${money(Math.abs(d.paceDifference), currency)} ${(d.paceDifference ?? 0) >= 0 ? 'under' : 'over'} ${d.historical ? 'budget' : 'pace'}`}
                  </span>
                  <span>
                    {d.projection !== null ? (
                      <>
                        Est. month end <b>{money(d.projection, currency)}</b>
                      </>
                    ) : d.historical ? (
                      'Completed month'
                    ) : !d.complete ? (
                      'Incomplete history · estimate unavailable'
                    ) : (
                      'No estimate yet'
                    )}
                  </span>
                </div>
                <Help>
                  Actuals include all posted spending less refunds, excluding transfers and
                  budget-excluded transactions. Ideal pace spreads the budget evenly through the
                  calendar month. Estimate = month-to-date spending ÷ {d.elapsed} elapsed calendar
                  days × {d.days} days. Early-month and lumpy spending can distort it. No future
                  bills have been deducted.
                </Help>
              </section>
              <WorthCard worth={worth} currency={currency} onOpen={() => navigate('Accounts')} />
              <section className="card review-card">
                <div className="card-heading">
                  <h3>
                    To review <span className="count">{review.length}</span>
                  </h3>
                  <button onClick={() => txNavigate({ review: 'unreviewed' })}>
                    View all
                    <ChevronRight size={13} />
                  </button>
                </div>
                {review.length ? (
                  <>
                    <TransactionRows
                      state={state}
                      items={review.slice(0, 5)}
                      onOpen={(t) => {
                        navigate('Transactions');
                        setSelected(t.id);
                      }}
                    />
                    <div className="card-footer">
                      <span>
                        {Math.min(review.length, 5)} of {review.length} transactions
                      </span>
                      <button
                        className="border-button"
                        onClick={() =>
                          void run({
                            type: 'transactions.review',
                            payload: { ids: review.slice(0, 5).map((t) => t.id), reviewed: true },
                          }).catch(() => {})
                        }
                      >
                        <Check size={14} />
                        Mark these {Math.min(review.length, 5)} reviewed
                      </button>
                    </div>
                  </>
                ) : (
                  <Empty title="Nothing to review">
                    New imports will appear here for your review.
                  </Empty>
                )}
              </section>
              <section className="card">
                <div className="card-heading">
                  <h3>Trending budgets</h3>
                  <button onClick={() => navigate('Categories')}>
                    Categories
                    <ChevronRight size={13} />
                  </button>
                </div>
                <div className="budget-list">
                  {d.categories.slice(0, 6).map((c) => (
                    <button
                      className="budget-row"
                      key={c.id}
                      onClick={() => {
                        navigate('Categories');
                        setSelected(c.id);
                      }}
                    >
                      <span className="budget-name">
                        <CategorySymbol category={c} />
                        {c.name}
                      </span>
                      <b>{money(c.spent, currency)}</b>
                      <span className="progress">
                        <i
                          style={{
                            width: `${Math.min(100, c.budget ? (c.spent / c.budget) * 100 : 0)}%`,
                            background: 'var(--progress)',
                          }}
                        />
                      </span>
                      <small>
                        {c.left === null
                          ? 'No budget'
                          : money(Math.abs(c.left), currency) + (c.left >= 0 ? ' left' : ' over')}
                      </small>
                    </button>
                  ))}
                </div>
              </section>
              <section className="card net-card">
                <div className="card-heading">
                  <h3>Net this month</h3>
                  <button onClick={() => navigate('Cash Flow')}>
                    Cash Flow
                    <ChevronRight size={13} />
                  </button>
                </div>
                <div className="net-body">
                  <div>
                    <strong className={d.netThisMonth.net >= 0 ? 'positive' : 'negative'}>
                      {money(d.netThisMonth.net, currency)}
                    </strong>
                    <p>
                      {d.historical ? 'Calendar month' : 'Month to date'}
                      {!d.netThisMonth.complete ? ' · incomplete history' : ''}
                    </p>
                  </div>
                  <div className="net-pair">
                    <span>
                      Income<b>{money(d.netThisMonth.income, currency)}</b>
                    </span>
                    <span>
                      Spending<b>{money(d.netThisMonth.spending, currency)}</b>
                    </span>
                  </div>
                </div>
                <p className="muted tiny">
                  {state.settings.includeExcludedCashflow ? 'Includes' : 'Excludes'} budget-excluded
                  spending. Actual activity only.
                </p>
              </section>
            </div>
          </div>
        )}
        {page === 'Transactions' && (
          <Transactions
            state={state}
            run={run}
            selected={selected}
            setSelected={setSelected}
            filters={filters}
            setFilters={setFilters}
          />
        )}
        {page === 'Categories' && (
          <Categories
            state={state}
            run={run}
            month={month}
            setMonth={setMonth}
            selected={selected}
            setSelected={setSelected}
            edit={(id) => setModal({ kind: 'category', id })}
            drill={txNavigate}
          />
        )}
        {page === 'Accounts' && (
          <Accounts
            state={state}
            run={run}
            selected={selected}
            setSelected={setSelected}
            edit={(id) => setModal({ kind: 'account', id })}
            drill={txNavigate}
          />
        )}
        {page === 'Investments' && (
          <Investments
            state={state}
            selected={selected}
            setSelected={setSelected}
            edit={(id) => setModal({ kind: 'holding', id })}
          />
        )}
        {page === 'Cash Flow' && (
          <CashFlow state={state} run={run} month={month} setMonth={setMonth} drill={txNavigate} />
        )}
      </main>
      {page === 'Transactions' && tx && (
        <TransactionEditor
          key={tx.id}
          transaction={tx}
          state={state}
          run={run}
          onClose={() => setSelected(null)}
        />
      )}
      {modal?.kind === 'manual' && (
        <ManualTransaction state={state} run={run} onClose={() => setModal(null)} />
      )}
      {modal?.kind === 'category' && (
        <CategoryEditor
          state={state}
          run={run}
          id={modal.id}
          month={month}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === 'account' && (
        <AccountEditor state={state} run={run} id={modal.id} onClose={() => setModal(null)} />
      )}
      {modal?.kind === 'holding' && (
        <HoldingEditor state={state} run={run} id={modal.id} onClose={() => setModal(null)} />
      )}
      {modal?.kind === 'import' && (
        <ImportDialog state={state} run={run} onClose={() => setModal(null)} />
      )}
      {modal?.kind === 'settings' && (
        <SettingsDialog state={state} run={run} onClose={() => setModal(null)} />
      )}
      {modal?.kind === 'connections' && (
        <ConnectionsDialog
          key={sessionId}
          state={state}
          connections={connections}
          configured={configured}
          sessionId={sessionId}
          receivedRedirectUri={plaidReturn}
          load={load}
          onClose={() => {
            setModal(null);
            setPlaidReturn(undefined);
          }}
        />
      )}
    </div>
  );
}
function Welcome({ onReady, message = '' }: { onReady: () => Promise<void>; message?: string }) {
  const [error, setError] = useState(
      () =>
        message ||
        (new URLSearchParams(window.location.search).has('auth_error')
          ? 'Google sign-in was not completed. Please try again.'
          : ''),
    ),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('auth_error'))
      window.history.replaceState(null, '', window.location.pathname);
  }, []);
  async function go(google: boolean) {
    clearPlaidAttempt();
    setBusy(true);
    setError('');
    try {
      if (google) {
        const { url } = await api('/auth/google/start', {});
        window.location.assign(url);
      } else {
        await api('/auth/demo', {});
        await onReady();
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="welcome">
      <div className="welcome-card">
        <h1 className="brand">asset</h1>
        <p>Track spending, budgets, accounts, and investments.</p>
        <button className="primary full" disabled={busy} onClick={() => void go(true)}>
          {busy ? 'Opening…' : 'Continue with Google'}
        </button>
        <p className="tiny muted">Your private workspace, across your devices.</p>
        <div className="divider" />
        <button className="border-button full" disabled={busy} onClick={() => void go(false)}>
          Explore the demo
        </button>
        <p className="tiny muted">Sample data. No bank connection needed.</p>
        {error && (
          <p role="alert" className="negative">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
export function TransactionRows({
  state,
  items,
  onOpen,
}: {
  state: State;
  items: Transaction[];
  onOpen: (t: Transaction) => void;
}) {
  let last = '';
  return (
    <div className="transaction-rows">
      {items.map((raw) => {
        const t = effective(raw),
          date = last !== t.date;
        last = t.date;
        return (
          <React.Fragment key={t.id}>
            {date && (
              <div className="date-label">
                {new Date(t.date + 'T12:00:00').toLocaleDateString('en-US', {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                })}
              </div>
            )}
            <button className="transaction-row" onClick={() => onOpen(raw)}>
              <span className="row-merchant">
                {t.name}
                <small>
                  {state.accounts.find((a) => a.id === t.accountId)?.name}
                  {t.pending ? ' · Pending' : ''}
                </small>
              </span>
              <Badge category={state.categories.find((c) => c.id === t.categoryId)} />
              <span
                className={
                  'amount ' + (t.kind === 'income' || t.kind === 'refund' ? 'positive' : '')
                }
              >
                {t.kind === 'income' || t.kind === 'refund' ? '+' : ''}
                {money(t.amount, t.currency)}
                {!t.reviewed && <i className="review-dot" aria-label="To review" />}
              </span>
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}
function WorthCard({
  worth,
  currency,
  onOpen,
}: {
  worth: ReturnType<typeof netWorth>;
  currency: string;
  onOpen: () => void;
}) {
  const [range, setRange] = useState('1Y');
  return (
    <section className="card worth-card">
      <div className="card-heading">
        <h3>Net worth</h3>
        <button onClick={onOpen}>
          Accounts
          <ChevronRight size={13} />
        </button>
      </div>
      <div className="center-metric">
        <span>Net worth</span>
        <strong>{money(worth.total, currency)}</strong>
        <p>{worth.complete ? 'Assets minus debts' : 'Some balances unavailable'}</p>
      </div>
      <LineChart
        points={filterHistory(worth.history, range, today())
          .filter((p) => p.complete)
          .map((p) => ({ date: p.date, value: p.value }))}
        currency={currency}
        label="Net worth history"
      />
      <RangeControl value={range} onChange={setRange} />
      <div className="worth-footer">
        <span>
          <i className="account-dot savings" />
          Assets <b>{money(worth.assets, currency)}</b>
        </span>
        <span>
          <i className="account-dot credit" />
          Debts <b>{money(worth.debt, currency)}</b>
        </span>
      </div>
    </section>
  );
}
const transactionDateFormatter = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
const TransactionListRow = React.memo(function TransactionListRow({
  entry,
  index,
  showDate,
  accountName,
  category,
  checked,
  selected,
  onToggle,
  onOpen,
  onFocusRow,
  run,
}: {
  entry: TransactionIndexEntry;
  index: number;
  showDate: boolean;
  accountName?: string;
  category?: State['categories'][number];
  checked: boolean;
  selected: boolean;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  onFocusRow: (index: number, direction: number) => void;
  run: Run;
}) {
  const t = entry.transaction;
  return (
    <>
      {showDate && (
        <div className="date-label">
          {transactionDateFormatter.format(new Date(t.date + 'T12:00:00Z'))}
        </div>
      )}
      <div
        className={'tx-row ' + (checked || selected ? 'selected' : '')}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.target instanceof HTMLInputElement) return;
          if (e.key.toLowerCase() === 'r') {
            void run({
              type: 'transactions.review',
              payload: { ids: [t.id], reviewed: true },
            }).catch(() => {});
          }
          if (e.key.toLowerCase() === 'x') onToggle(t.id);
          if (e.key === 'Enter' || e.key.toLowerCase() === 'c') onOpen(t.id);
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            onFocusRow(index, e.key === 'ArrowDown' ? 1 : -1);
          }
        }}
      >
        <input
          type="checkbox"
          aria-label={`Select ${t.name} ${t.date}`}
          checked={checked}
          onChange={() => onToggle(t.id)}
        />
        <button className="tx-open" onClick={() => onOpen(t.id)}>
          <span className="row-merchant">
            {t.name}
            <small>
              {accountName}
              {t.pending ? ' · Pending' : ''}
              {t.excluded ? ' · Excluded' : ''}
              {t.splits.length ? ` · ${t.splits.length} splits` : ''}
            </small>
          </span>
          <Badge category={category} />
          <span
            className={'amount ' + (t.kind === 'refund' || t.kind === 'income' ? 'positive' : '')}
          >
            {['refund', 'income'].includes(t.kind) ? '+' : ''}
            {money(t.amount, t.currency)}
            {!t.reviewed && <i className="review-dot" aria-label="To review" />}
          </span>
        </button>
      </div>
    </>
  );
});
function Transactions({
  state,
  run,
  selected,
  setSelected,
  filters,
  setFilters,
}: {
  state: State;
  run: Run;
  selected: string | null;
  setSelected: (id: string | null) => void;
  filters: Record<string, string>;
  setFilters: (f: Record<string, string>) => void;
}) {
  const filterKey = transactionFilterKey(filters);
  const [windowState, setWindowState] = useState({
    filterKey,
    limit: TRANSACTION_PAGE_SIZE,
    checked: [] as string[],
  });
  const sentinel = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<number | null>(null);
  const mounted = useRef(true);
  const reviewingRef = useRef(false);
  const [reviewing, setReviewing] = useState(false);
  const index = useMemo(() => createTransactionIndex(state.transactions), [state.transactions]);
  const list = useMemo(() => filterTransactionIndex(index, filters), [index, filterKey]);
  const matchingIDs = useMemo(() => new Set(list.map((entry) => entry.transaction.id)), [list]);
  const activeWindow =
    windowState.filterKey === filterKey
      ? windowState
      : { filterKey, limit: TRANSACTION_PAGE_SIZE, checked: [] as string[] };
  const checked = useMemo(
    () => activeWindow.checked.filter((id) => matchingIDs.has(id)),
    [activeWindow.checked, matchingIDs],
  );
  const checkedSet = useMemo(() => new Set(checked), [checked]);
  const visible = useMemo(() => list.slice(0, activeWindow.limit), [list, activeWindow.limit]);
  const hasMore = visible.length < list.length;
  const canLoadMore = useRef(hasMore);
  canLoadMore.current = hasMore;
  const accountNames = useMemo(
    () => new Map(state.accounts.map((a) => [a.id, a.name])),
    [state.accounts],
  );
  const categories = useMemo(
    () => new Map(state.categories.map((c) => [c.id, c])),
    [state.categories],
  );
  const asOf = today(state.settings.timezone);
  const sums = useMemo(
    () =>
      totals(
        { ...state, transactions: list.map((entry) => entry.raw) },
        '1900-01-01',
        asOf,
        false,
        filters.category,
      ),
    [state, list, asOf, filters.category],
  );
  const setChecked = useCallback(
    (update: string[] | ((ids: string[]) => string[])) => {
      setWindowState((current) => {
        const base =
          current.filterKey === filterKey
            ? current
            : { filterKey, limit: TRANSACTION_PAGE_SIZE, checked: [] as string[] };
        const ids = base.checked.filter((id) => matchingIDs.has(id));
        return { ...base, checked: typeof update === 'function' ? update(ids) : update };
      });
    },
    [filterKey, matchingIDs],
  );
  const toggleChecked = useCallback(
    (id: string) => {
      setChecked((ids) =>
        ids.includes(id) ? ids.filter((existing) => existing !== id) : [...ids, id],
      );
    },
    [setChecked],
  );
  const loadMore = useCallback(() => {
    setWindowState((current) => {
      const base =
        current.filterKey === filterKey
          ? current
          : { filterKey, limit: TRANSACTION_PAGE_SIZE, checked: [] as string[] };
      const limit = nextTransactionLimit(base.limit, list.length);
      return limit === base.limit ? base : { ...base, limit };
    });
  }, [filterKey, list.length]);
  const focusRow = useCallback(
    (row: number, direction: number) => {
      const rows = document.querySelectorAll<HTMLElement>('.full-transaction-list .tx-row');
      const next = row + direction;
      if (next === rows.length && canLoadMore.current) {
        pendingFocus.current = next;
        loadMore();
      } else {
        rows[Math.min(rows.length - 1, Math.max(0, next))]?.focus();
      }
    },
    [loadMore],
  );
  const change = (key: string, v: string) => {
    setFilters({ ...filters, [key]: v });
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    pendingFocus.current = null;
    setWindowState((current) => {
      if (current.filterKey !== filterKey)
        return { filterKey, limit: TRANSACTION_PAGE_SIZE, checked: [] };
      const ids = current.checked.filter((id) => matchingIDs.has(id));
      return ids.length === current.checked.length ? current : { ...current, checked: ids };
    });
  }, [filterKey, matchingIDs]);
  useEffect(() => {
    if (pendingFocus.current === null) return;
    document
      .querySelectorAll<HTMLElement>('.full-transaction-list .tx-row')
      [pendingFocus.current]?.focus();
    pendingFocus.current = null;
  }, [visible.length]);
  useEffect(() => {
    const element = sentinel.current;
    if (!element || !hasMore || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          loadMore();
        }
      },
      { rootMargin: '600px 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasMore, loadMore, visible.length]);
  return (
    <div className={'transactions-view ' + (selected ? 'has-detail' : '')}>
      <div className="filter-toolbar">
        <div className="search-box">
          <Search size={15} />
          <input
            aria-label="Search transactions"
            placeholder="Search merchants or notes"
            value={filters.search ?? ''}
            onChange={(e) => change('search', e.target.value)}
          />
        </div>
        <select
          aria-label="Review status"
          value={filters.review ?? ''}
          onChange={(e) => change('review', e.target.value)}
        >
          <option value="">All transactions</option>
          <option value="unreviewed">To review</option>
          <option value="reviewed">Reviewed</option>
        </select>
        <select
          aria-label="Filter account"
          value={filters.account ?? ''}
          onChange={(e) => change('account', e.target.value)}
        >
          <option value="">All accounts</option>
          {state.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter category"
          value={filters.category ?? ''}
          onChange={(e) => change('category', e.target.value)}
        >
          <option value="">All categories</option>
          {state.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter type"
          value={filters.type ?? ''}
          onChange={(e) => change('type', e.target.value)}
        >
          <option value="">All types</option>
          {transactionKinds.map((kind) => (
            <option key={kind} value={kind}>
              {transactionKindLabel(kind)}
            </option>
          ))}
        </select>
        <div className="date-filter-range" role="group" aria-label="Date range">
          <label className="date-filter">
            From
            <input
              aria-label="From date"
              type="date"
              value={filters.start ?? ''}
              onChange={(e) => change('start', e.target.value)}
            />
          </label>
          <label className="date-filter">
            To
            <input
              aria-label="To date"
              type="date"
              value={filters.end ?? ''}
              onChange={(e) => change('end', e.target.value)}
            />
          </label>
        </div>
        {Object.values(filters).some(Boolean) && (
          <button
            className="text-button"
            onClick={() => {
              setFilters({});
              setChecked([]);
            }}
          >
            Clear filters
          </button>
        )}
      </div>
      <div className="list-summary">
        <label>
          <input
            type="checkbox"
            aria-label={`Select ${visible.length} loaded transactions`}
            checked={
              visible.length > 0 &&
              visible.every(({ transaction }) => checkedSet.has(transaction.id))
            }
            onChange={(e) =>
              setChecked(e.target.checked ? visible.map(({ transaction }) => transaction.id) : [])
            }
          />
          {list.length} {list.length === 1 ? 'transaction' : 'transactions'}
        </label>
        <span>
          Posted spending{filters.category ? ' in category' : ''}{' '}
          <b>{money(sums.spending, state.settings.currency)}</b>
          <em>
            Income <b>{money(sums.income, state.settings.currency)}</b>
          </em>
        </span>
      </div>
      <div className="full-transaction-list">
        {visible.length === 0 ? (
          <Empty title="No matching transactions">
            Try another filter, add a transaction, or import a CSV.
          </Empty>
        ) : (
          visible.map((entry, i) => (
            <TransactionListRow
              key={entry.transaction.id}
              entry={entry}
              index={i}
              showDate={i === 0 || visible[i - 1].transaction.date !== entry.transaction.date}
              accountName={accountNames.get(entry.transaction.accountId)}
              category={categories.get(entry.transaction.categoryId)}
              checked={checkedSet.has(entry.transaction.id)}
              selected={selected === entry.transaction.id}
              onToggle={toggleChecked}
              onOpen={setSelected}
              onFocusRow={focusRow}
              run={run}
            />
          ))
        )}
      </div>
      <div className="transaction-load-more" ref={sentinel}>
        <span role="status" aria-live="polite" aria-atomic="true">
          {hasMore
            ? `${visible.length} of ${list.length} loaded`
            : `${list.length} ${list.length === 1 ? 'transaction' : 'transactions'} · End of list`}
        </span>
        {hasMore && <button onClick={loadMore}>Load more transactions</button>}
      </div>
      {checked.length > 0 && (
        <div className="bulk-bar">
          <b>{checked.length} selected</b>
          <button
            className="primary small"
            disabled={reviewing}
            onClick={async () => {
              if (reviewingRef.current) return;
              reviewingRef.current = true;
              setReviewing(true);
              const ids = [...checked];
              try {
                for (let offset = 0; offset < ids.length && mounted.current; offset += 10000) {
                  const batch = ids.slice(offset, offset + 10000);
                  await run({
                    type: 'transactions.review',
                    payload: { ids: batch, reviewed: true },
                  });
                  if (!mounted.current) break;
                  const saved = new Set(batch);
                  setWindowState((current) => ({
                    ...current,
                    checked: current.checked.filter((id) => !saved.has(id)),
                  }));
                }
              } catch {
                // run displays the error; keep the unsaved selection available to retry.
              } finally {
                reviewingRef.current = false;
                if (mounted.current) setReviewing(false);
              }
            }}
          >
            <Check size={14} />
            {reviewing ? 'Reviewing…' : 'Review selected'}
          </button>
          <button onClick={() => setChecked([])}>Clear</button>
        </div>
      )}
    </div>
  );
}
function Categories({
  state,
  run,
  month,
  setMonth,
  selected,
  setSelected,
  edit,
  drill,
}: {
  state: State;
  run: Run;
  month: string;
  setMonth: (m: string) => void;
  selected: string | null;
  setSelected: (id: string) => void;
  edit: (id: string) => void;
  drill: (f: Record<string, string>) => void;
}) {
  const d = dashboard(state, month),
    currency = state.settings.currency,
    c = d.categories.find((c) => c.id === selected);
  const groups = [...new Set(d.categories.map((c) => c.group))];
  return (
    <div className="content">
      <div className="page-heading">
        <div></div>
        <MonthControl month={month} setMonth={setMonth} />
      </div>
      <div className="split-layout">
        <div>
          <section className="card category-summary">
            <div>
              <strong>{money(d.spending, currency)}</strong>
              <span>spent this month</span>
            </div>
            <div
              className="donut"
              style={{
                background: `conic-gradient(${
                  d.categories
                    .filter((c) => c.spent > 0)
                    .map((c, i, arr) => {
                      const sum = arr.reduce((n, c) => n + c.spent, 0);
                      const before = (arr.slice(0, i).reduce((n, c) => n + c.spent, 0) / sum) * 100;
                      return `${c.color} ${before}% ${before + (c.spent / sum) * 100}%`;
                    })
                    .join(',') || 'var(--border)'
                })`,
              }}
            >
              <div />
            </div>
            <div>
              <strong>{money(d.budget, currency)}</strong>
              <span>total budget</span>
            </div>
          </section>
          <div className="category-table">
            <div className="table-labels">
              <span>Category</span>
              <span>Spent</span>
              <span>Monthly budget</span>
              <span>Remaining</span>
            </div>
            {groups.map((group) => (
              <section key={group}>
                <h3 className="group-heading">{group}</h3>
                {d.categories
                  .filter((c) => c.group === group)
                  .map((c) => (
                    <button
                      className={'category-table-row ' + (selected === c.id ? 'selected' : '')}
                      key={c.id}
                      onClick={() => setSelected(c.id)}
                    >
                      <span>
                        <CategorySymbol category={c} />
                        {c.name}
                      </span>
                      <b>{money(c.spent, currency)}</b>
                      <div>
                        <div className="progress">
                          <i
                            style={{
                              width: `${Math.min(100, Math.max(0, c.budget ? (c.spent / c.budget) * 100 : 0))}%`,
                              background: 'var(--progress)',
                            }}
                          />
                        </div>
                        <Status status={c.status} />
                      </div>
                      <span className={c.left !== null && c.left < 0 ? 'negative' : ''}>
                        {money(c.left, currency)}
                        <small>of {money(c.budget, currency)}</small>
                      </span>
                    </button>
                  ))}
              </section>
            ))}
          </div>
        </div>
        <aside className="detail-card">
          {c ? (
            <>
              <div className="detail-heading">
                <Badge category={c} />
                <button className="text-button" onClick={() => edit(c.id)}>
                  Edit
                </button>
              </div>
              <h2>{c.name}</h2>
              <strong className="detail-number">{money(c.spent, currency)}</strong>
              <p className="muted">Spent in {month}</p>
              <Status status={c.status} />
              <div className="divider" />
              <label>
                Budget for {month}
                <form
                  className="inline-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    await run({
                      type: 'budget.save',
                      payload: {
                        month,
                        categoryId: c.id,
                        amount: parseMoney(String(f.get('amount'))),
                      },
                    });
                  }}
                >
                  <input
                    key={c.id + month}
                    type="number"
                    min="0"
                    step=".01"
                    name="amount"
                    aria-label="Monthly category budget"
                    defaultValue={(c.budget ?? 0) / 100}
                  />
                  <button className="primary small">Save</button>
                </form>
              </label>
              <p className="tiny muted">Changes apply to this month only.</p>
              <button
                className="border-button full"
                onClick={() =>
                  drill({ category: c.id, start: month + '-01', end: monthEnd(month) })
                }
              >
                View transactions
                <ChevronRight size={14} />
              </button>
              <div className="divider" />
              <h3>Recent activity</h3>
              <TransactionRows
                state={state}
                items={state.transactions
                  .filter((t) => !t.removed && effective(t).categoryId === c.id)
                  .sort((a, b) => b.date.localeCompare(a.date))
                  .slice(0, 4)}
                onOpen={() => drill({ category: c.id })}
              />
            </>
          ) : (
            <Empty title="Select a category">
              Edit its monthly budget and view its transactions.
            </Empty>
          )}
        </aside>
      </div>
    </div>
  );
}
function Accounts({
  state,
  run,
  selected,
  setSelected,
  edit,
  drill,
}: {
  state: State;
  run: Run;
  selected: string | null;
  setSelected: (id: string) => void;
  edit: (id: string) => void;
  drill: (f: Record<string, string>) => void;
}) {
  const worth = netWorth(state),
    a = state.accounts.find((a) => a.id === selected),
    [range, setRange] = useState('1Y');
  return (
    <div className="content">
      <div className="page-heading">
        <div></div>
        <span className="muted tiny">Reporting in {state.settings.currency}</span>
      </div>
      {worth.otherCurrencies.length > 0 && (
        <p className="warning">
          {worth.otherCurrencies.join(', ')} accounts are displayed separately and excluded from{' '}
          {state.settings.currency} totals. No currency conversion is assumed.
        </p>
      )}
      <div className="split-layout">
        <div>
          <WorthCard worth={worth} currency={state.settings.currency} onOpen={() => {}} />
          <div className="account-groups">
            {['checking', 'savings', 'credit', 'investment', 'loan', 'manual'].map((type) => {
              const accounts = state.accounts.filter((a) => a.type === type);
              return (
                accounts.length > 0 && (
                  <section key={type}>
                    <h3 className="group-heading">
                      {type === 'credit'
                        ? 'Credit cards'
                        : type.charAt(0).toUpperCase() + type.slice(1)}
                    </h3>
                    {accounts.map((a) => (
                      <button
                        className={'account-list-row ' + (selected === a.id ? 'selected' : '')}
                        key={a.id}
                        onClick={() => setSelected(a.id)}
                      >
                        <span className={'account-avatar ' + a.type}>
                          <Landmark size={19} />
                        </span>
                        <span>
                          {a.name}
                          <small>
                            {a.source === 'demo'
                              ? 'Demo data'
                              : a.source === 'manual'
                                ? 'Manual account'
                                : a.source === 'csv'
                                  ? 'CSV import'
                                  : 'Plaid cached balance'}{' '}
                            · {a.mask ?? a.currency}
                            {!a.enabled ? ' · Sync account disabled' : ''}
                          </small>
                        </span>
                        <b>
                          {money(a.balance, a.currency)}
                          <small>
                            {a.includeInNetWorth
                              ? 'Included in net worth'
                              : 'Excluded from net worth'}
                          </small>
                        </b>
                      </button>
                    ))}
                  </section>
                )
              );
            })}
          </div>
          {state.accounts.length === 0 && (
            <Empty title="No accounts">
              Add a manual account or connect Plaid Sandbox from Connections.
            </Empty>
          )}
        </div>
        <aside className="detail-card">
          {a ? (
            <>
              <div className="detail-heading">
                <span className={'account-avatar ' + a.type}>
                  <Landmark size={19} />
                </span>
                <button className="text-button" onClick={() => edit(a.id)}>
                  Edit account
                </button>
              </div>
              <h2>{a.name}</h2>
              <strong className="detail-number">{money(a.balance, a.currency)}</strong>
              <p className="muted tiny">
                {a.source} · updated {new Date(a.updatedAt).toLocaleString()}
              </p>
              {new Date(a.updatedAt).getTime() < Date.now() - 4 * 864e5 && (
                <Status status="Stale balance" />
              )}
              <LineChart
                compact
                currency={a.currency}
                points={filterHistory(
                  state.snapshots
                    .filter((p) => p.accountId === a.id)
                    .sort((a, b) => a.date.localeCompare(b.date)),
                  range,
                  today(),
                ).map((p) => ({ date: p.date, value: p.balance }))}
                label={`${a.name} balance history`}
              />
              <RangeControl value={range} onChange={setRange} />
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={a.includeInNetWorth}
                  onChange={(e) =>
                    void run({
                      type: 'account.save',
                      payload: { ...a, includeInNetWorth: e.target.checked },
                    }).catch(() => {})
                  }
                />
                Include in net worth
              </label>
              <p className="tiny muted">
                This does not change spending totals or hide the account balance.
              </p>
              <button className="border-button full" onClick={() => drill({ account: a.id })}>
                Related transactions
                <ChevronRight size={14} />
              </button>
              <div className="divider" />
              <h3>History coverage</h3>
              <p className="muted tiny">
                {a.coverageStart
                  ? `${a.coverageStart} to ${a.coverageEnd}`
                  : 'Coverage not established'}
                {!a.coverageComplete ? ' · incomplete' : ''}
              </p>
              <p className="tiny muted">
                Balance history contains recorded snapshots only. Earlier balances are not inferred
                from transactions.
              </p>
            </>
          ) : (
            <Empty title="Select an account">
              Select an account for its history and transactions.
            </Empty>
          )}
        </aside>
      </div>
    </div>
  );
}
function Investments({
  state,
  selected,
  setSelected,
  edit,
}: {
  state: State;
  selected: string | null;
  setSelected: (id: string) => void;
  edit: (id: string) => void;
}) {
  const [account, setAccount] = useState('all'),
    [range, setRange] = useState('1Y');
  const v = investmentOverview(state, account),
    h = v.holdings.find((h) => h.id === selected);
  return (
    <div className="content">
      <div className="page-heading">
        <div></div>
        <select
          aria-label="Investment account"
          value={account}
          onChange={(e) => setAccount(e.target.value)}
        >
          <option value="all">All investment accounts</option>
          {state.accounts
            .filter((a) => a.type === 'investment')
            .map((a) => (
              <option value={a.id} key={a.id}>
                {a.name}
              </option>
            ))}
        </select>
      </div>
      <div className="split-layout">
        <div>
          <section className="card">
            <div className="card-heading">
              <h3>Portfolio value</h3>
              <span className="muted tiny">Recorded valuations</span>
            </div>
            <div className="center-metric">
              <strong>{money(v.accountBalance, state.settings.currency)}</strong>
              <p>
                Account balances · {v.accounts.length}{' '}
                {v.accounts.length === 1 ? 'account' : 'accounts'}
              </p>
            </div>
            <LineChart
              points={filterHistory(v.history, range, today())
                .filter((p) => p.complete)
                .map((p) => ({ date: p.date, value: p.value }))}
              label="Portfolio balance history"
              currency={state.settings.currency}
            />
            <RangeControl value={range} onChange={setRange} />
            <div className="info-note">
              <b>Investment return unavailable</b>
              <p>{v.returnReason}</p>
            </div>
          </section>
          <section className="card allocation">
            <div className="card-heading">
              <h3>Allocation</h3>
              <span className="muted tiny">
                Known holdings · {money(v.value, state.settings.currency)}
              </span>
            </div>
            <div className="allocation-bar">
              {Object.entries(v.allocation).map(([type, value], i) => (
                <div
                  key={type}
                  title={`${type} ${money(value, state.settings.currency)}`}
                  style={{
                    width: `${v.value ? (value / v.value) * 100 : 0}%`,
                    background: `var(--series-${(i % 4) + 1})`,
                  }}
                />
              ))}
            </div>
            <div className="allocation-legend">
              {Object.entries(v.allocation).map(([type, value], i) => (
                <span key={type}>
                  <i style={{ background: `var(--series-${(i % 4) + 1})` }} />
                  {type}
                  <b>{v.value ? ((value / v.value) * 100).toFixed(1) : '0'}%</b>
                </span>
              ))}
            </div>
            {(!v.complete || v.accountBalance !== v.value) && (
              <p className="tiny muted">
                {!v.complete ? 'Some holding valuations are unavailable. ' : ''}Account balance and
                holdings may differ due to cash, missing holdings, or valuation timestamps.
                Difference: {money(v.accountBalance - v.value, state.settings.currency)}.
              </p>
            )}
          </section>
          <section className="card holdings">
            <div className="card-heading">
              <h3>Holdings</h3>
              <span className="muted tiny">Quantity · market value</span>
            </div>
            {v.holdings.length ? (
              v.holdings.map((h) => (
                <button
                  className={'holding-row ' + (selected === h.id ? 'selected' : '')}
                  key={h.id}
                  onClick={() => setSelected(h.id)}
                >
                  <span className="ticker-icon">{h.symbol.slice(0, 3)}</span>
                  <span>
                    <b>{h.symbol}</b>
                    <small>{h.name}</small>
                  </span>
                  <span>
                    {h.quantity}
                    <small>shares / units</small>
                  </span>
                  <span>
                    <b>{money(h.marketValue, h.currency)}</b>
                    <small className={h.stale ? 'negative' : ''}>
                      {h.stale ? 'Stale price' : (h.priceAt?.slice(0, 10) ?? 'No price')}
                    </small>
                  </span>
                </button>
              ))
            ) : (
              <Empty title="No holdings yet">
                Add a manual holding or connect a supported brokerage in Sandbox.
              </Empty>
            )}
          </section>
        </div>
        <aside className="detail-card">
          {h ? (
            <>
              <div className="detail-heading">
                <span className="muted">{h.type}</span>
                {h.source !== 'plaid' && (
                  <button className="text-button" onClick={() => edit(h.id)}>
                    Edit holding
                  </button>
                )}
              </div>
              <p className="eyebrow">{h.symbol}</p>
              <h2>{h.name}</h2>
              <strong className="detail-number">{money(h.price, h.currency)}</strong>
              <p className="muted tiny">Price as of {h.priceAt ?? 'unavailable'}</p>
              {h.stale && <Status status="Stale price" />}
              <div className="divider" />
              <dl className="metrics">
                <dt>Quantity</dt>
                <dd>{h.quantity}</dd>
                <dt>Market value</dt>
                <dd>{money(h.marketValue, h.currency)}</dd>
                <dt>Cost basis</dt>
                <dd>{money(h.costBasis, h.currency)}</dd>
                <dt>Unrealized gain</dt>
                <dd>{money(h.gain, h.currency)}</dd>
                <dt>Gain / basis</dt>
                <dd>{h.gainPercent === null ? 'Unavailable' : h.gainPercent.toFixed(2) + '%'}</dd>
              </dl>
              <p className="tiny muted">
                Position gain is not your portfolio's cash-flow-adjusted return. No real-time quote
                feed is connected.
              </p>
              <h3>Account</h3>
              <p>{state.accounts.find((a) => a.id === h.accountId)?.name}</p>
            </>
          ) : (
            <Empty title="Select a holding">View its quantity, value, and last price update.</Empty>
          )}
        </aside>
      </div>
    </div>
  );
}
function CashFlow({
  state,
  run,
  month,
  setMonth,
  drill,
}: {
  state: State;
  run: Run;
  month: string;
  setMonth: (s: string) => void;
  drill: (f: Record<string, string>) => void;
}) {
  const [mode, setMode] = useState<'month' | 'year'>('month'),
    [year, setYear] = useState(month.slice(0, 4));
  const c = cashflow(state, mode, mode === 'month' ? month : year),
    currency = state.settings.currency;
  return (
    <div className="content">
      <div className="page-heading">
        <div>
          <p>
            {c.start} — {c.end}
            {c.current ? ' · to date' : ''}
            {!c.complete ? ' · incomplete history' : ''}
          </p>
        </div>
        <div className="period-controls">
          <div className="segmented">
            <button
              className={mode === 'month' ? 'active' : ''}
              aria-pressed={mode === 'month'}
              onClick={() => setMode('month')}
            >
              Month
            </button>
            <button
              className={mode === 'year' ? 'active' : ''}
              aria-pressed={mode === 'year'}
              onClick={() => setMode('year')}
            >
              Year
            </button>
          </div>
          {mode === 'month' ? (
            <MonthControl month={month} setMonth={setMonth} />
          ) : (
            <div className="year-control">
              <button onClick={() => setYear(String(Number(year) - 1))}>‹</button>
              <input
                aria-label="Calendar year"
                type="number"
                min="1900"
                max="2100"
                value={year}
                onChange={(e) => setYear(e.target.value)}
              />
              <button onClick={() => setYear(String(Number(year) + 1))}>›</button>
            </div>
          )}
        </div>
      </div>
      <label className="check-label cash-toggle">
        <input
          type="checkbox"
          checked={state.settings.includeExcludedCashflow}
          onChange={(e) =>
            void run({
              type: 'settings.save',
              payload: { includeExcludedCashflow: e.target.checked },
            }).catch(() => {})
          }
        />
        Include budget-excluded spending <small>Also applies to Dashboard net this month</small>
      </label>
      <div className="cash-grid">
        {(['net', 'spending', 'income'] as const).map((key) => (
          <section className="card cash-card" key={key}>
            <div className="card-heading">
              <h3>{key === 'net' ? 'Net income' : key === 'spending' ? 'Spending' : 'Income'}</h3>
              <button
                onClick={() =>
                  drill({
                    start: c.start,
                    end: c.end,
                    ...(key === 'income' ? { type: 'income' } : {}),
                  })
                }
              >
                Transactions
                <ChevronRight size={13} />
              </button>
            </div>
            <strong
              className={
                'cash-number ' + (key === 'net' ? (c.net >= 0 ? 'positive' : 'negative') : '')
              }
            >
              {money(c[key], currency)}
            </strong>
            <p className="comparison">
              {c.comparison[key] === null ? (
                !c.prior.complete ? (
                  'Missing prior history'
                ) : !c.complete ? (
                  'Current history incomplete'
                ) : c.prior[key] === 0 ? (
                  'No percentage comparison: prior value is zero'
                ) : (
                  'Unavailable'
                )
              ) : (
                <>
                  <span className="status muted">
                    {c.comparison[key]! > 0 ? '+' : ''}
                    {c.comparison[key]!.toFixed(1)}%
                  </span>{' '}
                  versus {money(c.prior[key], currency)}
                </>
              )}
            </p>
            {mode === 'year' ? (
              <div className="bars" aria-label={`${key} by calendar month`}>
                {c.months.map((m, i) => {
                  const max = Math.max(1, ...c.months.map((m) => Math.abs(m[key])));
                  return (
                    <button
                      key={m.month}
                      className={'month-bar ' + (m.future ? 'future' : '')}
                      title={`${m.month}: ${m.future ? 'Future period' : !m.complete ? 'Incomplete history; known total ' + money(m[key], currency) : money(m[key], currency)}`}
                      onClick={() => {
                        setMonth(m.month);
                        setMode('month');
                      }}
                    >
                      <span className="bar-space">
                        <i
                          style={{
                            height: `${m.future ? 0 : Math.max(1, (Math.abs(m[key]) / max) * 100)}%`,
                            background:
                              key === 'spending'
                                ? 'transparent'
                                : m[key] < 0
                                  ? 'var(--error)'
                                  : 'var(--accent)',
                            opacity: m.future ? 0 : !m.complete ? 0.45 : 1,
                            display: 'flex',
                            flexDirection: 'column-reverse',
                          }}
                        >
                          {key === 'spending' &&
                            Object.entries(m.categories)
                              .filter(([, v]) => v > 0)
                              .map(([id, value]) => (
                                <span
                                  key={id}
                                  style={{
                                    display: 'block',
                                    width: '100%',
                                    height: `${
                                      (value /
                                        Math.max(
                                          1,
                                          Object.values(m.categories)
                                            .filter((v) => v > 0)
                                            .reduce((a, b) => a + b, 0),
                                        )) *
                                      100
                                    }%`,
                                    background:
                                      state.categories.find((c) => c.id === id)?.color ??
                                      'var(--muted)',
                                  }}
                                />
                              ))}
                        </i>
                      </span>
                      <small>
                        {new Date(2026, i, 1).toLocaleDateString('en-US', { month: 'short' })}
                      </small>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="cash-month-bar">
                <span
                  style={{
                    width: `${key === 'net' ? Math.min(100, (Math.abs(c.net) / Math.max(1, c.income)) * 100) : 100}%`,
                    background: c[key] < 0 ? 'var(--error)' : 'var(--accent)',
                  }}
                />
                <p>
                  {key === 'net'
                    ? 'Income minus actual spending'
                    : key === 'spending'
                      ? 'Posted spending minus refunds'
                      : 'Posted income only'}
                </p>
              </div>
            )}
            <p className="tiny muted">
              Previous: {c.priorStart} — {c.priorEnd}
            </p>
          </section>
        ))}
      </div>
      <section className="card">
        <div className="card-heading">
          <h3>Spending by category</h3>
          <span className="muted tiny">
            Actual activity · {state.settings.includeExcludedCashflow ? 'including' : 'excluding'}{' '}
            excluded spend
          </span>
        </div>
        <div className="cash-category-grid">
          {Object.entries(c.categories)
            .sort((a, b) => b[1] - a[1])
            .map(([id, value]) => {
              const category = state.categories.find((x) => x.id === id);
              return (
                <button
                  className="cash-category"
                  key={id}
                  onClick={() => drill({ category: id, start: c.start, end: c.end })}
                >
                  <Badge category={category} />
                  <div className="progress">
                    <i
                      style={{
                        background: category?.color,
                        width: `${Math.max(0, (value / Math.max(1, c.spending)) * 100)}%`,
                      }}
                    />
                  </div>
                  <b>{money(value, currency)}</b>
                  <ChevronRight size={14} />
                </button>
              );
            })}
        </div>
        {Object.keys(c.categories).length === 0 && (
          <Empty title={c.complete ? 'No spending this period' : 'History not available'}>
            {c.complete
              ? 'There is no posted spending in this period.'
              : 'Import history or select another period. Missing history is not zero activity.'}
          </Empty>
        )}
      </section>
    </div>
  );
}
