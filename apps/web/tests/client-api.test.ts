import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/App';

afterEach(() => vi.unstubAllGlobals());

describe('client API requests', () => {
  it('preserves GET/POST defaults and sends explicit credential methods with session binding', async () => {
    const request = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', request);
    await api('/state');
    await api('/command', { type: 'example' });
    await api(
      '/plaid/config',
      { clientId: 'test-client', secret: 'test-only-secret', environment: 'sandbox' },
      'PUT',
      'session-context',
    );
    await api('/plaid/config', undefined, 'DELETE', 'session-context');
    expect(request.mock.calls[0]).toEqual([
      '/api/state',
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(request.mock.calls[1]).toEqual([
      '/api/command',
      expect.objectContaining({ method: 'POST' }),
    ]);
    expect(request.mock.calls[2]).toEqual([
      '/api/plaid/config',
      expect.objectContaining({
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-asset-client': 'web',
          'x-asset-session': 'session-context',
        },
        body: JSON.stringify({
          clientId: 'test-client',
          secret: 'test-only-secret',
          environment: 'sandbox',
        }),
      }),
    ]);
    expect(request.mock.calls[3]).toEqual([
      '/api/plaid/config',
      expect.objectContaining({ method: 'DELETE' }),
    ]);
    expect(request.mock.calls[3][1]).not.toHaveProperty('body');
    expect(request.mock.calls[0][1]?.headers).not.toHaveProperty('x-asset-session');
  });

  it('preserves server failure status for expired or changed sessions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'Sign-in changed. Please reload.' }), {
            status: 409,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    await expect(
      api('/plaid/exchange', { publicToken: 'test-only-token' }, 'POST', 'old-session'),
    ).rejects.toMatchObject({ message: 'Sign-in changed. Please reload.', status: 409 });
  });
});
