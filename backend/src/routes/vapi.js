const express      = require('express');
const router       = express.Router();
const ctrl         = require('../controllers/vapiController');
const vapiService  = require('../services/vapiService');
const config       = require('../config');
const logger       = require('../utils/logger');

// Tool call webhook — server.url on every Vapi tool
router.post('/tool-call', ctrl.handleToolCall.bind(ctrl));
router.post('/tool',      ctrl.handleToolCall.bind(ctrl)); // legacy alias

// Call lifecycle events — Server URL on the Vapi phone number
router.post('/events', ctrl.handleVapiEvent.bind(ctrl));

// PATCH /api/vapi/voice  — sync voice to all assistants in the squad
// Body: { voiceId: "...", provider: "11labs" }  (provider defaults to 11labs)
// Example: curl -X PATCH .../api/vapi/voice -d '{"voiceId":"EXAVITQu4vr4xnSDxMaL"}'
router.patch('/voice', async (req, res) => {
  const { voiceId, provider = '11labs' } = req.body;
  if (!voiceId) return res.status(400).json({ success: false, error: 'voiceId is required' });

  const squadId = config.VAPI_ASSISTANT_ID; // VAPI_ASSISTANT_ID holds the squad ID
  if (!squadId) return res.status(400).json({ success: false, error: 'VAPI_ASSISTANT_ID not set' });

  try {
    const updated = await vapiService.syncSquadVoice(squadId, { provider, voiceId });
    res.json({ success: true, updated });
  } catch (err) {
    logger.error('Voice sync failed', { message: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
