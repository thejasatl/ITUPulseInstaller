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
  let resp;
  try {
    resp = await fetch(url, { method: 'POST', headers, body: raw, signal: controller.signal });
  } catch (e) {
    // Node's fetch throws an opaque "fetch failed" — the real reason lives in
    // e.cause. Surface it so install/registration shows WHY it failed:
    //   ECONNREFUSED            -> API not listening on that host:port
    //   ENOTFOUND / EAI_AGAIN   -> DNS can't resolve the API domain
    //   ETIMEDOUT               -> firewall / port 4000 blocked
    //   *SELF_SIGNED* / *VERIFY*-> TLS cert not trusted (self-signed cert)
    //   ABORT_ERR               -> request timed out
    clearTimeout(timer);
    const c = (e && e.cause) ? e.cause : e;
    const detail = (c && (c.code || c.reason || c.message)) || (e && e.message) || 'unknown';
    let hint = '';
    if (/ECONNREFUSED/i.test(detail)) hint = ' (API not reachable on that host:port — is it running on 4000 and is the port open?)';
    else if (/ENOTFOUND|EAI_AGAIN/i.test(detail)) hint = ' (DNS cannot resolve the API domain from this server)';
    else if (/ETIMEDOUT|CONNECT_TIMEOUT|aborted|ABORT/i.test(detail)) hint = ' (connection timed out — firewall blocking port 4000?)';
    else if (/SELF_SIGNED|UNABLE_TO_VERIFY|CERT|TLS|SSL|ALT_NAME/i.test(detail)) hint = ' (TLS certificate not trusted — self-signed cert? use a real CA cert, or set NODE_TLS_REJECT_UNAUTHORIZED=0 for testing only)';
    const err = new Error(`network error: ${detail}${hint} [${url}]`);
    err.cause = c;
    throw err;
  }
  try {
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
