import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { KioskState } from '../types';
import { useToast } from './Toast';

type Props = {
  state: KioskState;
  onRefresh: () => Promise<void>;
};

type TvStatus = { available: boolean; power?: string };

export function TvCard({ state, onRefresh }: Props) {
  const toast = useToast();
  const unsupported = state.platform.os !== 'linux' && !state.tv.available;
  const [status, setStatus] = useState<TvStatus | null>(null);
  const [autoOn, setAutoOn] = useState(state.tv.autoOn);
  const [lead, setLead] = useState(String(state.tv.leadMinutes ?? 30));
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    setAutoOn(state.tv.autoOn);
    setLead(String(state.tv.leadMinutes ?? 30));
  }, [state.tv.autoOn, state.tv.leadMinutes]);

  const refreshStatus = useCallback(async () => {
    try {
      const r = await api<TvStatus>('/api/tv/status');
      setStatus(r);
    } catch {
      setStatus({ available: false });
    }
  }, []);

  useEffect(() => {
    if (unsupported) return;
    void refreshStatus();
    const t = window.setInterval(() => void refreshStatus(), 30000);
    return () => window.clearInterval(t);
  }, [unsupported, refreshStatus]);

  async function power(on: boolean) {
    try {
      await api(on ? '/api/tv/on' : '/api/tv/off', { method: 'POST' });
      setMsg(on ? 'TV on command sent.' : 'TV off command sent.');
      toast.push(on ? 'TV on sent.' : 'TV off sent.', 'ok');
      await refreshStatus();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'CEC failed');
      toast.push(err instanceof Error ? err.message : 'CEC failed', 'err');
    }
  }

  async function save() {
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ tvAutoOn: autoOn, tvLeadMinutes: Number(lead) || 0 }),
      });
      setMsg('TV settings saved.');
      toast.push('TV settings saved.', 'ok');
      await onRefresh();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Save failed');
      toast.push(err instanceof Error ? err.message : 'Save failed', 'err');
    }
  }

  const powerLabel = !status?.available
    ? 'CEC unavailable'
    : status.power === 'on'
      ? 'TV power: ON'
      : status.power === 'standby'
        ? 'TV power: STAND BY'
        : 'TV power: unknown';

  return (
    <section className="card">
      <div className="section-head">
        <div>
          <h2>TV &amp; auto-on</h2>
          <p className="lead">HDMI-CEC power control on Linux kiosks.</p>
        </div>
      </div>
      {unsupported ? (
        <p className="hint">
          CEC isn’t available on this platform. Auto-on and TV buttons are for Linux boxes with a CEC-capable display.
        </p>
      ) : (
        <>
          <div className={`tv-status ${status?.power === 'on' ? 'on' : 'off'}`}>{powerLabel}</div>
          <div className="btn-row">
            <button type="button" className="btn btn-primary" onClick={() => void power(true)}>TV on</button>
            <button type="button" className="btn" onClick={() => void power(false)}>TV off</button>
            <button type="button" className="btn" onClick={() => void refreshStatus()}>Refresh</button>
          </div>
          <label className="check">
            <input type="checkbox" checked={autoOn} onChange={(e) => setAutoOn(e.target.checked)} />
            Auto-on before services
          </label>
          <p className="hint">Uses upcoming service/rehearsal times from Planning Center.</p>
          <label className="field" htmlFor="tv-lead">Minutes before</label>
          <input id="tv-lead" type="number" min={0} max={600} value={lead} onChange={(e) => setLead(e.target.value)} />
          <div className="btn-row">
            <button type="button" className="btn btn-primary" onClick={() => void save()}>Save TV settings</button>
          </div>
          {msg && <div className="msg ok">{msg}</div>}
        </>
      )}
    </section>
  );
}
