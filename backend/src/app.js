require('express-async-errors');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const logger = require('./utils/logger');
const twilioRoutes = require('./routes/twilio');
const vapiRoutes = require('./routes/vapi');
const callRoutes = require('./routes/call');
const agentRoutes = require('./routes/agent');
const packageRoutes = require('./routes/package');
const countryRoutes = require('./routes/country');
const communicationRoutes = require('./routes/communication');

const app = express();

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(morgan('combined', { stream: { write: (m) => logger.info(m.trim()) } }));

// ── Routes ─────────────────────────────────────────────────────────────────────
app.use('/api/twilio', twilioRoutes);
app.use('/api/vapi', vapiRoutes);
app.use('/api/call', callRoutes);
app.use('/api/agents', agentRoutes);
app.use('/api/packages', packageRoutes);
app.use('/api/countries', countryRoutes);
app.use('/api/communication', communicationRoutes);

// Health check
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
);

// ── Global Error Handler ────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  logger.error('Unhandled error', { message: err.message, url: req.url });
  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

module.exports = app;
