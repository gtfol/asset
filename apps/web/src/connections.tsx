import React, { useEffect, useRef, useState } from 'react';
import {
  usePlaidLink,
  type PlaidLinkOnSuccessMetadata,
  type PlaidLinkOnExitMetadata,
  type PlaidLinkOnEventMetadata,
  type PlaidLinkError,
} from 'react-plaid-link';
import { api, type Run } from './App';
import { VenmoConnection } from './venmo';
import { AccountLinks } from './account-links';
import { Modal, Status } from './components';
import { money, type State } from '../shared/core';
import {
  clearPlaidAttempt,
  createPlaidAttempt,
  plaidExitMessage,
  PlaidLinkDiagnostics,
  plaidRedirect,
  readPlaidAttempt,
  savePlaidAttempt,
  type PlaidAttempt,
  type PlaidProduct,
  type PlaidErrorDetails,
} from './plaid-link';

interface PlaidConfig {
  configured: boolean;
  environment: string;
  clientIdLast4?: string;
  supportedEnvironments: string[];
  workerReady: boolean;
  storageReady: boolean;
  redirectUri?: string;
}

function PlaidButton({
  attempt,
  redirect,
  onOpen,
  onSuccess,
  onExit,
  onEvent,
}: {
  attempt: PlaidAttempt;
  redirect?: string;
  onOpen: () => void;
  onSuccess: (token: string | null, metadata: PlaidLinkOnSuccessMetadata) => void;
  onExit: (error: PlaidLinkError | null, metadata?: PlaidLinkOnExitMetadata) => void;
  onEvent: (name: string, metadata: PlaidLinkOnEventMetadata) => void;
}) {
  const opened = useRef(false);
  const launched = useRef(false);
  const [opening, setOpening] = useState(false);
  const { open, ready, error } = usePlaidLink({
    token: attempt.token,
    receivedRedirectUri: redirect,
    onSuccess,
    onExit,
    onEvent,
  });
  function launch() {
    if (!ready || opened.current) return;
    if (attempt.expiresAt <= Date.now()) {
      onExit({
        display_message: 'This connection session expired. Please start again.',
      } as PlaidLinkError);
      return;
    }
    opened.current = true;
    setOpening(true);
    onOpen();
  }
  useEffect(() => {
    if (!opening || launched.current) return;
    launched.current = true;
    // Modal closes in its layout effect before Plaid adds its own overlay.
    // Keep this hook mounted so Link can deliver exit and success callbacks.
    try {
      open();
    } catch {
      onExit({
        display_message: 'Plaid could not open. Please start a new connection.',
      } as PlaidLinkError);
    }
  }, [opening, open, onExit]);
  useEffect(() => {
    if (redirect && ready) launch();
  }, [redirect, ready, open]);
  return (
    <>
      <button className="primary" disabled={!ready || opening} onClick={launch}>
        {opening ? 'Connection open…' : ready ? 'Open Plaid' : 'Preparing connection…'}
      </button>
      {error && (
        <p className="form-error" role="alert">
          Plaid could not load. Check your connection and try again.
        </p>
      )}
    </>
  );
}

export function ConnectionsDialog({
  state,
  connections,
  configured,
  sessionId,
  receivedRedirectUri,
  load,
  run,
  onClose,
}: {
  state: State;
  connections: any[];
  configured: boolean;
  sessionId: string;
  receivedRedirectUri?: string;
  load: () => Promise<void>;
  run: Run;
  onClose: () => void;
}) {
  const [resume] = useState(() => {
    if (!receivedRedirectUri) return { attempt: null, redirect: undefined, error: '' };
    const redirect = plaidRedirect(receivedRedirectUri, window.location.origin);
    const attempt = redirect ? readPlaidAttempt(sessionId) : null;
    if (!attempt) clearPlaidAttempt();
    return {
      attempt,
      redirect,
      error: attempt
        ? ''
        : 'This bank sign-in has expired or belongs to another session. Start a new connection.',
    };
  });
  const [product, setProduct] = useState<PlaidProduct>(resume.attempt?.product ?? 'transactions');
  const [attempt, setAttempt] = useState<PlaidAttempt | null>(resume.attempt);
  const [linkOpen, setLinkOpen] = useState(false);
  const [error, setError] = useState(resume.error);
  const [errorDetails, setErrorDetails] = useState<PlaidErrorDetails | null>(null);
  const diagnostics = useRef(new PlaidLinkDiagnostics(resume.attempt?.id));
  const [busy, setBusy] = useState('');
  const [config, setConfig] = useState<PlaidConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(!state.settings.demo);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [environment, setEnvironment] = useState('production');
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [remove, setRemove] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const active = useRef(attempt);
  const operating = useRef(false);
  const mounted = useRef(true);
  const locked = !!busy || !!attempt || configLoading;
  const hasConnections = connections.some((c) => c.status !== 'disconnected');
  const savedSandbox = config?.configured === true && config.environment === 'sandbox';
  const showEnvironment =
    config &&
    (config.supportedEnvironments.length !== 1 || config.supportedEnvironments[0] !== 'production');
  const connectionAPI = (
    path: string,
    body?: unknown,
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE',
  ) => api(path, body, method, sessionId);

  useEffect(() => {
    let current = true;
    mounted.current = true;
    diagnostics.current.start(active.current?.id);
    if (receivedRedirectUri) window.history.replaceState(null, '', '/');
    if (!state.settings.demo) {
      void connectionAPI('/plaid/config')
        .then((result) => {
          if (!current) return;
          setConfig(result);
          setEnvironment(result.environment);
        })
        .catch((e) => {
          if (current) setError(e.message);
        })
        .finally(() => {
          if (current) setConfigLoading(false);
        });
    }
    return () => {
      current = false;
      mounted.current = false;
      diagnostics.current.start();
    };
  }, []);

  function discardAttempt() {
    diagnostics.current.start();
    setErrorDetails(null);
    active.current = null;
    setLinkOpen(false);
    setAttempt(null);
    clearPlaidAttempt();
  }
  function close() {
    if (operating.current) return;
    discardAttempt();
    setSecret('');
    onClose();
  }
  async function operate(label: string, action: () => Promise<void>) {
    if (operating.current || active.current || !mounted.current) return;
    operating.current = true;
    setBusy(label);
    setError('');
    setErrorDetails(null);
    diagnostics.current.start();
    try {
      await action();
    } catch (e: any) {
      if (mounted.current)
        setError(plaidExitMessage({ display_message: e.message, error_code: e.message }));
    } finally {
      operating.current = false;
      if (mounted.current) setBusy('');
    }
  }
  async function credentials(removeCredentials: boolean) {
    const supplied = { clientId: clientId.trim(), secret: secret.trim(), environment };
    setSecret('');
    await operate(removeCredentials ? 'Removing credentials…' : 'Saving credentials…', async () => {
      clearPlaidAttempt();
      await connectionAPI(
        '/plaid/config',
        removeCredentials ? undefined : supplied,
        removeCredentials ? 'DELETE' : 'PUT',
      );
      const result = await connectionAPI('/plaid/config');
      if (!mounted.current) return;
      setConfig(result);
      setEnvironment(result.environment);
      setClientId('');
      await load();
    });
  }
  async function link(connectionId?: string) {
    const chosenProduct = connectionId
      ? (connections.find((c) => c.id === connectionId)?.product as PlaidProduct)
      : product;
    await operate('Preparing connection…', async () => {
      const result = await connectionAPI('/plaid/link-token', {
        product: chosenProduct,
        connectionId,
      });
      if (!mounted.current) return;
      const next = createPlaidAttempt(result, { sessionId, product: chosenProduct, connectionId });
      savePlaidAttempt(next);
      active.current = next;
      diagnostics.current.start(next.id);
      setAttempt(next);
    });
  }
  async function complete(
    current: PlaidAttempt,
    token: string | null,
    metadata: PlaidLinkOnSuccessMetadata,
  ) {
    if (!mounted.current || active.current?.id !== current.id || operating.current) return;
    // Link has finished. Never reopen its one-use token, even if the server request fails.
    discardAttempt();
    await operate('Saving connection…', async () => {
      try {
        const selected = (metadata.accounts ?? []).map((a) => a.id);
        if (current.connectionId) {
          await connectionAPI(`/plaid/${current.connectionId}/update-complete`, { selected });
        } else {
          if (!token) throw Error('Plaid did not return a connection. Please start again.');
          await connectionAPI('/plaid/exchange', {
            publicToken: token,
            product: current.product,
            selected,
          });
        }
      } finally {
        // A lost response may still have created the connection. Refresh before offering a new Link flow.
        await load();
      }
    });
  }
  function exit(
    current: PlaidAttempt,
    cause: PlaidLinkError | null,
    metadata?: PlaidLinkOnExitMetadata,
  ) {
    if (!mounted.current || active.current?.id !== current.id) return;
    const result = diagnostics.current.finish(current.id, cause, metadata);
    discardAttempt();
    setError(result?.message ?? plaidExitMessage(cause));
    setErrorDetails(result?.details ?? null);
  }

  return (
    <Modal
      title="Connections"
      onClose={close}
      wide
      suspended={linkOpen}
      className="connections-dialog"
    >
      <div className="connection-intro">
        <h3>Connect with your Plaid account.</h3>
        <p>
          {savedSandbox
            ? 'Your saved Plaid Sandbox credentials connect test institutions only. Save Production credentials to connect your real accounts.'
            : 'Use your own Plaid Production credentials to connect your banks and brokerages.'}
        </p>
      </div>
      {state.settings.demo ? (
        <p className="muted">
          Sign in with Google to set up your own connections. The demo uses synthetic data.
        </p>
      ) : (
        <>
          {configLoading ? (
            <p className="muted">Loading connection settings…</p>
          ) : config ? (
            <section className="connection-section">
              <h3>Plaid credentials</h3>
              {config.configured && (
                <p className="tiny muted">
                  {config.environment === 'sandbox' ? 'Sandbox' : 'Production'} credentials saved.
                  Client ID ending in {config.clientIdLast4 ?? '••••'}.
                </p>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void credentials(false);
                }}
              >
                <div className="form-grid plaid-credential-fields">
                  {showEnvironment && (
                    <label>
                      Environment
                      <select
                        value={environment}
                        onChange={(e) => setEnvironment(e.target.value)}
                        disabled={locked || hasConnections || !config.storageReady}
                      >
                        {config.supportedEnvironments.map((value) => (
                          <option key={value} value={value}>
                            {value === 'sandbox'
                              ? 'Sandbox'
                              : value === 'production'
                                ? 'Production'
                                : value}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label>
                    Client ID
                    <input
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      required
                      disabled={locked || !config.storageReady}
                    />
                  </label>
                  <label>
                    {environment === 'sandbox' ? 'Sandbox secret' : 'Production secret'}
                    <input
                      type="password"
                      value={secret}
                      onChange={(e) => setSecret(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      required
                      disabled={locked || !config.storageReady}
                    />
                  </label>
                </div>
                <p className="tiny muted">
                  Credentials are encrypted on the server and used for your connections.
                </p>
                {hasConnections && (
                  <p className="tiny muted">
                    You can update the secret for this Plaid account. Disconnect your institutions
                    before changing Plaid accounts{showEnvironment ? ' or environments' : ''}, or
                    removing credentials.
                  </p>
                )}
                <div className="button-row">
                  <button
                    className="primary"
                    disabled={locked || !config.storageReady || !clientId.trim() || !secret.trim()}
                  >
                    {config.configured ? 'Update credentials' : 'Save credentials'}
                  </button>
                  {config.configured && (
                    <button
                      type="button"
                      className="border-button negative"
                      disabled={locked || hasConnections}
                      onClick={() => void credentials(true)}
                    >
                      Remove credentials
                    </button>
                  )}
                </div>
              </form>
              {config.redirectUri && (
                <label className="connection-redirect">
                  Allowed redirect URI
                  <input
                    value={config.redirectUri}
                    readOnly
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <span className="tiny muted">
                    Add this exact address to Allowed redirect URIs in your Plaid Dashboard.
                  </span>
                </label>
              )}
              {!config.storageReady && (
                <p className="muted">Credential storage is unavailable on this server right now.</p>
              )}
              {!config.workerReady && (
                <p className="muted">
                  Connections are unavailable on this server right now. You can still save your
                  credentials.
                </p>
              )}
            </section>
          ) : (
            <button className="border-button" onClick={close}>
              Close and try again
            </button>
          )}
          {(configured || attempt) && (
            <section className="connection-section">
              <label>
                Connection type
                <select
                  value={product}
                  onChange={(e) => setProduct(e.target.value as PlaidProduct)}
                  disabled={locked}
                >
                  <option value="transactions">Bank / credit card — Transactions</option>
                  <option value="investments">Brokerage — Investments</option>
                </select>
              </label>
              {product === 'investments' && (
                <p className="tiny muted">
                  The institution must support Plaid Investments. Coverage varies by institution.
                </p>
              )}
              {attempt ? (
                <div className="button-row">
                  <PlaidButton
                    key={attempt.id}
                    attempt={attempt}
                    redirect={resume.attempt?.id === attempt.id ? resume.redirect : undefined}
                    onOpen={() => setLinkOpen(true)}
                    onSuccess={(token, metadata) => void complete(attempt, token, metadata)}
                    onExit={(cause, metadata) => exit(attempt, cause, metadata)}
                    onEvent={(name, metadata) => {
                      if (mounted.current && active.current?.id === attempt.id)
                        diagnostics.current.event(attempt.id, name, metadata);
                    }}
                  />
                  <button className="border-button" disabled={!!busy} onClick={discardAttempt}>
                    Cancel connection
                  </button>
                </div>
              ) : (
                <button className="primary" disabled={locked} onClick={() => void link()}>
                  {savedSandbox ? 'Connect Sandbox institution' : 'Connect institution'}
                </button>
              )}
            </section>
          )}
        </>
      )}
      {!!busy && (
        <p className="muted" role="status">
          {busy}
        </p>
      )}
      <VenmoConnection key={sessionId} state={state} sessionId={sessionId} load={load} />
      <AccountLinks state={state} run={run} disabled={locked} />
      {connections.map((c) => (
        <section className="connection-card" key={c.id}>
          <div className="connection-heading">
            <h3>{c.institution_name}</h3>
            <Status
              status={
                c.last_synced_at &&
                new Date(c.last_synced_at).getTime() < Date.now() - 4 * 864e5 &&
                c.status === 'healthy'
                  ? 'stale'
                  : c.status
              }
            />
          </div>
          <p className="connection-meta tiny muted">
            {c.product}
            {c.environment === 'sandbox' ? ' · Sandbox test data' : ''} · Last fetched{' '}
            {c.last_synced_at ? new Date(c.last_synced_at).toLocaleString() : 'not yet'} ·{' '}
            {c.historical_complete ? 'Initial history finished' : 'History may still be loading'}
          </p>
          {c.error_code && (
            <p className="negative">
              {(
                {
                  WORKSPACE_SIZE_LIMIT: 'This history exceeds the current workspace size limit.',
                  SYNC_DATA_INVALID:
                    'A bank record could not be imported. Your saved history is unchanged.',
                  SYNC_STORAGE_FAILED: 'The bank update could not be saved. Please try again.',
                  SYNC_FAILED: 'The sync could not finish. Please try again.',
                } as Record<string, string>
              )[c.error_code] ?? c.error_code}
            </p>
          )}
          {state.accounts
            .filter((a) => a.connectionId === c.id)
            .map((a) => (
              <label className="check-label" key={a.id}>
                <input
                  type="checkbox"
                  checked={a.enabled}
                  disabled={locked || c.status === 'disconnected'}
                  onChange={(e) => {
                    const enabled = e.target.checked;
                    const selected = state.accounts
                      .filter(
                        (x) => x.connectionId === c.id && (x.id === a.id ? enabled : x.enabled),
                      )
                      .map((x) => x.providerId);
                    void operate('Saving accounts…', async () => {
                      await connectionAPI(`/plaid/${c.id}/accounts`, { selected });
                      await load();
                    });
                  }}
                />
                <span className="connection-account-name">
                  {a.name}
                  {a.mask && <small> · {a.mask}</small>}
                </span>
                <span className="connection-account-balance muted">
                  {money(a.balance, a.currency)}
                </span>
              </label>
            ))}
          {c.status !== 'disconnected' && (
            <div className="button-row">
              <button
                className="border-button"
                disabled={locked}
                onClick={() =>
                  void operate('Checking for updates…', async () => {
                    try {
                      await connectionAPI(`/plaid/${c.id}/sync`, {});
                    } finally {
                      await load();
                    }
                  })
                }
              >
                Check for updates
              </button>
              <button
                className="border-button"
                disabled={locked || !configured}
                onClick={() => void link(c.id)}
              >
                Reauthenticate / add accounts
              </button>
              <button
                className="border-button negative"
                disabled={locked}
                onClick={() => {
                  setDisconnecting(c.id);
                  setRemove(false);
                  setConfirmation('');
                }}
              >
                Disconnect
              </button>
            </div>
          )}
          {disconnecting === c.id && (
            <div>
              <p>Future access stops. Imported data stays unless you choose to delete it.</p>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={remove}
                  disabled={locked}
                  onChange={(e) => setRemove(e.target.checked)}
                />
                Also delete imported accounts and data
              </label>
              {remove && (
                <label>
                  Type DELETE to confirm deletion
                  <input
                    value={confirmation}
                    disabled={locked}
                    onChange={(e) => setConfirmation(e.target.value)}
                  />
                </label>
              )}
              <div className="button-row">
                <button
                  className="border-button negative"
                  disabled={locked || (remove && confirmation !== 'DELETE')}
                  onClick={() =>
                    void operate('Disconnecting…', async () => {
                      await connectionAPI(`/plaid/${c.id}/disconnect`, {
                        deleteData: remove,
                        confirm: confirmation,
                      });
                      if (mounted.current) setDisconnecting(null);
                      await load();
                    })
                  }
                >
                  Confirm disconnect{remove ? ' and delete' : ''}
                </button>
                <button
                  className="border-button"
                  disabled={locked}
                  onClick={() => setDisconnecting(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>
      ))}
      <p className="tiny muted">Balances and holdings reflect the last bank update.</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {errorDetails && (
        <details className="original-info">
          <summary>Details</summary>
          <p style={{ overflowWrap: 'anywhere' }}>
            {errorDetails.errorCode && (
              <>
                Code: {errorDetails.errorCode}
                <br />
              </>
            )}
            {errorDetails.requestId && (
              <>
                Request ID: {errorDetails.requestId}
                <br />
              </>
            )}
            {errorDetails.linkSessionId && <>Link session ID: {errorDetails.linkSessionId}</>}
          </p>
        </details>
      )}
    </Modal>
  );
}
