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

export function plaidExitMessage(error: { display_message?: string | null } | null): string {
  return error
    ? error.display_message || 'The bank connection could not be completed. Please try again.'
    : '';
}
