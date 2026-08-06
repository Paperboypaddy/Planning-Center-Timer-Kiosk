'use strict';

// Polls Planning Center Services LIVE and turns the JSON into a TV display
// state (countdown remaining + projected "end on time" caption).
//
// The kiosk Chromium tab loads /display and consumes this via SSE — no PCO
// browser login required. An operator still advances items in Services LIVE.

const { EventEmitter } = require('events');
const { fetchLiveSnapshot, PcoError } = require('./pco');

const DEFAULT_POLL_MS = 1000;

function parseTime(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

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

function formatEndCaption(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const opts = { hour: 'numeric', minute: '2-digit' };
  // Prefer 12h like PCO's "10:50" when the locale supports it.
  const text = date.toLocaleTimeString('en-US', opts);
  return `Service should end on time at ${text}`;
}

function sumItemLengthsMs(items, { forProjectedEnd = false } = {}) {
  return (items || []).reduce((sum, item) => {
    // PCO's "end on time" projection uses during/post lengths (excludes pre
    // countdown blocks and headers), matching plan total_length.
    if (forProjectedEnd) {
      if (item.itemType === 'header') return sum;
      if (item.servicePosition === 'pre') return sum;
    }
    return sum + Math.max(0, Number(item.length) || 0) * 1000;
  }, 0);
}

function effectiveItemLengthSec(cur, items) {
  if (cur && Number(cur.length) > 0) return Number(cur.length);
  if (cur && cur.itemId && Array.isArray(items)) {
    const item = items.find((i) => i.id === cur.itemId);
    if (item && Number(item.length) > 0) return Number(item.length);
  }
  return 0;
}

function projectedCaptionFromItem(snapshot, cur, now, remainingMs) {
  let subsequentMs = 0;
  if (cur.itemId && Array.isArray(snapshot.items) && snapshot.items.length) {
    const current = snapshot.items.find((i) => i.id === cur.itemId);
    const seq = current ? current.sequence : null;
    if (seq != null) {
      for (const item of snapshot.items) {
        if (item.sequence > seq) subsequentMs += Math.max(0, item.length) * 1000;
      }
    }
  }
  const projectedEndAt = new Date(now + remainingMs + subsequentMs);
  let captionDate = projectedEndAt;
  if ((!snapshot.items || !snapshot.items.length) && snapshot.serviceEndsAt) {
    const planned = parseTime(snapshot.serviceEndsAt);
    if (planned != null) captionDate = new Date(planned);
  }
  return captionDate;
}

// Pure: build the Countdown Full payload from a Live snapshot + wall clock.
function computeDisplayState(snapshot, {
  now = Date.now(),
  displayType = 'Countdown Full',
  theme = 'dark',
  serviceName = null,
} = {}) {
  const base = {
    status: 'waiting',
    mode: null,
    displayType: displayType || 'Countdown Full',
    theme: theme === 'light' ? 'light' : 'dark',
    serviceName,
    remainingMs: null,
    clockText: null,
    overtime: false,
    caption: null,
    projectedEndAt: null,
    waitingMessage: 'Waiting for Services LIVE\u2026',
    liveId: snapshot && snapshot.liveId ? snapshot.liveId : null,
    error: null,
    updatedAt: new Date(now).toISOString(),
  };

  const cur = snapshot && snapshot.currentItemTime;
  let itemDeadlineMs = cur && cur.liveEndAt ? parseTime(cur.liveEndAt) : null;
  // LIVE often leaves live_end_at null; fall back to live_start + planned length
  // so the clock can still run (and go negative / red after the deadline).
  if (itemDeadlineMs == null && cur && cur.liveStartAt) {
    const start = parseTime(cur.liveStartAt);
    const lenSec = effectiveItemLengthSec(cur, snapshot.items);
    if (start != null && lenSec > 0) itemDeadlineMs = start + lenSec * 1000;
  }

  // Active LIVE item: countdown to deadline (overtime goes negative / red).
  if (itemDeadlineMs != null) {
    const remainingMs = itemDeadlineMs - now;
    const clock = formatClock(remainingMs);
    const captionDate = projectedCaptionFromItem(snapshot, cur, now, remainingMs);

    return {
      ...base,
      status: 'live',
      mode: 'item',
      remainingMs,
      clockText: clock.text,
      overtime: clock.overtime,
      caption: formatEndCaption(captionDate),
      projectedEndAt: captionDate.toISOString(),
      waitingMessage: null,
    };
  }

  // Scheduled service start: count down before, then keep counting negative
  // (red) after the start time has passed — same as PCO's overtime clock.
  const startMs = snapshot ? parseTime(snapshot.serviceStartsAt) : null;
  if (startMs != null) {
    const remainingMs = startMs - now;
    const clock = formatClock(remainingMs);
    const itemsMs = sumItemLengthsMs(snapshot.items, { forProjectedEnd: true });
    let captionDate = itemsMs > 0 ? new Date(startMs + itemsMs) : null;
    if (!captionDate && snapshot.serviceEndsAt) {
      const planned = parseTime(snapshot.serviceEndsAt);
      if (planned != null) captionDate = new Date(planned);
    }

    return {
      ...base,
      status: 'live',
      mode: 'scheduled',
      remainingMs,
      clockText: clock.text,
      overtime: clock.overtime,
      caption: captionDate ? formatEndCaption(captionDate) : null,
      projectedEndAt: captionDate ? captionDate.toISOString() : null,
      waitingMessage: null,
    };
  }

  if (!snapshot || !snapshot.liveId) {
    return { ...base, waitingMessage: 'Waiting for Services LIVE\u2026 Start LIVE on your phone or laptop.' };
  }

  return {
    ...base,
    waitingMessage: 'Services LIVE is open \u2014 advance to an item to start the countdown.',
  };
}

function createLiveDisplay({ getApiKey, logger = console, pollMs = DEFAULT_POLL_MS, fetchSnapshot = fetchLiveSnapshot } = {}) {
  const bus = new EventEmitter();
  bus.setMaxListeners(50);

  let timer = null;
  let target = null; // { planId, serviceTypeId, serviceName, displayType, theme }
  let lastState = computeDisplayState(null);
  let inFlight = false;

  function emitState(state) {
    lastState = state;
    bus.emit('state', state);
  }

  async function tick() {
    const active = target;
    if (!active || inFlight) return;
    const apiKey = typeof getApiKey === 'function' ? getApiKey() : getApiKey;
    if (!apiKey) {
      emitState({
        ...computeDisplayState(null, {
          displayType: active.displayType,
          theme: active.theme,
          serviceName: active.serviceName,
        }),
        waitingMessage: 'Add a Planning Center API key in Settings to drive the display.',
        error: 'no_api_key',
      });
      return;
    }
    inFlight = true;
    try {
      const snap = await fetchSnapshot(active.planId, active.serviceTypeId, { apiKey });
      // Deselect may have cleared target while we were awaiting.
      if (target !== active) return;
      emitState(computeDisplayState(snap, {
        displayType: active.displayType,
        theme: active.theme,
        serviceName: active.serviceName,
      }));
    } catch (err) {
      if (target !== active) return;
      const code = err instanceof PcoError ? err.code : 'error';
      logger.warn(`[display] live poll failed: ${err.message}`);
      emitState({
        ...lastState,
        status: 'error',
        error: code || 'error',
        waitingMessage: err.message || 'Could not reach Planning Center.',
        updatedAt: new Date().toISOString(),
        displayType: active.displayType,
        theme: active.theme,
        serviceName: active.serviceName,
      });
    } finally {
      inFlight = false;
    }
  }

  function start(nextTarget) {
    stopTimer();
    target = nextTarget;
    emitState(computeDisplayState(null, {
      displayType: nextTarget.displayType,
      theme: nextTarget.theme,
      serviceName: nextTarget.serviceName,
    }));
    tick();
    timer = setInterval(tick, pollMs);
    if (timer.unref) timer.unref();
  }

  function stopTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function stop() {
    stopTimer();
    target = null;
    emitState(computeDisplayState(null));
  }

  function updateOptions(patch) {
    if (!target) return;
    target = { ...target, ...patch };
    // Re-emit immediately so theme/layout changes apply without waiting a poll.
    emitState({
      ...lastState,
      displayType: target.displayType,
      theme: target.theme === 'light' ? 'light' : 'dark',
      serviceName: target.serviceName,
    });
  }

  function getState() {
    return lastState;
  }

  function subscribe(listener) {
    bus.on('state', listener);
    return () => bus.off('state', listener);
  }

  return { start, stop, updateOptions, getState, subscribe, computeDisplayState, tick };
}

module.exports = {
  createLiveDisplay,
  computeDisplayState,
  formatClock,
  formatEndCaption,
};
