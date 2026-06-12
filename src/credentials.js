'use strict';

/**
 * Agent credential storage.
 * serverId + agentSecret live in <stateDir>/credentials.json, owned by the
 * itupulse user, mode 600. Never in the repo, never in logs, never re-sent.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');

const CRED_FILE = path.join(config.stateDir, 'credentials.json');
let cached = null;

function get() {
  if (cached) return cached;
  try {
    const data = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    if (data.serverId && data.agentSecret) {
      cached = data;
      return cached;
    }
  } catch {
    /* not registered yet */
  }
  return null;
}

function save({ serverId, agentSecret }) {
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o750 });
  const tmp = CRED_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ serverId, agentSecret }), { mode: 0o600 });
  fs.renameSync(tmp, CRED_FILE);
  cached = { serverId, agentSecret };
}

function clear() {
  cached = null;
  try {
    fs.unlinkSync(CRED_FILE);
  } catch {
    /* already gone */
  }
}

module.exports = { get, save, clear, CRED_FILE };
