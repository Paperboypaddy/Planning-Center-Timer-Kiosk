'use strict';

(function () {
  const waitingEl = document.getElementById('waiting');
  const timerEl = document.getElementById('timer');
  const clockEl = document.getElementById('clock');
  const captionEl = document.getElementById('caption');
  const fallbackEl = document.getElementById('fallback');

  let state = null;
  let raf = null;

  function formatClock(ms) {
    const overtime = ms < 0;
    const abs = Math.abs(ms);
    const totalSec = Math.floor(abs / 1000);
    const d = Math.floor(totalSec / 86400);
    const h = Math.floor((totalSec % 86400) / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    let core;
    if (d > 0) core = `${d}:${pad(h)}:${pad(m)}:${pad(s)}`;
    else if (h > 0) core = `${h}:${pad(m)}:${pad(s)}`;
    else core = `${m}:${pad(s)}`;
    return { text: overtime ? `-${core}` : core, overtime };
  }

  function applyChrome(s) {
    const theme = s && s.theme === 'light' ? 'light' : 'dark';
    document.body.classList.toggle('theme-light', theme === 'light');
    document.body.classList.toggle('theme-dark', theme !== 'light');
    const dt = (s && s.displayType) || 'Countdown Full';
    const supported = !dt || /^countdown\s*full$/i.test(dt);
    fallbackEl.hidden = supported;
  }

  function paint() {
    if (!state) return;
    applyChrome(state);

    if (state.status !== 'live' || state.remainingMs == null) {
      waitingEl.hidden = false;
      timerEl.hidden = true;
      waitingEl.textContent = state.waitingMessage || 'Waiting for Services LIVE\u2026';
      return;
    }

    waitingEl.hidden = true;
    timerEl.hidden = false;
    const age = Date.now() - Date.parse(state.updatedAt || 0);
    const remaining = state.remainingMs - (Number.isFinite(age) ? age : 0);
    const clock = formatClock(remaining);
    clockEl.textContent = clock.text;
    clockEl.classList.toggle('overtime', clock.overtime);
    captionEl.textContent = state.caption || '';
  }

  function loop() {
    paint();
    raf = requestAnimationFrame(loop);
  }

  function onState(next) {
    state = next;
    paint();
  }

  function connectSse() {
    const es = new EventSource('/api/display/stream');
    es.onmessage = (ev) => {
      try {
        onState(JSON.parse(ev.data));
      } catch { /* ignore malformed */ }
    };
    es.onerror = () => {
      // EventSource reconnects; also poll a snapshot so we recover if SSE is blocked.
      fetch('/api/display/state')
        .then((r) => r.json())
        .then(onState)
        .catch(() => {});
    };
  }

  fetch('/api/display/state')
    .then((r) => r.json())
    .then(onState)
    .catch(() => {
      onState({
        status: 'waiting',
        waitingMessage: 'Waiting for Services LIVE\u2026',
        updatedAt: new Date().toISOString(),
      });
    })
    .finally(() => {
      connectSse();
      raf = requestAnimationFrame(loop);
    });
})();
