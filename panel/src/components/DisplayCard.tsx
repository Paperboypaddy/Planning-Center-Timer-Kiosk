import { useEffect, useState } from 'react';
import { api } from '../api';
import type { KioskState } from '../types';
import { useToast } from './Toast';

type Props = {
  state: KioskState;
  onRefresh: () => Promise<void>;
};

export function DisplayCard({ state, onRefresh }: Props) {
  const toast = useToast();
  const [layout, setLayout] = useState(state.defaultDisplayType || '');
  const [theme, setTheme] = useState(state.defaultTheme === 'light' ? 'light' : 'dark');
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    setLayout(state.defaultDisplayType || '');
    setTheme(state.defaultTheme === 'light' ? 'light' : 'dark');
  }, [state.defaultDisplayType, state.defaultTheme]);

  async function save() {
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          defaultDisplayType: layout || null,
          defaultTheme: theme,
        }),
      });
      setMsg('Display settings saved.');
      toast.push('Display settings saved.', 'ok');
      await onRefresh();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Save failed');
      toast.push(err instanceof Error ? err.message : 'Save failed', 'err');
    }
  }

  async function apply() {
    try {
      const r = await api<{ applied: { displayType: string | null; theme: string | null } }>(
        '/api/kiosk/settings/apply',
        { method: 'POST' },
      );
      const bits = [];
      if (r.applied.displayType) bits.push(`layout: ${r.applied.displayType}`);
      if (r.applied.theme) bits.push(`theme: ${r.applied.theme}`);
      setMsg(bits.length ? `Applied ${bits.join(', ')}.` : 'Nothing set to apply yet.');
      toast.push('Applied to active display.', 'ok');
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Apply failed');
      toast.push(err instanceof Error ? err.message : 'Apply failed', 'err');
    }
  }

  return (
    <section className="card">
      <div className="section-head">
        <div>
          <h2>Display</h2>
          <p className="lead">
            Layout and theme for the local countdown. Countdown Full + dark is fully supported.
          </p>
        </div>
      </div>
      <div className="field-grid">
        <div>
          <label className="field" htmlFor="def-layout">Default layout</label>
          <select id="def-layout" value={layout} onChange={(e) => setLayout(e.target.value)}>
            <option value="">Countdown Full</option>
            {state.displayTypes.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="field" htmlFor="def-theme">Default theme</label>
          <select id="def-theme" value={theme} onChange={(e) => setTheme(e.target.value)}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </div>
      </div>
      <div className="btn-row">
        <button type="button" className="btn" onClick={() => void apply()}>Apply to active display</button>
        <button type="button" className="btn btn-primary" onClick={() => void save()}>Save</button>
      </div>
      {msg && <div className="msg ok">{msg}</div>}
    </section>
  );
}
