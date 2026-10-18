import React, { useState } from 'react';
import { api } from './App';
export function DeviceVerification({ onReady }: { onReady: () => Promise<void> }) {
  const [code, setCode] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <main className="welcome">
      <h1>asset</h1>
      <h2>Verify this device</h2>
      <p>
        Enter your authenticator code to open your private workspace. You can also use your
        single-use recovery code.
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError('');
          try {
            await api('/security/verify', { code });
            await onReady();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Verification code
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="one-time-code"
            autoFocus
            maxLength={32}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button className="primary" disabled={busy || code.length < 6}>
          {busy ? 'Verifying…' : 'Verify device'}
        </button>
      </form>
      <button
        onClick={async () => {
          await api('/auth/logout', {});
          window.location.assign('/');
        }}
      >
        Sign out
      </button>
    </main>
  );
}
