import { useState } from 'react';
import { api } from '../api';
import type { AuthStatus } from '../types';

type Props = {
  status: AuthStatus;
  onAuthed: () => void;
};

export function AuthGate({ status, onAuthed }: Props) {
  const setup = status.setupRequired;
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setMsg(null);
    if (!username.trim()) {
      setMsg({ text: 'Username is required.', kind: 'err' });
      return;
    }
    if (setup) {
      if (password.length < 8) {
        setMsg({ text: 'Password must be at least 8 characters.', kind: 'err' });
        return;
      }
      if (password !== confirm) {
        setMsg({ text: 'Passwords do not match.', kind: 'err' });
        return;
      }
    }
    setBusy(true);
    try {
      if (setup) {
        await api('/api/auth/setup', {
          method: 'POST',
          body: JSON.stringify({ username: username.trim(), password }),
        });
      } else {
        await api('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ username: username.trim(), password }),
        });
        setPassword('');
      }
      onAuthed();
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : 'Request failed', kind: 'err' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h2>{setup ? 'Create admin account' : 'Sign in'}</h2>
        <p className="lead">
          {setup
            ? 'First-time setup: choose the admin username and password (8+ characters) for this control panel.'
            : 'Enter your admin login to manage the kiosk.'}
        </p>
        <label className="field" htmlFor="auth-user">Username</label>
        <input
          id="auth-user"
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <label className="field" htmlFor="auth-pass">Password</label>
        <input
          id="auth-pass"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={setup ? 'new-password' : 'current-password'}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        {setup && (
          <>
            <label className="field" htmlFor="auth-confirm">Confirm password</label>
            <input
              id="auth-confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </>
        )}
        <div className="btn-row">
          <button className="btn btn-primary" type="button" disabled={busy} onClick={submit}>
            {setup ? 'Create account' : 'Sign in'}
          </button>
        </div>
        {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
      </div>
    </div>
  );
}
