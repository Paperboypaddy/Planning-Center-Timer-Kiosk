import { useEffect, useState } from 'react';
import { api } from '../api';
import type { KioskState } from '../types';
import { useToast } from './Toast';

type Props = {
  state: KioskState;
  onRefresh: () => Promise<void>;
  updating: boolean;
  setUpdating: (v: boolean) => void;
};

type Progress = {
  state?: string;
  progress?: number;
  message?: string;
};

export function UpdateCard({ state, onRefresh, updating, setUpdating }: Props) {
  const toast = useToast();
  const [prereleases, setPrereleases] = useState(!!state.updatePrereleases);
  const [result, setResult] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [canApply, setCanApply] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);

  useEffect(() => {
    setPrereleases(!!state.updatePrereleases);
  }, [state.updatePrereleases]);

  useEffect(() => {
    if (!updating) return;
    const t = window.setInterval(async () => {
      try {
        const r = await fetch('/api/update/progress');
        if (!r.ok) return;
        const s = (await r.json()) as Progress;
        setProgress(s);
        if (s.state === 'done') {
          setUpdating(false);
          setResult('Update complete. Sign in again if needed.');
          toast.push('Update complete.', 'ok');
          window.setTimeout(() => void onRefresh(), 1500);
        } else if (s.state === 'error') {
          setUpdating(false);
          setResult(`Update failed: ${s.message || 'unknown error'}`);
          toast.push('Update failed.', 'err');
          void onRefresh();
        }
      } catch {
        /* server restart mid-update */
      }
    }, 1000);
    return () => window.clearInterval(t);
  }, [updating, setUpdating, onRefresh, toast]);

  async function togglePrereleases(next: boolean) {
    setPrereleases(next);
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ updatePrereleases: next }),
      });
      await onRefresh();
    } catch (err) {
      toast.push(err instanceof Error ? err.message : 'Could not save', 'err');
    }
  }

  async function check() {
    setResult('Checking…');
    setHint(null);
    setCanApply(false);
    try {
      const r = await api<{
        updateAvailable: boolean;
        latestVersion?: string;
        version: string;
        canApplyUpdate?: boolean;
        note?: string;
      }>('/api/update/status');
      if (r.updateAvailable) {
        setResult(`Update available: ${r.latestVersion} (you have ${r.version}).`);
        setCanApply(!!r.canApplyUpdate);
        setHint(
          r.canApplyUpdate
            ? r.note || 'Apply it below, or download from the release page.'
            : r.note ||
              'In-app install is not available on this install — update via nixos-rebuild / your package manager.',
        );
      } else if (r.note) {
        setResult('No release published yet — you’re on the latest.');
      } else {
        setResult(`You’re up to date (version ${r.version}).`);
      }
    } catch (err) {
      setResult(err instanceof Error ? err.message : 'Check failed');
      toast.push(err instanceof Error ? err.message : 'Check failed', 'err');
    }
  }

  async function apply() {
    setResult('Applying…');
    try {
      const r = await api<{ ok?: boolean; hint?: string; releaseUrl?: string }>('/api/update', {
        method: 'POST',
      });
      if (r.ok) {
        setUpdating(true);
        setCanApply(false);
        setProgress({ progress: 0, message: 'Starting update…' });
        setResult(null);
      } else {
        setResult(
          (r.hint || 'Not automatic on this platform.') +
            (r.releaseUrl ? ` Download: ${r.releaseUrl}` : ''),
        );
      }
    } catch (err) {
      setResult(err instanceof Error ? err.message : 'Update failed');
      toast.push(err instanceof Error ? err.message : 'Update failed', 'err');
    }
  }

  const pct = Math.max(0, Math.min(100, Math.round(progress?.progress || 0)));

  return (
    <section className="card">
      <div className="section-head">
        <div>
          <h2>Software update</h2>
          <p className="lead">
            Current version: <code>{state.version || '—'}</code>
          </p>
        </div>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={prereleases}
          onChange={(e) => void togglePrereleases(e.target.checked)}
        />
        Include prereleases (beta)
      </label>
      <div className="btn-row">
        <button type="button" className="btn" onClick={() => void check()}>Check for updates</button>
        {canApply && (
          <button type="button" className="btn btn-primary" onClick={() => void apply()}>
            Download &amp; install
          </button>
        )}
      </div>
      {progress && (
        <>
          <div className="progress-track">
            <div
              className={`progress-bar ${progress.state === 'error' ? 'error' : ''}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="progress-label">{progress.message || ''}</p>
        </>
      )}
      {result && <div className="msg">{result}</div>}
      {hint && <p className="hint">{hint}</p>}
    </section>
  );
}
