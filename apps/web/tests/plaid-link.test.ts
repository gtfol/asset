import { describe, expect, it } from 'vitest';
import {
  clearPlaidAttempt,
  createPlaidAttempt,
  plaidExitMessage,
  PlaidLinkDiagnostics,
  plaidRedirect,
  readPlaidAttempt,
  savePlaidAttempt,
} from '../src/plaid-link';

const now = Date.parse('2026-10-16T12:00:00Z');
const response = { link_token: 'link-sandbox-test', expiration: '2026-10-16T16:00:00Z' };
const context = {
  sessionId: 'session-a',
  product: 'transactions' as const,
  connectionId: 'item-a',
};
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    values,
  };
}

describe('Plaid browser handoff', () => {
  it('binds immutable token/product/update context and caps transient lifetime', () => {
    const attempt = createPlaidAttempt(response, context, now);
    expect(attempt).toMatchObject({
      token: response.link_token,
      ...context,
      expiresAt: now + 30 * 60_000,
    });
    expect(Object.isFrozen(attempt)).toBe(true);
    expect(createPlaidAttempt(response, context, now).id).not.toBe(attempt.id);
  });
  it('honors an earlier provider expiration and rejects invalid token responses', () => {
    expect(
      createPlaidAttempt({ ...response, expiration: '2026-10-16T12:05:00Z' }, context, now)
        .expiresAt,
    ).toBe(now + 5 * 60_000);
    for (const invalid of [
      {},
      { ...response, link_token: null },
      { ...response, expiration: 'invalid' },
      { ...response, expiration: '2026-10-16T11:59:59Z' },
    ]) {
      expect(() => createPlaidAttempt(invalid, context, now)).toThrow();
    }
    expect(() => createPlaidAttempt(response, { ...context, sessionId: '' }, now)).toThrow();
  });
  it('restores the same user session across a redirect and never saves credentials or public tokens', () => {
    const storage = memoryStorage();
    const attempt = createPlaidAttempt(response, context, now);
    savePlaidAttempt(
      {
        ...attempt,
        secret: 'must-not-store',
        clientId: 'must-not-store',
        publicToken: 'must-not-store',
      } as typeof attempt,
      storage,
    );
    expect(readPlaidAttempt('session-a', storage, now + 1000)).toEqual(attempt);
    expect([...storage.values.values()][0]).not.toContain('must-not-store');
    clearPlaidAttempt(storage);
    expect(readPlaidAttempt('session-a', storage, now)).toBeNull();
  });
  it('clears a handoff after sign-out, another session, or expiry', () => {
    const storage = memoryStorage();
    const attempt = createPlaidAttempt(response, context, now);
    for (const [sessionId, time] of [
      ['session-b', now],
      ['', now],
      ['session-a', attempt.expiresAt],
    ] as const) {
      savePlaidAttempt(attempt, storage);
      expect(readPlaidAttempt(sessionId, storage, time)).toBeNull();
      expect(storage.values.size).toBe(0);
    }
  });
  it('clears corrupt or unsupported handoffs instead of resuming the wrong flow', () => {
    const storage = memoryStorage();
    const attempt = createPlaidAttempt(response, context, now);
    savePlaidAttempt(attempt, storage);
    const key = [...storage.values.keys()][0];
    for (const value of [
      'not-json',
      JSON.stringify({ ...attempt, product: 'other' }),
      JSON.stringify({ ...attempt, expiresAt: now + 31 * 60_000 }),
      JSON.stringify({ ...attempt, connectionId: 123 }),
    ]) {
      storage.setItem(key, value);
      expect(readPlaidAttempt('session-a', storage, now)).toBeNull();
      expect(storage.values.size).toBe(0);
    }
  });
  it('fails clearly if transient browser storage is blocked', () => {
    const blocked = {
      getItem: () => {
        throw Error('blocked');
      },
      setItem: () => {
        throw Error('blocked');
      },
      removeItem: () => {
        throw Error('blocked');
      },
    };
    expect(() => savePlaidAttempt(createPlaidAttempt(response, context, now), blocked)).toThrow(
      'temporary browser storage',
    );
    expect(readPlaidAttempt('session-a', blocked, now)).toBeNull();
    expect(() => clearPlaidAttempt(blocked)).not.toThrow();
  });
  it('accepts only the exact local OAuth callback and preserves the received state', () => {
    const origin = 'https://asset.gtfol.dev';
    const valid = origin + '/plaid/oauth?oauth_state_id=state-123';
    expect(plaidRedirect(valid, origin)).toBe(valid);
    for (const value of [
      origin + '/other?oauth_state_id=one',
      'https://other.example/plaid/oauth?oauth_state_id=one',
      origin + '/plaid/oauth',
      valid + '&oauth_state_id=two',
      valid + '&next=other',
      valid + '#fragment',
    ]) {
      expect(plaidRedirect(value, origin)).toBeUndefined();
    }
  });
  it('uses Plaid user-facing exit text and hides developer error details', () => {
    expect(plaidExitMessage(null)).toBe('');
    expect(plaidExitMessage({ display_message: 'Please try another institution.' })).toBe(
      'Please try another institution.',
    );
    expect(
      plaidExitMessage({
        display_message: null,
        error_message: 'sensitive developer diagnostics',
      } as any),
    ).not.toContain('diagnostics');
  });
});

describe('Plaid error diagnostics', () => {
  it('keeps the last ERROR details when Link exits without an error object', () => {
    const diagnostics = new PlaidLinkDiagnostics('attempt-a');
    diagnostics.event('attempt-a', 'ERROR', {
      error_code: 'INSTITUTION_REGISTRATION_REQUIRED',
      request_id: 'request-error',
      link_session_id: 'session-error',
      error_message: 'developer-only details',
      routing_number: 'must-not-retain',
      account_number_mask: 'must-not-retain',
      institution_search_query: 'must-not-retain',
      public_token: 'must-not-retain',
    });
    expect(JSON.stringify(diagnostics)).not.toContain('must-not-retain');
    expect(JSON.stringify(diagnostics)).not.toContain('developer-only');
    const result = diagnostics.finish('attempt-a', null, { request_id: 'request-exit' });
    expect(result?.details).toEqual({
      errorCode: 'INSTITUTION_REGISTRATION_REQUIRED',
      requestId: 'request-exit',
      linkSessionId: 'session-error',
    });
    expect(result?.message).toContain('OAuth access requirements');
    expect(diagnostics.finish('attempt-a', null)).toBeUndefined();
  });

  it('prefers exit error and metadata while preserving missing event identifiers', () => {
    const diagnostics = new PlaidLinkDiagnostics('attempt-a');
    diagnostics.event('attempt-a', 'ERROR', {
      error_code: 'INSTITUTION_DOWN',
      request_id: 'request-a',
      link_session_id: 'session-a',
    });
    expect(
      diagnostics.finish(
        'attempt-a',
        {
          error_code: 'UNAUTHORIZED_INSTITUTION',
          display_message: 'Unhelpful provider text',
        },
        { link_session_id: 'session-exit', request_id: null },
      ),
    ).toEqual({
      message: plaidExitMessage({ error_code: 'UNAUTHORIZED_INSTITUTION' }),
      details: {
        errorCode: 'UNAUTHORIZED_INSTITUTION',
        requestId: 'request-a',
        linkSessionId: 'session-exit',
      },
    });
  });

  it('keeps ordinary cancellation quiet even when exit metadata has reference IDs', () => {
    const diagnostics = new PlaidLinkDiagnostics('attempt-a');
    diagnostics.event('attempt-a', 'SELECT_INSTITUTION', {
      error_code: 'UNAUTHORIZED_INSTITUTION',
    });
    expect(
      diagnostics.finish('attempt-a', null, {
        request_id: 'request-a',
        link_session_id: 'session-a',
      }),
    ).toEqual({ message: '', details: null });
  });

  it('clears diagnostics for a new attempt and ignores callbacks from old attempts', () => {
    const diagnostics = new PlaidLinkDiagnostics('old');
    diagnostics.event('old', 'ERROR', { error_code: 'INSTITUTION_DOWN' });
    diagnostics.start('current');
    diagnostics.event('old', 'ERROR', { error_code: 'INVALID_LINK_CUSTOMIZATION' });
    expect(diagnostics.finish('old', { error_code: 'INVALID_LINK_CUSTOMIZATION' })).toBeUndefined();
    expect(diagnostics.finish('current', null)).toEqual({ message: '', details: null });
    diagnostics.start('next');
    diagnostics.event('next', 'ERROR', { error_code: 'UNAUTHORIZED_INSTITUTION' });
    expect(diagnostics.finish('old', null)).toBeUndefined();
    expect(diagnostics.finish('next', null)?.details?.errorCode).toBe('UNAUTHORIZED_INSTITUTION');
  });

  it('discards prior errors after success, reset, or closing the connection dialog', () => {
    const diagnostics = new PlaidLinkDiagnostics('attempt-a');
    diagnostics.event('attempt-a', 'ERROR', {
      error_code: 'INSTITUTION_DOWN',
      request_id: 'request-a',
    });
    diagnostics.start();
    diagnostics.event('attempt-a', 'ERROR', { error_code: 'INVALID_LINK_CUSTOMIZATION' });
    expect(diagnostics.finish('attempt-a', null)).toBeUndefined();
    diagnostics.start('attempt-b');
    expect(diagnostics.finish('attempt-b', null)).toEqual({ message: '', details: null });
  });

  it('retains only bounded diagnostic fields with safe characters', () => {
    for (const value of [
      '<script>',
      'one two',
      'one/two',
      'one\ntwo',
      'SAFE\n',
      'request\r',
      42,
      {},
      'x'.repeat(129),
    ]) {
      const diagnostics = new PlaidLinkDiagnostics('attempt-a');
      diagnostics.event('attempt-a', 'ERROR', {
        error_code: value,
        request_id: value,
        link_session_id: value,
      });
      const result = diagnostics.finish('attempt-a', null);
      expect(result?.details).toBeNull();
      expect(result?.message).toContain('could not be completed');
    }
    const diagnostics = new PlaidLinkDiagnostics('attempt-a');
    diagnostics.event('attempt-a', 'ERROR', {
      error_code: 'A'.repeat(97),
      request_id: 'r'.repeat(128),
      link_session_id: 'ea6cf4f1-541a-4be6-b341-6785c8bd3493',
    });
    expect(diagnostics.finish('attempt-a', null)?.details).toEqual({
      requestId: 'r'.repeat(128),
      linkSessionId: 'ea6cf4f1-541a-4be6-b341-6785c8bd3493',
    });
  });

  it('offers setup guidance for known codes without making payment claims and keeps other display text', () => {
    for (const error_code of [
      'INVALID_LINK_CUSTOMIZATION',
      'INSTITUTION_REGISTRATION_REQUIRED',
      'UNAUTHORIZED_INSTITUTION',
    ]) {
      const message = plaidExitMessage({ error_code, display_message: 'Something went wrong' });
      expect(message).toContain('Plaid Dashboard');
      expect(message).not.toMatch(/paid|payment|upgrade/i);
    }
    expect(
      plaidExitMessage({ error_code: 'INSTITUTION_DOWN', display_message: 'Please try later.' }),
    ).toBe('Please try later.');
  });
});
