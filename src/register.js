'use strict';

/**
 * One-time registration with the install key.
 * - Sends machine fingerprint: sha256(machine-id + hostname) per security spec
 * - Stores serverId + agentSecret (mode 600) — the secret is never re-sent
 * - The install key is dead after this (backend flips it atomically)
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const config = require('./config');
const logger = require('./logger');
const credentials = require('./credentials');
const { post } = require('./transportHttp');

function machineFingerprint() {
  let machineId = '';
  for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      machineId = fs.readFileSync(p, 'utf8').trim();
      break;
    } catch {
      /* try next */
    }
  }
  return crypto.createHash('sha256').update(`${machineId}${os.hostname()}`).digest('hex');
}

async function register() {
  if (credentials.get()) {
    logger.info('already registered — skipping registration');
    return true;
  }
  if (!config.installKey) {
    logger.error('not registered and no ITUPULSE_INSTALL_KEY configured');
    return false;
  }

  logger.info('registering with backend…');
  try {
    const resp = await post(
      '/api/v1/agent/register',
      {
        installKey: config.installKey,
        name: config.serverName || os.hostname(),
        hostname: os.hostname(),
        os: `${os.type()} ${os.release()} (${os.arch()})`,
        agentVersion: config.agentVersion,
        machineFingerprint: machineFingerprint()
      },
      { signed: false }
    );

    const { serverId, agentSecret } = resp.data || {};
    if (!serverId || !agentSecret) {
      logger.error('registration response missing credentials');
      return false;
    }
    credentials.save({ serverId, agentSecret });
    logger.info('registered successfully', { serverId });
    return true;
  } catch (err) {
    logger.error('registration failed', { err: err.message });
    return false;
  }
}

module.exports = { register };
