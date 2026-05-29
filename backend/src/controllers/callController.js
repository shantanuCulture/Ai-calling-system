'use strict';

const fs            = require('fs').promises;
const twilioService = require('../services/twilioService');
const dbService     = require('../services/dbService');
const callLogger    = require('../utils/callLogger');
const logger        = require('../utils/logger');

class CallController {

  /** POST /api/call/outbound */
  async initiateOutboundCall(req, res) {
    const { to, assistantId, customerName, notes } = req.body;
    if (!to) return res.status(400).json({ success: false, error: 'Phone number "to" is required' });

    logger.info(`Initiating outbound call to: ${to}`);
    const call = await twilioService.initiateOutboundCall({ to, vapiAssistantId: assistantId });

    res.json({
      success: true,
      callSid: call.sid,
      status:  call.status,
      to:      call.to,
      message: `Outbound call initiated to ${to}`,
    });
  }

  /** GET /api/call/history — call records from DB */
  async getHistory(req, res) {
    const limit = parseInt(req.query.limit, 10) || 100;
    const rows  = await dbService.getCallHistory(limit);
    res.json({ success: true, count: rows.length, calls: rows });
  }

  /** GET /api/call/stats — aggregated dashboard stats */
  async getStats(req, res) {
    const stats = await dbService.getCallStats();
    res.json({ success: true, stats });
  }

  /** GET /api/call/detail/:callSid — full JSON log for one call */
  async getDetail(req, res) {
    const { callSid } = req.params;
    const filePath    = await callLogger.findFile(callSid);
    if (!filePath) return res.status(404).json({ success: false, error: 'Call log not found' });
    const raw  = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(raw);
    res.json({ success: true, call: data });
  }

  /** GET /api/call/files — list of available log files */
  async getFiles(req, res) {
    const limit = parseInt(req.query.limit, 10) || 100;
    const files = await callLogger.listFiles(limit);
    res.json({ success: true, count: files.length, files });
  }
}

module.exports = new CallController();
