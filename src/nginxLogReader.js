'use strict';

/**
 * Safe access-log tail. Supports EITHER:
 *   - a single file:  ITUPULSE_ACCESS_LOG=/path/app/access.log
 *   - a whole folder: ITUPULSE_ACCESS_LOG=/path/app/logs   (tails every *.log in it)
 *
 * Lines that aren't valid access entries (plain stdout/stderr) are ignored by
 * the parser. A once-a-minute diagnostic line reports how many lines were read
 * vs parsed, so you can SEE whether your logs are request logs or just console
 * output (look in `journalctl -u itupulse-agent`).
 *
 * - Read-only; never writes/locks/rotates the logs
 * - Per-file byte offset persisted across restarts; handles logrotate
 * - Starts at end-of-file (monitors from "now", not history)
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const { parseLine } = require('./nginxParser');

const STATE_FILE = path.join(config.stateDir, 'state.json');
const CHUNK = 64 * 1024;
const POLL_MS = 1000;
const REPORT_MS = 60 * 1000;

class NginxLogReader {
  constructor(onEntries) {
    this.target = config.nginxAccessLog;
    this.onEntries = onEntries;
    this.files = new Map();
    this.reading = false;
    this.timer = null;
    // diagnostics
    this.statLines = 0;
    this.statParsed = 0;
    this.statSample = '';
    this.lastStatAt = Date.now();
  }

  loadState() {
    try {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (s.target === this.target && s.files) {
        for (const [f, v] of Object.entries(s.files)) {
          this.files.set(f, { offset: v.offset || 0, inode: v.inode || null, partial: '' });
        }
      }
    } catch {
      /* fresh start */
    }
  }

  saveState() {
    try {
      fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o750 });
      const files = {};
      for (const [f, v] of this.files) files[f] = { offset: v.offset, inode: v.inode };
      fs.writeFileSync(STATE_FILE, JSON.stringify({ target: this.target, files }));
    } catch (err) {
      logger.error('state save failed', { err: err.message });
    }
  }

  discover() {
    let st;
    try {
      st = fs.statSync(this.target);
    } catch {
      return [];
    }
    if (st.isDirectory()) {
      try {
        return fs.readdirSync(this.target)
          .filter((n) => n.endsWith('.log'))
          .map((n) => path.join(this.target, n));
      } catch {
        return [];
      }
    }
    return [this.target];
  }

  start() {
    this.loadState();
    for (const f of this.discover()) this.ensureTracked(f, true);
    this.saveState();
    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.timer.unref();
    const mode = (() => { try { return fs.statSync(this.target).isDirectory() ? 'directory' : 'file'; } catch { return 'pending'; } })();
    logger.info('access log reader started', { target: this.target, mode, tracking: this.files.size });
  }

  ensureTracked(file, atEnd) {
    if (this.files.has(file)) return;
    let size = 0;
    let ino = null;
    try {
      const st = fs.statSync(file);
      size = st.size;
      ino = st.ino;
    } catch {
      /* vanished */
    }
    this.files.set(file, { offset: atEnd ? size : 0, inode: ino, partial: '' });
  }

  stop() {
    clearInterval(this.timer);
    this.saveState();
  }

  /** Once a minute, tell the operator whether real request logs are being seen. */
  report() {
    const now = Date.now();
    if (now - this.lastStatAt < REPORT_MS) return;
    if (this.statLines > 0) {
      if (this.statParsed > 0) {
        logger.info(`access log OK: read ${this.statLines} new line(s), parsed ${this.statParsed} request(s) in the last minute`);
      } else {
        logger.warn(
          `access log: read ${this.statLines} new line(s) but NONE are request logs. ` +
            `The agent needs JSON ({"method","url","status","ms"}) or NGINX-combined lines. ` +
            `These look like app/console output. Sample: ${this.statSample || '(n/a)'}`
        );
      }
    }
    this.statLines = 0;
    this.statParsed = 0;
    this.statSample = '';
    this.lastStatAt = now;
  }

  poll() {
    if (this.reading) return;
    for (const f of this.discover()) this.ensureTracked(f, true);
    this.reading = true;
    this.readAll()
      .catch((err) => logger.error('log read failed', { err: err.message }))
      .finally(() => {
        this.reading = false;
        this.report();
      });
  }

  async readAll() {
    let touched = false;
    for (const [file, state] of this.files) {
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (state.inode !== null && st.ino !== state.inode) {
        state.inode = st.ino; state.offset = 0; state.partial = '';
      } else if (st.size < state.offset) {
        state.offset = 0; state.partial = '';
      }
      if (st.size === state.offset) continue;

      const fd = await fs.promises.open(file, 'r');
      try {
        while (state.offset < st.size) {
          const toRead = Math.min(CHUNK, st.size - state.offset);
          const buf = Buffer.alloc(toRead);
          const { bytesRead } = await fd.read(buf, 0, toRead, state.offset);
          if (bytesRead === 0) break;
          state.offset += bytesRead;

          const text = state.partial + buf.toString('utf8', 0, bytesRead);
          const lines = text.split('\n');
          state.partial = lines.pop();

          const entries = [];
          for (const line of lines) {
            if (!line.trim()) continue;
            this.statLines += 1;
            const entry = parseLine(line);
            if (entry) entries.push(entry);
            else if (!this.statSample) this.statSample = line.trim().slice(0, 100);
          }
          this.statParsed += entries.length;
          if (entries.length) this.onEntries(entries);
        }
        touched = true;
      } finally {
        await fd.close();
      }
    }
    if (touched) this.saveState();
  }
}

module.exports = NginxLogReader;
