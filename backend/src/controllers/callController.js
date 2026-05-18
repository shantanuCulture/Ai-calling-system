const twilioService = require('../services/twilioService');
const databaseService = require('../services/databaseService');
const logger = require('../utils/logger');

class CallController {
  /**
   * POST /api/call/outbound
   * Triggers an outbound call to a customer using Twilio, which then connects
   * the answered call to the configured Vapi assistant.
   */
  async initiateOutboundCall(req, res) {
    const { to, assistantId, customerName, notes } = req.body;

    if (!to) {
      return res.status(400).json({ success: false, error: 'Phone number "to" is required' });
    }

    logger.info(`Initiating outbound call to: ${to}`);
    const call = await twilioService.initiateOutboundCall({ to, vapiAssistantId: assistantId });

    databaseService.saveCallLog({
      callSid: call.sid,
      from: call.from,
      to: call.to,
      customerName,
      notes,
      direction: 'outbound',
      status: call.status,
    });

    res.json({
      success: true,
      callSid: call.sid,
      status: call.status,
      to: call.to,
      message: `Outbound call initiated to ${to}`,
    });
  }

  /** GET /api/call/logs */
  async getCallLogs(req, res) {
    const logs = databaseService.getAllCallLogs();
    res.json({ success: true, count: logs.length, callLogs: logs });
  }

  /** GET /api/call/leads */
  async getLeads(req, res) {
    const leads = databaseService.getAllLeads();
    res.json({ success: true, count: leads.length, leads });
  }
}

module.exports = new CallController();
