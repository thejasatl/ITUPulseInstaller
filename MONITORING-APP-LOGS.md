# Monitoring apps that write their OWN log file (no NGINX)

The agent doesn't require NGINX. It tails **one request-log file** and parses
each line. It now auto-detects two formats per line:

1. **NGINX combined** (`/var/log/nginx/access.log`)
2. **JSON-lines** — one JSON object per request. This is what most apps (and the
   ITUPulse API itself) write. Point the agent at that file instead.

So if your project has its own log folder (e.g. `myapi/logs/access.log`), just
point the agent at it.

## Point the agent at your app's log

Edit `/etc/itupulse/agent.env`:

```
# preferred name (works for nginx OR an app log file)
ITUPULSE_ACCESS_LOG=/opt/itucareer-api/logs/access.log
```
(`ITUPULSE_NGINX_ACCESS_LOG` still works too.)

Then restart the agent:
```
sudo systemctl restart itupulse-agent   # or: pm2 restart itupulse-agent
```

Two things the agent needs to read the file:
- The `itupulse` user must be able to read it. Either put the log in a
  world-readable dir, add `itupulse` to the file's group, or run the agent as a
  user that can read it. Give the systemd unit read access:
  `ReadOnlyPaths=-/opt/itucareer-api/logs` (the install unit already tolerates
  missing paths).
- The app must **append** to the file (not keep it open-and-truncate). Logrotate
  is handled (the reader detects rotation/truncation).

## Required JSON line format

One JSON object per line. The agent is flexible about field names — any of
these work:

| Field        | Accepted keys                                   | Notes |
|--------------|-------------------------------------------------|-------|
| HTTP method  | `method` or `verb`                              | GET/POST/… |
| Path         | `url` or `path` or `endpoint` or `uri`          | query string is stripped |
| Status code  | `status` or `statusCode` or `code`              | 100–599 |
| Latency (ms) | `ms` or `responseTimeMs` or `durationMs`        | milliseconds |
| Latency (s)  | `responseTime` or `duration` or `rt` or `elapsed` | seconds → converted to ms |
| Client IP    | `ip` or `remoteAddr` or `clientIp`              | optional |
| User agent   | `ua` or `userAgent` or `user-agent`             | optional |
| Time         | `time` or `timestamp` or `@timestamp`           | ISO 8601; defaults to now |

Example line the agent parses (this is exactly what the ITUPulse API writes):
```json
{"time":"2026-06-15T07:00:00.000Z","ip":"41.58.12.9","method":"GET","url":"/api/v1/orders?page=2","status":200,"ms":42,"ua":"Mozilla/5.0"}
```

## Make your Node/Express API write this file (drop-in)

```js
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'logs');
fs.mkdirSync(dir, { recursive: true });
const stream = fs.createWriteStream(path.join(dir, 'access.log'), { flags: 'a' });

app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
    stream.write(JSON.stringify({
      time: new Date().toISOString(),
      ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '-').toString().split(',')[0].trim(),
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      ms,
      ua: req.headers['user-agent'] || '-'
    }) + '\n');
  });
  next();
});
```

Other frameworks: morgan `morgan('combined')` (NGINX-style) or a JSON token
format, pino-http, winston with a JSON file transport — all produce lines the
agent can read. The ITUPulse API's own `src/middleware/accessLog.js` is a working
reference.

## Self-monitoring the ITUPulse API
The API already writes `logs/access.log` in this exact format. To watch the API
server itself, install the agent there and set
`ITUPULSE_ACCESS_LOG=/path/to/ITUPulseAgent/logs/access.log`.

## Mixed / multiple logs
One agent tails one file. If an app writes several logs, point the agent at the
combined request log, or run one agent per log file (each = its own dashboard
server). Both NGINX and JSON lines can even coexist in the same file — the agent
detects each line independently.
