'use strict';

/**
 * Safe NGINX access.log tail.
 * - Read-only (open flag 'r'); never writes, locks, or rotates the log itself
 * - Persists byte offset in <stateDir>/state.json across restarts
 * - Handles logrotate: file truncation (size < offset) and inode change
 * - Backpressure: reads in 64 KB chunks, max one read loop at a time
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const { parseLine } = require('./nginxParser');

const STATE_FILE = path.join(config.stateDir, 'state.json');
const CHUNK = 64 * 1024;
const POLL_MS = 1000;

class NginxLogReader {
  constructor(onEntries) {
    this.file = config.nginxAccessLog;
    this.onEntries = onEntries;
    this.offset = 0;
    this.inode = null;
    this.partial = '';
    this.reading = false;
    this.timer = null;
  }

  loadState() {
    try {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (s.file === this.file) {
        this.offset = s.offset || 0;
        this.inode = s.inode || null;
      }
    } catch {
      /* fresh start */
    }
  }

  saveState() {
    try {
      fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o750 });
      fs.writeFileSync(STATE_FILE, JSON.stringify({ file: this.file, offset: this.offset, inode: this.inode }));
    } catch (err) {
      logger.error('state save failed', { err: err.message });
    }
  }

  start() {
    this.loadState();
    let st;
    try {
      st = fs.statSync(this.file);
    } catch {
      logger.warn('nginx access log not found yet — will keep polling', { file: this.file });
    }
    if (st) {
      if (this.inode === null) {
        // First run: start at end of file. We monitor from now, not history.
        this.offset = st.size;
        this.inode = st.ino;
        this.saveState();
      }
    }
    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.timer.unref();
    logger.info('nginx log reader started', { file: this.file, offset: this.offset });
  }

  stop() {
    clearInterval(this.timer);
    this.saveState();
  }

  poll() {
    if (this.reading) return;
    let st;
    try {
      st = fs.statSync(this.file);
    } catch {
      return; // log file missing (rotation gap) — retry next poll
    }

    // Rotation detection
    if (this.inode !== null && st.ino !== this.inode) {
      logger.info('log rotation detected (inode changed) — restarting from new file');
      this.inode = st.ino;
      this.offset = 0;
      this.partial = '';
    } else if (st.size < this.offset) {
      logger.info('log truncation detected — resetting offset');
      this.offset = 0;
      this.partial = '';
    }
    if (st.size === this.offset) return;

    this.reading = true;
    this.readNew(st.size)
      .catch((err) => logger.error('log read failed', { err: err.message }))
      .finally(() => {
        this.reading = false;
      });
  }

  async readNew(fileSize) {
    const fd = await fs.promises.open(this.file, 'r');
    try {
      while (this.offset < fileSize) {
        const toRead = Math.min(CHUNK, fileSize - this.offset);
        const buf = Buffer.alloc(toRead);
        const { bytesRead } = await fd.read(buf, 0, toRead, this.offset);
        if (bytesRead === 0) break;
        this.offset += bytesRead;

        const text = this.partial + buf.toString('utf8', 0, bytesRead);
        const lines = text.split('\n');
        this.partial = lines.pop(); // last element is incomplete (or '')

        const entries = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          const entry = parseLine(line);
          if (entry) entries.push(entry);
        }
        if (entries.length) this.onEntries(entries);
      }
      this.saveState();
    } finally {
      await fd.close();
    }
  }
}

module.exports = NginxLogReader;
