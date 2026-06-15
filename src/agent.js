'use strict';

/**
 * ITUPulse Agent — main loop.
 *
 * Safety rules enforced by design (spec section 14):
 * - reads ONLY the configured NGINX access log and /proc metrics
 * - outbound HTTPS only; accepts no inbound connections, executes no commands
 * - buffers locally when the backend is unreachable instead of crashing
 * - runs as the restricted `itupulse` user under systemd
 *
 * Modes (spec section 11):
 * - background: heartbeat 30s, metrics 5s, log flush 10s
 * - realtime:  when the heartbeat says a dashboard viewer is watching,
 *              metrics 2s and log flush 2s
 */
const config = require('./config');
const logger = require('./logger');
const { register } = require('./register');
const credentials = require('./credentials');
const buffer = require('./bufferStore');
const metricsCollector = require('./metricsCollector');
const NginxLogReader = require('./nginxLogReader');
const { post, isAuthFailure, isNetworkFailure } = require('./transportHttp');

let realtimeMode = false;
let pendingLogs = [];
let timers = [];
let logReader = null;
let stopping = false;

// ---------- senders ----------

async function sendLogs() {
  if (!realtimeMode) return; // logs only flow to the DB while a viewer is watching
  // Drain buffered backlog first, then in-memory batch.
  try {
    const backlog = buffer.drain('logs', config.logBatchSize);
    if (backlog.items.length) {
      await post('/api/v1/agent/logs', { logs: backlog.items });
      backlog.commit();
      return; // one batch per tick — keeps request sizes sane
    }
  } catch (err) {
    if (isAuthFailure(err)) return handleRevoked();
    // backlog stays in buffer, retry next tick
    return;
  }

  if (!pendingLogs.length) return;
  const batch = pendingLogs.splice(0, config.logBatchSize);
  try {
    await post('/api/v1/agent/logs', { logs: batch });
  } catch (err) {
    if (isAuthFailure(err)) return handleRevoked();
    if (isNetworkFailure(err) || err.status >= 500 || err.status === 429) {
      buffer.push('logs', batch); // park it locally, never lose data
    } else {
      logger.warn('log batch rejected by backend', { err: err.message });
    }
  }
}

// On-demand: read the last N lines straight from the access.log FILE and ship
// them immediately (used by the dashboard "read from file" / History view).
// Independent of realtime mode — this is an explicit request, not background.
async function sendTailFromFile(lines) {
  if (!logReader) return;
  const n = Math.min(Math.max(Number(lines) || 100, 1), 5000);
  let entries = [];
  try {
    entries = await logReader.backfill(n);
  } catch (err) {
    logger.warn('access.log tail read failed', { err: err.message });
    return;
  }
  // Always report the access.log health so the dashboard can explain results
  // (path found? readable? how many lines?) instead of spinning forever.
  try {
    const diag = logReader.diagnostics();
    await post('/api/v1/agent/log-status', {
      accessLog: diag.target,
      mode: diag.mode,
      targetExists: diag.targetExists,
      files: diag.files,
      returned: entries.length
    });
  } catch (err) {
    if (isAuthFailure(err)) return handleRevoked();
  }
  if (!entries.length) {
    logger.info('access.log tail requested but file had no readable lines', { requested: n });
    return;
  }
  // Send in chunks so request sizes stay sane; bypasses the realtime gate.
  for (let i = 0; i < entries.length; i += config.logBatchSize) {
    const batch = entries.slice(i, i + config.logBatchSize);
    try {
      await post('/api/v1/agent/logs', { logs: batch });
    } catch (err) {
      if (isAuthFailure(err)) return handleRevoked();
      buffer.push('logs', batch);
    }
  }
  logger.info('shipped access.log tail from file', { requested: n, sent: entries.length });
}

async function sendMetrics(live = false) {
  let snapshot;
  try {
    snapshot = await metricsCollector.collect();
  } catch (err) {
    logger.error('metrics collection failed', { err: err.message });
    return;
  }
  // `live` is explicit: true -> 1-min live sample (2-min retention in the DB),
  // false -> hourly background sample (7-day retention). Single `metrics` store.
  snapshot.live = live;

  // Flush one buffered metric first if present
  try {
    const backlog = buffer.drain('metrics', 1);
    if (backlog.items.length) {
      await post('/api/v1/agent/metrics', backlog.items[0]);
      backlog.commit();
    }
    await post('/api/v1/agent/metrics', snapshot);
  } catch (err) {
    if (isAuthFailure(err)) return handleRevoked();
    if (isNetworkFailure(err) || err.status >= 500 || err.status === 429) {
      buffer.push('metrics', [snapshot]);
    }
  }
}

async function sendHeartbeat() {
  try {
    const resp = await post('/api/v1/agent/heartbeat', {
      agentVersion: config.agentVersion,
      agentUptimeSec: Math.round(process.uptime()),
      bufferSize: buffer.size()
    });
    if (resp.data && resp.data.sampleNow) {
      sendMetrics(true).catch(() => {}); // on-demand sample requested from the dashboard
    }
    if (resp.data && resp.data.tailLogs > 0) {
      sendTailFromFile(resp.data.tailLogs).catch(() => {}); // dashboard asked to read access.log from file
    }
    const wantRealtime = Boolean(resp.data && resp.data.streamingRequested);
    if (wantRealtime !== realtimeMode) {
      realtimeMode = wantRealtime;
      logger.info(`switching to ${realtimeMode ? 'REALTIME' : 'background'} mode`);
      schedule(); // re-arm timers with new intervals
      // When a viewer opens this server, backfill recent history from the file
      // so the dashboard's History/stream shows it — without background storage.
      if (realtimeMode && logReader) {
        logReader.backfill(200)
          .then((entries) => { if (entries.length) { pendingLogs.push(...entries); return sendLogs(); } })
          .catch(() => {});
      }
    }
  } catch (err) {
    if (isAuthFailure(err)) return handleRevoked();
    logger.warn('heartbeat failed', { err: err.message });
  }
}

/**
 * Backend says 401 on signed requests: agent was revoked or decommissioned.
 * Stop sending, clear credentials, and exit — systemd will restart us, and
 * we'll sit in "waiting for registration" until a NEW install key is issued.
 */
function handleRevoked() {
  if (stopping) return;
  logger.error('backend rejected credentials — agent revoked. A new install key is required.');
  credentials.clear();
  shutdown(1);
}

// ---------- scheduling ----------

function clearTimers() {
  for (const t of timers) clearInterval(t);
  timers = [];
}

function schedule() {
  clearTimers();
  const flushMs = realtimeMode ? config.realtimeLogFlushIntervalMs : config.logFlushIntervalMs;

  // Background metric ALWAYS: one hourly sample regardless of whether anyone is
  // watching (live=false -> kept 7 days). This is the "whatever happens, send
  // every hour" guarantee — it no longer stops when the socket is active.
  timers.push(setInterval(() => sendMetrics(false).catch(() => {}), config.backgroundMetricIntervalMs));

  // Live metric ONLY while a dashboard viewer is watching this server:
  // a 1-minute sample (live=true -> auto-deleted after 2 minutes).
  if (realtimeMode) {
    timers.push(setInterval(() => sendMetrics(true).catch(() => {}), config.realtimeMetricIntervalMs));
  }

  timers.push(setInterval(() => sendLogs().catch(() => {}), flushMs));
  timers.push(setInterval(() => sendHeartbeat().catch(() => {}), config.heartbeatIntervalMs));

  // Send samples immediately so the dashboard has fresh data right after a
  // (re)start or a mode switch (otherwise the first hourly sample is an hour away).
  sendMetrics(false).catch(() => {});               // background snapshot now
  if (realtimeMode) sendMetrics(true).catch(() => {}); // live snapshot now (if watched)
}

// ---------- lifecycle ----------

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  logger.info('shutting down');
  clearTimers();
  if (logReader) logReader.stop();
  if (pendingLogs.length) buffer.push('logs', pendingLogs); // persist unsent
  // Best-effort: tell the backend we're going offline so the dashboard updates
  // immediately instead of waiting for the heartbeat timeout. Ignore failures.
  try {
    if (credentials.get()) {
      await post('/api/v1/agent/shutdown', { reason: 'service stop' }, { timeoutMs: 4000 });
    }
  } catch {
    /* offline detector will catch it anyway */
  }
  process.exit(code);
}

async function main() {
  logger.info(`ITUPulse Agent v${config.agentVersion} starting`, {
    api: config.apiUrl,
    accessLog: config.nginxAccessLog
  });

  // Register (no-op if credentials already exist). Retry with backoff —
  // backend might be briefly unreachable during install.
  let attempt = 0;
  while (!(await register())) {
    attempt += 1;
    const delay = Math.min(60000, 5000 * attempt);
    logger.warn(`registration retry in ${delay / 1000}s`);
    await new Promise((r) => setTimeout(r, delay));
    if (attempt > 20) {
      logger.error('registration failed too many times — exiting (systemd will restart)');
      process.exit(1);
    }
  }

  logReader = new NginxLogReader((entries) => {
    // Only stream logs to the backend while a dashboard viewer is watching this
    // server (realtime mode). In background we discard them — no DB spam. The
    // reader keeps advancing the file offset, so when a viewer connects we stream
    // from "now", not the whole backlog. Raw history lives in the access.log file.
    if (!realtimeMode) return;
    pendingLogs.push(...entries);
    if (pendingLogs.length > config.logBatchSize * 5) {
      buffer.push('logs', pendingLogs.splice(0, pendingLogs.length - config.logBatchSize));
    }
  });
  logReader.start();

  await sendHeartbeat(); // announce immediately (also learns watch mode)
  schedule();

  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  process.on('unhandledRejection', (err) => logger.error('unhandled rejection', { err: String(err) }));
}

main().catch((err) => {
  logger.error('fatal startup error', { err: err.message });
  process.exit(1);
});
