const dbService = require('../services/dbService');

class PackageController {
  /** GET /api/packages?countryCode=DU&agentId=xxx */
  async getByCountry(req, res) {
    const { countryCode, agentId } = req.query;
    if (!countryCode) return res.status(400).json({ success: false, error: 'countryCode is required' });

    const packages = await dbService.getPackagesByCountry(countryCode, agentId || null);
    res.json({ success: true, count: packages.length, packages });
  }

  /** GET /api/packages/:pkgId/itinerary */
  async getItinerary(req, res) {
    const itinerary = await dbService.getPackageItinerary(req.params.pkgId);
    res.json({ success: true, count: itinerary.length, itinerary });
  }
}

module.exports = new PackageController();
