'use strict';

/**
 * ITUPulse root updater — runs as root on a 30s systemd timer.
 *
 * It polls the API (signed with the agent's own credentials) for a pending
 * command. The only command today is 'update': it runs /opt/itupulse-agent/
 * update.sh, then reports success/failure back to the dashboard. Kept SEPARATE
 * from the agent so the agent itself stays non-root and fully sandboxed.
 */
const { execFile } = require('child_process');
const config = require('./config');
const credentials = require('./credentials');
const { post } = require('./transportHttp');
const logger = require('./logger');

const UPDATE_SCRIPT = '/opt/itupulse-agent/update.sh';

function currentVersion() {
  try {
    return require('/opt/itupulse-agent/package.json').version || '';
  } catch {
    return '';
  }
}

async function main() {
  if (!credentials.get()) {
    return; // not registered yet — nothing to do
  }

  let command = null;
  try {
    const resp = await post('/api/v1/agent/command', {}, { timeoutMs: 8000 });
    command = resp && resp.data ? resp.data.command : null;
  } catch (err) {
    logger.warn('updater: command poll failed', { err: err.message });
    return;
  }
  if (command !== 'update') return;

  logger.info('updater: update command received — running update.sh');
  const result = await new Promise((resolve) => {
    execFile(
      'bash',
      [UPDATE_SCRIPT],
      { timeout: 180000, maxBuffer: 4 * 1024 * 1024, env: process.env },
      (err, stdout, stderr) => {
        if (err) resolve({ ok: false, error: String(stderr || err.message || 'update failed').slice(-1500) });
        else resolve({ ok: true });
      }
    );
  });

  try {
    await post(
      '/api/v1/agent/command-result',
      { command: 'update', ok: result.ok, error: result.error, version: currentVersion() },
      { timeoutMs: 8000 }
    );
  } catch (err) {
    logger.warn('updater: failed to report result', { err: err.message });
  }
  logger.info('updater: finished', { ok: result.ok });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error('updater fatal', { err: e.message });
    process.exit(1);
  });
