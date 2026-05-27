const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/twilioController');

// Inbound call from Twilio (set this URL in Twilio console → Phone Numbers)
router.post('/incoming-call', ctrl.handleIncomingCall.bind(ctrl));

// Human escalation: transfer active call to an agent
router.post('/transfer-call', ctrl.handleTransferCall.bind(ctrl));

// Simultaneous ring to all human support agents (redirected via Twilio REST API)
router.post('/human-support', ctrl.handleHumanSupport.bind(ctrl));

// Twilio action URL called when the agent dial attempt ends (no-answer, busy, etc.)
router.post('/transfer-fallback', ctrl.handleTransferFallback.bind(ctrl));

// Called when an outbound call is answered — attaches Vapi assistant
router.post('/outbound-vapi', ctrl.handleOutboundVapi.bind(ctrl));

// Twilio status callbacks (initiated/ringing/answered/completed)
router.post('/call-status', ctrl.handleCallStatus.bind(ctrl));

// Recording ready callback (configure in Twilio Console → Recording Status Callback)
router.post('/recording-status', ctrl.handleRecordingStatus.bind(ctrl));

// Connect caller to a specific salesperson (triggered by connectToSalesperson tool)
router.post('/connect-salesperson', ctrl.handleConnectSalesperson.bind(ctrl));

// Fallback when salesperson doesn't answer — returns call to Vapi Squad
router.post('/salesperson-fallback', ctrl.handleSalespersonFallback.bind(ctrl));

module.exports = router;
