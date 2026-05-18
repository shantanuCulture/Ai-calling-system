const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/callController');

router.post('/outbound', ctrl.initiateOutboundCall.bind(ctrl));
router.get('/logs', ctrl.getCallLogs.bind(ctrl));
router.get('/leads', ctrl.getLeads.bind(ctrl));

module.exports = router;
