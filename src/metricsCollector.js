'use strict';

/**
 * System metrics from /proc and Node os module. Read-only, Linux-only.
 * CPU% and network rates are computed as deltas between samples.
 * RAM and disk report BOTH a percentage and absolute totals/used so the
 * dashboard shows real GB instead of approximations.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Accurate system CPU% over a fixed 250ms window. Measuring its OWN window
 * (instead of the delta between collect() calls) makes it correct regardless
 * of how often/closely collect() runs — the old cross-call delta could read a
 * tiny window where idle barely ticked and report a fake ~100%.
 */
async function cpuPercent() {
  try {
    const a = cpuSnapshot();
    await sleep(250);
    const b = cpuSnapshot();
    const dTotal = b.total - a.total;
    const dIdle = b.idle - a.idle;
    if (dTotal <= 0) return 0;
    return Math.min(100, Math.max(0, ((dTotal - dIdle) / dTotal) * 100));
  } catch {
    return 0;
  }
}

/** RAM: percent + absolute totals (MB) from /proc/meminfo (values are in kB). */
function ramStats() {
  try {
    const mem = readProc('/proc/meminfo');
    const get = (k) => Number((mem.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) || [])[1] || 0);
    const totalKb = get('MemTotal');
    const availKb = get('MemAvailable');
    if (!totalKb) return { percent: 0, totalMb: 0, usedMb: 0 };
    const usedKb = Math.max(0, totalKb - availKb);
    return {
      percent: Math.min(100, Math.max(0, (usedKb / totalKb) * 100)),
      totalMb: Math.round(totalKb / 1024),
      usedMb: Math.round(usedKb / 1024)
    };
  } catch {
    return { percent: 0, totalMb: 0, usedMb: 0 };
  }
}

/** Disk usage of the root filesystem: percent + absolute totals (GB). */
function diskStats() {
  return new Promise((resolve) => {
    const fromStatfs = (s) => {
      // Use bsize for byte sizing; "usable" excludes root-reserved blocks (matches df).
      const bs = s.bsize || 4096;
      const totalBytes = s.blocks * bs;
      const freeBytes = s.bavail * bs;
      const usedBytes = Math.max(0, (s.blocks - s.bfree) * bs);
      const usable = usedBytes + freeBytes;
      const GB = 1024 * 1024 * 1024;
      resolve({
        percent: usable ? Math.min(100, (usedBytes / usable) * 100) : 0,
        totalGb: +(usable / GB).toFixed(1),
        usedGb: +(usedBytes / GB).toFixed(1)
      });
    };
    if (typeof fs.statfs === 'function') {
      fs.statfs('/', (err, s) => {
        if (err || !s.blocks) return resolve({ percent: 0, totalGb: 0, usedGb: 0 });
        fromStatfs(s);
      });
    } else {
      // df -k fallback (kB). Columns: Filesystem 1K-blocks Used Available Use% Mounted
      execFile('df', ['-k', '/'], { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve({ percent: 0, totalGb: 0, usedGb: 0 });
        const cols = (stdout.split('\n')[1] || '').trim().split(/\s+/);
        const usedKb = Number(cols[2]) || 0;
        const availKb = Number(cols[3]) || 0;
        const pct = parseFloat(cols[4]);
        const usable = usedKb + availKb;
        resolve({
          percent: Number.isFinite(pct) ? pct : (usable ? (usedKb / usable) * 100 : 0),
          totalGb: +(usable / (1024 * 1024)).toFixed(1),
          usedGb: +(usedKb / (1024 * 1024)).toFixed(1)
        });
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
  const ram = ramStats();
  const disk = await diskStats();
  const cpu = await cpuPercent();
  return {
    cpuPercent: Number(cpu.toFixed(2)),
    ramPercent: Number(ram.percent.toFixed(2)),
    diskPercent: Number(disk.percent.toFixed(2)),
    ramTotalMb: ram.totalMb,
    ramUsedMb: ram.usedMb,
    diskTotalGb: disk.totalGb,
    diskUsedGb: disk.usedGb,
    networkRxBytes: net.rxPerSec,
    networkTxBytes: net.txPerSec,
    uptimeSeconds: Math.round(os.uptime()),
    hostname: os.hostname(),
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    timestamp: new Date().toISOString()
  };
}

module.exports = { collect };
