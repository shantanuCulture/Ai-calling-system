'use strict';

const dbService    = require('../services/dbService');
const emailService = require('../services/emailService');
const smsService   = require('../services/smsService');
const config       = require('../config');
const otpStore     = require('../utils/otpStore');
const callSession  = require('../utils/callSession');
const callLogger   = require('../utils/callLogger');
const topicBuffer  = require('../utils/topicBuffer');
const { normalize: normalizePhone } = require('../utils/phoneUtils');
const logger             = require('../utils/logger');
const resolvePackageRef  = require('../utils/resolvePackageRef');

// ── Country list cache ────────────────────────────────────────────────────────
// Loaded once from DB, refreshed every hour. Used to match destination names
// from conversation-update events without hitting DB on every event.
let _countryCache     = null;
let _countryCacheTime = 0;
const COUNTRY_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getCachedCountries() {
  const now = Date.now();
  if (!_countryCache || (now - _countryCacheTime) > COUNTRY_CACHE_TTL_MS) {
    _countryCache     = await dbService.getCountryList('').catch(() => []);
    _countryCacheTime = now;
  }
  return _countryCache;
}

// Levenshtein edit distance — handles phonetic/spelling variations from STT.
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = [];
  for (let i = 0; i <= m; i++) {
    dp[i] = [i];
    for (let j = 1; j <= n; j++) dp[i][j] = i === 0 ? j : 0;
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

// Match a free-text destination string against the country list.
// Common English words that appear in travel phrases but are NOT destinations.
// Prevents "new booking" → "New Zealand", "turkey dinner" → "Turkey", etc.
const COUNTRY_MATCH_STOPWORDS = new Set([
  'new', 'the', 'for', 'are', 'can', 'want', 'book', 'make', 'plan', 'trip',
  'tour', 'help', 'need', 'call', 'also', 'just', 'your', 'have', 'will',
  'from', 'that', 'this', 'with', 'more', 'some', 'here', 'there', 'like',
  'only', 'back', 'into', 'them', 'then', 'than', 'when', 'been', 'good',
  'very', 'each', 'much', 'over', 'same', 'take', 'name', 'most', 'many',
  'about', 'would', 'could', 'going', 'speak', 'visit', 'travel', 'holiday',
  'package', 'booking', 'enquiry', 'agent', 'human', 'support',
]);

// Returns the country object with an extra _matchLevel field, or null.
// Levels (high → low): 'exact' → 'substring' → 'word' → 'fuzzy'
// Use _matchLevel to decide whether to override an existing session destination.
function matchCountry(text, countries) {
  if (!text || !countries?.length) return null;
  const t = text.toLowerCase().trim();

  // Pass 1: exact name
  let m = countries.find(c => c.CountryName?.toLowerCase() === t);
  if (m) return { ...m, _matchLevel: 'exact' };

  // Pass 2: substring either way
  m = countries.find(c => {
    const n = c.CountryName?.toLowerCase() || '';
    return n.includes(t) || t.includes(n);
  });
  if (m) return { ...m, _matchLevel: 'substring' };

  // Pass 3: any significant word (4+ chars, not a stopword) appears in country name
  const words = t.split(/\s+/).filter(w => w.length > 3 && !COUNTRY_MATCH_STOPWORDS.has(w));
  if (words.length > 0) {
    m = countries.find(c => {
      const n = c.CountryName?.toLowerCase() || '';
      return words.some(w => n.includes(w));
    });
    if (m) return { ...m, _matchLevel: 'word' };
  }

  // Pass 4: Levenshtein — catch phonetic/spelling variations ("Dobai"→"Dubai")
  // Only run against single-word input or individual words to avoid false positives
  // on full sentences.
  const inputWords = t.split(/\s+/).filter(w => w.length > 3 && !COUNTRY_MATCH_STOPWORDS.has(w));
  const candidates = inputWords.length > 0 ? inputWords : [t];
  const scored = countries.map(c => {
    const name = c.CountryName?.toLowerCase() || '';
    const nameWords = name.split(/\s+/);
    const distFull = Math.min(...candidates.map(iw => levenshtein(iw, name)));
    const distWord = Math.min(...candidates.flatMap(iw => nameWords.map(nw => levenshtein(iw, nw))));
    return { c, dist: Math.min(distFull, distWord) };
  });
  scored.sort((a, b) => a.dist - b.dist);
  const best = scored[0];
  const threshold = Math.min(3, Math.floor(best.c.CountryName.length * 0.4));
  if (best.dist <= threshold) return { ...best.c, _matchLevel: 'fuzzy' };

  return null;
}

class VapiController {

  // ── Vapi phone-number event webhook ───────────────────────────────────────
  // Vapi POSTs call lifecycle events here: call-start, call-end,
  // end-of-call-report, status-update, transcript.
  // Set this URL as "Server URL" on the phone number in the Vapi dashboard.

  async handleVapiEvent(req, res) {
    const { message } = req.body;
    const type = message?.type || req.body?.type || 'unknown';

    const twilioSid = message?.call?.phoneCallProviderId || null;
    const vapiId    = message?.call?.id                  || null;

    // Log real-time transcript lines so you can see exactly what Deepgram heard
    if (type === 'transcript') {
      const role = message?.role || '?';
      const text = message?.transcript || '';
      const isFinal = message?.transcriptType === 'final';
      if (isFinal && text) {
        logger.info(`  [STT ${role.toUpperCase()}] ${text}`);
      }
      return res.sendStatus(200);
    }

    // Parse conversation-update to extract destination server-side.
    // Short-circuit as early as possible — these payloads grow very large as the
    // conversation accumulates tool results. Once we have a high-confidence
    // destination there is nothing more to extract.
    if (type === 'conversation-update') {
      const sessionKey = twilioSid || vapiId;
      if (sessionKey) {
        const session = callSession.get(sessionKey) || {};
        const existingConf = session.destinationConfidence || 'none';

        // Only look at the last 3 user turns — avoids scanning the whole history
        // and prevents early phrases like "new booking" from matching country names.
        const turns = message?.conversation || [];
        const userTexts = turns
          .filter(t => t.role === 'user')
          .map(t => t.message || t.content || '')
          .slice(-3);

        if (userTexts.length > 0) {
          // Always keep the most recent user utterance — used for package reference resolution
          const lastText = userTexts[userTexts.length - 1];
          if (lastText) callSession.merge(sessionKey, { lastUserText: lastText });

          // ── Destination capture ─────────────────────────────────────────────
          if (existingConf !== 'high') {
            const countries = await getCachedCountries();
            for (const text of [...userTexts].reverse()) {
              const match = matchCountry(text, countries);
              if (match) {
                const newConf = (match._matchLevel === 'exact' || match._matchLevel === 'substring') ? 'high' : 'low';
                if (newConf === 'high' || existingConf === 'none') {
                  callSession.merge(sessionKey, {
                    destination:           match.CountryName,
                    countryCode:           match.CountryCode,
                    destinationConfidence: newConf,
                  });
                  logger.info(`  Destination captured  dest="${match.CountryName}"  code="${match.CountryCode}"  level=${match._matchLevel}  sessionKey=${sessionKey.substring(0, 16)}`);
                }
                break;
              }
            }
          }
        }
      }
      return res.sendStatus(200);
    }

    logger.info(`VAPI EVENT: ${type}`, { twilioSid, vapiId });

    // end-of-call-report contains the full transcript + AI summary
    if (type === 'end-of-call-report') {
      const summary    = message?.summary    || null;
      const transcript = message?.transcript || null;
      const duration   = message?.durationSeconds || null;

      logger.info('VAPI CALL REPORT', {
        twilioSid,
        duration: duration ? `${duration}s` : '-',
        summary:  summary ? summary.substring(0, 120) : '(none)',
      });
      // Print full conversation transcript
      if (transcript) {
        logger.info('--- TRANSCRIPT ---');
        for (const line of transcript.split('\n')) {
          if (line.trim()) logger.info(`  ${line.trim()}`);
        }
        logger.info('--- END TRANSCRIPT ---');
      }

      // Persist if Twilio SID is known and we haven't already saved via saveCallSummary tool
      if (twilioSid && summary) {
        await dbService.closeCallMaster({
          twilio_call_sid: twilioSid,
          call_summary:    summary,
          call_status:     'completed',
        }).catch(() => {}); // already closed — that's fine
      }

      // Flush per-call JSON log. Vapi doesn't reliably send a call-start event,
      // so start the logger here if it wasn't already started by another path.
      if (twilioSid) {
        if (!callLogger.has(twilioSid)) {
          const s = callSession.get(twilioSid) || {};
          callLogger.start(twilioSid, { phone: s.phone || 'unknown', direction: 'inbound', callId: s.callId || null });
        }
        callLogger.callEvent(twilioSid, 'vapi_end_of_call', { summary: summary?.substring(0, 200) || null, durationSeconds: duration });
        await callLogger.flush(twilioSid, {
          session: callSession.get(twilioSid),
          summary: summary || null,
        });
      }
    }

    if (type === 'call-start') {
      const phone = message?.call?.customer?.number || null;
      const normalizedPhone = normalizePhone(phone) || phone || 'unknown';
      logger.info('VAPI CALL STARTED', { twilioSid, vapiId, phone });

      // Create DB record (replaces handleIncomingCall when Vapi owns the number)
      if (twilioSid) {
        const record = await dbService.insertCallMaster({
          twilio_call_sid: twilioSid,
          caller_phone:    normalizedPhone,
          called_phone:    message?.call?.phoneNumber?.number || config.TWILIO_PHONE_NUMBER,
          direction:       'inbound',
          vapi_call_id:    vapiId,
        }).catch(() => null); // idempotent — ignore if already exists

        const sessionKey = twilioSid;
        if (!callSession.has(sessionKey)) {
          callSession.set(sessionKey, {
            callId:     record?.CallID || null,
            phone:      normalizedPhone,
            callerType: 'unknown',
            isVerified: false,
            vapiCallId: vapiId,
          });
        }
        // Start per-call JSON log (idempotent — skips if already started by Twilio webhook)
        callLogger.start(twilioSid, { phone: normalizedPhone, direction: 'inbound', callId: record?.CallID || null });
        callLogger.callEvent(twilioSid, 'call_started', { phone: normalizedPhone, vapiId });
        logger.info('Call record created via Vapi event', { callId: record?.CallID, twilioSid });
      }
    }

    if (type === 'call-end') {
      logger.info('VAPI CALL ENDED', { twilioSid, vapiId });
    }

    res.sendStatus(200);
  }

  // ── Tool call webhook ──────────────────────────────────────────────────────

  async handleToolCall(req, res) {
    const { message } = req.body;

    if (!message || message.type !== 'tool-calls') {
      logger.info('Vapi webhook (non-tool)', { type: message?.type });
      return res.json({ results: [] });
    }

    // Vapi injects call identifiers — available on every tool call
    const twilioCallSid = message.call?.phoneCallProviderId || null;
    const vapiCallId    = message.call?.id                  || null;
    const callerPhone   = normalizePhone(message.call?.customer?.number) || message.call?.customer?.number || null;

    // For web/dashboard test calls there is no TwilioCallSID — fall back to
    // vapiCallId so the in-memory session still works end-to-end.
    const sessionKey = twilioCallSid || vapiCallId;

    if (sessionKey) {
      if (!callSession.has(sessionKey)) {
        if (twilioCallSid) {
          // Real phone call — try to recover session from DB first
          const record = await dbService.getCallByTwilioSID(twilioCallSid);
          if (record) {
            callSession.set(sessionKey, {
              callId:     record.CallID,
              phone:      normalizePhone(record.CallerPhone) || record.CallerPhone,
              callerType: record.CallerStatus || 'unknown',
              agentId:    record.AgentID    || null,
              name:       record.CallerName || null,
              email:      record.CallerEmail || null,
              isVerified: record.CallerStatus === 'agent_verified',
            });
            logger.info('Session recovered from DB', { callSid: sessionKey, callId: record.CallID });
          } else {
            // No DB record yet — auto-create one now (call-start event was likely missed)
            const created = await dbService.insertCallMaster({
              twilio_call_sid: twilioCallSid,
              caller_phone:    callerPhone || 'unknown',
              called_phone:    config.TWILIO_PHONE_NUMBER,
              direction:       'inbound',
              vapi_call_id:    vapiCallId,
            }).catch(() => null);
            callSession.set(sessionKey, {
              callId:     created?.CallID || null,
              phone:      callerPhone,
              callerType: 'unknown',
              isVerified: false,
            });
            if (created?.CallID) {
              logger.info('Call record auto-created on first tool call', { callId: created.CallID, twilioSid: twilioCallSid });
            } else {
              logger.warn('Could not create call_master record on first tool call', { twilioSid: twilioCallSid });
            }
          }
        } else {
          // Web/dashboard call — seed a minimal in-memory session (no DB record)
          callSession.set(sessionKey, { phone: callerPhone, callerType: 'unknown', isVerified: false, webCall: true });
          logger.info('Web call session created', { sessionKey });
        }
      }
      // Keep vapiCallId and phone up to date on every tool call
      callSession.merge(sessionKey, {
        vapiCallId,
        ...(callerPhone && { phone: callerPhone }),
      });

      // Start per-call JSON log on the first tool call if not already started
      if (!callLogger.has(sessionKey)) {
        const s = callSession.get(sessionKey) || {};
        callLogger.start(sessionKey, { phone: s.phone || callerPhone || 'unknown', direction: 'inbound', callId: s.callId || null });
      }
    }

    const toolCallList = message.toolCallList || [];
    const callType = twilioCallSid ? 'phone' : 'web';

    const SEP = '─'.repeat(50);
    logger.info(SEP);
    logger.info(`TOOL CALL  [${callType}]  session=${sessionKey?.substring(0, 20) || 'none'}  tools=${toolCallList.map(t => t.function?.name || t.name).join(', ')}`);

    // Snapshot the full session context so you can verify the LLM hasn't lost anything
    if (sessionKey) {
      const snap = callSession.get(sessionKey) || {};
      logger.info(`  CTX  phone=${snap.phone || '-'}  type=${snap.callerType || '-'}  agentId=${snap.agentId || '-'}  verified=${snap.isVerified || false}  dest=${snap.destination || '-'}  callId=${snap.callId || '-'}`);
    }

    // Vapi sends the full conversation history on every tool call — use it as a fallback
    // when GPT-4o omits required params (known GPT-4o function-calling limitation).
    const conversationMessages = message.messages || [];

    const results = await Promise.all(
      toolCallList.map(async (toolCall) => {
        const id   = toolCall.id;
        const name = toolCall.function?.name || toolCall.name;
        let params = {};

        if (toolCall.function?.arguments) {
          try { params = JSON.parse(toolCall.function.arguments); } catch { params = {}; }
        } else if (toolCall.parameters) {
          params = toolCall.parameters;
        }

        // Strip internal fields for cleaner log output
        const logParams = Object.fromEntries(
          Object.entries(params).filter(([k]) => !k.startsWith('_'))
        );
        logger.info(`  >> ${name}  params=${JSON.stringify(logParams)}`);
        callLogger.toolCall(sessionKey, name, logParams);

        // Inject server-side call context — tools don't need AI to pass these.
        // _twilioCallSid is the unified session key (vapiCallId for web calls).
        params._twilioCallSid  = sessionKey;
        params._vapiCallId     = vapiCallId;
        params._callerPhone    = callerPhone;
        // Last thing the user said — used by getPackageItinerary to let the LLM
        // self-correct when pkgId is omitted (LLM receives package list + user text
        // and retries with the correct pkgId instead of server-wide text matching).
        const lastUserMsg = conversationMessages.filter(m => m.role === 'user').slice(-1)[0];
        params._lastUserText = lastUserMsg?.content || lastUserMsg?.message || '';

        const t0 = Date.now();
        let result;
        try {
          result = await this._dispatch(name, params);
        } catch (err) {
          logger.error(`  !! ${name} THREW: ${err.message}`);
          result = { success: false, error: err.message, _ctx: this._buildCtx(sessionKey) };
        }
        const durationMs = Date.now() - t0;

        const ok = result?.success === true ? 'OK' : 'FAIL';
        const preview = result?.message
          ? result.message.substring(0, 100).replace(/\n/g, ' ')
          : (result?.error || JSON.stringify(result).substring(0, 100));
        logger.info(`  << ${name}  [${ok}]  ${durationMs}ms  ${preview}`);

        callLogger.toolResponse(sessionKey, name, result, durationMs);
        callLogger.sessionSnap(sessionKey, callSession.get(sessionKey) || {});

        return { toolCallId: id, result: JSON.stringify(result) };
      })
    );

    res.json({ results });
  }

  // ── Dispatch ───────────────────────────────────────────────────────────────

  async _dispatch(name, params) {
    switch (name) {
      // New unified tools
      case 'identifyCaller':         return this._identifyCaller(params);
      case 'updateCallTopic':        return this._updateCallTopic(params);
      case 'saveCallSummary':        return this._saveCallSummary(params);
      case 'registerCallerPhone':    return this._registerCallerPhone(params);
      case 'lookupAgentByIdOrEmail': return this._lookupAgentByIdOrEmail(params);
      case 'sendOTPtoEmail':         return this._sendOTPtoEmail(params);
      // Existing tools
      case 'getAgentBookings':       return this._getAgentBookings(params);
      case 'getCountryList':         return this._getCountryList(params);
      case 'getPackages':            return this._getPackages(params);
      case 'getPackageItinerary':    return this._getPackageItinerary(params);
      case 'sendPackageDetails':     return this._sendPackageDetails(params);
      case 'scheduleCallback':       return this._scheduleCallback(params);
      case 'transferToHuman':        return this._transferToHuman(params);
      case 'saveLead':               return this._saveLead(params);
      case 'saveBookingEnquiry':     return this._saveBookingEnquiry(params);
      case 'sendBookingLink':        return this._sendBookingLink(params);
      case 'sendPaymentLink':        return this._sendPaymentLink(params);
      case 'sendRegistrationLink':   return this._sendRegistrationLink(params);
      case 'sendVerificationOTP':    return this._sendVerificationOTP(params);
      case 'verifyOTP':              return this._verifyOTP(params);
      // Backward-compat aliases
      case 'checkCallerIdentity':    return this._identifyCaller(params);
      case 'checkTourAvailability':  return this._getPackages(params);
      case 'getAgentDetails':        return this._identifyCaller(params);
      default:
        return { success: false, error: `Unknown tool: ${name}` };
    }
  }

  // ── Context helpers ────────────────────────────────────────────────────────

  _buildCtx(sessionKey) {
    // sessionKey may be twilioCallSid (real call) or vapiCallId (web/dashboard call)
    const s = sessionKey ? callSession.get(sessionKey) : {};
    return {
      phone:       s.phone       || null,
      name:        s.name        || null,
      type:        s.callerType  || 'unknown',
      agentId:     s.agentId     || null,
      verified:    s.isVerified  || false,
      destination: s.destination || null,
      callId:      s.callId      || null,
      totalCalls:  s.totalCalls  ?? 0,
    };
  }

  // ── Tool: identifyCaller ───────────────────────────────────────────────────
  // Replaces checkCallerIdentity. Three-stage lookup:
  // 1. caller_registry (fast path for returning callers)
  // 2. tbl_agent by phone (auto-registers if found)
  // 3. New customer fallback

  async _identifyCaller({ phone, agentId, _twilioCallSid, _callerPhone }) {
    const rawPhone    = phone || _callerPhone;
    const lookupPhone = normalizePhone(rawPhone) || rawPhone;

    // --- Agent ID provided directly (manual entry by caller) ---
    if (agentId) {
      const agent = await dbService.getAgentById(agentId);
      if (agent) {
        if (_twilioCallSid) {
          callSession.merge(_twilioCallSid, { callerType: 'agent_verified', agentId: agent.AgentID, email: agent.EmailID, isVerified: true });
          await dbService.updateCallMaster({ twilio_call_sid: _twilioCallSid, caller_status: 'agent_verified', agent_id: agent.AgentID, caller_email: agent.EmailID });
        }
        return {
          success: true, type: 'agent_verified',
          agentId: agent.AgentID, email: agent.EmailID, phone: agent.Contact,
          _ctx: this._buildCtx(_twilioCallSid),
          message: `I've confirmed your Agent ID ${agent.AgentID}. How can I assist you today?`,
        };
      }
      return {
        success: true, type: 'unknown',
        _ctx: this._buildCtx(_twilioCallSid),
        message: `I couldn't find an agent with ID ${agentId}. Please double-check or try your registered number.`,
      };
    }

    if (!lookupPhone) {
      return { success: false, error: 'phone is required', _ctx: this._buildCtx(_twilioCallSid) };
    }

    // --- Stage 1: caller_registry ---
    const registry = await dbService.getCallerByPhone(lookupPhone);

    if (registry && registry.IsVerified && registry.CustomerType === 'agent') {
      await dbService.updateCallerRegistry({ phone: lookupPhone });
      if (_twilioCallSid) {
        callSession.merge(_twilioCallSid, { phone: lookupPhone, callerType: 'agent_verified', agentId: registry.AgentID, name: registry.CallerName, email: registry.CallerEmail, isVerified: true, totalCalls: registry.TotalCalls || 0 });
        await dbService.updateCallMaster({ twilio_call_sid: _twilioCallSid, caller_status: 'agent_verified', agent_id: registry.AgentID, caller_name: registry.CallerName, caller_email: registry.CallerEmail });
      }
      return {
        success: true, type: 'agent_verified',
        agentId: registry.AgentID, name: registry.CallerName, email: registry.CallerEmail, phone: lookupPhone,
        totalCalls: registry.TotalCalls,
        _ctx: this._buildCtx(_twilioCallSid),
        message: `Welcome back${registry.CallerName ? ' ' + registry.CallerName : ''}! How can I assist you today?`,
      };
    }

    if (registry && registry.CustomerType === 'new_customer') {
      await dbService.updateCallerRegistry({ phone: lookupPhone });
      if (_twilioCallSid) {
        callSession.merge(_twilioCallSid, { phone: lookupPhone, callerType: 'new_customer', name: registry.CallerName, isVerified: false });
        await dbService.updateCallMaster({ twilio_call_sid: _twilioCallSid, caller_status: 'new_customer', caller_name: registry.CallerName });
      }
      return {
        success: true, type: 'new_customer', name: registry.CallerName,
        _ctx: this._buildCtx(_twilioCallSid),
        message: `Welcome back${registry.CallerName ? ' ' + registry.CallerName : ''}! How can I assist you today?`,
      };
    }

    // --- Stage 2: tbl_agent by phone (auto-register on match) ---
    const agent = await dbService.getAgentByPhone(lookupPhone);
    if (agent) {
      await dbService.insertCallerRegistry({ phone: lookupPhone, agent_id: agent.AgentID, caller_email: agent.EmailID, customer_type: 'agent', is_verified: 1, verify_method: 'phone_match' });
      if (_twilioCallSid) {
        callSession.merge(_twilioCallSid, { phone: lookupPhone, callerType: 'agent_verified', agentId: agent.AgentID, email: agent.EmailID, isVerified: true });
        await dbService.updateCallMaster({ twilio_call_sid: _twilioCallSid, caller_status: 'agent_verified', agent_id: agent.AgentID, caller_email: agent.EmailID });
      }
      return {
        success: true, type: 'agent_verified',
        agentId: agent.AgentID, email: agent.EmailID, phone: lookupPhone,
        _ctx: this._buildCtx(_twilioCallSid),
        message: `Welcome back! I've identified you as Agent ${agent.AgentID}. How can I assist you today?`,
      };
    }

    // --- Stage 3: Unknown → new customer ---
    if (_twilioCallSid) {
      callSession.merge(_twilioCallSid, { phone: lookupPhone, callerType: 'new_customer', isVerified: false });
      await dbService.updateCallMaster({ twilio_call_sid: _twilioCallSid, caller_status: 'new_customer' });
    }
    return {
      success: true, type: 'new_customer',
      _ctx: this._buildCtx(_twilioCallSid),
      message: `Welcome to Culture Holidays! Could I get your name and email so I can assist you better?`,
    };
  }

  // ── Tool: updateCallTopic ─────────────────────────────────────────────────
  // Called progressively during the call after each meaningful event.
  // Writes are buffered in memory and flushed to DB every 30 seconds.
  // The buffer is force-flushed on call end and before saving the summary
  // so no entries are ever lost.

  async _updateCallTopic({ topic, data, _twilioCallSid }) {
    // GPT-4o sometimes calls this without topic — succeed silently rather than
    // confusing the AI with an error it will try to retry.
    if (!topic) return { success: true, skipped: true, _ctx: this._buildCtx(_twilioCallSid) };
    // _twilioCallSid is now always set (falls back to vapiCallId for web calls)
    // Only fail hard if there is truly no call context at all
    if (!_twilioCallSid) return { success: false, error: 'call context not available', _ctx: {} };

    // Persist key session fields immediately (in-memory — no DB needed)
    if (data && typeof data === 'object') {
      const patch = {};
      if (data.destination)  patch.destination  = data.destination;
      if (data.countryCode)  patch.countryCode  = data.countryCode;
      if (data.pax)          patch.pax          = data.pax;
      if (data.durationDays) patch.durationDays = data.durationDays;
      if (data.budget)       patch.budget       = data.budget;
      if (Object.keys(patch).length) {
        callSession.merge(_twilioCallSid, patch);
        logger.info(`  Session updated: ${JSON.stringify(patch)}`);
      }
    }

    const entry = { ts: new Date().toISOString(), ...(typeof data === 'object' ? data : { value: data }) };

    // Buffer the DB write — flushed every 30s or on call end
    topicBuffer.push(_twilioCallSid, topic, entry);

    return {
      success: true,
      topic,
      pending: topicBuffer.pendingCount(_twilioCallSid),
      _ctx: this._buildCtx(_twilioCallSid),
    };
  }

  // ── Tool: saveCallSummary ─────────────────────────────────────────────────
  // Flush any buffered topic entries BEFORE closing the record so the summary
  // and all topic data land in DB atomically before the call row is finalised.

  async _saveCallSummary({ summary, isResolved, _twilioCallSid, _vapiCallId }) {
    // For web/dashboard calls _twilioCallSid = vapiCallId (no DB record — flush + skip DB write)
    if (!_twilioCallSid) return { success: false, error: 'call context not available' };

    // Drain buffered topic entries first
    const flushed = await topicBuffer.flush(_twilioCallSid);
    if (flushed > 0) logger.info(`saveCallSummary: flushed ${flushed} buffered topic entries`, { callSid: _twilioCallSid });

    // If enquiry was saved in memory but details were never sent, persist to DB now
    const sess = callSession.get(_twilioCallSid) || {};
    if (sess.enquirySaved && !sess.packageDetailsSent) {
      const req = sess.requirements || {};
      await dbService.updateCallTopic({
        twilio_call_sid: _twilioCallSid,
        topic_name:  'new_booking',
        topic_entry: {
          ts:                  new Date().toISOString(),
          destination:         req.destination        || sess.destination  || null,
          pax:                 req.pax                || null,
          durationDays:        req.durationDays        || null,
          budgetPerPerson:     req.budgetPerPerson     || null,
          tripType:            req.tripType            || null,
          specialRequirements: req.specialRequirements || null,
          packagesShown:       (sess.filteredPackages || []).map(p => ({ rank: p.rank ?? null, pkgId: p.pkgId, title: p.title })),
          packageCount:        (sess.filteredPackages || []).length,
          noPackageFound:      !!sess.noPackageFound,
          customRequirements:  sess.customRequirements || null,
          additionalNotes:     sess.additionalNotes    || null,
          detailsSent:         false,
          sentVia:             [],
        },
      }).catch(err => logger.warn('saveCallSummary: enquiry fallback write failed', { err: err.message }));
    }

    await dbService.closeCallMaster({
      twilio_call_sid: _twilioCallSid,
      call_summary:    summary    || null,
      call_status:     'completed',
      is_resolved:     isResolved ?? null,
    });

    // Flush the per-call JSON log file now that we have the summary and final session state.
    await callLogger.flush(_twilioCallSid, {
      session: callSession.get(_twilioCallSid),
      summary: summary || null,
    });

    return { success: true, message: 'Call summary saved.' };
  }

  // ── Tool: registerCallerPhone ─────────────────────────────────────────────

  async _registerCallerPhone({ phone, agentId, verifyMethod, callerName, callerEmail, _twilioCallSid }) {
    if (!phone || !agentId) return { success: false, error: 'phone and agentId are required', _ctx: this._buildCtx(_twilioCallSid) };

    await dbService.insertCallerRegistry({ phone, agent_id: agentId, caller_name: callerName || null, caller_email: callerEmail || null, customer_type: 'agent', is_verified: 1, verify_method: verifyMethod || 'otp_sms' });

    if (_twilioCallSid) {
      callSession.merge(_twilioCallSid, {
        callerType:         'agent_verified',
        agentId,
        name:               callerName,
        email:              callerEmail,
        isVerified:         true,
        // Clear pending verification scratch fields now that registration is done
        pendingAgentId:     undefined,
        pendingAgentPhone:  undefined,
        pendingAgentEmail:  undefined,
      });
      await dbService.updateCallMaster({ twilio_call_sid: _twilioCallSid, caller_status: 'agent_verified', agent_id: agentId, caller_name: callerName || null, caller_email: callerEmail || null });
    }
    return {
      success: true,
      _ctx: this._buildCtx(_twilioCallSid),
      message: `Your number has been registered. How can I assist you today?`,
    };
  }

  // ── Tool: lookupAgentByIdOrEmail ──────────────────────────────────────────

  async _lookupAgentByIdOrEmail({ agentId, email, _twilioCallSid }) {
    if (!agentId && !email) {
      logger.warn('  lookupAgentByIdOrEmail called with no agentId or email — AI did not extract the ID');
      return {
        success: false,
        error: 'missing_input',
        _ctx: this._buildCtx(_twilioCallSid),
        message: `I didn't catch your Agent ID clearly. Could you please repeat just the numbers at the end of your Agent ID, one digit at a time?`,
      };
    }

    // Agent ID prefix expansion:
    // Format 1 — CHAGT00000 + 5-6 variable digits  (e.g. CHAGT00000123456)
    // Format 2 — CHAGT00010000 + 5-6 variable digits (e.g. CHAGT00010000123456)
    // Callers often speak only the variable digits, so we try both prefixes automatically.
    const PREFIX1 = 'CHAGT00000';
    const PREFIX2 = 'CHAGT00010000';

    const expandIds = (raw) => {
      if (!raw) return [];
      const upper = raw.toUpperCase().trim();
      // Already a full ID — try as-is first, then no expansions needed
      if (upper.startsWith('CHAGT')) return [upper];
      // Only digits spoken — build both candidate IDs
      const digits = raw.replace(/\D/g, '');
      if (!digits) return [upper]; // non-numeric, non-CHAGT — try as-is
      return [`${PREFIX1}${digits}`, `${PREFIX2}${digits}`];
    };

    let agent = null;
    if (agentId) {
      const candidates = expandIds(agentId);
      logger.info(`  DB lookup — input="${agentId}"  trying=${JSON.stringify(candidates)}`);
      for (const candidate of candidates) {
        agent = await dbService.getAgentById(candidate);
        if (agent) break;
      }
    } else if (email) {
      logger.info(`  DB lookup — email="${email}"`);
      agent = await dbService.getAgentByEmail(email);
    }
    logger.info(`  DB result — found=${!!agent}  dbAgentId="${agent?.AgentID || ''}"  contact="${agent?.Contact || ''}"`);

    if (!agent) {
      return {
        success: true, found: false,
        _ctx: this._buildCtx(_twilioCallSid),
        message: `I couldn't find a matching account. Please double-check your Agent ID or email address.`,
      };
    }

    const maskStr = (s) => {
      if (!s) return null;
      const at = s.indexOf('@');
      return at > 0 ? s[0] + '***' + s.slice(at) : s.slice(0, -4).replace(/\d/g, '*') + s.slice(-4);
    };

    if (_twilioCallSid) {
      callSession.merge(_twilioCallSid, { pendingAgentId: agent.AgentID, pendingAgentPhone: agent.Contact, pendingAgentEmail: agent.EmailID });
    }

    return {
      success: true, found: true,
      agentId: agent.AgentID,
      maskedPhone: maskStr(agent.Contact),
      maskedEmail: maskStr(agent.EmailID),
      registeredPhone: agent.Contact,
      _ctx: this._buildCtx(_twilioCallSid),
      message: `Found your account. I'll send a verification code to your registered number ending in ${agent.Contact ? agent.Contact.slice(-4) : 'XXXX'}.`,
    };
  }

  // ── Tool: sendOTPtoEmail ───────────────────────────────────────────────────

  async _sendOTPtoEmail({ email, agentName, phone, _twilioCallSid }) {
    if (!email || !phone) return { success: false, error: 'email and phone are required', _ctx: this._buildCtx(_twilioCallSid) };

    const otp = otpStore.create(phone);
    try {
      await emailService.sendGenericEmail({
        to: email,
        subject: 'Your Culture Holidays Verification Code',
        html: `<p>Hi ${agentName || 'there'},</p><p>Your verification code is: <strong style="font-size:24px;letter-spacing:4px;">${otp}</strong></p><p style="color:#666;">Valid for 5 minutes. Do not share this code.</p>`,
      });
    } catch (err) {
      return { success: false, error: `Failed to send OTP email: ${err.message}`, _ctx: this._buildCtx(_twilioCallSid) };
    }

    const maskEmail = (e) => e[0] + '***' + e.slice(e.indexOf('@'));
    return {
      success: true,
      maskedEmail: maskEmail(email),
      _ctx: this._buildCtx(_twilioCallSid),
      message: `I've sent a 4-digit code to ${maskEmail(email)}. Please share it when you receive it.`,
    };
  }

  // ── Tool: getAgentBookings ────────────────────────────────────────────────

  async _getAgentBookings({ agentId, _twilioCallSid }) {
    if (!agentId) return { success: false, error: 'agentId is required', _ctx: this._buildCtx(_twilioCallSid) };

    const bookings = await dbService.getAgentBookings(agentId);
    if (bookings.length === 0) {
      return { success: true, count: 0, bookings: [], _ctx: this._buildCtx(_twilioCallSid), message: 'You have no upcoming bookings at the moment.' };
    }

    const summary = bookings.slice(0, 5)
      .map((b, i) => `${i + 1}. ${b.PKG_TITLE} — Tour Date: ${b.TourDate} (Ref: ${b.QueryID})`)
      .join('\n');

    return {
      success: true, count: bookings.length, bookings,
      _ctx: this._buildCtx(_twilioCallSid),
      message: `You have ${bookings.length} upcoming booking(s):\n${summary}\n\nWhich booking would you like details on?`,
    };
  }

  // ── Tool: getCountryList ──────────────────────────────────────────────────

  async _getCountryList({ agentId, _twilioCallSid }) {
    const countries = await dbService.getCountryList(agentId || '');
    const list = countries.map(c => ({ name: c.CountryName, code: c.CountryCode }));

    // If the session already has a raw destination from what the caller said,
    // match it against the list now (with fuzzy/Levenshtein matching) so
    // GPT-4o gets the exact correct name+code without having to figure it out.
    let suggestedMatch = null;
    if (_twilioCallSid) {
      const sess = callSession.get(_twilioCallSid) || {};
      const rawDest = sess.destination; // captured from conversation-update
      if (rawDest && !sess.countryCode) {
        const matched = matchCountry(rawDest, countries);
        if (matched) {
          suggestedMatch = { name: matched.CountryName, code: matched.CountryCode };
          // Update session with the validated exact name+code
          callSession.merge(_twilioCallSid, {
            destination: matched.CountryName,
            countryCode: matched.CountryCode,
          });
          logger.info(`  getCountryList: matched "${rawDest}" → "${matched.CountryName}" (${matched.CountryCode})`);
        }
      } else if (sess.destination && sess.countryCode) {
        suggestedMatch = { name: sess.destination, code: sess.countryCode };
      }
    }

    const nameStr = list.slice(0, 15).map(c => c.name).join(', ');
    const matchMsg = suggestedMatch
      ? `The caller's destination matches: "${suggestedMatch.name}" (code: "${suggestedMatch.code}"). Use EXACTLY destination="${suggestedMatch.name}" and countryCode="${suggestedMatch.code}" when calling getPackages.`
      : `Match the caller's spoken destination to the closest entry and use that exact name + code when calling getPackages.`;

    return {
      success: true, count: list.length,
      countries: list,
      suggestedMatch,
      _ctx: this._buildCtx(_twilioCallSid),
      message: `${matchMsg} All destinations (${list.length}): ${nameStr}${list.length > 15 ? ', and more' : ''}.`,
    };
  }

  // ── Tool: getPackages ─────────────────────────────────────────────────────

  async _getPackages({ countryCode, destination, agentId, _twilioCallSid, _conversationMessages }) {
    let resolvedDest = (destination && destination !== 'undefined' && destination !== 'null') ? destination.trim() : null;
    let resolvedCode = (countryCode && countryCode !== 'undefined' && countryCode !== 'null') ? countryCode : null;

    // ── LAYER 2: session fallback (stored earlier via updateCallTopic) ─────────
    if (!resolvedDest && _twilioCallSid) {
      const sess = callSession.get(_twilioCallSid) || {};
      if (sess.destination) {
        resolvedDest = sess.destination;
        resolvedCode = resolvedCode || sess.countryCode || null;
        logger.info(`  getPackages: using session fallback  dest="${resolvedDest}"  code="${resolvedCode || '?'}"`);
      }
    }

    // ── LAYER 3: country list scan on raw dest string ─────────────────────────
    // If we have a destination string but no code yet, try to match it now.
    if (resolvedDest && !resolvedCode) {
      const countries = await getCachedCountries();
      const match = matchCountry(resolvedDest, countries);
      if (match) {
        resolvedDest = match.CountryName;
        resolvedCode = match.CountryCode;
        logger.info(`  getPackages: matched dest string  dest="${resolvedDest}"  code="${resolvedCode}"`);
      }
    }

    // ── Still no destination — fail clearly ───────────────────────────────────
    if (!resolvedDest) {
      return {
        success: false, retryRequired: true,
        _ctx: this._buildCtx(_twilioCallSid),
        message: `TOOL_ERROR: destination is required. Ask the caller which destination they want, then call getPackages again with destination set.`,
      };
    }

    // ── Resolve countryCode via fuzzy match if still missing ──────────────────
    let code = resolvedCode;
    let matchedCountryName = resolvedDest;

    if (!code) {
      let countries = [];
      try { countries = await dbService.getCountryList(''); } catch (e) { logger.error('getCountryList failed', { err: e.message }); }

      const dest = resolvedDest.toLowerCase();
      let match = countries.find(c =>
        c.CountryName?.toLowerCase().includes(dest) || dest.includes(c.CountryName?.toLowerCase())
      );
      if (!match) {
        const words = dest.split(/\s+/).filter(w => w.length > 2);
        match = countries.find(c => {
          const name = c.CountryName?.toLowerCase() || '';
          return words.some(w => name.includes(w)) || name.split(/\s+/).some(w => w.length > 2 && dest.includes(w));
        });
      }
      if (match) {
        code = match.CountryCode;
        matchedCountryName = match.CountryName;
      } else {
        const available = countries.slice(0, 20).map(c => c.CountryName).join(', ');
        return {
          success: false, retryRequired: false,
          availableDestinations: countries.map(c => c.CountryName),
          _ctx: this._buildCtx(_twilioCallSid),
          message: `No packages found for "${resolvedDest}". Available: ${available}. Ask the caller to pick from this list.`,
        };
      }
    }

    logger.info(`  getPackages: resolved  dest="${matchedCountryName}"  code="${code}"`);
    if (_twilioCallSid) callSession.merge(_twilioCallSid, { destination: matchedCountryName, countryCode: code });

    // Return cached packages if already fetched for this destination this call —
    // avoids a DB round-trip when LLM calls getPackages again on the "show nearest" fallback path.
    const sessForCache = _twilioCallSid ? (callSession.get(_twilioCallSid) || {}) : {};
    let packages;
    if (Array.isArray(sessForCache.lastPackages) && sessForCache.lastPackages.length > 0) {
      packages = sessForCache.lastPackages;
      logger.info(`  getPackages: cache hit — returning ${packages.length} packages from session`);
    } else {
      packages = await dbService.getPackagesByCountry(code, agentId || null);
      if (_twilioCallSid) callSession.merge(_twilioCallSid, { lastPackages: packages });
    }

    if (packages.length === 0) {
      return {
        success: true, count: 0,
        noPackageFound: true,
        _ctx: this._buildCtx(_twilioCallSid),
        message: `[INTERNAL — do NOT say this to the caller] No standard packages currently listed for "${matchedCountryName}". INSTRUCTION: Do NOT tell the caller we have no packages. Instead say something like "We have some great options for ${matchedCountryName}! Let me note your requirements so I can put together the best fit for you." Then ask all 4 requirements (pax, days, budget, tripType) one at a time. Once collected, call saveBookingEnquiry({ requirements: { destination: "${matchedCountryName}", pax, durationDays, budgetPerPerson, tripType, specialRequirements }, selectedPackages: [], noPackageFound: true, customRequirements: "<any specific needs the caller mentions>" }).`,
      };
    }

    // Pass up to 20 compact entries to LLM for filtering; full objects already in session
    const forLLM = packages.slice(0, 20);
    const sess   = _twilioCallSid ? (callSession.get(_twilioCallSid) || {}) : {};
    const reqSummary = sess.requirements && Object.keys(sess.requirements).length > 0
      ? `Requirements already in session: ${JSON.stringify(sess.requirements)}`
      : 'Requirements not yet collected — ask the caller next.';

    const packageList = forLLM.map((pkg, i) => {
      const firstDate = pkg.availableDates[0]?.date || 'TBD';
      return `${i + 1}. pkgId=${pkg.pkgId} | ${pkg.title} | ${pkg.durationDays} days | next: ${firstDate}`;
    }).join('\n');

    return {
      success: true, count: packages.length, packages: forLLM,
      _ctx: this._buildCtx(_twilioCallSid),
      message: `${packages.length} package(s) available for ${matchedCountryName}.\n\n${packageList}\n\n${reqSummary}\n\nINSTRUCTION:\n1. If any of the 4 requirements (pax, durationDays, budgetPerPerson, tripType) are missing, ask the caller one at a time — do not call any tool between questions.\n2. Once all 4 requirements are known, score ALL packages above against those requirements (duration fit, budget fit, trip type match, group size) and pick the TOP 3. Order them rank 1 (best match), rank 2, rank 3 — this order is what the caller will hear.\n3. Call saveBookingEnquiry BEFORE presenting anything to the caller:\n   saveBookingEnquiry({ requirements: { destination, pax, durationDays, budgetPerPerson, tripType }, selectedPackages: [<rank-1 package object>, <rank-2 package object>, <rank-3 package object>] })\n   Pass the full package objects from the list above in ranked order. Do NOT modify or summarise them.\n4. After saveBookingEnquiry succeeds, present only those 3 to the caller as "first option", "second option", "third option" — name and duration only. Do NOT say "rank" or package IDs to the caller.`,
    };
  }

  // ── Tool: getPackageItinerary ─────────────────────────────────────────────

  async _getPackageItinerary({ pkgId, _twilioCallSid, _lastUserText }) {
    if (!pkgId && _twilioCallSid) {
      const sess      = callSession.get(_twilioCallSid) || {};
      const shownPkgs = sess.filteredPackages?.length
        ? sess.filteredPackages
        : (sess.lastPackages || []).slice(0, 3);

      // Prefer _lastUserText injected from the Vapi tool-call payload (bound to this
      // exact turn) over sess.lastUserText (from the last conversation-update event,
      // which may be from a different turn).
      const userText = _lastUserText || sess.lastUserText || '';

      if (shownPkgs.length && userText) {
        // Try to resolve what the user said → pkgId without asking LLM to retry
        const resolved = await resolvePackageRef(userText, shownPkgs);
        if (resolved) {
          logger.info(`  getPackageItinerary: resolved pkgId=${resolved} from "${userText}"`);
          pkgId = resolved; // fall through to normal fetch below
        }
      }

      if (!pkgId) {
        // Backend couldn't resolve — give Vapi LLM the user's exact words + package list
        // so it can identify the pkgId and call getPackageItinerary again with it.
        const pkgList = shownPkgs
          .map((p, i) => `${i + 1}. pkgId=${p.pkgId} — "${p.title}" (${p.durationDays} days)`)
          .join('\n');
        const userSaid = userText || '(not captured)';
        logger.info(`  getPackageItinerary: backend could not resolve — sending to Vapi LLM  userText="${userSaid}"`);
        return {
          success: false,
          requiresRetry: true,
          _ctx: this._buildCtx(_twilioCallSid),
          message: `The caller said: "${userSaid}"\n\nPackages shown to them:\n${pkgList}\n\nIdentify which package the caller is referring to and call getPackageItinerary again with the correct pkgId. If you genuinely cannot tell, ask the caller: "Could you say first, second, or third — or the package name?"`,
        };
      }
    }

    if (!pkgId) {
      return { success: false, error: 'pkgId is required. Call getPackages first.', _ctx: this._buildCtx(_twilioCallSid) };
    }

    const itinerary = await dbService.getPackageItinerary(pkgId);
    if (itinerary.length === 0) {
      return { success: true, itinerary: [], _ctx: this._buildCtx(_twilioCallSid), message: 'Full itinerary is in the PDF. Shall I send it to you?' };
    }

    const summary  = itinerary.map((d) => `Day ${d.PKG_ITI_DAY}: ${d.PKG_ITI_TITLE}`).join('\n');
    const sess2    = _twilioCallSid ? (callSession.get(_twilioCallSid) || {}) : {};
    const isKnown  = sess2.callerType && sess2.callerType !== 'unknown' && sess2.callerType !== 'new_customer';
    const channels = isKnown ? 'email or SMS' : 'SMS';
    return {
      success: true, itinerary,
      _ctx: this._buildCtx(_twilioCallSid),
      message: `Day-wise overview:\n\n${summary}\n\nWould you like me to send the full PDF itinerary to your ${channels}?`,
    };
  }

  // ── Tool: sendPackageDetails ──────────────────────────────────────────────

  async _sendPackageDetails({ phone, email, customerName, packages, agentId, _twilioCallSid, _callerPhone }) {
    const session = _twilioCallSid ? callSession.get(_twilioCallSid) : {};

    // If saveBookingEnquiry was never called, auto-save with best-effort top-3 so the
    // send can still proceed — the LLM presented packages verbally, we just backfill the record.
    if (!session.enquirySaved && session.lastPackages?.length > 0 && !(Array.isArray(packages) && packages.length > 0)) {
      const top3 = session.lastPackages.slice(0, 3).map((p, i) => ({ ...p, rank: i + 1 }));
      if (_twilioCallSid) callSession.merge(_twilioCallSid, { filteredPackages: top3, enquirySaved: true });
    }

    // Prefer explicit packages passed by LLM, then filtered top-3, then last-resort lastPackages slice.
    const resolvedPackages = (Array.isArray(packages) && packages.length > 0)
      ? packages
      : (session.filteredPackages?.length ? session.filteredPackages : (session.lastPackages || []).slice(0, 3));

    if (!resolvedPackages || resolvedPackages.length === 0) {
      return { success: false, error: 'No packages to send. Call getPackages first, then sendPackageDetails with the results.', _ctx: this._buildCtx(_twilioCallSid) };
    }

    const resolvedPhone = phone || _callerPhone || session.phone || null;
    const resolvedEmail = email || session.email || null;
    const callId  = session.callId || null;
    const channels = [], errors = [];

    if (!resolvedEmail && !resolvedPhone) {
      return {
        success: false,
        error: 'No email or phone to send to. Ask the caller for their email address first.',
        _ctx: this._buildCtx(_twilioCallSid),
      };
    }

    if (resolvedEmail) {
      try {
        await emailService.sendPackageEmail({ to: resolvedEmail, customerName, packages: resolvedPackages, agentId });
        await dbService.insertCommunicationLog({ call_id: callId, channel: 'email', recipient_email: resolvedEmail, subject: 'Your Tour Package Details', body: resolvedPackages.map((p) => p.title).join(', '), status: 'sent' });
        channels.push('email');
      } catch (err) { errors.push(`Email: ${err.message}`); }
    }

    if (resolvedPhone) {
      try {
        const msg = await smsService.sendPackageSMS({ to: resolvedPhone, customerName, packages: resolvedPackages });
        await dbService.insertCommunicationLog({ call_id: callId, channel: 'sms', recipient_phone: resolvedPhone, twilio_msg_sid: msg.sid, body: 'Package SMS', status: 'sent' });
        channels.push('SMS');
      } catch (err) { errors.push(`SMS: ${err.message}`); }
    }

    const sent = channels.length > 0;
    if (sent && _twilioCallSid) {
      callSession.merge(_twilioCallSid, { packageDetailsSent: true, sentVia: channels });
      // Write full enquiry record to DB now that caller has confirmed interest
      const s   = callSession.get(_twilioCallSid) || {};
      const req = s.requirements || {};
      dbService.updateCallTopic({
        twilio_call_sid: _twilioCallSid,
        topic_name:  'new_booking',
        topic_entry: {
          ts:                  new Date().toISOString(),
          destination:         req.destination        || s.destination  || null,
          pax:                 req.pax                || null,
          durationDays:        req.durationDays        || null,
          budgetPerPerson:     req.budgetPerPerson     || null,
          tripType:            req.tripType            || null,
          specialRequirements: req.specialRequirements || null,
          packagesShown:       resolvedPackages.map(p => ({ rank: p.rank ?? null, pkgId: p.pkgId, title: p.title })),
          packageCount:        resolvedPackages.length,
          noPackageFound:      !!s.noPackageFound,
          customRequirements:  s.customRequirements || null,
          additionalNotes:     s.additionalNotes    || null,
          detailsSent:         true,
          sentVia:             channels,
        },
      }).catch(err => logger.warn('sendPackageDetails: topic update failed', { err: err.message }));
    }
    return {
      success: sent, channelsSent: channels,
      _ctx: this._buildCtx(_twilioCallSid),
      message: sent
        ? `Package details sent via ${channels.join(' and ')}. Our team will follow up. Anything else?`
        : `Unable to send details. ${errors.join(' ')} Please try again.`,
    };
  }

  // ── Tool: scheduleCallback ────────────────────────────────────────────────

  async _scheduleCallback({ phone, reason, department, priority, _twilioCallSid, _callerPhone }) {
    const session = _twilioCallSid ? callSession.get(_twilioCallSid) : {};
    const callbackPhone = phone || _callerPhone || session.phone || null;
    if (!callbackPhone) return { success: false, error: 'phone is required — ask the caller for their number', _ctx: this._buildCtx(_twilioCallSid) };
    await dbService.scheduleCallback({ phone: callbackPhone, call_id: session.callId || null, reason: reason || 'Customer requested callback', department: department || 'sales', priority: priority || 1 });

    return {
      success: true,
      _ctx: this._buildCtx(_twilioCallSid),
      message: `Callback scheduled for ${callbackPhone}. Our ${department || 'sales'} team will call you shortly. Anything else I can help with?`,
    };
  }

  // ── Tool: transferToHuman ─────────────────────────────────────────────────

  async _transferToHuman({ reason, department, _twilioCallSid }) {
    if (_twilioCallSid) {
      await dbService.updateCallMaster({ twilio_call_sid: _twilioCallSid, routed_to: `human_${department || 'sales'}`, routing_reason: reason || null });
    }
    return {
      success: true, transferring: true, department: department || 'sales',
      _ctx: this._buildCtx(_twilioCallSid),
      message: `Connecting you with our ${department || 'sales'} team now. Please hold.`,
    };
  }

  // ── Tool: saveLead ────────────────────────────────────────────────────────

  async _saveLead({ name, phone, email, destination, notes, _twilioCallSid, _callerPhone }) {
    const leadPhone = phone || _callerPhone;
    if (!leadPhone) return { success: false, error: 'phone is required', _ctx: this._buildCtx(_twilioCallSid) };

    const session = _twilioCallSid ? callSession.get(_twilioCallSid) : {};
    await dbService.scheduleCallback({ phone: leadPhone, call_id: session.callId || null, reason: `New enquiry — ${destination || 'TBD'}. Name: ${name || 'N/A'}. Email: ${email || 'N/A'}. Notes: ${notes || ''}`, department: 'sales', priority: 1 });

    // Register as new customer so they're recognised next call
    await dbService.insertCallerRegistry({ phone: leadPhone, caller_name: name || null, caller_email: email || null, customer_type: 'new_customer', is_verified: 0 });

    return {
      success: true,
      _ctx: this._buildCtx(_twilioCallSid),
      message: `Thank you${name ? ' ' + name : ''}! I've noted your enquiry for ${destination || 'your trip'}. Our sales team will reach out at ${leadPhone}. Anything else?`,
    };
  }

  // ── Tool: saveBookingEnquiry ──────────────────────────────────────────────

  async _saveBookingEnquiry({ requirements, selectedPackages, selectedPkgIds, noPackageFound, customRequirements, additionalNotes, _twilioCallSid, _callerPhone }) {
    const session = _twilioCallSid ? (callSession.get(_twilioCallSid) || {}) : {};

    // Resolve packages: prefer full objects passed by LLM, fall back to pkgId lookup from session
    let resolvedPackages = [];
    if (Array.isArray(selectedPackages) && selectedPackages.length > 0) {
      resolvedPackages = selectedPackages.slice(0, 3);
    } else if (Array.isArray(selectedPkgIds) && selectedPkgIds.length > 0 && Array.isArray(session.lastPackages)) {
      resolvedPackages = session.lastPackages.filter(p => selectedPkgIds.includes(p.pkgId)).slice(0, 3);
    }

    const req = requirements || {};

    // Attach rank (1=best, 2, 3) based on order LLM passed them in
    resolvedPackages = resolvedPackages.map((p, i) => ({ ...p, rank: i + 1 }));

    // Save to in-memory session only — DB write happens in sendPackageDetails or saveCallSummary
    if (_twilioCallSid) {
      callSession.merge(_twilioCallSid, {
        requirements:       req,
        filteredPackages:   resolvedPackages,
        noPackageFound:     !!noPackageFound,
        hasCustomRequest:   !!(noPackageFound || customRequirements),
        customRequirements: customRequirements || null,
        additionalNotes:    additionalNotes    || null,
        enquirySaved:       true,
        destination:        req.destination || session.destination || null,
      });
    }

    // Defensive: treat as noPackageFound if LLM passed empty packages but all packages in session are also empty
    const effectiveNoPackage = !!noPackageFound
      || (resolvedPackages.length === 0 && !customRequirements && (session.lastPackages?.length ?? 1) === 0);

    // 3. Auto-schedule callback when no packages found or caller has custom requirements
    if (effectiveNoPackage || customRequirements) {
      const callbackPhone = _callerPhone || session.phone || null;
      if (callbackPhone) {
        const reasonParts = [
          `Custom package request — ${req.destination || 'destination unknown'}`,
          req.pax             ? `Pax: ${req.pax}`                      : null,
          req.durationDays    ? `Days: ${req.durationDays}`             : null,
          req.budgetPerPerson ? `Budget: ${req.budgetPerPerson}`        : null,
          req.tripType        ? `Type: ${req.tripType}`                 : null,
          customRequirements  ? `Custom needs: ${customRequirements}`   : null,
        ].filter(Boolean).join(' | ');

        await dbService.scheduleCallback({
          phone:      callbackPhone,
          call_id:    session.callId || null,
          reason:     reasonParts,
          department: 'sales',
          priority:   2,
        });
      }

      return {
        success:           true,
        enquirySaved:      true,
        callbackScheduled: true,
        noPackageFound:    effectiveNoPackage,
        _ctx: this._buildCtx(_twilioCallSid),
        message: effectiveNoPackage
          ? `Enquiry saved and callback scheduled. Tell the caller: "We're working on some exciting options for you! Our team will put together a customised package based on your requirements and get in touch with you very soon. Is there anything specific you'd like us to include — like particular hotels, activities, or travel dates?"`
          : `Custom requirements saved and callback scheduled. Tell the caller: "Noted! Our team will create a personalised package for you and be in touch soon. Is there anything else I can help you with?"`,
      };
    }

    const rankedList = resolvedPackages
      .map(p => `Rank ${p.rank}: pkgId=${p.pkgId}  "${p.title}" — ${p.durationDays} days`)
      .join('\n');

    return {
      success:          true,
      enquirySaved:     true,
      packagesSelected: resolvedPackages.length,
      packages:         resolvedPackages,
      _ctx: this._buildCtx(_twilioCallSid),
      message: `Enquiry saved. Ranked packages (1=best match):\n${rankedList}\n\nNow do the following in order:\n1. Present only the names and durations: "I have 3 great options for you — [name1] for [N] days, [name2] for [N] days, and [name3] for [N] days."\n2. Ask: "Would you like me to explain any of these in detail, or shall I send all the details to your phone?"\n3. If caller wants explanation → ask "Which one?" → wait for reply → call getPackageItinerary.\n4. If caller wants details sent → ${resolvedPackages.length > 0 ? `ask for their ${['agent_verified','existing_customer'].includes((callSession.get(_twilioCallSid) || {}).callerType) ? 'email or phone number for SMS' : 'phone number for SMS'}` : 'ask for their phone number for SMS'} → call sendPackageDetails.\nDo NOT call sendPackageDetails before the caller confirms they want to receive it.`,
    };
  }

  // ── Tool: sendBookingLink ─────────────────────────────────────────────────

  async _sendBookingLink({ phone, email, customerName, bookingUrl, _twilioCallSid, _callerPhone }) {
    if (!bookingUrl) return { success: false, error: 'bookingUrl is required', _ctx: this._buildCtx(_twilioCallSid) };

    const session    = _twilioCallSid ? callSession.get(_twilioCallSid) : {};
    const callId     = session.callId || null;
    const smsPhone   = phone || _callerPhone;
    const channels   = [], errors = [];

    if (email) {
      try {
        await emailService.sendBookingLinkEmail({ to: email, customerName, bookingUrl });
        await dbService.insertCommunicationLog({ call_id: callId, channel: 'email', recipient_email: email, subject: 'Booking Link', body: bookingUrl, status: 'sent' });
        channels.push('email');
      } catch (err) { errors.push(`Email: ${err.message}`); }
    }

    if (smsPhone) {
      try {
        const msg = await smsService.sendBookingLinkSMS({ to: smsPhone, customerName, bookingUrl });
        await dbService.insertCommunicationLog({ call_id: callId, channel: 'sms', recipient_phone: smsPhone, twilio_msg_sid: msg.sid, body: 'Booking link SMS', status: 'sent' });
        channels.push('SMS');
      } catch (err) { errors.push(`SMS: ${err.message}`); }
    }

    const sent = channels.length > 0;
    return {
      success: sent, channelsSent: channels,
      _ctx: this._buildCtx(_twilioCallSid),
      message: sent
        ? `Booking link sent to your ${channels.join(' and ')}. You can complete your booking at your convenience.`
        : `Unable to send the booking link. ${errors.join(' ')} Please try again.`,
    };
  }

  // ── Tool: sendPaymentLink ─────────────────────────────────────────────────

  async _sendPaymentLink({ phone, email, customerName, paymentUrl, amount, _twilioCallSid, _callerPhone }) {
    if (!paymentUrl) return { success: false, error: 'paymentUrl is required', _ctx: this._buildCtx(_twilioCallSid) };

    const session    = _twilioCallSid ? callSession.get(_twilioCallSid) : {};
    const callId     = session.callId || null;
    const smsPhone   = phone || _callerPhone;
    const channels   = [], errors = [];

    if (email) {
      try {
        await emailService.sendPaymentLinkEmail({ to: email, customerName, paymentUrl, amount });
        await dbService.insertCommunicationLog({ call_id: callId, channel: 'email', recipient_email: email, subject: 'Payment Link', body: paymentUrl, status: 'sent' });
        channels.push('email');
      } catch (err) { errors.push(`Email: ${err.message}`); }
    }

    if (smsPhone) {
      try {
        const msg = await smsService.sendPaymentLinkSMS({ to: smsPhone, customerName, paymentUrl, amount });
        await dbService.insertCommunicationLog({ call_id: callId, channel: 'sms', recipient_phone: smsPhone, twilio_msg_sid: msg.sid, body: 'Payment link SMS', status: 'sent' });
        channels.push('SMS');
      } catch (err) { errors.push(`SMS: ${err.message}`); }
    }

    const sent = channels.length > 0;
    return {
      success: sent, channelsSent: channels,
      _ctx: this._buildCtx(_twilioCallSid),
      message: sent
        ? `Payment link${amount ? ' for ' + amount : ''} sent to your ${channels.join(' and ')}. Please complete the payment at your earliest convenience.`
        : `Unable to send the payment link. ${errors.join(' ')} Please try again.`,
    };
  }

  // ── Tool: sendRegistrationLink ────────────────────────────────────────────

  async _sendRegistrationLink({ phone, email, _twilioCallSid, _callerPhone }) {
    const registrationUrl = config.AGENT_REGISTRATION_URL;
    const session  = _twilioCallSid ? callSession.get(_twilioCallSid) : {};
    const callId   = session.callId || null;
    const smsPhone = phone || _callerPhone;
    const channels = [], errors = [];

    if (email) {
      try {
        await emailService.sendRegistrationLinkEmail({ to: email, registrationUrl });
        await dbService.insertCommunicationLog({ call_id: callId, channel: 'email', recipient_email: email, subject: 'Agent Registration Link', body: registrationUrl, status: 'sent' });
        channels.push('email');
      } catch (err) { errors.push(`Email: ${err.message}`); }
    }

    if (smsPhone) {
      try {
        const msg = await smsService.sendRegistrationLinkSMS({ to: smsPhone, registrationUrl });
        await dbService.insertCommunicationLog({ call_id: callId, channel: 'sms', recipient_phone: smsPhone, twilio_msg_sid: msg.sid, body: 'Registration link SMS', status: 'sent' });
        channels.push('SMS');
      } catch (err) { errors.push(`SMS: ${err.message}`); }
    }

    if (channels.length === 0 && !email && !smsPhone) {
      return { success: false, error: 'Provide at least one of phone or email to send the registration link.', _ctx: this._buildCtx(_twilioCallSid) };
    }

    const sent = channels.length > 0;
    return {
      success: sent, channelsSent: channels,
      _ctx: this._buildCtx(_twilioCallSid),
      message: sent
        ? `Registration link sent to your ${channels.join(' and ')}. Once registered you'll have full access to your agent portal.`
        : `Unable to send the registration link. ${errors.join(' ')} Please try again.`,
    };
  }

  // ── Tool: sendVerificationOTP (SMS) ───────────────────────────────────────

  async _sendVerificationOTP({ phone, _twilioCallSid }) {
    if (!phone) return { success: false, error: 'phone is required', _ctx: this._buildCtx(_twilioCallSid) };

    const otp = otpStore.create(phone);
    try {
      await smsService.sendGenericSMS({ to: phone, body: `Your Culture Holidays verification code is: ${otp}. Valid for 5 minutes. Do not share this with anyone.` });
    } catch (err) {
      return { success: false, error: `Failed to send OTP: ${err.message}`, _ctx: this._buildCtx(_twilioCallSid) };
    }

    return {
      success: true, maskedPhone: otpStore.mask(phone),
      _ctx: this._buildCtx(_twilioCallSid),
      message: `I've sent a 4-digit code to ${otpStore.mask(phone)}. Please share it when you receive it.`,
    };
  }

  // ── Tool: verifyOTP ───────────────────────────────────────────────────────

  async _verifyOTP({ phone, otp, agentId, _twilioCallSid }) {
    if (!phone || !otp) return { success: false, error: 'phone and otp are required', _ctx: this._buildCtx(_twilioCallSid) };

    const result = otpStore.verify(phone, otp);
    if (!result.valid) {
      let msg;
      if (result.reason === 'expired') {
        msg = 'That code has expired. Shall I send a new one?';
      } else if (result.reason === 'too_many_attempts') {
        msg = 'Too many incorrect attempts. For security, please call back or ask for a new code.';
      } else if (result.reason === 'no_otp') {
        msg = "I don't have an active code for that number. Shall I send a new one?";
      } else {
        const left = result.attemptsLeft;
        msg = left > 0
          ? `That code doesn't match. You have ${left} attempt${left > 1 ? 's' : ''} remaining.`
          : "That code doesn't match. Please ask me to resend a new code.";
      }
      return { success: false, verified: false, reason: result.reason, _ctx: this._buildCtx(_twilioCallSid), message: msg };
    }

    return {
      success: true, verified: true, agentId: agentId || null,
      _ctx: this._buildCtx(_twilioCallSid),
      message: 'Identity verified! How can I assist you today?',
    };
  }
}

module.exports = new VapiController();
