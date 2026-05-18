const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/packageController');

router.get('/', ctrl.getByCountry.bind(ctrl));
router.get('/:pkgId/itinerary', ctrl.getItinerary.bind(ctrl));

module.exports = router;
