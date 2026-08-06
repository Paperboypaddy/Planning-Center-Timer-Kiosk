import { useState } from 'react';
import { api } from '../api';
import type { KioskState } from '../types';
import { useToast } from './Toast';

type Net = { ssid: string; security?: string; signal?: number; inUse?: boolean };

type Props = {
  state: KioskState;
};

export function WifiCard({ state }: Props) {
  const toast = useToast();
  const [networks, setNetworks] = useState<Net[]>([]);
  const [ssid, setSsid] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; kind: 'ok' | 'err' | '' } | null>(null);

  if (!state.wifi.supported) return null;

  async function scan() {
    setScanMsg('Scanning for networks…');
    try {
      const r = await api<{ networks: Net[] }>('/api/wifi/networks');
      const nets = (r.networks || [])
        .slice()
        .sort((a, b) => (b.signal || 0) - (a.signal || 0));
      const seen = new Set<string>();
      const unique: Net[] = [];
      for (const n of nets) {
        if (!n.ssid || seen.has(n.ssid)) continue;
        seen.add(n.ssid);
        unique.push(n);
      }
      setNetworks(unique);
      setSsid(unique[0]?.ssid || '');
      setScanMsg(unique.length ? `${unique.length} network(s) found.` : 'No networks found.');
    } catch (err) {
      setScanMsg(err instanceof Error ? err.message : 'Scan failed');
      toast.push(err instanceof Error ? err.message : 'Scan failed', 'err');
    }
  }

  async function connect() {
    if (!ssid) {
      setMsg({ text: 'Select a network first.', kind: 'err' });
      return;
    }
    setMsg({ text: `Connecting to “${ssid}”…`, kind: '' });
    try {
      await api('/api/wifi/connect', {
        method: 'POST',
        body: JSON.stringify({ ssid, password }),
      });
      setMsg({ text: `Connected to “${ssid}”.`, kind: 'ok' });
      toast.push(`Connected to ${ssid}.`, 'ok');
      setPassword('');
      setShowPass(false);
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : 'Connect failed', kind: 'err' });
      toast.push(err instanceof Error ? err.message : 'Connect failed', 'err');
    }
  }

  return (
    <section className="card">
      <div className="section-head">
        <div>
          <h2>Wi-Fi</h2>
          <p className="lead">
            Connect this device to a wireless network. The password is sent to the OS and not stored by the panel.
          </p>
        </div>
      </div>
      {scanMsg && <div className="msg">{scanMsg}</div>}
      <div className="btn-row">
        <button type="button" className="btn" onClick={() => void scan()}>Scan</button>
        <button type="button" className="btn btn-primary" onClick={() => void connect()}>Connect</button>
      </div>
      <label className="field" htmlFor="wifi-net">Network</label>
      <select id="wifi-net" value={ssid} onChange={(e) => setSsid(e.target.value)}>
        {!networks.length && <option value="">Scan to list networks</option>}
        {networks.map((n) => (
          <option key={n.ssid} value={n.ssid}>
            {n.ssid}
            {n.security && n.security !== '--' ? ` · ${n.security}` : ''}
            {n.inUse ? ' · (connected)' : ''}
          </option>
        ))}
      </select>
      <label className="field" htmlFor="wifi-pass">Password</label>
      <div className="pass-row">
        <input
          id="wifi-pass"
          type={showPass ? 'text' : 'password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          spellCheck={false}
        />
        <button
          type="button"
          className="btn"
          disabled={!password}
          onClick={() => setShowPass((v) => !v)}
        >
          {showPass ? 'Hide' : 'Show'}
        </button>
      </div>
      {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
    </section>
  );
}
