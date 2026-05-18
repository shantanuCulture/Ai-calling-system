const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/vapiController');

// Tool call webhook — server.url on every Vapi tool
router.post('/tool-call', ctrl.handleToolCall.bind(ctrl));
router.post('/tool',      ctrl.handleToolCall.bind(ctrl)); // legacy alias

// Call lifecycle events — Server URL on the Vapi phone number
router.post('/events', ctrl.handleVapiEvent.bind(ctrl));

module.exports = router;
