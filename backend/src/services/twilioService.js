const twilio = require('twilio');
const { getTwilioClient } = require('../integrations/twilio');
const config = require('../config');
const logger = require('../utils/logger');

const VoiceResponse = twilio.twiml.VoiceResponse;

class TwilioService {
  /**
   * Returns TwiML that bridges the Twilio call into a Vapi assistant via SIP.
   *
   * Vapi SIP endpoint format:  sip:<assistantId>@sip.vapi.ai
   * Vapi authenticates via the SIP username = your Vapi API key.
   */
  generateTwiMLForVapi(assistantId) {
    // Use the Vapi phone number UUID as the SIP address — this routes to the
    // squad configured on that number (same routing as api.vapi.ai/twilio/inbound_call).
    // Using the squad ID directly in SIP fails: Vapi returns "phone number not found".
    const sipTarget = config.VAPI_PHONE_NUMBER_ID || assistantId || config.VAPI_ASSISTANT_ID;
    const response = new VoiceResponse();

    const dial = response.dial({
      callerId:   config.TWILIO_PHONE_NUMBER,
      timeout:    60,
      // When the Vapi SIP session ends for ANY reason, Twilio calls this URL instead of hanging up.
      // This is how we bridge the caller to a human agent without a race condition.
      action:     `${config.BASE_URL}/api/twilio/after-vapi`,
      method:     'POST',
      // Trigger recording per-call — console setting alone is not enough
      record:     'record-from-answer',
      recordingStatusCallback:       `${config.BASE_URL}/api/twilio/recording-status`,
      recordingStatusCallbackMethod: 'POST',
    });

    // Transport=tcp required for Vapi SIP
    dial.sip(
      { username: config.VAPI_API_KEY },
      `sip:${sipTarget}@sip.vapi.ai;transport=tcp`
    );

    logger.info(`TwiML generated for Vapi SIP target: ${sipTarget}`);
    return response.toString();
  }

  /**
   * Returns TwiML that dials a human agent with a fallback action URL.
   * If the agent doesn't answer (DialCallStatus != completed), Twilio POSTs
   * to /api/twilio/transfer-fallback and we play an apologetic message.
   */
  generateTwiMLForTransfer(agentNumber) {
    const response = new VoiceResponse();

    response.say(
      { voice: 'Polly.Joanna' },
      'Please hold while we connect you to one of our agents.'
    );

    const dial = response.dial({
      callerId: config.TWILIO_PHONE_NUMBER,
      timeout: 30,
      action: `${config.BASE_URL}/api/twilio/transfer-fallback`,
      method: 'POST',
    });

    dial.number(agentNumber);
    logger.info(`Transfer TwiML generated for agent: ${agentNumber}`);
    return response.toString();
  }

  /**
   * Plays when the agent didn't pick up or the dial failed.
   */
  generateTransferFallbackTwiML() {
    const response = new VoiceResponse();
    response.say(
      { voice: 'Polly.Joanna' },
      'We are sorry, all of our agents are currently busy. ' +
        'Please leave your name and phone number and we will call you back shortly. ' +
        'Thank you for calling Culture Holidays.'
    );
    response.hangup();
    return response.toString();
  }

  /**
   * Initiates an outbound call via Twilio.
   * When the customer picks up, Twilio fetches /api/twilio/outbound-vapi
   * which returns TwiML to connect the call to the Vapi assistant.
   */
  async initiateOutboundCall({ to, vapiAssistantId }) {
    const client = getTwilioClient();
    const aid = vapiAssistantId || config.VAPI_ASSISTANT_ID;

    const call = await client.calls.create({
      to,
      from: config.TWILIO_PHONE_NUMBER,
      url: `${config.BASE_URL}/api/twilio/outbound-vapi?assistantId=${aid}`,
      method: 'POST',
      statusCallback: `${config.BASE_URL}/api/twilio/call-status`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    });

    logger.info(`Outbound call initiated: ${call.sid} → ${to}`);
    return call;
  }

  async getCallDetails(callSid) {
    const client = getTwilioClient();
    return client.calls(callSid).fetch();
  }
}

module.exports = new TwilioService();
