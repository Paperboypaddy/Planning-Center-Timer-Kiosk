import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { AuthStatus, KioskState } from './types';
import { ToastProvider } from './components/Toast';
import { Header } from './components/Header';
import { AuthGate } from './components/AuthGate';
import { PlanHero } from './components/PlanHero';
import { PcoCard } from './components/PcoCard';
import { DisplayCard } from './components/DisplayCard';
import { TvCard } from './components/TvCard';
import { WifiCard } from './components/WifiCard';
import { RebootCard } from './components/RebootCard';
import { UpdateCard } from './components/UpdateCard';
import { AccountCard } from './components/AccountCard';
import './styles/app.css';

export default function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [state, setState] = useState<KioskState | null>(null);
  const [updating, setUpdating] = useState(false);

  const checkAuth = useCallback(async () => {
    try {
      const s = await api<AuthStatus>('/api/auth/status');
      setAuth(s);
    } catch {
      setAuth({ authenticated: false, setupRequired: false });
    }
  }, []);

  const refresh = useCallback(async () => {
    if (updating) return;
    if (!auth?.authenticated) return;
    try {
      const s = await api<KioskState>('/api/state');
      setState(s);
    } catch (err) {
      const e = err as { status?: number };
      if (e.status === 401) {
        setAuth({ authenticated: false, setupRequired: false });
        setState(null);
      }
    }
  }, [auth?.authenticated, updating]);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    if (!auth?.authenticated) return;
    void refresh();
    const t = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(t);
  }, [auth?.authenticated, refresh]);

  async function logout() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      /* ignore */
    }
    setState(null);
    setAuth({ authenticated: false, setupRequired: false });
  }

  const connected = !!(state?.kiosk?.connected);

  return (
    <ToastProvider>
      <Header
        connected={connected}
        showLogout={!!auth?.authenticated}
        onLogout={() => void logout()}
      />
      {!auth ? null : !auth.authenticated ? (
        <AuthGate
          status={auth}
          onAuthed={() => {
            setAuth({ authenticated: true, setupRequired: false });
          }}
        />
      ) : state ? (
        <main className="shell">
          <PlanHero state={state} onRefresh={refresh} />
          <div className="card-grid">
            <PcoCard state={state} onRefresh={refresh} />
            <DisplayCard state={state} onRefresh={refresh} />
            <TvCard state={state} onRefresh={refresh} />
            <WifiCard state={state} />
            <RebootCard state={state} onRefresh={refresh} />
            <UpdateCard
              state={state}
              onRefresh={refresh}
              updating={updating}
              setUpdating={setUpdating}
            />
            <AccountCard />
          </div>
          <p className="footer">
            The TV browser shows <code>/display</code> when a plan is selected, or <code>/nowplaying</code> when idle.
          </p>
        </main>
      ) : (
        <main className="shell">
          <p className="hint">Loading…</p>
        </main>
      )}
    </ToastProvider>
  );
}
