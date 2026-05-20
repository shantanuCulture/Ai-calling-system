const vapiClient = require('../integrations/vapi');
const config = require('../config');
const logger = require('../utils/logger');

class VapiService {
  async getAssistant(assistantId) {
    const id = assistantId || config.VAPI_ASSISTANT_ID;
    const res = await vapiClient.get(`/assistant/${id}`);
    return res.data;
  }

  async listAssistants() {
    const res = await vapiClient.get('/assistant');
    return res.data;
  }

  /**
   * Creates an outbound call directly via Vapi (alternative to Twilio-initiated outbound).
   * Requires a Vapi phone number ID configured in the dashboard.
   */
  async createOutboundCall({ phoneNumber, assistantId }) {
    const res = await vapiClient.post('/call/phone', {
      assistantId: assistantId || config.VAPI_ASSISTANT_ID,
      customer: { number: phoneNumber },
    });
    logger.info(`Vapi outbound call created: ${res.data.id}`);
    return res.data;
  }

  async updateAssistant(assistantId, patch) {
    const res = await vapiClient.patch(`/assistant/${assistantId}`, patch);
    logger.info(`Vapi assistant updated`, { assistantId, fields: Object.keys(patch) });
    return res.data;
  }

  // Sync the voice on every assistant in a squad to a single voice config.
  // voiceConfig: { provider: '11labs', voiceId: '...' }
  async syncSquadVoice(squadId, voiceConfig) {
    const squadRes  = await vapiClient.get(`/squad/${squadId}`);
    const members   = squadRes.data?.members || [];
    const results   = [];
    for (const m of members) {
      const id = m.assistantId || m.assistant?.id;
      if (!id) continue;
      const updated = await this.updateAssistant(id, { voice: voiceConfig });
      results.push({ id, name: updated.name });
    }
    logger.info(`syncSquadVoice: updated ${results.length} assistants`, { voiceConfig });
    return results;
  }

  async getCall(callId) {
    const res = await vapiClient.get(`/call/${callId}`);
    return res.data;
  }

  async listCalls(limit = 50) {
    const res = await vapiClient.get('/call', { params: { limit } });
    return res.data;
  }
}

module.exports = new VapiService();
