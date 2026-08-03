'use strict';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, { timeout = 5000, interval = 25 } = {}) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await delay(interval);
  }
}

const quietLogger = {
  log() {},
  warn() {},
  error() {},
};

module.exports = { delay, waitFor, quietLogger };
