'use strict';

const express = require('express');
const { addClient } = require('../utils/logBroadcaster');

const router = express.Router();

// GET /api/logs/stream
// Server-Sent Events — streams every Winston log entry to the browser in real time.
router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // prevent nginx from buffering the stream
  res.flushHeaders();

  // Send an initial connected event
  res.write(`data: ${JSON.stringify({ level: 'system', message: 'Connected to live log stream', timestamp: new Date().toISOString() })}\n\n`);

  // Heartbeat every 25s keeps the connection alive through proxies/load balancers
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
  }, 25000);

  const removeClient = addClient(res);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient();
  });
});

module.exports = router;
