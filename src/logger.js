'use strict';

/**
 * Minimal structured logger. Writes to stdout/stderr — journalctl captures
 * everything when running under systemd. Never logs secrets.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = LEVELS[process.env.ITUPULSE_LOG_LEVEL || 'info'] || 20;

function log(level, msg, extra) {
  if (LEVELS[level] < minLevel) return;
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    msg,
    ...(extra || {})
  });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

module.exports = {
  debug: (msg, extra) => log('debug', msg, extra),
  info: (msg, extra) => log('info', msg, extra),
  warn: (msg, extra) => log('warn', msg, extra),
  error: (msg, extra) => log('error', msg, extra)
};
