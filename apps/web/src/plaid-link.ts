export type PlaidProduct = 'transactions' | 'investments';
export interface PlaidAttempt {
  id: string;
  sessionId: string;
  token: string;
  product: PlaidProduct;
  connectionId?: string;
  expiresAt: number;
}
type TransientStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const key = 'asset.plaid.pending.v1';
const maxAge = 30 * 60 * 1000;

export function plaidStorage(): TransientStorage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

export function createPlaidAttempt(
  response: { link_token?: unknown; expiration?: unknown },
  context: { sessionId: string; product: PlaidProduct; connectionId?: string },
  now = Date.now(),
): PlaidAttempt {
  const expiration =
    typeof response.expiration === 'string' ? Date.parse(response.expiration) : NaN;
  if (
    !context.sessionId ||
    typeof response.link_token !== 'string' ||
    !response.link_token ||
    !Number.isFinite(expiration) ||
    expiration <= now
  ) {
    throw Error('The bank connection could not be started. Please try again.');
  }
  return Object.freeze({
    id: crypto.randomUUID(),
    sessionId: context.sessionId,
    token: response.link_token,
    product: context.product,
    ...(context.connectionId ? { connectionId: context.connectionId } : {}),
    expiresAt: Math.min(expiration, now + maxAge),
  });
}

export function clearPlaidAttempt(storage = plaidStorage()) {
  try {
    storage?.removeItem(key);
  } catch {
    /* Storage may be blocked by the browser. */
  }
}

export function savePlaidAttempt(attempt: PlaidAttempt, storage = plaidStorage()) {
  try {
    if (!storage) throw Error('Storage unavailable');
    // Persist only the short-lived Link context. API credentials and public tokens never belong here.
    storage.setItem(
      key,
      JSON.stringify({
        id: attempt.id,
        sessionId: attempt.sessionId,
        token: attempt.token,
        product: attempt.product,
        connectionId: attempt.connectionId,
        expiresAt: attempt.expiresAt,
      }),
    );
  } catch {
    throw Error('Allow temporary browser storage to connect an institution.');
  }
}

export function readPlaidAttempt(
  sessionId: string,
  storage = plaidStorage(),
  now = Date.now(),
): PlaidAttempt | null {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (
      !sessionId ||
      value.sessionId !== sessionId ||
      typeof value.id !== 'string' ||
      !value.id ||
      typeof value.token !== 'string' ||
      !value.token ||
      !['transactions', 'investments'].includes(value.product) ||
      (value.connectionId !== undefined &&
        (typeof value.connectionId !== 'string' || !value.connectionId)) ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt <= now ||
      value.expiresAt > now + maxAge
    ) {
      throw Error('Invalid pending connection');
    }
    return Object.freeze({
      id: value.id,
      sessionId: value.sessionId,
      token: value.token,
      product: value.product,
      ...(value.connectionId ? { connectionId: value.connectionId } : {}),
      expiresAt: value.expiresAt,
    });
  } catch {
    clearPlaidAttempt(storage);
    return null;
  }
}

export function plaidRedirect(value: string, origin: string): string | undefined {
  try {
    const url = new URL(value);
    const states = url.searchParams.getAll('oauth_state_id');
    if (
      url.origin !== origin ||
      url.pathname !== '/plaid/oauth' ||
      url.hash ||
      states.length !== 1 ||
      !states[0] ||
      [...url.searchParams.keys()].some((name) => name !== 'oauth_state_id')
    )
      return;
    return url.href;
  } catch {
    return;
  }
}

type PlaidExitError = { display_message?: string | null; error_code?: string | null } | null;
export interface PlaidErrorDetails {
  errorCode?: string;
  requestId?: string;
  linkSessionId?: string;
}

function diagnosticValue(value: unknown, pattern: RegExp, limit: number) {
  return typeof value === 'string' && value.length <= limit && pattern.exec(value)?.[0] === value
    ? value
    : undefined;
}
function errorCode(value: unknown) {
  return diagnosticValue(value, /^[A-Z][A-Z0-9_]*$/, 96);
}
function safeDetails(value: unknown): PlaidErrorDetails {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const fields = value as Record<string, unknown>;
  const code = errorCode(fields.error_code);
  const requestId = diagnosticValue(fields.request_id, /^[A-Za-z0-9][A-Za-z0-9_-]*$/, 128);
  const linkSessionId = diagnosticValue(fields.link_session_id, /^[A-Za-z0-9][A-Za-z0-9_-]*$/, 128);
  return {
    ...(code ? { errorCode: code } : {}),
    ...(requestId ? { requestId } : {}),
    ...(linkSessionId ? { linkSessionId } : {}),
  };
}

// This object lives only in memory. Never retain SDK metadata, which can include bank details.
export class PlaidLinkDiagnostics {
  private attemptId?: string;
  private lastError: PlaidErrorDetails | null = null;

  constructor(attemptId?: string) {
    this.start(attemptId);
  }
  start(attemptId?: string) {
    this.attemptId = attemptId;
    this.lastError = null;
  }
  event(attemptId: string, name: string, metadata: unknown) {
    if (attemptId === this.attemptId && name === 'ERROR') this.lastError = safeDetails(metadata);
  }
  finish(attemptId: string, error: PlaidExitError, metadata?: unknown) {
    if (attemptId !== this.attemptId) return;
    const hadError = !!error || this.lastError !== null;
    const details = { ...this.lastError, ...safeDetails(metadata) };
    const code = errorCode(error?.error_code);
    if (code) details.errorCode = code;
    this.start();
    return {
      message: hadError ? plaidExitMessage(error ?? {}, details.errorCode) : '',
      details: hadError && Object.keys(details).length ? details : null,
    };
  }
}

export function plaidExitMessage(error: PlaidExitError, previousCode?: string): string {
  const code = errorCode(error?.error_code) ?? errorCode(previousCode);
  if (code === 'INVALID_LINK_CUSTOMIZATION')
    return 'Complete the Data Transparency use case and publish your Link customization in the Plaid Dashboard, then try again. For an existing connection, also check account selection settings.';
  if (code === 'INSTITUTION_REGISTRATION_REQUIRED')
    return 'This bank requires registration for your Plaid account. Check its OAuth access requirements in your Plaid Dashboard, then try again after access is enabled.';
  if (code === 'UNAUTHORIZED_INSTITUTION')
    return 'Your Plaid account does not currently have access to this bank. Check institution access in your Plaid Dashboard or contact Plaid support.';
  return error
    ? error.display_message || 'The bank connection could not be completed. Please try again.'
    : '';
}
