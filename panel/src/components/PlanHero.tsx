import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ApiError, KioskState, Service } from '../types';
import { useToast } from './Toast';

type Props = {
  state: KioskState;
  onRefresh: () => Promise<void>;
};

export function PlanHero({ state, onRefresh }: Props) {
  const toast = useToast();
  const [dialog, setDialog] = useState<null | { mode: 'add' } | { mode: 'edit'; service: Service }>(null);

  async function select(s: Service) {
    try {
      await api('/api/select', { method: 'POST', body: JSON.stringify({ id: s.id }) });
    } catch (err) {
      const e = err as ApiError;
      toast.push(
        e.status === 502
          ? 'Saved — the kiosk will switch when it reconnects.'
          : e.message,
        e.status === 502 ? 'ok' : 'err',
      );
    }
    await onRefresh();
  }

  async function idle() {
    try {
      await api('/api/deselect', { method: 'POST' });
      toast.push('Showing idle page.', 'ok');
    } catch (err) {
      toast.push(err instanceof Error ? err.message : 'Could not switch to idle', 'err');
    }
    await onRefresh();
  }

  async function remove(s: Service) {
    if (!window.confirm(`Remove “${s.name}”?`)) return;
    try {
      await api(`/api/services/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
      toast.push('Plan removed.', 'ok');
      await onRefresh();
    } catch (err) {
      toast.push(err instanceof Error ? err.message : 'Delete failed', 'err');
    }
  }

  return (
    <section className="hero">
      <div className="section-head">
        <div>
          <h2>On the TV</h2>
          <p className="lead">
            Tap a plan to show its countdown. Advance items in Services LIVE on your phone.
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setDialog({ mode: 'add' })}>
          + Add plan
        </button>
      </div>

      <div className="plan-grid">
        {!state.services.length && (
          <p className="empty">No plans yet. Add one or import from Planning Center.</p>
        )}
        {state.services.map((s) => {
          const active = s.id === state.activeServiceId;
          return (
            <button
              key={s.id}
              type="button"
              className={`plan-tile ${active ? 'active' : ''}`}
              onClick={() => select(s)}
            >
              {active && <span className="plan-live">ON TV</span>}
              <span className="plan-name">{s.name}</span>
              <span className="plan-sub">
                {s.serviceId}
                {s.displayType ? ` · ${s.displayType}` : ''}
              </span>
              <span className="plan-actions">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDialog({ mode: 'edit', service: s });
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="del"
                  onClick={(e) => {
                    e.stopPropagation();
                    void remove(s);
                  }}
                >
                  Delete
                </button>
              </span>
            </button>
          );
        })}
      </div>

      <button type="button" className="btn btn-block" onClick={() => void idle()}>
        Show idle page
      </button>

      {dialog && (
        <PlanDialog
          mode={dialog.mode}
          service={dialog.mode === 'edit' ? dialog.service : null}
          displayTypes={state.displayTypes}
          onClose={() => setDialog(null)}
          onSaved={async () => {
            setDialog(null);
            await onRefresh();
          }}
        />
      )}
    </section>
  );
}

function PlanDialog({
  mode,
  service,
  displayTypes,
  onClose,
  onSaved,
}: {
  mode: 'add' | 'edit';
  service: Service | null;
  displayTypes: string[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const toast = useToast();
  const [name, setName] = useState(service?.name || '');
  const [serviceId, setServiceId] = useState(service?.serviceId || '');
  const [displayType, setDisplayType] = useState(service?.displayType || '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function save() {
    if (!serviceId.trim()) {
      toast.push('Plan ID is required.', 'err');
      return;
    }
    setBusy(true);
    try {
      const payload = {
        name: name.trim(),
        serviceId: serviceId.trim(),
        displayType: displayType.trim(),
      };
      if (mode === 'edit' && service) {
        await api(`/api/services/${encodeURIComponent(service.id)}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      } else {
        await api('/api/services', { method: 'POST', body: JSON.stringify(payload) });
      }
      toast.push('Plan saved.', 'ok');
      await onSaved();
    } catch (err) {
      toast.push(err instanceof Error ? err.message : 'Save failed', 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <h2>{mode === 'edit' ? 'Edit plan' : 'Add plan'}</h2>
        <label className="field" htmlFor="plan-name">Name</label>
        <input id="plan-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sunday 9am" />
        <label className="field" htmlFor="plan-id">Planning Center plan ID</label>
        <input
          id="plan-id"
          value={serviceId}
          onChange={(e) => setServiceId(e.target.value)}
          inputMode="numeric"
          placeholder="e.g. 90197325"
        />
        <label className="field" htmlFor="plan-layout">Layout <em>(optional)</em></label>
        <select id="plan-layout" value={displayType} onChange={(e) => setDisplayType(e.target.value)}>
          <option value="">Countdown Full</option>
          {displayTypes.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
