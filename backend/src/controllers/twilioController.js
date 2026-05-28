'use strict';

const twilio           = require('twilio');
const twilioService    = require('../services/twilioService');
const dbService        = require('../services/dbService');
const callSession      = require('../utils/callSession');
const callLogger       = require('../utils/callLogger');
const { normalize }    = require('../utils/phoneUtils');
const otpStore         = require('../utils/otpStore');
const topicBuffer      = require('../utils/topicBuffer');
const config           = require('../config');
const logger           = require('../utils/logger');
const { getActiveAgents } = require('../utils/businessHours');

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

    logger.info(`Routing call → Vapi via SIP`, { sipTarget: config.VAPI_PHONE_NUMBER_ID, callSid: CallSid });

    const twiml = twilioService.generateTwiMLForVapi();
    res.type('text/xml').send(twiml);
  }

  // ── POST /api/twilio/call-status ──────────────────────────────────────────

  async handleCallStatus(req, res) {
    const { CallSid, CallStatus, CallDuration, RecordingSid, RecordingUrl } = req.body;

    logger.info('CALL STATUS', {
      callSid:      CallSid,
      status:       CallStatus,
      duration:     CallDuration ? `${CallDuration}s` : '-',
      Direction:    req.body.Direction,
      From:         req.body.From,
      To:           req.body.To,
      SequenceNumber: req.body.SequenceNumber,
    });

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

  // ── POST /api/twilio/after-vapi ──────────────────────────────────────────
  // Called by Twilio when the Vapi SIP <Dial> ends for ANY reason (normal end, endCall, etc.)
  // instead of Twilio hanging up the parent PSTN call.
  // If a pendingTransfer is stored in session → dial the support agent.
  // Otherwise → play goodbye and hang up.

  async handleAfterVapi(req, res) {
    const { CallSid, DialCallStatus, DialCallSid } = req.body;

    // pendingTransfer may be stored under the parent SID (CallSid) or the Vapi
    // dial-leg SID (DialCallSid), depending on whether the call was routed via
    // our server or Vapi's native Twilio integration. Check both.
    const parentSession  = callSession.get(CallSid)    || {};
    const dialSession    = DialCallSid ? (callSession.get(DialCallSid) || {}) : {};
    const sessionWithPending = parentSession.pendingTransfer ? parentSession : dialSession;
    const sidWithPending     = parentSession.pendingTransfer ? CallSid : DialCallSid;

    logger.info(SEP);
    logger.info('▶ AFTER VAPI — Vapi SIP ended', {
      callSid:         CallSid,
      dialCallSid:     DialCallSid,
      dialCallStatus:  DialCallStatus,
      pendingTransfer: sessionWithPending.pendingTransfer || null,
      rawBody:         req.body,
    });

    const pending = sessionWithPending.pendingTransfer;
    if (pending && pending.numbers && pending.numbers.length > 0) {
      logger.info('AFTER VAPI: Pending transfer found — dialling support', {
        callSid:    CallSid,
        sidWithPending,
        department: pending.department,
        numbers:    pending.numbers,
      });

      // Clear the pending transfer so it isn't re-used on fallback
      callSession.merge(sidWithPending, { pendingTransfer: null });

      const fallbackUrl = `${config.BASE_URL}/api/twilio/transfer-fallback`;
      const response    = new VoiceResponse();
      const dial = response.dial({
        callerId: config.TWILIO_PHONE_NUMBER,
        timeout:  30,
        action:   fallbackUrl,
        method:   'POST',
      });

      for (const number of pending.numbers) {
        const dialLegStatusUrl = `${config.BASE_URL}/api/twilio/dial-leg-status`;
        dial.number({
          statusCallbackEvent:   'initiated ringing answered completed',
          statusCallback:        dialLegStatusUrl,
          statusCallbackMethod:  'POST',
        }, number);
        logger.info('AFTER VAPI: Added <Number> to Dial', { callSid: CallSid, number });
      }

      const twiml = response.toString();
      logger.info('AFTER VAPI: Returning Dial TwiML', { callSid: CallSid, twiml });
      return res.type('text/xml').send(twiml);
    }

    // No pending transfer — call ended normally, hang up cleanly
    logger.info('AFTER VAPI: No pending transfer — hanging up', { callSid: CallSid });
    const response = new VoiceResponse();
    response.hangup();
    return res.type('text/xml').send(response.toString());
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

  // ── POST /api/twilio/human-support ───────────────────────────────────────
  // Called via Twilio REST API redirect from transferToHuman tool.
  // Rings all active support agents from DB simultaneously (falls back to .env).

  async handleHumanSupport(req, res) {
    const { CallSid } = req.body;

    logger.info(SEP);
    logger.info('▶ HUMAN SUPPORT HANDLER — full Twilio request body', {
      callSid:     CallSid,
      CallStatus:  req.body.CallStatus,
      From:        req.body.From,
      To:          req.body.To,
      Direction:   req.body.Direction,
      rawBody:     req.body,
    });

    // Load agents from DB — fall back to .env SUPPORT_NUMBERS if DB is empty
    let supportNumbers = [];
    let agentSource = 'none';
    try {
      const dbAgents = await getActiveAgents('support');
      supportNumbers = dbAgents.map(a => a.phone).filter(Boolean);
      agentSource = 'db';
      logger.info('HUMAN SUPPORT: DB agents loaded', {
        callSid: CallSid,
        count:   supportNumbers.length,
        agents:  dbAgents.map(a => ({ name: a.name, phone: a.phone, priority: a.priority })),
      });
    } catch (err) {
      logger.warn('HUMAN SUPPORT: Could not load agents from DB — falling back to .env', { err: err.message });
    }

    if (supportNumbers.length === 0) {
      supportNumbers = config.SUPPORT_NUMBERS || [];
      agentSource = 'env';
      logger.info('HUMAN SUPPORT: Using .env fallback numbers', {
        callSid:         CallSid,
        count:           supportNumbers.length,
        SUPPORT_NUMBERS: supportNumbers,
      });
    }

    if (supportNumbers.length === 0) {
      logger.warn('HUMAN SUPPORT: No support agents configured anywhere — playing unavailable message', { callSid: CallSid });
      const response = new VoiceResponse();
      response.say({ voice: 'Polly.Joanna' }, 'We are sorry, all agents are currently unavailable. Please call back shortly and we will be happy to assist you.');
      response.hangup();
      const twiml = response.toString();
      logger.info('HUMAN SUPPORT: Returning unavailable TwiML', { callSid: CallSid, twiml });
      return res.type('text/xml').send(twiml);
    }

    if (CallSid) {
      await dbService.updateCallMaster({
        twilio_call_sid: CallSid,
        call_status:     'in_progress',
        routed_to:       'human_support',
      }).catch(() => {});
    }

    const fallbackUrl = `${config.BASE_URL}/api/twilio/transfer-fallback`;
    logger.info('HUMAN SUPPORT: Building Dial TwiML', {
      callSid:      CallSid,
      callerId:     config.TWILIO_PHONE_NUMBER,
      timeout:      30,
      actionUrl:    fallbackUrl,
      dialNumbers:  supportNumbers,
      agentSource,
    });

    const response = new VoiceResponse();

    const dial = response.dial({
      callerId: config.TWILIO_PHONE_NUMBER,
      timeout:  30,
      action:   fallbackUrl,
      // answerOnBridge intentionally omitted (defaults false) — caller hears ringback tone while agent's phone rings.
      // With answerOnBridge=true the caller hears dead silence until the agent picks up, which causes them to hang up.
    });

    const dialLegStatusUrl = `${config.BASE_URL}/api/twilio/dial-leg-status`;
    for (const number of supportNumbers) {
      dial.number({
        statusCallbackEvent: 'initiated ringing answered completed',
        statusCallback:      dialLegStatusUrl,
        statusCallbackMethod: 'POST',
      }, number);
      logger.info(`HUMAN SUPPORT: Added <Number> to Dial`, { callSid: CallSid, number, dialLegStatusUrl });
    }

    const twiml = response.toString();
    logger.info('HUMAN SUPPORT: Returning TwiML to Twilio', { callSid: CallSid, twiml });
    res.type('text/xml').send(twiml);
  }

  // ── POST /api/twilio/dial-leg-status ─────────────────────────────────────
  // Per-leg status callback — fires for every state change on the outbound dial
  // leg to +918292879966 (or any support number). Gives us initiated/ringing/answered/completed.

  async handleDialLegStatus(req, res) {
    const {
      CallSid, CallStatus,
      To, From,
      CallDuration,
    } = req.body;

    logger.info('▶ DIAL LEG STATUS', {
      to:          To,
      from:        From,
      callSid:     CallSid,
      callStatus:  CallStatus,
      duration:    CallDuration ? `${CallDuration}s` : 'N/A',
      rawBody:     req.body,
    });

    res.sendStatus(200);
  }

  // ── POST /api/twilio/connect-salesperson ─────────────────────────────────
  // Called via Twilio REST API redirect from connectToSalesperson tool.
  // Dials a specific salesperson number with 30-second timeout.
  // On no-answer → /api/twilio/salesperson-fallback → routes back to Vapi.

  async handleConnectSalesperson(req, res) {
    const { CallSid } = req.body;
    const session     = CallSid ? (callSession.get(CallSid) || {}) : {};

    // Phone and name stored in session by _connectToSalesperson tool handler
    const phone = session.pendingSalespersonPhone || null;
    const name  = session.pendingSalespersonName  || 'your contact';

    logger.info('CONNECT SALESPERSON', { callSid: CallSid, phone: phone || 'none', name });

    if (!phone) {
      logger.warn('handleConnectSalesperson: no pendingSalespersonPhone in session — falling back');
      const response = new VoiceResponse();
      response.say({ voice: 'Polly.Joanna' }, `We're sorry, we could not connect you at this time. Let us arrange a callback for you.`);
      const vapiTwiml = twilioService.generateTwiMLForVapi();
      // Re-enter Vapi with no-answer flag already set
      if (CallSid) {
        callSession.merge(CallSid, { salespersonCallResult: 'no_phone', salespersonCallAt: Date.now() });
      }
      return res.type('text/xml').send(vapiTwiml);
    }

    if (CallSid) {
      await dbService.updateCallMaster({
        twilio_call_sid: CallSid,
        call_status:     'in_progress',
        routed_to:       `salesperson_${name.replace(/\s+/g, '_').toLowerCase()}`,
      }).catch(() => {});
    }

    const response = new VoiceResponse();
    response.say({ voice: 'Polly.Joanna' }, `Please hold while we connect you to ${name}.`);

    const dial = response.dial({
      callerId:       config.TWILIO_PHONE_NUMBER,
      timeout:        30,
      action:         `${config.BASE_URL}/api/twilio/salesperson-fallback`,
      answerOnBridge: true,
    });
    dial.number(phone);

    res.type('text/xml').send(response.toString());
  }

  // ── POST /api/twilio/salesperson-fallback ─────────────────────────────────
  // Called by Twilio when the salesperson dial times out / doesn't answer.
  // Stores the no-answer result in session and returns the call to Vapi Squad.
  // Receptionist picks up the call again with _ctx.salespersonCallResult = 'no_answer'.

  async handleSalespersonFallback(req, res) {
    const { DialCallStatus, CallSid } = req.body;
    const session = CallSid ? (callSession.get(CallSid) || {}) : {};
    const name    = session.pendingSalespersonName || 'the contact';

    logger.warn('SALESPERSON FALLBACK', {
      dialCallStatus: DialCallStatus,
      callSid:        CallSid,
      salesperson:    name,
    });

    // Mark no-answer in session so Receptionist can explain it when Vapi resumes
    if (CallSid) {
      callSession.merge(CallSid, {
        salespersonCallResult:  'no_answer',
        salespersonCallAt:      Date.now(),
        // Keep pendingSalespersonName for _buildCtx to expose in _ctx
      });
      await dbService.updateCallMaster({
        twilio_call_sid: CallSid,
        routing_reason:  `Salesperson ${name} did not answer (DialCallStatus: ${DialCallStatus})`,
      }).catch(() => {});
    }

    // Route the call back into Vapi Squad — session context is preserved.
    // Receptionist will fire identifyCaller → agent_verified, then read
    // _ctx.salespersonCallResult and offer a callback.
    const twiml = twilioService.generateTwiMLForVapi();
    res.type('text/xml').send(twiml);
  }

  // ── POST /api/twilio/transfer-fallback ────────────────────────────────────

  async handleTransferFallback(req, res) {
    const {
      DialCallStatus, DialCallSid, DialCallDuration,
      CallSid, CallStatus, DialBridged,
      From, To,
    } = req.body;

    logger.warn(SEP);
    logger.warn('▶ TRANSFER FALLBACK — full Twilio request body', {
      callSid:          CallSid,
      CallStatus,
      DialCallStatus,
      DialCallSid,
      DialCallDuration: DialCallDuration ? `${DialCallDuration}s` : 'N/A',
      DialBridged:      DialBridged ?? 'N/A',
      From,
      To,
      rawBody:          req.body,
    });

    // Interpret the dial outcome
    if (DialCallStatus === 'completed') {
      logger.info('TRANSFER FALLBACK: Agent answered and call completed normally', { callSid: CallSid, DialCallSid, duration: DialCallDuration });
    } else if (DialCallStatus === 'no-answer') {
      logger.warn('TRANSFER FALLBACK: Agent did not answer within timeout (30s)', { callSid: CallSid });
    } else if (DialCallStatus === 'busy') {
      logger.warn('TRANSFER FALLBACK: Agent line was busy', { callSid: CallSid });
    } else if (DialCallStatus === 'failed') {
      logger.warn('TRANSFER FALLBACK: Dial to agent FAILED (bad number or carrier error)', { callSid: CallSid });
    } else if (DialCallStatus === 'canceled') {
      logger.warn('TRANSFER FALLBACK: Dial was canceled — caller likely hung up before agent answered', { callSid: CallSid });
    } else {
      logger.warn(`TRANSFER FALLBACK: Unexpected DialCallStatus = "${DialCallStatus}"`, { callSid: CallSid });
    }

    if (CallSid) {
      await dbService.updateCallMaster({
        twilio_call_sid: CallSid,
        routing_reason:  `Transfer fallback: DialCallStatus=${DialCallStatus} DialCallSid=${DialCallSid || 'none'} duration=${DialCallDuration || 0}s`,
      });
    }

    const twiml = twilioService.generateTransferFallbackTwiML();
    logger.warn('TRANSFER FALLBACK: Returning fallback TwiML', { callSid: CallSid, twiml });
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
