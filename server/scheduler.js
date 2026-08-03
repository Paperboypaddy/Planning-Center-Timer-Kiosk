'use strict';

const { execFile } = require('child_process');
const { CronExpressionParser } = require('cron-parser');

// Background tasks for the kiosk:
//   - auto-on: turn the TV on `leadMinutes` before the next service/rehearsal
//     time of any configured service (needs a PCO API key to know the times)
//   - daily reboot: `systemctl reboot` when config.reboot.cron matches
// All timing is coarse (checked every intervalMs); failure is always non-fatal.
function createScheduler({
  config,
  persist,
  pco,
  cec,
  apiKey,
  logger = console,
  rebootFn = null,
  intervalMs = 60000,
  cacheMs = 5 * 60 * 1000,
}) {
  let timer = null;
  let stopped = false;
  let autoOnFired = null; // ISO of the event we last turned the TV on for
  let rebootFiredMinute = null; // epoch-minute we last fired a reboot for
  let nextTimeCache = { at: 0, value: null };

  function checkReboot() {
    if (!config.reboot || !config.reboot.cron) return;
    const now = new Date();
    let expr;
    try {
      expr = CronExpressionParser.parse(config.reboot.cron, { currentDate: now });
    } catch (err) {
      logger.warn(`[scheduler] invalid reboot cron "${config.reboot.cron}": ${err.message}`);
      return;
    }
    const prev = expr.prev().toDate();
    const minute = Math.floor(now.getTime() / 60000);
    if (Math.floor(prev.getTime() / 60000) === minute && rebootFiredMinute !== minute) {
      rebootFiredMinute = minute;
      logger.log(`[scheduler] scheduled reboot (cron "${config.reboot.cron}")`);
      if (rebootFn) {
        rebootFn();
      } else {
        execFile('systemctl', ['reboot'], (err) => {
          if (err) logger.warn(`[scheduler] reboot failed: ${err.message}`);
        });
      }
    }
  }

  // Earliest upcoming service/rehearsal time across all configured services,
  // cached for cacheMs to limit PCO API calls.
  async function nextServiceTime() {
    if (Date.now() - nextTimeCache.at < cacheMs) return nextTimeCache.value;
    const key = apiKey();
    let next = null;
    if (key) {
      const nowMs = Date.now();
      const horizon = nowMs + 7 * 24 * 3600 * 1000;
      for (const s of config.services) {
        if (!s.serviceId) continue;
        let st = s.serviceTypeId;
        if (!st) {
          try {
            st = await pco.resolveServiceTypeId(s.serviceId, { apiKey: key });
            if (st) {
              s.serviceTypeId = st;
              persist();
            }
          } catch {
            /* keep going */
          }
          if (!st) continue;
        }
        let times;
        try {
          times = await pco.listPlanTimes(s.serviceId, st, { apiKey: key });
        } catch {
          continue;
        }
        for (const t of times) {
          if (t.timeType !== 'service' && t.timeType !== 'rehearsal') continue;
          const ts = t.startsAt ? Date.parse(t.startsAt) : NaN;
          if (Number.isNaN(ts)) continue;
          if (ts > nowMs - 120000 && ts < horizon && (next === null || ts < next)) next = ts;
        }
      }
    }
    nextTimeCache = { at: Date.now(), value: next };
    return next;
  }

  async function checkAutoOn() {
    if (!config.tv || !config.tv.autoOn) return;
    if (!apiKey()) return; // can't know service times without the API
    const nowMs = Date.now();
    const next = await nextServiceTime();
    if (!next) return;
    const lead = (config.tv.leadMinutes || 0) * 60000;
    const eventKey = new Date(next).toISOString();
    if (nowMs >= next - lead && nowMs < next && autoOnFired !== eventKey) {
      autoOnFired = eventKey;
      const r = await cec.powerOn();
      logger.log(`[scheduler] auto-on TV for ${new Date(next).toISOString()} -> ${r.ok ? 'sent' : 'failed'}`);
      if (!r.ok) logger.warn(`[scheduler] auto-on command failed: ${r.error || 'unknown'}`);
    }
  }

  async function tick() {
    if (stopped) return;
    try {
      checkReboot();
    } catch (err) {
      logger.warn(`[scheduler] reboot check failed: ${err.message}`);
    }
    try {
      await checkAutoOn();
    } catch (err) {
      logger.warn(`[scheduler] auto-on check failed: ${err.message}`);
    }
  }

  return {
    start() {
      if (timer) return;
      stopped = false;
      timer = setInterval(tick, intervalMs);
      tick();
    },
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

module.exports = { createScheduler };
