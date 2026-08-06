type Props = {
  connected: boolean;
  showLogout: boolean;
  onLogout: () => void;
};

export function Header({ connected, showLogout, onLogout }: Props) {
  return (
    <header className="app-header">
      <div className="brand">
        <h1>Kiosk Control</h1>
        <span className="tagline">Planning Center countdown</span>
      </div>
      <div className="header-actions">
        {showLogout && (
          <button type="button" className="btn" onClick={onLogout}>
            Log out
          </button>
        )}
        <span className={`badge ${connected ? '' : 'off'}`.trim()}>
          {connected ? 'kiosk connected' : 'kiosk offline'}
        </span>
      </div>
    </header>
  );
}
