'use strict';

const twilio        = require('twilio');
const twilioService = require('../services/twilioService');
const dbService     = require('../services/dbService');
const callSession   = require('../utils/callSession');
const callLogger    = require('../utils/callLogger');
const { normalize } = require('../utils/phoneUtils');
const otpStore      = require('../utils/otpStore');
const topicBuffer   = require('../utils/topicBuffer');
const config        = require('../config');
const logger        = require('../utils/logger');

const VoiceResponse = twilio.twiml.VoiceResponse;

const TERMINAL_STATUSES = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);

const SEP = '─'.repeat(60);

class TwilioController {

  // ── POST /api/twilio/incoming-call ─────────────────────────────────────────

  async handleIncomingCall(req, res) {
    const { From, To, CallSid, CallStatus } = req.body;
    const phone = normalize(From) || From || 'unknown';

    logger.info(SEP);
    logger.info('INBOUND CALL RECEIVED', { from: phone, to: To, callSid: CallSid, initialStatus: CallStatus });

    const record = await dbService.insertCallMaster({
      twilio_call_sid: CallSid,
      caller_phone:    phone,
      called_phone:    To || config.TWILIO_PHONE_NUMBER,
      direction:       'inbound',
    });
    logger.info('DB record created', { callId: record?.CallID, callSid: CallSid });

    if (!callSession.has(CallSid)) {
      callSession.set(CallSid, {
        callId:     record?.CallID || null,
        phone,
        callerType: 'unknown',
        isVerified: false,
      });
      logger.info('Session created', { callSid: CallSid, callId: record?.CallID, phone });
    } else {
      logger.info('Session already exists (Twilio retry)', { callSid: CallSid });
    }

    callLogger.start(CallSid, { phone, direction: 'inbound', callId: record?.CallID || null });
    callLogger.callEvent(CallSid, 'call_started', { phone, to: To, callId: record?.CallID || null });

    const squadId = config.VAPI_ASSISTANT_ID;
    logger.info(`Routing call → Vapi Squad via SIP`, { squadId, callSid: CallSid });

    const twiml = twilioService.generateTwiMLForVapi();
    res.type('text/xml').send(twiml);
  }

  // ── POST /api/twilio/call-status ──────────────────────────────────────────

  async handleCallStatus(req, res) {
    const { CallSid, CallStatus, CallDuration, RecordingSid, RecordingUrl } = req.body;

    logger.info('CALL STATUS', { callSid: CallSid, status: CallStatus, duration: CallDuration ? `${CallDuration}s` : '-' });

    if (TERMINAL_STATUSES.has(CallStatus)) {
      const flushed = await topicBuffer.flush(CallSid);
      if (flushed > 0) logger.info(`Topic buffer flushed`, { entries: flushed, callSid: CallSid });

      await dbService.closeCallMaster({
        twilio_call_sid: CallSid,
        call_status:     CallStatus,
        duration_secs:   CallDuration ? parseInt(CallDuration, 10) : null,
        recording_sid:   RecordingSid || null,
        recording_url:   RecordingUrl || null,
      });

      const session = callSession.get(CallSid);

      // Flush call log if saveCallSummary didn't already do it (e.g. call dropped mid-way)
      if (callLogger.has(CallSid)) {
        callLogger.callEvent(CallSid, 'call_ended_by_status', { status: CallStatus, durationSecs: CallDuration || null });
        await callLogger.flush(CallSid, { session });
      }

      if (session.phone) otpStore.remove(session.phone);
      if (session.pendingAgentPhone) otpStore.remove(session.pendingAgentPhone);
      callSession.remove(CallSid);

      logger.info('CALL ENDED', { callSid: CallSid, status: CallStatus, duration: CallDuration ? `${CallDuration}s` : '-', phone: session.phone });
      logger.info(SEP);

    } else if (CallStatus === 'in-progress') {
      await dbService.updateCallMaster({ twilio_call_sid: CallSid, call_status: 'in_progress' });
      logger.info('Call in progress', { callSid: CallSid });
    } else if (CallStatus === 'ringing') {
      logger.info('Call ringing', { callSid: CallSid });
    }

    res.sendStatus(200);
  }

  // ── POST /api/twilio/recording-status ─────────────────────────────────────

  async handleRecordingStatus(req, res) {
    const { CallSid, RecordingSid, RecordingUrl, RecordingStatus } = req.body;
    logger.info('RECORDING STATUS', { callSid: CallSid, status: RecordingStatus, recordingSid: RecordingSid });

    if (RecordingStatus === 'completed' && RecordingSid) {
      await dbService.updateCallMaster({
        twilio_call_sid: CallSid,
        recording_sid:   RecordingSid,
        recording_url:   RecordingUrl || null,
      });
      logger.info('Recording saved to DB', { callSid: CallSid, recordingSid: RecordingSid });
    }

    res.sendStatus(200);
  }

  // ── POST /api/twilio/transfer-call ────────────────────────────────────────

  async handleTransferCall(req, res) {
    const { agentNumber, department, callSid } = req.body;
    logger.info('TRANSFER TO HUMAN', { agentNumber, department, callSid });

    if (callSid) {
      await dbService.updateCallMaster({
        twilio_call_sid: callSid,
        routed_to:       `human_${department || 'sales'}`,
        routing_reason:  'Customer requested transfer',
      });
    }

    if (!agentNumber) {
      logger.warn('No agent number provided for transfer — playing unavailable message');
      const response = new VoiceResponse();
      response.say({ voice: 'Polly.Joanna' }, 'We are sorry, all agents are currently unavailable. Please call back during business hours.');
      response.hangup();
      return res.type('text/xml').send(response.toString());
    }

    const twiml = twilioService.generateTwiMLForTransfer(agentNumber);
    res.type('text/xml').send(twiml);
  }

  // ── POST /api/twilio/transfer-fallback ────────────────────────────────────

  async handleTransferFallback(req, res) {
    const { DialCallStatus, CallSid } = req.body;
    logger.warn('TRANSFER FALLBACK (agent did not answer)', { dialCallStatus: DialCallStatus, callSid: CallSid });

    if (CallSid) {
      await dbService.updateCallMaster({
        twilio_call_sid: CallSid,
        routing_reason:  `Transfer fallback: agent dial status = ${DialCallStatus}`,
      });
    }

    const twiml = twilioService.generateTransferFallbackTwiML();
    res.type('text/xml').send(twiml);
  }

  // ── POST /api/twilio/outbound-vapi ────────────────────────────────────────

  async handleOutboundVapi(req, res) {
    const { CallSid, From, To } = req.body;
    const assistantId = req.query.assistantId || config.VAPI_ASSISTANT_ID;
    const phone = normalize(To) || To || 'unknown';

    logger.info(SEP);
    logger.info('OUTBOUND CALL ANSWERED', { to: phone, callSid: CallSid, assistantId });

    if (CallSid && !callSession.has(CallSid)) {
      const record = await dbService.insertCallMaster({
        twilio_call_sid: CallSid,
        caller_phone:    phone,
        called_phone:    From || config.TWILIO_PHONE_NUMBER,
        direction:       'outbound',
      });
      if (!callSession.has(CallSid)) {
        callSession.set(CallSid, { callId: record?.CallID || null, phone, callerType: 'unknown', isVerified: false });
        logger.info('Outbound session created', { callSid: CallSid, callId: record?.CallID, phone });
      }
    }

    logger.info(`Routing outbound → Vapi Squad via SIP`, { assistantId, callSid: CallSid });
    const twiml = twilioService.generateTwiMLForVapi(assistantId);
    res.type('text/xml').send(twiml);
  }
}

module.exports = new TwilioController();
