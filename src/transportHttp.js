'use strict';

/**
 * Signed HTTP transport to the ITUPulse backend.
 *
 * Auth model (matches backend agentAuth middleware):
 *   x-itupulse-server:    serverId
 *   x-itupulse-timestamp: unix ms
 *   x-itupulse-signature: HMAC-SHA256(key = sha256hex(agentSecret),
 *                                     msg = `${timestamp}.${rawJsonBody}`)
 *
 * The raw agent secret never leaves this machine after registration.
 * HTTPS is enforced by config.js. Certificate validation is Node default (on).
 */
const crypto = require('crypto');
const config = require('./config');
const logger = require('./logger');
const credentials = require('./credentials');

function signingKey(agentSecret) {
  return crypto.createHash('sha256').update(agentSecret).digest('hex');
}

async function post(path, body, { signed = true, timeoutMs = 15000 } = {}) {
  const url = `${config.apiUrl}${path}`;
  const raw = JSON.stringify(body);
  const headers = { 'content-type': 'application/json', 'user-agent': `itupulse-agent/${config.agentVersion}` };

  if (signed) {
    const creds = credentials.get();
    if (!creds) throw new Error('Agent not registered — no credentials');
    const ts = Date.now().toString();
    headers['x-itupulse-server'] = creds.serverId;
    headers['x-itupulse-timestamp'] = ts;
    headers['x-itupulse-signature'] = crypto
      .createHmac('sha256', signingKey(creds.agentSecret))
      .update(`${ts}.${raw}`)
      .digest('hex');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method: 'POST', headers, body: raw, signal: controller.signal });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error(json.error || `HTTP ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 401 on a signed request means we've been revoked or the server record is
 * gone. The agent must NOT retry forever with dead credentials.
 */
function isAuthFailure(err) {
  return err && err.status === 401;
}

function isNetworkFailure(err) {
  return err && !err.status;
}

module.exports = { post, isAuthFailure, isNetworkFailure };
