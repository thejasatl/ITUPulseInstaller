'use strict';

/**
 * ITUPulse access log — drop-in Express middleware.
 *
 * Writes ONE JSON line per HTTP request to <project>/logs/access.log, in the
 * exact format the ITUPulse agent parses. Point the agent's ITUPULSE_ACCESS_LOG
 * at that file OR at the logs folder — it auto-detects and starts charting
 * traffic, status codes, latency, and per-endpoint stats.
 *
 * Usage in your API (e.g. server.js), BEFORE your routes:
 *   const itupulseAccessLog = require('./middleware/express-access-log');
 *   app.use(itupulseAccessLog());        // default: ./logs/access.log
 *   // or: app.use(itupulseAccessLog('/var/log/itucareer-api/access.log'));
 */
const fs = require('fs');
const path = require('path');

module.exports = function itupulseAccessLog(filePath) {
  const target = filePath || path.join(process.cwd(), 'logs', 'access.log');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const stream = fs.createWriteStream(target, { flags: 'a' });

  return function (req, res, next) {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
      const fwd = req.headers['x-forwarded-for'];
      const ip = (fwd ? String(fwd).split(',')[0].trim() : (req.socket && req.socket.remoteAddress)) || '-';
      stream.write(
        JSON.stringify({
          time: new Date().toISOString(),
          ip,
          method: req.method,
          url: req.originalUrl,
          status: res.statusCode,
          ms,
          ua: req.headers['user-agent'] || '-'
        }) + '\n'
      );
    });
    next();
  };
};
