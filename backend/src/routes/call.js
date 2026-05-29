const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/callController');

router.post('/outbound',         ctrl.initiateOutboundCall.bind(ctrl));
router.get('/history',           ctrl.getHistory.bind(ctrl));
router.get('/stats',             ctrl.getStats.bind(ctrl));
router.get('/files',             ctrl.getFiles.bind(ctrl));
router.get('/detail/:callSid',   ctrl.getDetail.bind(ctrl));

module.exports = router;
