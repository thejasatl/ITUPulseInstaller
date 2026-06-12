'use strict';

/**
 * NGINX access log parser.
 * Supports the standard "combined" format and the recommended "itupulse"
 * format (combined + ` rt=$request_time`). Returns null for unparseable lines
 * — never throws on garbage input.
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

function parseLine(line) {
  const m = line.match(LINE_RE);
  if (!m) return null;
  const [, ip, time, method, rawPath, status, , rt] = m;

  if (!VALID_METHODS.has(method)) return null; // skips malformed/binary junk requests

  // Strip query string — endpoint analytics group by path, and query strings
  // can contain sensitive data we should not ship (read-only, minimal data).
  const endpoint = rawPath.split('?')[0].slice(0, 2048);

  return {
    ip,
    method,
    endpoint,
    statusCode: Number(status),
    // rt is in seconds (e.g. 0.042) -> ms. Missing rt => 0 (latency unknown).
    responseTimeMs: rt !== undefined ? Math.round(parseFloat(rt) * 1000) : 0,
    timestamp: parseNginxTime(time)
  };
}

module.exports = { parseLine };
