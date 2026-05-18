const dbService = require('../services/dbService');
const logger = require('../utils/logger');

class AgentController {
  /** GET /api/agents/by-phone?phone=+1xxx */
  async getByPhone(req, res) {
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ success: false, error: 'phone query param required' });

    const agent = await dbService.getAgentByPhone(phone);
    res.json({ success: true, found: !!agent, agent: agent || null });
  }

  /** GET /api/agents/:agentId */
  async getById(req, res) {
    const agent = await dbService.getAgentById(req.params.agentId);
    if (!agent) return res.status(404).json({ success: false, error: 'Agent not found' });
    res.json({ success: true, agent });
  }

  /** GET /api/agents/:agentId/bookings */
  async getBookings(req, res) {
    const bookings = await dbService.getAgentBookings(req.params.agentId);
    res.json({ success: true, count: bookings.length, bookings });
  }
}

module.exports = new AgentController();
