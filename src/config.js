'use strict';

/**
 * Agent configuration.
 * systemd injects /etc/itupulse/agent.env via EnvironmentFile, so everything
 * arrives as process.env. Falls back to reading the file directly when run
 * manually (e.g. registration test during install).
 */
const fs = require('fs');
let pkgVersion = '1.0.5';
try { pkgVersion = require('../package.json').version || pkgVersion; } catch { /* keep default */ }

const ENV_FILE = process.env.ITUPULSE_ENV_FILE || '/etc/itupulse/agent.env';

function loadEnvFile() {
  try {
    const content = fs.readFileSync(ENV_FILE, 'utf8');
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    /* env file optional when vars come from systemd */
  }
}

loadEnvFile();

// Test-only escape hatch: accept a self-signed / untrusted API TLS cert.
// This DISABLES certificate verification — only for testing against a box that
// doesn't yet have a real CA cert. Production must use a valid full-chain cert.
if (String(process.env.ITUPULSE_INSECURE_TLS || '').toLowerCase() === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  process.stderr.write(
    'WARNING: ITUPULSE_INSECURE_TLS=true — TLS certificate verification is DISABLED. Use only for testing.\n'
  );
}

function required(name) {
  const v = process.env[name];
  if (!v) {
    process.stderr.write(`FATAL: missing required config ${name} (set in ${ENV_FILE})\n`);
    process.exit(1);
  }
  return v;
}

const config = {
  apiUrl: required('ITUPULSE_API_URL').replace(/\/+$/, ''),
  installKey: process.env.ITUPULSE_INSTALL_KEY || '',
  serverName: process.env.ITUPULSE_SERVER_NAME || '',
  environment: process.env.ITUPULSE_ENVIRONMENT || 'production',
  // Path to the request log to tail. Either NGINX's access.log OR an app's own
  // request-log file (JSON-lines auto-detected). ITUPULSE_ACCESS_LOG is the
  // preferred name; ITUPULSE_NGINX_ACCESS_LOG kept for backward compatibility.
  nginxAccessLog: process.env.ITUPULSE_ACCESS_LOG || process.env.ITUPULSE_NGINX_ACCESS_LOG || '/var/log/nginx/access.log',

  metricIntervalMs: Number(process.env.ITUPULSE_METRIC_INTERVAL_MS) || 3600000,
  logBatchSize: Math.min(Number(process.env.ITUPULSE_LOG_BATCH_SIZE) || 100, 500),

  // Background mode: relaxed intervals. Realtime mode (viewer watching): fast.
  // 1h when idle. Deliberately ignores the legacy ITUPULSE_METRIC_INTERVAL_MS
  // (old installs set it to 5-15s) and clamps to a 1-min floor so a stale
  // agent.env can never spam the database.
  backgroundMetricIntervalMs: Math.max(60000, Number(process.env.ITUPULSE_BACKGROUND_METRIC_MS) || 3600000),
  // realtime (a viewer is watching) stays fast:
  realtimeMetricIntervalMs: Math.max(15000, Number(process.env.ITUPULSE_REALTIME_METRIC_MS) || 60000), // 1 min while watched (floor 15s)
  heartbeatIntervalMs: 30000,
  logFlushIntervalMs: 10000,
  realtimeLogFlushIntervalMs: 2000,

  stateDir: process.env.ITUPULSE_STATE_DIR || '/var/lib/itupulse-agent',
  agentVersion: pkgVersion
};

// Security: refuse plain HTTP outside explicit dev override (spec: HTTPS only).
if (!config.apiUrl.startsWith('https://') && process.env.ITUPULSE_ALLOW_INSECURE !== 'true') {
  process.stderr.write('FATAL: ITUPULSE_API_URL must use https:// (set ITUPULSE_ALLOW_INSECURE=true only for local testing)\n');
  process.exit(1);
}

module.exports = config;
