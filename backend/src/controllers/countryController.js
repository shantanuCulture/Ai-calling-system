const dbService = require('../services/dbService');

class CountryController {
  /** GET /api/countries?agentId=xxx */
  async getAll(req, res) {
    const { agentId } = req.query;
    const countries = await dbService.getCountryList(agentId || '');
    res.json({ success: true, count: countries.length, countries });
  }
}

module.exports = new CountryController();
