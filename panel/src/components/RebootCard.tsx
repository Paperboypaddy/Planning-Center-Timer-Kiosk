import { useEffect, useState } from 'react';
import { api } from '../api';
import type { KioskState } from '../types';
import { useToast } from './Toast';

type Props = {
  state: KioskState;
  onRefresh: () => Promise<void>;
};

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function cronToSimple(cron: string | null) {
  const base = { day: '0', time: '04:00' };
  if (!cron) return { freq: 'never', ...base };
  const c = String(cron).trim();
  let r = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(c);
  if (r) return { freq: 'daily', day: '0', time: `${pad2(+r[2])}:${pad2(+r[1])}` };
  r = /^(\d{1,2}) (\d{1,2}) \* \* 1-5$/.exec(c);
  if (r) return { freq: 'weekdays', day: '0', time: `${pad2(+r[2])}:${pad2(+r[1])}` };
  r = /^(\d{1,2}) (\d{1,2}) \* \* ([0-6])$/.exec(c);
  if (r) return { freq: 'weekly', day: r[3], time: `${pad2(+r[2])}:${pad2(+r[1])}` };
  return { freq: 'custom', ...base };
}

export function RebootCard({ state, onRefresh }: Props) {
  const toast = useToast();
  const initial = cronToSimple(state.reboot.cron);
  const [freq, setFreq] = useState(initial.freq);
  const [day, setDay] = useState(initial.day);
  const [time, setTime] = useState(initial.time);
  const [cron, setCron] = useState(state.reboot.cron || '');
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    const s = cronToSimple(state.reboot.cron);
    setFreq(s.freq);
    setDay(s.day);
    setTime(s.time);
    setCron(state.reboot.cron || '');
  }, [state.reboot.cron]);

  function simpleToCron() {
    if (freq === 'never' || freq === 'custom' || !time) return '';
    const [h, m] = time.split(':').map(Number);
    if (freq === 'daily') return `${m} ${h} * * *`;
    if (freq === 'weekdays') return `${m} ${h} * * 1-5`;
    return `${m} ${h} * * ${day}`;
  }

  function onFreqChange(next: string) {
    setFreq(next);
    if (next !== 'custom') {
      const [h, m] = (time || '04:00').split(':').map(Number);
      if (next === 'never') setCron('');
      else if (next === 'daily') setCron(`${m} ${h} * * *`);
      else if (next === 'weekdays') setCron(`${m} ${h} * * 1-5`);
      else setCron(`${m} ${h} * * ${day}`);
    }
  }

  async function save() {
    const value = (freq === 'custom' ? cron : simpleToCron()).trim() || null;
    try {
      await api('/api/settings', { method: 'PUT', body: JSON.stringify({ rebootCron: value }) });
      setMsg(value ? `Reboot schedule saved (${value}).` : 'Reboot schedule cleared.');
      toast.push('Reboot schedule saved.', 'ok');
      await onRefresh();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Save failed');
      toast.push(err instanceof Error ? err.message : 'Save failed', 'err');
    }
  }

  return (
    <section className="card">
      <div className="section-head">
        <div>
          <h2>Reboot schedule</h2>
          <p className="lead">Optional daily or weekly restart so the kiosk stays fresh.</p>
        </div>
      </div>
      <div className="field-grid">
        <div>
          <label className="field" htmlFor="reboot-freq">Frequency</label>
          <select id="reboot-freq" value={freq} onChange={(e) => onFreqChange(e.target.value)}>
            <option value="never">Never</option>
            <option value="daily">Every day</option>
            <option value="weekdays">Weekdays (Mon–Fri)</option>
            <option value="weekly">Weekly on…</option>
            <option value="custom">Custom (cron)</option>
          </select>
        </div>
        <div>
          <label className="field" htmlFor="reboot-day">Day</label>
          <select id="reboot-day" value={day} disabled={freq !== 'weekly'} onChange={(e) => {
            setDay(e.target.value);
            if (freq === 'weekly') {
              const [h, m] = time.split(':').map(Number);
              setCron(`${m} ${h} * * ${e.target.value}`);
            }
          }}>
            {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => (
              <option key={d} value={String(i)}>{d}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="field" htmlFor="reboot-time">Time</label>
          <input
            id="reboot-time"
            type="time"
            value={time}
            onChange={(e) => {
              setTime(e.target.value);
              if (freq !== 'custom' && freq !== 'never') {
                const [h, m] = e.target.value.split(':').map(Number);
                if (freq === 'daily') setCron(`${m} ${h} * * *`);
                else if (freq === 'weekdays') setCron(`${m} ${h} * * 1-5`);
                else setCron(`${m} ${h} * * ${day}`);
              }
            }}
          />
        </div>
      </div>
      <label className="field" htmlFor="reboot-cron">Cron expression</label>
      <input
        id="reboot-cron"
        value={cron}
        onChange={(e) => {
          setCron(e.target.value);
          const s = cronToSimple(e.target.value);
          setFreq(s.freq);
          setDay(s.day);
          setTime(s.time);
        }}
        placeholder="e.g. 0 4 * * *"
        spellCheck={false}
        autoComplete="off"
      />
      <div className="btn-row">
        <button type="button" className="btn btn-primary" onClick={() => void save()}>Save schedule</button>
      </div>
      {msg && <div className="msg ok">{msg}</div>}
    </section>
  );
}
