'use strict';

/**
 * Access-log parser. Auto-detects per line:
 *   - JSON lines (apps that log one JSON object per request, e.g. the ITUPulse
 *     API's own logs/access.log, pino/winston/morgan-json, etc.)
 *   - NGINX "combined" format (+ optional ` rt=$request_time`)
 * Returns null for unparseable lines — never throws on garbage input.
 *
 * So you can point the agent at NGINX's access.log OR at an application's own
 * request-log file. See "Monitoring apps that write their own log file" docs.
 */

// 1.2.3.4 - user [12/Jun/2026:10:00:01 +0000] "GET /api/x HTTP/1.1" 200 512 "ref" "ua" rt=0.042
const LINE_RE =
  /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+)[^"]*" (\d{3}) \S+ "[^"]*" "([^"]*)"(?:.*?rt=([\d.]+))?/;

const MONTHS = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
};

const VALID_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** "12/Jun/2026:10:00:01 +0000" -> ISO string */
function parseNginxTime(s) {
  const m = s.match(/^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})$/);
  if (!m) return new Date().toISOString();
  const [, dd, mon, yyyy, hh, mi, ss, tz] = m;
  const offsetMin =
    (tz[0] === '-' ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
  const utcMs =
    Date.UTC(Number(yyyy), MONTHS[mon] ?? 0, Number(dd), Number(hh), Number(mi), Number(ss)) -
    offsetMin * 60 * 1000;
  return new Date(utcMs).toISOString();
}

function toIso(v) {
  if (!v) return new Date().toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/**
 * Parse a single JSON log line. Accepts common field-name variants so most
 * app loggers work without reformatting:
 *   method | verb
 *   url | path | endpoint | uri
 *   status | statusCode | code
 *   ms | responseTimeMs | durationMs        (milliseconds)
 *   responseTime | duration | rt | elapsed  (seconds — converted to ms)
 *   ip | remoteAddr | clientIp
 *   ua | userAgent | "user-agent"
 *   time | timestamp | @timestamp
 */
function fromJson(line) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;

  const method = String(o.method || o.verb || '').toUpperCase();
  if (!VALID_METHODS.has(method)) return null;

  const rawPath = o.url || o.path || o.endpoint || o.uri || '';
  if (!rawPath) return null;
  const endpoint = String(rawPath).split('?')[0].slice(0, 2048); // drop query (no sensitive data)

  const status = Number(o.status ?? o.statusCode ?? o.code ?? 0);
  if (!status || status < 100 || status > 599) return null;

  let ms = o.ms ?? o.responseTimeMs ?? o.durationMs;
  if (ms === undefined || ms === null) {
    const sec = o.responseTime ?? o.duration ?? o.rt ?? o.elapsed;
    ms = sec !== undefined && sec !== null ? Number(sec) * 1000 : 0;
  }
  ms = Math.max(0, Math.min(600000, Math.round(Number(ms) || 0)));

  const ua = o.ua || o.userAgent || o['user-agent'];
  return {
    ip: String(o.ip || o.remoteAddr || o.clientIp || '-').slice(0, 45),
    method,
    endpoint,
    statusCode: status,
    responseTimeMs: ms,
    userAgent: ua ? String(ua).slice(0, 512) : undefined,
    timestamp: toIso(o.time || o.timestamp || o['@timestamp'])
  };
}

/** Parse a single NGINX combined-format line. */
function fromNginx(line) {
  const m = line.match(LINE_RE);
  if (!m) return null;
  const [, ip, time, method, rawPath, status, ua, rt] = m;
  if (!VALID_METHODS.has(method)) return null;
  const endpoint = rawPath.split('?')[0].slice(0, 2048);
  return {
    ip,
    method,
    endpoint,
    statusCode: Number(status),
    responseTimeMs: rt !== undefined ? Math.round(parseFloat(rt) * 1000) : 0,
    userAgent: ua ? String(ua).slice(0, 512) : undefined,
    timestamp: parseNginxTime(time)
  };
}

function parseLine(line) {
  const t = line.trim();
  if (!t) return null;
  return t[0] === '{' ? fromJson(t) : fromNginx(t);
}

module.exports = { parseLine };
