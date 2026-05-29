const winston = require('winston');
const path = require('path');
const { broadcast } = require('./logBroadcaster');

const { combine, timestamp, errors, json, printf, colorize } = winston.format;

// Custom transport — streams every log entry to connected SSE clients.
class SseTransport extends winston.Transport {
  log(info, callback) {
    setImmediate(() => this.emit('logged', info));
    const { level, message, timestamp: ts, service: _s, splat: _sp, ...meta } = info;
    broadcast({ level, message, timestamp: ts, ...meta });
    callback();
  }
}

// Readable single-line console format:
//   10:42:31 [INFO]  Inbound call received  from=+919876543210 sid=CA123...
const consoleFormat = printf(({ level, message, timestamp: ts, service: _s, ...meta }) => {
  const time = ts ? ts.slice(11, 19) : '';  // HH:MM:SS

  // Flatten key metadata into  key=value pairs, skipping internal fields
  const skip = new Set(['stack']);
  const pairs = Object.entries(meta)
    .filter(([k, v]) => !skip.has(k) && v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('  ');

  const line = `${time} [${level.toUpperCase().padEnd(5)}]  ${message}`;
  return pairs ? `${line}  ${pairs}` : line;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(timestamp(), errors({ stack: true }), json()),
  defaultMeta: { service: 'ai-call-system' },
  transports: [
    new winston.transports.Console({
      format: combine(colorize({ all: true }), timestamp(), errors({ stack: true }), consoleFormat),
    }),
    new winston.transports.File({
      filename: path.join('logs', 'error.log'),
      level: 'error',
    }),
    new winston.transports.File({
      filename: path.join('logs', 'combined.log'),
    }),
    new SseTransport(),
  ],
});

module.exports = logger;
