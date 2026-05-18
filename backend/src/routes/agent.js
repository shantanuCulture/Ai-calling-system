const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/agentController');

router.get('/by-phone', ctrl.getByPhone.bind(ctrl));
router.get('/:agentId/bookings', ctrl.getBookings.bind(ctrl));
router.get('/:agentId', ctrl.getById.bind(ctrl));

module.exports = router;
