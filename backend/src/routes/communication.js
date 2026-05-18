const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/communicationController');

router.post('/send-packages', ctrl.sendPackages.bind(ctrl));
router.post('/schedule-callback', ctrl.scheduleCallback.bind(ctrl));
router.get('/callbacks', ctrl.getPendingCallbacks.bind(ctrl));
router.put('/callbacks/:id/status', ctrl.updateCallbackStatus.bind(ctrl));

module.exports = router;
