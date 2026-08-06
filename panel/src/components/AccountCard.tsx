import { useState } from 'react';
import { api } from '../api';
import { useToast } from './Toast';

export function AccountCard() {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [msg, setMsg] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);

  async function save() {
    if (next.length < 8) {
      setMsg({ text: 'New password must be at least 8 characters.', kind: 'err' });
      return;
    }
    try {
      await api('/api/panel/password', {
        method: 'PUT',
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      setMsg({
        text: 'Password changed. You’ll be asked to log in again with the new one.',
        kind: 'ok',
      });
      toast.push('Password changed.', 'ok');
      setCurrent('');
      setNext('');
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : 'Could not change', kind: 'err' });
      toast.push(err instanceof Error ? err.message : 'Could not change', 'err');
    }
  }

  return (
    <section className="card">
      <div className="section-head">
        <div>
          <h2>Account</h2>
          <p className="lead">Change the control-panel password.</p>
        </div>
      </div>
      <label className="field" htmlFor="cur-pass">Current password</label>
      <input
        id="cur-pass"
        type="password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        autoComplete="current-password"
      />
      <label className="field" htmlFor="new-pass">
        New password <em>(8+ characters)</em>
      </label>
      <input
        id="new-pass"
        type="password"
        value={next}
        onChange={(e) => setNext(e.target.value)}
        autoComplete="new-password"
      />
      <div className="btn-row">
        <button type="button" className="btn" onClick={() => void save()}>Change password</button>
      </div>
      {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
    </section>
  );
}
