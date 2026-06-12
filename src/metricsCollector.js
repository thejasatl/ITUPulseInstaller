'use strict';

/**
 * System metrics from /proc and Node os module. Read-only, Linux-only.
 * CPU% and network rates are computed as deltas between samples.
 */
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const logger = require('./logger');

let prevCpu = null;
let prevNet = null;
let prevNetTime = null;

function readProc(file) {
  return fs.readFileSync(file, 'utf8');
}

/** Aggregate jiffies from /proc/stat 'cpu' line. */
function cpuSnapshot() {
  const line = readProc('/proc/stat').split('\n')[0];
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = parts[3] + (parts[4] || 0); // idle + iowait
  const total = parts.reduce((a, b) => a + b, 0);
  return { idle, total };
}

function cpuPercent() {
  try {
    const cur = cpuSnapshot();
    if (!prevCpu) {
      prevCpu = cur;
      return 0;
    }
    const dTotal = cur.total - prevCpu.total;
    const dIdle = cur.idle - prevCpu.idle;
    prevCpu = cur;
    if (dTotal <= 0) return 0;
    return Math.min(100, Math.max(0, ((dTotal - dIdle) / dTotal) * 100));
  } catch {
    return 0;
  }
}

function ramPercent() {
  try {
    const mem = readProc('/proc/meminfo');
    const get = (k) => Number((mem.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) || [])[1] || 0);
    const total = get('MemTotal');
    const available = get('MemAvailable');
    if (!total) return 0;
    return Math.min(100, Math.max(0, ((total - available) / total) * 100));
  } catch {
    return 0;
  }
}

/** Disk usage of the root filesystem via statfs (Node >= 18.15) or df fallback. */
function diskPercent() {
  return new Promise((resolve) => {
    if (typeof fs.statfs === 'function') {
      fs.statfs('/', (err, s) => {
        if (err || !s.blocks) return resolve(0);
        const used = s.blocks - s.bfree;
        const usable = used + s.bavail;
        resolve(usable ? Math.min(100, (used / usable) * 100) : 0);
      });
    } else {
      execFile('df', ['-k', '/'], { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve(0);
        const cols = (stdout.split('\n')[1] || '').trim().split(/\s+/);
        const pct = parseFloat(cols[4]);
        resolve(Number.isFinite(pct) ? pct : 0);
      });
    }
  });
}

/** RX/TX bytes per second from /proc/net/dev deltas (all non-loopback ifaces). */
function networkRates() {
  try {
    const now = Date.now();
    let rx = 0;
    let tx = 0;
    for (const line of readProc('/proc/net/dev').split('\n').slice(2)) {
      const m = line.trim().match(/^(\S+):\s*(.+)$/);
      if (!m || m[1] === 'lo') continue;
      const nums = m[2].trim().split(/\s+/).map(Number);
      rx += nums[0] || 0;
      tx += nums[8] || 0;
    }
    if (!prevNet) {
      prevNet = { rx, tx };
      prevNetTime = now;
      return { rxPerSec: 0, txPerSec: 0 };
    }
    const dt = (now - prevNetTime) / 1000;
    const rates = {
      rxPerSec: dt > 0 ? Math.max(0, Math.round((rx - prevNet.rx) / dt)) : 0,
      txPerSec: dt > 0 ? Math.max(0, Math.round((tx - prevNet.tx) / dt)) : 0
    };
    prevNet = { rx, tx };
    prevNetTime = now;
    return rates;
  } catch {
    return { rxPerSec: 0, txPerSec: 0 };
  }
}

async function collect() {
  const net = networkRates();
  return {
    cpuPercent: Number(cpuPercent().toFixed(2)),
    ramPercent: Number(ramPercent().toFixed(2)),
    diskPercent: Number((await diskPercent()).toFixed(2)),
    networkRxBytes: net.rxPerSec,
    networkTxBytes: net.txPerSec,
    uptimeSeconds: Math.round(os.uptime()),
    hostname: os.hostname(),
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    timestamp: new Date().toISOString()
  };
}

module.exports = { collect };
