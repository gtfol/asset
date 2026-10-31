import React, { useId, useState } from 'react';
import { api } from './App';
export function DeviceVerification({ onReady }: { onReady: () => Promise<void> }) {
  const helpId = useId();
  const [code, setCode] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <div className="device-verification">
      <p id={helpId} className="muted">
        Enter the code from your authenticator app, or use your single-use recovery code.
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
            autoCapitalize="none"
            spellCheck={false}
            aria-describedby={helpId}
            autoFocus
            maxLength={32}
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy || code.length < 6}>
          {busy ? 'Verifying…' : 'Verify device'}
        </button>
      </form>
      <button
        className="border-button"
        disabled={busy}
        onClick={async () => {
          await api('/auth/logout', {});
          window.location.assign('/');
        }}
      >
        Sign out
      </button>
    </div>
  );
}
