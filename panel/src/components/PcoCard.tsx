import { useMemo, useState } from 'react';
import { api } from '../api';
import type { KioskState, PcoGroup, PcoPlan } from '../types';
import { useToast } from './Toast';

type Props = {
  state: KioskState;
  onRefresh: () => Promise<void>;
};

export function PcoCard({ state, onRefresh }: Props) {
  const toast = useToast();
  const [key, setKey] = useState('');
  const [groups, setGroups] = useState<PcoGroup[] | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const configured = state.pco.configured;
  const existing = useMemo(
    () => new Set(state.services.map((s) => s.serviceId)),
    [state.services],
  );

  async function saveKey() {
    setBusy(true);
    try {
      const r = await api<{ configured: boolean }>('/api/pco/config', {
        method: 'PUT',
        body: JSON.stringify({ apiKey: key.trim() }),
      });
      setKey('');
      toast.push(r.configured ? 'API key saved.' : 'API key cleared.', r.configured ? 'ok' : 'err');
      await onRefresh();
    } catch (err) {
      toast.push(err instanceof Error ? err.message : 'Save failed', 'err');
    } finally {
      setBusy(false);
    }
  }

  async function loadPlans() {
    setBusy(true);
    setStatus('Loading plans…');
    try {
      const r = await api<{ groups: PcoGroup[] }>('/api/pco/plans');
      const next = (r.groups || []).map((g) => ({
        ...g,
        serviceTypes: g.serviceTypes.map((st) => ({
          ...st,
          plans: st.plans.map((p) => ({ ...p, existing: existing.has(p.id) })),
        })),
      }));
      setGroups(next);
      setSelected({});
      const count = next.reduce((n, g) => n + g.serviceTypes.reduce((m, st) => m + st.plans.length, 0), 0);
      setStatus(count ? `${count} upcoming plan(s). Select the ones to add.` : 'No upcoming plans found.');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Load failed');
      toast.push(err instanceof Error ? err.message : 'Load failed', 'err');
    } finally {
      setBusy(false);
    }
  }

  async function importSelected() {
    const planIds = Object.entries(selected).filter(([, v]) => v).map(([id]) => id);
    if (!planIds.length) {
      toast.push('Select at least one plan.', 'err');
      return;
    }
    setBusy(true);
    setStatus('Adding…');
    try {
      const r = await api<{ created?: unknown[]; skipped?: unknown[] }>('/api/pco/import', {
        method: 'POST',
        body: JSON.stringify({ planIds }),
      });
      setStatus(`${r.created?.length || 0} added, ${r.skipped?.length || 0} skipped.`);
      toast.push('Import complete.', 'ok');
      await onRefresh();
      await loadPlans();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Import failed');
      toast.push(err instanceof Error ? err.message : 'Import failed', 'err');
    } finally {
      setBusy(false);
    }
  }

  function togglePlan(plan: PcoPlan, on: boolean) {
    if (plan.existing) return;
    setSelected((prev) => ({ ...prev, [plan.id]: on }));
  }

  return (
    <section className="card">
      <div className="section-head">
        <div>
          <h2>Planning Center</h2>
          <p className="lead">
            API access drives the TV countdown and plan import. Use a personal access token or <code>app_id:secret</code>.
          </p>
        </div>
      </div>

      {!configured ? (
        <>
          <label className="field" htmlFor="pco-key">API key</label>
          <input
            id="pco-key"
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Paste API key"
            autoComplete="off"
          />
          <div className="btn-row">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void saveKey()}>
              Save key
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="msg ok">
            {state.pco.viaEnv
              ? 'Connected (key from KIOSK_PCO_API_KEY).'
              : 'Connected (key stored on this device).'}
          </div>
          <div className="btn-row">
            <button type="button" className="btn" disabled={busy} onClick={() => void loadPlans()}>
              Load upcoming plans
            </button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void importSelected()}>
              Add selected
            </button>
          </div>
          {status && <div className="msg">{status}</div>}
          {groups && (
            <div className="pco-list">
              {groups.map((g) => (
                <details key={g.id} className="pco-folder" open>
                  <summary>
                    {g.name} ({g.serviceTypes.reduce((n, st) => n + st.plans.length, 0)})
                  </summary>
                  {g.serviceTypes.map((st) => (
                    <div key={st.id}>
                      <div className="pco-type">
                        <input
                          type="checkbox"
                          onChange={(e) => {
                            const on = e.target.checked;
                            for (const p of st.plans) togglePlan(p, on);
                          }}
                        />
                        <span>{st.name} ({st.plans.length})</span>
                      </div>
                      {st.plans.map((p) => (
                        <label key={p.id} className={`pco-item ${p.existing ? 'existing' : ''}`}>
                          <input
                            type="checkbox"
                            disabled={!!p.existing}
                            checked={!!selected[p.id]}
                            onChange={(e) => togglePlan(p, e.target.checked)}
                          />
                          <span>
                            <span className="pco-name">
                              {p.serviceTypeName}{p.title ? ` — ${p.title}` : ''}
                            </span>
                            <span className="pco-meta">{p.shortDates || p.sortDate || `plan #${p.id}`}</span>
                          </span>
                          {p.existing && <span className="pco-tag">added</span>}
                        </label>
                      ))}
                    </div>
                  ))}
                </details>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
