'use strict';

/**
 * Offline buffer (spec: buffer data locally when backend is unavailable
 * instead of crashing; limit memory; rotate buffer files).
 *
 * JSONL files under <stateDir>/buffer/. Hard cap on total size — oldest
 * files are dropped first when the cap is hit.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

const BUFFER_DIR = path.join(config.stateDir, 'buffer');
const MAX_BUFFER_BYTES = 50 * 1024 * 1024; // 50 MB cap
const MAX_FILE_BYTES = 1024 * 1024; // rotate at 1 MB

fs.mkdirSync(BUFFER_DIR, { recursive: true, mode: 0o750 });

function bufferFiles(kind) {
  return fs
    .readdirSync(BUFFER_DIR)
    .filter((f) => f.startsWith(`${kind}-`) && f.endsWith('.jsonl'))
    .sort();
}

function enforceCap() {
  const all = fs
    .readdirSync(BUFFER_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const p = path.join(BUFFER_DIR, f);
      return { f, p, size: fs.statSync(p).size };
    })
    .sort((a, b) => (a.f < b.f ? -1 : 1));

  let total = all.reduce((s, x) => s + x.size, 0);
  for (const item of all) {
    if (total <= MAX_BUFFER_BYTES) break;
    fs.unlinkSync(item.p);
    total -= item.size;
    logger.warn('buffer cap reached — dropped oldest buffer file', { file: item.f });
  }
}

/** Append items (array) to the current buffer file for a kind ('logs'|'metrics'). */
function push(kind, items) {
  try {
    const files = bufferFiles(kind);
    let target = files.length ? path.join(BUFFER_DIR, files[files.length - 1]) : null;
    if (!target || fs.statSync(target).size > MAX_FILE_BYTES) {
      target = path.join(BUFFER_DIR, `${kind}-${Date.now()}.jsonl`);
    }
    const lines = items.map((i) => JSON.stringify(i)).join('\n') + '\n';
    fs.appendFileSync(target, lines);
    enforceCap();
  } catch (err) {
    logger.error('buffer write failed', { err: err.message });
  }
}

/** Drain up to `max` items of a kind. Returns { items, commit() } — call commit after successful send. */
function drain(kind, max) {
  const files = bufferFiles(kind);
  if (!files.length) return { items: [], commit: () => {} };

  const file = path.join(BUFFER_DIR, files[0]);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const take = lines.slice(0, max);
  const rest = lines.slice(max);

  const items = [];
  for (const line of take) {
    try {
      items.push(JSON.parse(line));
    } catch {
      /* skip corrupt line */
    }
  }

  return {
    items,
    commit() {
      try {
        if (rest.length) fs.writeFileSync(file, rest.join('\n') + '\n');
        else fs.unlinkSync(file);
      } catch (err) {
        logger.error('buffer commit failed', { err: err.message });
      }
    }
  };
}

function size() {
  try {
    return bufferFiles('logs').length + bufferFiles('metrics').length;
  } catch {
    return 0;
  }
}

module.exports = { push, drain, size };
