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
const businessHours      = require('../utils/businessHours');

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

// ── TourDate formatter ────────────────────────────────────────────────────────
// Converts any TourDate from the DB into "25th May 2026" before sending to Vapi.
// This lets the AI match the caller's spoken date directly against a readable
// string instead of trying to decode ISO timestamps.
const _MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

function _ordinalSuffix(d) {
  if (d >= 11 && d <= 13) return 'th';
  switch (d % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

function formatTourDate(raw) {
  if (!raw) return raw;
  let year, month, day;
  const s = String(raw);

  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    // ISO: "2026-05-25T..." or "2026-05-25"
    year  = parseInt(s.substring(0, 4), 10);
    month = parseInt(s.substring(5, 7), 10);
    day   = parseInt(s.substring(8, 10), 10);
  } else if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(s)) {
    // DD/MM/YYYY
    const p = s.split('/');
    day = parseInt(p[0], 10); month = parseInt(p[1], 10); year = parseInt(p[2], 10);
  } else {
    return raw; // unknown format — return as-is
  }

  if (!day || !month || !year || month < 1 || month > 12) return raw;
  return `${day}${_ordinalSuffix(day)} ${_MONTH_NAMES[month - 1]} ${year}`;
}
// e.g. "2026-05-25T00:00:00.000Z" → "25th May 2026"
//      "11/09/2026"               → "11th September 2026"

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
  // Extra 4-char false-positive triggers
  // "know" fuzzy-matches "new" in "New Zealand" (Levenshtein=2) — explicit block
  'know', 'show', 'tell', 'said', 'told', 'want', 'give', 'find', 'look',
  'what', 'which', 'where', 'when', 'how', 'does', 'dont', 'isnt', 'cant',
  'info', 'data', 'details', 'status', 'update', 'check', 'existing',
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
  // Guard: skip fuzzy matching entirely for inputs with > 3 significant words.
  // Full sentences ("I want to know about my existing booking") produce too many
  // non-stopword tokens which each get scored independently, causing accidental
  // country matches on common 4-char words like "know" → "new" (dist=2).
  const inputWords = t.split(/\s+/).filter(w => w.length > 3 && !COUNTRY_MATCH_STOPWORDS.has(w));
  if (inputWords.length > 3) return null;
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

// ── Server-side bookingRef resolver ──────────────────────────────────────────
// GPT-4o sometimes calls getBookingDetails({}) with no bookingRef even though
// it has the full agentBookings list in context and verbally confirmed the
// booking with the caller. We recover the QueryID server-side by scoring each
// booking against the recent conversation text (title keywords + date mentions).
function _resolveBookingRefFromConversation(agentBookings, conversationMessages, lastUserText, lastAssistantText = '') {
  if (!agentBookings?.length) return null;

  const msgs = Array.isArray(conversationMessages) ? conversationMessages : [];

  // 1. Scan last 10 messages for an explicit CHOQ... QueryID in the transcript
  const choqWindow = msgs.slice(-10);
  for (const msg of [...choqWindow].reverse()) {
    const text = (msg.content || msg.message || '').toUpperCase();
    const m = text.match(/CHOQ\d{8,}/);
    if (m) {
      const hit = agentBookings.find(b => b.QueryID === m[0]);
      if (hit) return hit.QueryID;
    }
  }

  // 2. Build scoring text.
  //
  // Strategy: use the NARROWEST possible window so the "listing all dates" message
  // (which pollutes the scoring with every month/day) stays out of scope.
  //
  // Case A — _lastUserText is a real date/package statement ("September 11 2026",
  //          "Dashing Dubai May 25"): score from ONLY that text. This is the purest
  //          signal — it's exactly what the caller said, uncontaminated by prior turns.
  //
  // Case B — _lastUserText is just an acknowledgment ("Yes", "Correct", "That's right"):
  //          the caller confirmed the AI's rephrasing. Score from LAST 3 messages
  //          (user picks date → AI confirms → user says yes). The AI confirmation
  //          message contains the specific date, giving one clean winner.
  //
  // Case C — _lastUserText is empty: fall back to last 3 messages.

  const ACKNOWLEDGMENTS = new Set([
    'yes','yeah','yep','yup','sure','okay','ok','correct','right','exactly',
    'that\'s right','that\'s correct','that is correct','affirmative','go ahead','proceed',
  ]);
  const lastTrimmed = (lastUserText || '').toLowerCase().trim();
  // Strip trailing punctuation for matching
  const lastCore = lastTrimmed.replace(/[.!?]+$/, '').trim();

  let recentText;
  if (lastCore.length >= 4 && !ACKNOWLEDGMENTS.has(lastCore)) {
    // Case A: caller directly stated the date/package — score from their words alone.
    // Most reliable signal — exactly what the caller said, no prior turn contamination.
    recentText = lastTrimmed;
  } else {
    // Case B: caller said "yes" / "correct" — they confirmed what the AI just stated.
    // The AI's confirmation utterance contains the booking date ("departing 11th September 2026").
    // Use lastAssistantText (captured from conversation-update) as the scoring context —
    // it's the AI's rephrasing and contains the exact date the caller confirmed.
    //
    // Case C: lastUserText is empty — fall back to last 3 messages from Vapi payload
    // (only works for phone calls where Vapi includes message history).
    if (lastAssistantText) {
      recentText = lastAssistantText.toLowerCase();
    } else {
      const recent3 = msgs.slice(-3);
      recentText = [
        ...recent3.map(m => m.content || m.message || ''),
        lastUserText || '',
      ].join(' ').toLowerCase();
    }
  }

  // Spoken ordinal → day number
  const ORDINALS = {
    first:1, second:2, third:3, fourth:4, fifth:5, sixth:6,
    seventh:7, eighth:8, ninth:9, tenth:10, eleventh:11, twelfth:12,
    thirteenth:13, fourteenth:14, fifteenth:15, sixteenth:16,
    seventeenth:17, eighteenth:18, nineteenth:19, twentieth:20,
    'twenty-first':21,'twenty-second':22,'twenty-third':23,'twenty-fourth':24,
    'twenty-fifth':25,'twenty-sixth':26,'twenty-seventh':27,
    'twenty-eighth':28,'twenty-ninth':29, thirtieth:30,'thirty-first':31,
  };

  // Month name → month number
  const MONTHS = {
    jan:1, january:1, feb:2, february:2, mar:3, march:3,
    apr:4, april:4, may:5, jun:6, june:6, jul:7, july:7,
    aug:8, august:8, sep:9, sept:9, september:9,
    oct:10, october:10, nov:11, november:11, dec:12, december:12,
  };

  const mentionedMonths = new Set();
  for (const [word, num] of Object.entries(MONTHS)) {
    if (recentText.includes(word)) mentionedMonths.add(num);
  }

  const mentionedYears = new Set(
    (recentText.match(/\b(202\d)\b/g) || []).map(Number)
  );

  const mentionedDays = new Set();
  for (const [word, num] of Object.entries(ORDINALS)) {
    if (recentText.includes(word)) mentionedDays.add(num);
  }
  // Also catch bare numbers like "11" in "September 11"
  for (const m of (recentText.match(/\b([0-9]{1,2})\b/g) || [])) {
    const n = parseInt(m, 10);
    if (n >= 1 && n <= 31) mentionedDays.add(n);
  }

  const scored = agentBookings.map(b => {
    let score = 0;

    // Normalize TourDate — after formatTourDate() it is "25th May 2026", but
    // support ISO and DD/MM/YYYY as fallbacks for any un-formatted rows.
    const td = b.TourDate || '';
    let day, month, year;
    const _MN = {january:1,february:2,march:3,april:4,may:5,june:6,
                 july:7,august:8,september:9,october:10,november:11,december:12};
    if (/^\d{1,2}(?:st|nd|rd|th)\s+\w+\s+\d{4}/i.test(td)) {
      // "25th May 2026" — our formatted output
      const hm = td.match(/^(\d{1,2})(?:st|nd|rd|th)\s+(\w+)\s+(\d{4})/i);
      day   = parseInt(hm[1], 10);
      month = _MN[hm[2].toLowerCase()] || NaN;
      year  = parseInt(hm[3], 10);
    } else if (/^\d{4}-\d{2}-\d{2}/.test(td)) {
      // ISO: "2026-09-11T..."
      year  = parseInt(td.substring(0, 4), 10);
      month = parseInt(td.substring(5, 7), 10);
      day   = parseInt(td.substring(8, 10), 10);
    } else if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(td)) {
      // DD/MM/YYYY
      const p = td.split('/');
      day = parseInt(p[0], 10); month = parseInt(p[1], 10); year = parseInt(p[2], 10);
    } else {
      day = NaN; month = NaN; year = NaN;
    }

    // Title keyword match (+2 per word > 3 chars)
    const titleWords = b.PKG_TITLE.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    for (const w of titleWords) {
      if (recentText.includes(w)) score += 2;
    }

    // Date components — month is most reliable spoken signal
    if (mentionedMonths.has(month)) score += 4;
    if (mentionedYears.has(year))   score += 1;
    if (mentionedDays.has(day))     score += 2;

    return { queryId: b.QueryID, score };
  }).sort((a, b) => b.score - a.score);

  // Require a clear winner with a meaningful score gap
  if (scored.length === 0) return null;
  const best = scored[0];
  const second = scored[1];
  if (best.score < 4) return null;                         // not enough evidence
  if (second && best.score <= second.score + 1) return null; // too ambiguous

  return best.queryId;
}

// ── Server-side requirement extraction ────────────────────────────────────────
// GPT-4o sometimes calls saveBookingEnquiry({}) with no params. We recover
// requirements by scanning the last 15 user messages from the conversation
// history that Vapi injects with every tool call.
function _extractRequirementsFromConversation(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return {};
  const text = messages
    .filter(m => m.role === 'user')
    .slice(-15)
    .map(m => (m.content || m.message || '').toLowerCase())
    .join(' ');

  const result = {};

  const paxM = text.match(/\b(\d{1,2})\s*(?:people|persons?|pax|travelers?|travellers?|passengers?|adults?|guests?|members?)\b/);
  if (paxM) result.pax = parseInt(paxM[1], 10);

  const daysM = text.match(/\b(\d{1,2})\s*(?:days?|nights?)\b/);
  if (daysM) result.durationDays = parseInt(daysM[1], 10);

  const budgetM = text.match(/\b(\d{3,6})\s*(?:dollars?|usd|\$|rupees?|inr|pounds?|gbp|per person)?\b/);
  if (budgetM) result.budgetPerPerson = budgetM[1];

  if      (text.includes('honeymoon')) result.tripType = 'honeymoon';
  else if (text.includes('family'))    result.tripType = 'family';
  else if (text.includes('adventure')) result.tripType = 'adventure';
  else if (text.includes('luxury'))    result.tripType = 'luxury';
  else if (text.includes('solo'))      result.tripType = 'solo';
  else if (text.includes('group'))     result.tripType = 'group';

  return result;
}

// ── Server-side package matching ──────────────────────────────────────────────
// Primary flow: AI passes requirements, server picks top 3 with match quality.
// matchType: 'exact' (±0 days) | 'similar' (±2 days) | 'recommendation' (beyond)
function _scorePackages(packages, requirements) {
  const { durationDays, tripType } = requirements;
  return [...packages]
    .map(pkg => {
      let score = 1000;
      let matchType = 'recommendation';

      if (durationDays && pkg.durationDays) {
        const diff = Math.abs(pkg.durationDays - durationDays);
        if (diff === 0)      { score += 200; matchType = 'exact'; }
        else if (diff <= 2)  { score += 120; matchType = 'similar'; }
        else if (diff <= 4)  { score += 60; }
        else                 { score -= diff * 10; }
      }

      if (tripType) {
        const t = (pkg.title || '').toLowerCase();
        if (tripType === 'honeymoon' && (t.includes('honey') || t.includes('romance'))) score += 40;
        if (tripType === 'luxury'    && (t.includes('luxe')  || t.includes('luxury')))  score += 40;
        if (tripType === 'family'    && t.includes('family'))                            score += 40;
        if (tripType === 'adventure' && t.includes('adventure'))                         score += 40;
      }

      return { ...pkg, _score: score, matchType };
    })
    .sort((a, b) => b._score - a._score);
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

        // Always capture last assistant utterance — used as scoring context when
        // the caller says "yes" (acknowledgment) and _conversationMessages is empty.
        const assistantTexts = turns
          .filter(t => t.role === 'assistant')
          .map(t => t.message || t.content || '')
          .filter(Boolean);
        if (assistantTexts.length > 0) {
          const lastAssistant = assistantTexts[assistantTexts.length - 1];
          if (lastAssistant) callSession.merge(sessionKey, { lastAssistantText: lastAssistant });
        }

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
      const eocKey = twilioSid || vapiId;
      if (eocKey) {
        if (!callLogger.has(eocKey)) {
          const s = callSession.get(eocKey) || {};
          const dir = twilioSid ? 'inbound' : 'web';
          callLogger.start(eocKey, { phone: s.phone || 'unknown', direction: dir, callId: s.callId || null });
        }
        callLogger.callEvent(eocKey, 'vapi_end_of_call', { summary: summary?.substring(0, 200) || null, durationSeconds: duration });
        await callLogger.flush(eocKey, {
          session: callSession.get(eocKey),
          summary: summary || null,
        });
      }
    }

    if (type === 'call-start') {
      // For web/dashboard test calls customer.number is null — fall back to TEST_CALLER_PHONE
      const phone = message?.call?.customer?.number || config.TEST_CALLER_PHONE || null;
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
        // Merge so destination/lastUserText captured by earlier conversation-update events survive.
        // _dbInitialized prevents the tool-call handler from running a redundant DB lookup.
        callSession.merge(sessionKey, {
          callId:         record?.CallID || null,
          phone:          normalizedPhone,
          callerType:     'unknown',
          isVerified:     false,
          vapiCallId:     vapiId,
          _dbInitialized: true,
        });
        // Start per-call JSON log (idempotent — skips if already started by Twilio webhook)
        callLogger.start(twilioSid, { phone: normalizedPhone, direction: 'inbound', callId: record?.CallID || null });
        callLogger.callEvent(twilioSid, 'call_started', { phone: normalizedPhone, vapiId });
        logger.info('Call record created via Vapi event', { callId: record?.CallID, twilioSid });

        // Pre-load caller identity non-blocking so identifyCaller tool responds
        // instantly from cache (<5ms) instead of waiting for a DB round-trip (300-400ms).
        if (normalizedPhone && normalizedPhone !== 'unknown') {
          dbService.getCallerByPhone(normalizedPhone)
            .then(caller => {
              if (caller) {
                callSession.merge(twilioSid, { _preloadedCaller: caller });
                logger.info('Caller pre-loaded at call-start', {
                  twilioSid, agentId: caller.AgentID, source: caller.Source,
                });
              }
            })
            .catch(() => {}); // non-fatal — identifyCaller will fall back to live DB call
        }
      } else if (vapiId) {
        // Web/dashboard test call — no Twilio SID, use vapiId as session key
        callSession.merge(vapiId, {
          phone:          normalizedPhone,
          callerType:     'unknown',
          isVerified:     false,
          vapiCallId:     vapiId,
          webCall:        true,   // prevents _transferToHuman from trying Twilio redirect
          _dbInitialized: true,
        });
        callLogger.start(vapiId, { phone: normalizedPhone, direction: 'web', callId: null });
        callLogger.callEvent(vapiId, 'call_started', { phone: normalizedPhone, vapiId });
        logger.info('Web call session created at call-start', { vapiId, phone: normalizedPhone });

        // Pre-load caller identity non-blocking (uses TEST_CALLER_PHONE if set)
        if (normalizedPhone && normalizedPhone !== 'unknown') {
          dbService.getCallerByPhone(normalizedPhone)
            .then(caller => {
              if (caller) {
                callSession.merge(vapiId, { _preloadedCaller: caller });
                logger.info('Caller pre-loaded at call-start (web)', {
                  vapiId, agentId: caller.AgentID, source: caller.Source,
                });
              }
            })
            .catch(() => {}); // non-fatal — identifyCaller will fall back to live DB call
        }
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
    // For web/dashboard test calls customer.number is null — fall back to TEST_CALLER_PHONE
    // so identity lookup works without a real inbound number.
    const rawPhone    = message.call?.customer?.number || config.TEST_CALLER_PHONE || null;
    const callerPhone = normalizePhone(rawPhone) || rawPhone || null;

    // For web/dashboard test calls there is no TwilioCallSID — fall back to
    // vapiCallId so the in-memory session still works end-to-end.
    const sessionKey = twilioCallSid || vapiCallId;

    if (sessionKey) {
      // conversation-update events can pre-create the session via callSession.merge() before any
      // tool call fires, leaving it without callId/callerType/_dbInitialized. Guard against that
      // by checking _dbInitialized rather than just has() — so the DB lookup/auto-create still
      // runs on the first *tool call* even if the session entry already exists from event parsing.
      const existingSession = callSession.get(sessionKey);
      if (!existingSession._dbInitialized) {
        if (twilioCallSid) {
          // Real phone call — try to recover session from DB first
          const record = await dbService.getCallByTwilioSID(twilioCallSid);
          if (record) {
            callSession.merge(sessionKey, {
              callId:          record.CallID,
              phone:           normalizePhone(record.CallerPhone) || record.CallerPhone,
              callerType:      record.CallerStatus || 'unknown',
              agentId:         record.AgentID    || null,
              name:            record.CallerName || null,
              email:           record.CallerEmail || null,
              isVerified:      record.CallerStatus === 'agent_verified',
              _dbInitialized:  true,
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
            callSession.merge(sessionKey, {
              callId:         created?.CallID || null,
              phone:          callerPhone,
              callerType:     'unknown',
              isVerified:     false,
              _dbInitialized: true,
            });
            if (created?.CallID) {
              logger.info('Call record auto-created on first tool call', { callId: created.CallID, twilioSid: twilioCallSid });
            } else {
              logger.warn('Could not create call_master record on first tool call', { twilioSid: twilioCallSid });
            }
          }
        } else {
          // Web/dashboard call — seed a minimal in-memory session (no DB record)
          callSession.merge(sessionKey, { phone: callerPhone, callerType: 'unknown', isVerified: false, webCall: true, _dbInitialized: true });
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
        // Full user conversation — used by saveBookingEnquiry to extract requirements
        // server-side when GPT-4o omits them from the function call params.
        params._conversationMessages = conversationMessages;

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
      case 'getBookingDetails':      return this._getBookingDetails(params);
      case 'getPaymentDetails':      return this._getPaymentDetails(params);
      case 'getGuestDetails':        return this._getGuestDetails(params);
      case 'saveAdjustmentRequest':  return this._saveAdjustmentRequest(params);
      case 'saveLead':               return this._saveLead(params);
      case 'saveBookingEnquiry':     return this._saveBookingEnquiry(params);
      case 'sendBookingLink':        return this._sendBookingLink(params);
      case 'sendPaymentLink':        return this._sendPaymentLink(params);
      case 'sendRegistrationLink':   return this._sendRegistrationLink(params);
      case 'sendVerificationOTP':    return this._sendVerificationOTP(params);
      case 'verifyOTP':              return this._verifyOTP(params);
      // New feature tools
      case 'getFailedPayments':      return this._getFailedPayments(params);
      case 'getCallerQueries':       return this._getCallerQueries(params);
      case 'findSalesperson':        return this._findSalesperson(params);
      case 'connectToSalesperson':   return this._connectToSalesperson(params);
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
    const s = sessionKey ? (callSession.get(sessionKey) || {}) : {};
    return {
      phone:            s.phone            || null,
      name:             s.name             || null,
      type:             s.callerType       || 'unknown',
      agentId:          s.agentId          || null,
      verified:         s.isVerified       || false,
      destination:      s.destination      || null,
      callId:           s.callId           || null,
      totalCalls:       s.totalCalls       ?? 0,
      email:            s.email            || null,
      activeBookingRef: s.activeBookingRef || null,
      // Package ID of the active booking — use for getPackageItinerary after getBookingDetails
      activePackgId:    s.activePackgId    || null,
      // Constructed payment URL (travid-based) — set after getBookingDetails or getPaymentDetails
      paymentUrl:       s.paymentUrl       || null,
      // Balance due on active booking — used by Communication / Payment for payment link amount
      balanceDue:       s.activeBooking?.BalanceDue || null,
      // Salesperson call result — set when /salesperson-fallback fires after no-answer
      // Receptionist reads this to explain what happened and offer a callback.
      salespersonCallResult: s.salespersonCallResult || null,   // 'no_answer' | 'no_phone' | null
      pendingSalespersonName: s.pendingSalespersonName || null,  // name of salesperson we tried to reach
    };
  }

  // ── Tool: identifyCaller ───────────────────────────────────────────────────
  // Replaces checkCallerIdentity. Three-stage lookup:
  // 1. caller_registry (fast path for returning callers)
  // 2. tbl_agent by phone (auto-registers if found)
  // 3. New customer fallback

  async _identifyCaller({ phone, agentId, identityDenied, _twilioCallSid, _callerPhone }) {
    // ── Identity denial path ─────────────────────────────────────────────────────
    // Caller said "No, that's not me" after we proposed a name.
    // Reset the session to 'unknown' so downstream routing (HSR) treats them correctly.
    if (identityDenied) {
      logger.info('[identifyCaller] Identity denied — resetting session to unknown', { sid: _twilioCallSid });
      if (_twilioCallSid) {
        callSession.merge(_twilioCallSid, {
          callerType: 'unknown', isVerified: false,
          agentId: null, name: null, email: null,
        });
        await dbService.updateCallMaster({
          twilio_call_sid: _twilioCallSid,
          caller_status: 'identity_denied',
          agent_id: null,
          caller_name: null,
        }).catch(() => {});
      }
      return {
        success:  true,
        type:     'unknown',
        _ctx:     this._buildCtx(_twilioCallSid),
        message:  'Identity cleared. The caller is now treated as unverified.',
      };
    }

    const rawPhone    = phone || _callerPhone;
    const lookupPhone = normalizePhone(rawPhone) || rawPhone;

    // --- Agent ID provided directly (manual entry by caller) ---
    if (agentId) {
      const agent = await dbService.getAgentById(agentId);
      if (agent) {
        const agentFirstName = agent.name ? agent.name.trim().split(/\s+/)[0] : null;
        if (_twilioCallSid) {
          callSession.merge(_twilioCallSid, { callerType: 'agent_verified', agentId: agent.AgentID, name: agent.name || null, email: agent.EmailID, isVerified: true });
          await dbService.updateCallMaster({ twilio_call_sid: _twilioCallSid, caller_status: 'agent_verified', agent_id: agent.AgentID, caller_name: agent.name || null, caller_email: agent.EmailID });
        }
        return {
          success: true, type: 'agent_verified',
          agentId: agent.AgentID, name: agent.name || null, email: agent.EmailID, phone: agent.Contact,
          _ctx: this._buildCtx(_twilioCallSid),
          message: `I've confirmed your Agent ID ${agent.AgentID}${agentFirstName ? ', ' + agentFirstName : ''}. How can I assist you today?`,
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

    // --- USP_GetCallerByPhone: three-stage SP lookup ---
    //   Source='registry', IsVerified=1  → verified agent (returning caller)
    //   Source='tbl_agent', IsVerified=1  → known agent from main system, first time on AI line
    //                                       treat as verified but ask soft confirmation
    //   Source='registry', new_customer  → non-agent customer (returning)
    //   0 rows                           → unknown or unverified with no agent record
    //                                       → DO NOT treat as new customer; route to human support

    // Use pre-loaded caller if available (cached non-blocking at call-start for instant response)
    const existingSession = _twilioCallSid ? callSession.get(_twilioCallSid) : null;
    let registry = existingSession?._preloadedCaller || null;
    if (registry) {
      // Consume the cache so we never serve a stale pre-load on a subsequent call
      callSession.merge(_twilioCallSid, { _preloadedCaller: null });
      logger.info('identifyCaller: served from pre-loaded cache', { twilioSid: _twilioCallSid, agentId: registry.AgentID });
    } else {
      registry = await dbService.getCallerByPhone(lookupPhone);
    }

    if (registry) {

      // ── Path A: Verified agent (from registry or tbl_agent) ───────────────────
      if (registry.IsVerified && registry.CustomerType === 'agent') {
        const fromTblAgent = registry.Source === 'tbl_agent';

        // Bump call count only for registry rows (tbl_agent rows have no registry record yet)
        if (!fromTblAgent) {
          await dbService.updateCallerRegistry({ phone: lookupPhone });
        }

        if (_twilioCallSid) {
          callSession.merge(_twilioCallSid, {
            phone: lookupPhone, callerType: 'agent_verified',
            agentId:    registry.AgentID    || null,
            name:       registry.CallerName || null,
            email:      registry.CallerEmail || null,
            isVerified: true,
            totalCalls: registry.TotalCalls || 0,
          });
          await dbService.updateCallMaster({
            twilio_call_sid: _twilioCallSid,
            caller_status: 'agent_verified',
            agent_id:     registry.AgentID    || null,
            caller_name:  registry.CallerName  || null,
            caller_email: registry.CallerEmail || null,
          });
        }

        // tbl_agent match: ask a soft name confirmation before giving full access.
        // The agent IS verified — we just want to make sure it's really them.
        // Use the name column from tbl_agent if available.
        if (fromTblAgent) {
          const agentFirstName = registry.CallerName
            ? registry.CallerName.trim().split(/\s+/)[0]
            : null;
          const confirmMsg = agentFirstName
            ? `I found a registered agent account linked to your number — ${agentFirstName}. Could you confirm that's you, so I can pull up your details?`
            : `I found a registered agent account for your number (Agent ID: ${registry.AgentID}). Could you confirm that's you, so I can pull up your details?`;
          return {
            success: true, type: 'agent_verified',
            agentId: registry.AgentID,
            name:    registry.CallerName || null,
            email:   registry.CallerEmail,
            phone:   lookupPhone,
            source:  'tbl_agent',
            requiresConfirmation: true,
            _ctx: this._buildCtx(_twilioCallSid),
            message: confirmMsg,
          };
        }

        // Registry match: full welcome, no confirmation needed.
        // Use first name only for a natural greeting ("Welcome back Ashish!")
        const firstName = registry.CallerName
          ? registry.CallerName.trim().split(/\s+/)[0]
          : null;
        return {
          success: true, type: 'agent_verified',
          agentId:    registry.AgentID,
          name:       registry.CallerName,
          email:      registry.CallerEmail,
          phone:      lookupPhone,
          totalCalls: registry.TotalCalls,
          source:     'registry',
          _ctx: this._buildCtx(_twilioCallSid),
          message: `Welcome back${firstName ? ', ' + firstName : ''}! How can I assist you today?`,
        };
      }

      // ── Path B: Registered non-agent customer ────────────────────────────────
      if (registry.CustomerType === 'new_customer') {
        await dbService.updateCallerRegistry({ phone: lookupPhone });
        if (_twilioCallSid) {
          callSession.merge(_twilioCallSid, { phone: lookupPhone, callerType: 'new_customer', name: registry.CallerName, isVerified: false });
          await dbService.updateCallMaster({ twilio_call_sid: _twilioCallSid, caller_status: 'new_customer', caller_name: registry.CallerName });
        }
        const custFirstName = registry.CallerName
          ? registry.CallerName.trim().split(/\s+/)[0]
          : null;
        return {
          success: true, type: 'new_customer', name: registry.CallerName,
          _ctx: this._buildCtx(_twilioCallSid),
          message: `Welcome back${custFirstName ? ', ' + custFirstName : ''}! How can I assist you today?`,
        };
      }
    }

    // --- Unknown / unverified with no agent record → route to human support ---
    // Do NOT treat as a new customer. We cannot identify this caller.
    if (_twilioCallSid) {
      callSession.merge(_twilioCallSid, { phone: lookupPhone, callerType: 'unknown', isVerified: false });
      await dbService.updateCallMaster({ twilio_call_sid: _twilioCallSid, caller_status: 'unknown' });
    }
    return {
      success: true, type: 'unknown',
      _ctx: this._buildCtx(_twilioCallSid),
      message: `I'm unable to find a registered account for your number. Let me transfer you to our support team who can assist you directly.`,
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
    const session = _twilioCallSid ? (callSession.get(_twilioCallSid) || {}) : {};
    const resolvedAgentId = agentId || session.agentId;
    if (!resolvedAgentId) return { success: false, error: 'agentId is required', _ctx: this._buildCtx(_twilioCallSid) };

    const rawBookings = await dbService.getAgentBookings(resolvedAgentId);
    if (rawBookings.length === 0) {
      return { success: true, count: 0, bookings: [], _ctx: this._buildCtx(_twilioCallSid), message: 'You have no upcoming bookings at the moment.' };
    }

    // Format TourDate to human-readable "25th May 2026" so the AI can directly
    // match the caller's spoken date without needing ISO date conversion.
    const bookings = rawBookings.map(b => ({
      ...b,
      TourDate: formatTourDate(b.TourDate),
    }));

    // Store formatted list in session so the resolver can score by name/date
    if (_twilioCallSid) callSession.merge(_twilioCallSid, { agentBookings: bookings });

    const BOOKING_INSTRUCTION = `\n\nIMPORTANT: TourDate is now human-readable (e.g. "25th May 2026"). Each booking has its QueryID. When the caller identifies their booking by name and date, find the matching entry in bookings[] and use its QueryID as bookingRef when calling getBookingDetails. NEVER ask the caller for the QueryID — it is internal only.`;

    if (bookings.length <= 3) {
      const summary = bookings
        .map((b, i) => `${i + 1}. ${b.PKG_TITLE} — ${b.TourDate}`)
        .join('\n');
      return {
        success: true, count: bookings.length, bookings,
        _ctx: this._buildCtx(_twilioCallSid),
        message: `You have ${bookings.length} upcoming booking(s):\n${summary}\n\nWhich booking would you like details on?${BOOKING_INSTRUCTION}`,
      };
    }

    // >3 bookings — ask caller to narrow down
    return {
      success: true, count: bookings.length, bookings,
      _ctx: this._buildCtx(_twilioCallSid),
      message: `You have ${bookings.length} upcoming bookings. Could you tell me the package name or approximate tour date so I can find it quickly?${BOOKING_INSTRUCTION}`,
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

    // Send the LLM a compact reference list — title + durationDays only (no dates).
    // Full package objects stay in session.lastPackages for server-side matching.
    // The AI does NOT score packages — server handles that in saveBookingEnquiry.
    const forLLM = packages.slice(0, 30).map(pkg => ({
      pkgId:        pkg.pkgId,
      title:        pkg.title,
      durationDays: pkg.durationDays,
    }));

    const packageList = forLLM.map((pkg, i) =>
      `${i + 1}. pkgId=${pkg.pkgId} | ${pkg.title} | ${pkg.durationDays} days`
    ).join('\n');

    return {
      success: true, count: packages.length, packages: forLLM,
      _ctx: this._buildCtx(_twilioCallSid),
      message: `${packages.length} package(s) available for ${matchedCountryName} (showing top ${forLLM.length}):\n\n${packageList}\n\nINSTRUCTION:\n1. Ask the caller the following one at a time (skip any already answered):\n   - How many people are travelling?\n   - How many days?\n   - Approximate budget per person?\n   - Type of trip: honeymoon, family, adventure, or luxury?\n2. Once you have all 4 answers, call saveBookingEnquiry with ONLY the requirements:\n   saveBookingEnquiry({ requirements: { destination: "${matchedCountryName}", pax: N, durationDays: N, budgetPerPerson: "...", tripType: "..." } })\n   Do NOT include selectedPkgIds — the server matches packages automatically.\n3. After saveBookingEnquiry succeeds, present the 3 packages it returns EXACTLY as given — name and duration only.`,
    };
  }

  // ── Tool: getPackageItinerary ─────────────────────────────────────────────

  async _getPackageItinerary({ pkgId, _twilioCallSid, _lastUserText }) {
    if (!pkgId && _twilioCallSid) {
      const sess = callSession.get(_twilioCallSid) || {};

      // Use only the packages that were actually presented to the caller (ranked by LLM).
      // Do NOT fall back to lastPackages.slice(0,3) — that is DB order, not presentation order,
      // and would cause the wrong itinerary to be explained (e.g. 5-day pkg instead of 8-day).
      const shownPkgs = sess.filteredPackages?.length ? sess.filteredPackages : [];

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
        // Backend couldn't resolve — give Vapi LLM the user's exact words + package list.
        // If filteredPackages is empty (saveBookingEnquiry wasn't called properly), use lastPackages
        // so the LLM can identify the correct pkgId and also call saveBookingEnquiry first.
        const refPkgs = shownPkgs.length ? shownPkgs : (sess.lastPackages || []).slice(0, 20);
        const pkgList = refPkgs
          .map((p, i) => `${i + 1}. pkgId=${p.pkgId} — "${p.title}" (${p.durationDays} days)`)
          .join('\n');
        const userSaid = userText || '(not captured)';
        const noRanked = shownPkgs.length === 0 && refPkgs.length > 0;
        logger.info(`  getPackageItinerary: backend could not resolve — sending to Vapi LLM  userText="${userSaid}"  noRankedPkgs=${noRanked}`);
        return {
          success: false,
          requiresRetry: true,
          _ctx: this._buildCtx(_twilioCallSid),
          message: noRanked
            ? `The caller said: "${userSaid}"\n\nWARNING: saveBookingEnquiry has not yet been called with selectedPkgIds, so no ranked list is stored.\n\nAll available packages:\n${pkgList}\n\nFirst, identify which package the caller wants, then:\n1. Call saveBookingEnquiry with selectedPkgIds: [chosen_pkgId, ...] (rank-order your top 3)\n2. Then call getPackageItinerary with the correct pkgId.`
            : `The caller said: "${userSaid}"\n\nPackages shown to them:\n${pkgList}\n\nIdentify which package the caller is referring to and call getPackageItinerary again with the correct pkgId. If you genuinely cannot tell, ask the caller: "Could you say first, second, or third — or the package name?"`,
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
    // ── Holiday / availability check ─────────────────────────────────────────
    // Support is 24×7 so this only blocks on a public holiday.
    // If unavailable: return an instructive message to the LLM — it should then
    // speak the holiday message and call scheduleCallback instead of retrying.
    // Check availability for the relevant team — sales has time-based hours; support is 24×7 (holidays only)
    const teamToCheck  = (department === 'sales') ? 'sales' : 'support';
    const availability = await businessHours.checkAvailability(teamToCheck);
    if (!availability.available) {
      logger.info(`[transferToHuman] ${teamToCheck} unavailable (${availability.reason}) — returning holiday message`);
      return {
        success:     false,
        unavailable: true,
        reason:      availability.reason,
        holidayName: availability.holidayName || null,
        _ctx:        this._buildCtx(_twilioCallSid),
        message:     `${availability.message} Use scheduleCallback to arrange a callback for the caller instead of trying transferToHuman again.`,
      };
    }

    if (_twilioCallSid) {
      await dbService.updateCallMaster({ twilio_call_sid: _twilioCallSid, routed_to: `human_${department || 'sales'}`, routing_reason: reason || null });
    }

    // For real Twilio phone calls: redirect the active call to the simultaneous-ring endpoint.
    // Vapi's SIP leg gets replaced with a TwiML <Dial> that rings all SUPPORT_NUMBERS at once.
    const session = _twilioCallSid ? callSession.get(_twilioCallSid) : {};
    if (_twilioCallSid && !session.webCall) {
      try {
        const { getTwilioClient } = require('../integrations/twilio');
        const client = getTwilioClient();
        await client.calls(_twilioCallSid).update({
          url:    `${config.BASE_URL}/api/twilio/human-support`,
          method: 'POST',
        });
        logger.info(`[transferToHuman] Call redirected to /human-support`, { callSid: _twilioCallSid, department });
      } catch (err) {
        logger.warn(`[transferToHuman] Twilio redirect failed: ${err.message}`, { callSid: _twilioCallSid });
      }
    }

    return {
      success: true, transferring: true, department: department || 'sales',
      _ctx: this._buildCtx(_twilioCallSid),
      message: `Connecting you with our ${department || 'sales'} team now. Please hold.`,
    };
  }

  // ── Tool: getFailedPayments ────────────────────────────────────────────────
  // Returns recent failed + successful payment transactions for a verified agent.
  // Uses agentId from session (no bookingRef needed — SP queries by agent).
  // statusFilter: 'failed' | 'success' | null (both); fromDate: optional ISO date.

  async _getFailedPayments({ statusFilter, fromDate, _twilioCallSid }) {
    const session = _twilioCallSid ? (callSession.get(_twilioCallSid) || {}) : {};
    const agentId = session.agentId;

    if (!agentId) {
      return {
        success: false,
        error:   'Agent not verified — agentId not found in session. The caller must be verified before checking payment records.',
        _ctx:    this._buildCtx(_twilioCallSid),
      };
    }

    // Map statusFilter → SP @Status param ('failed' | 'success' | null)
    let spStatus = null;
    if (statusFilter === 'failed')  spStatus = 'failed';
    if (statusFilter === 'success') spStatus = 'success';

    const { failed, success } = await dbService.getFailedPayments({
      agentId,
      status:   spStatus,
      fromDate: fromDate || null,
    });

    // ── Build spoken summary lines ─────────────────────────────────────────
    const _fmtDate = raw => {
      if (!raw) return null;
      try {
        return new Date(raw).toLocaleDateString('en-IN', {
          day: 'numeric', month: 'short', year: 'numeric',
        });
      } catch { return null; }
    };

    const _fmtAmt = amt => amt ? `USD ${Number(amt).toLocaleString('en-US')}` : null;

    const failedLines = failed.map((r, i) => {
      const dateStr = _fmtDate(r.TransactionDate || r.CreatedDate);
      const amtStr  = _fmtAmt(r.Amount);
      const errText = r.ErrorText || r.ResponseMessage || r.Status || 'Unknown error';
      const gw      = r.PaymentGateway ? ` via ${r.PaymentGateway}` : '';
      const parts   = [`Attempt ${i + 1}`];
      if (dateStr) parts.push(` on ${dateStr}`);
      if (amtStr)  parts.push(` for ${amtStr}`);
      parts.push(`${gw}: ${errText}.`);
      return parts.join('');
    });

    const successLines = success.map((r, i) => {
      const dateStr = _fmtDate(r.TransactionDate || r.CreatedDate);
      const amtStr  = _fmtAmt(r.Amount);
      const gw      = r.PaymentGateway ? ` via ${r.PaymentGateway}` : '';
      const parts   = [`Payment ${i + 1}`];
      if (amtStr)  parts.push(` of ${amtStr}`);
      if (dateStr) parts.push(` on ${dateStr}`);
      parts.push(`${gw}: Successful.`);
      return parts.join('');
    });

    // ── Gateway-based suggestion ───────────────────────────────────────────
    const failedGateways  = [...new Set(failed.map(r => r.PaymentGateway).filter(Boolean))];
    const successGateways = [...new Set(success.map(r => r.PaymentGateway).filter(Boolean))];
    let suggestion = '';
    if (failed.length > 0) {
      if (successGateways.length > 0) {
        suggestion = ` Payments via ${successGateways[0]} have been going through — suggest using that gateway for the next attempt.`;
      } else if (failedGateways.length > 0) {
        suggestion = ` The failures are with ${failedGateways.join(' and ')}. Suggest switching to a different gateway or payment method.`;
      } else {
        suggestion = ' Suggest trying a different payment method or gateway.';
      }
    }

    // ── Compose final message ──────────────────────────────────────────────
    let message = '';
    if (failed.length === 0 && success.length === 0) {
      message = 'No payment records found for your account at the moment. If you are experiencing a payment issue with a very recent attempt, it may not have been recorded yet — please try again or use a different payment method.';
    } else if (failed.length === 0) {
      message = `No failed payment records found.${success.length > 0 ? ` Your ${success.length} recent payment(s) all appear successful.` : ''}`;
    } else {
      const parts = [];
      if (failedLines.length > 0) {
        parts.push(`I found ${failed.length} recent failed payment attempt(s):\n${failedLines.join('\n')}`);
      }
      if (successLines.length > 0 && spStatus !== 'failed') {
        parts.push(`\n\nRecent successful payment(s) (${success.length}):\n${successLines.join('\n')}`);
      }
      message = parts.join('') + suggestion;
    }

    return {
      success:      true,
      failedCount:  failed.length,
      successCount: success.length,
      failed: failed.map(r => ({
        date:      r.TransactionDate || r.CreatedDate,
        amount:    r.Amount,
        gateway:   r.PaymentGateway,
        trackId:   r.TrackId,
        bankTxnId: r.TId,
        status:    r.Status,
        error:     r.ErrorText || r.ResponseMessage,
      })),
      successful: success.map(r => ({
        date:      r.TransactionDate || r.CreatedDate,
        amount:    r.Amount,
        gateway:   r.PaymentGateway,
        trackId:   r.TrackId,
        bankTxnId: r.TId,
      })),
      _ctx:    this._buildCtx(_twilioCallSid),
      message,
    };
  }

  // ── Tool: findSalesperson ─────────────────────────────────────────────────
  // Looks up the assigned salesperson for a CHAM message ID only.
  // Booking-based routing is handled by the Existing Booking assistant.
  // Also checks sales team business hours availability.
  // SP returns: MSG_ID, StaffName, Mobile, AssignStatus, AssignTo, UserID

  // ── Tool: getCallerQueries ────────────────────────────────────────────────
  // Fetches all TBL_MESSAGE queries for the caller's phone (+ agentId if verified).
  // Used by Sales Connect as the FIRST action to avoid asking for CHAM ID upfront.
  // Returns count, queries[], sameSalesperson flag, and a ready-made spoken message.

  async _getCallerQueries({ _twilioCallSid, _callerPhone }) {
    const session = _twilioCallSid ? (callSession.get(_twilioCallSid) || {}) : {};
    const agentId = session.agentId || null;
    const phone   = _callerPhone || session.phone || null;
    const _ctx    = this._buildCtx(_twilioCallSid);

    if (!phone) {
      return {
        success: false,
        error:   'Phone number not found in session',
        count:   0,
        queries: [],
        _ctx,
        message: "I wasn't able to look up your queries right now. Could you share your message ID so I can find your salesperson?",
      };
    }

    const rows = await dbService.getQueriesByPhone({ phone, agentId });
    const count = rows.length;

    // ── Format each row ────────────────────────────────────────────────────
    const queries = rows.map(row => {
      let rawPhone = row.SalespersonMobile ? String(row.SalespersonMobile) : null;
      if (rawPhone) {
        rawPhone = normalizePhone(rawPhone);
        if (rawPhone && /^\d{10}$/.test(rawPhone)) rawPhone = '+91' + rawPhone;
      }
      return {
        chamId:          `CHAM-${row.MSG_ID}`,
        msgId:           String(row.MSG_ID),
        country:         row.Country       || null,
        fromDate:        row.FromDate      || null,
        createdDate:     row.CREATED_DATE  || null,
        salespersonName: row.SalespersonName  || null,
        salespersonId:   row.SalespersonId    || null,
        salespersonPhone: rawPhone,
      };
    });

    // ── Determine if all assigned queries share one salesperson ────────────
    const spIds = [...new Set(queries.map(q => q.salespersonId).filter(Boolean))];
    const sameSalesperson = count > 0 && spIds.length === 1;
    const leadQuery       = sameSalesperson ? queries[0] : null;

    // ── Build spoken message ───────────────────────────────────────────────
    let message;
    if (count === 0) {
      message = "You don't have any active queries on record. If you'd still like to speak with our team, I can connect you with customer support.";
    } else if (count === 1) {
      const q    = queries[0];
      const dest = q.country          || 'a destination';
      const sp   = q.salespersonName  || 'a salesperson';
      message = `I can see one query — ${dest}, handled by ${sp}. Shall I connect you with them?`;
    } else if (sameSalesperson) {
      const sp    = leadQuery.salespersonName || 'your contact';
      const dests = [...new Set(queries.map(q => q.country).filter(Boolean))].join(', ');
      message = `I can see ${count} queries, all handled by ${sp} — ${dests}. Shall I connect you with them?`;
    } else if (count <= 5) {
      const dests = [...new Set(queries.map(q => q.country).filter(Boolean))].join(', ');
      message = `I can see ${count} queries — ${dests}. Which destination would you like to connect about?`;
    } else {
      message = `You have ${count} queries on record. Could you tell me your CHAM ID, destination, or tour date so I can find the right one for you?`;
    }

    logger.info('[getCallerQueries] resolved', {
      sid: _twilioCallSid, phone, agentId, count, sameSalesperson,
    });

    return {
      success:         true,
      count,
      queries,
      sameSalesperson,
      salespersonName:  sameSalesperson ? leadQuery.salespersonName  : null,
      salespersonPhone: sameSalesperson ? leadQuery.salespersonPhone : null,
      _ctx,
      message,
    };
  }

  // ── Tool: findSalesperson ─────────────────────────────────────────────────

  async _findSalesperson({ chamId, _twilioCallSid }) {
    // chamId is required
    const raw = chamId ? chamId.trim() : null;

    if (!raw) {
      return {
        success: false,
        error:   'chamId is required — the caller must provide their CHAM message ID',
        _ctx:    this._buildCtx(_twilioCallSid),
        message: 'Could you please share your message ID? It starts with CHAM followed by some numbers — for example, CHAM-33518.',
      };
    }

    // Build a display ID (always CHAM-XXXXX format)
    const numericPart = raw.replace(/^cham-?/i, '').trim();
    const displayId   = `CHAM-${numericPart}`;

    const person = await dbService.findSalespersonByChamId(raw);

    if (!person || !person.StaffName) {
      return {
        success:   true,
        found:     false,
        lookupId:  displayId,
        _ctx:      this._buildCtx(_twilioCallSid),
        message:   `I couldn't find anyone assigned to ${displayId}. This ID may be invalid or not yet assigned in our system. Could the caller please double-check their message ID?`,
      };
    }

    // ── Check sales team availability ─────────────────────────────────────
    const avail = await businessHours.checkAvailability('sales');

    // Normalise phone to E.164 — tblstaff.Mobile stores 10-digit Indian numbers
    let rawPhone = person.Mobile || null;
    if (rawPhone) {
      rawPhone = normalizePhone(rawPhone);               // handles 12-15 digit strings
      if (rawPhone && /^\d{10}$/.test(rawPhone))
        rawPhone = '+91' + rawPhone;                     // add +91 for bare 10-digit numbers
    }
    const phone = rawPhone;
    const name  = person.StaffName || 'your contact';

    if (!avail.available) {
      return {
        success:    true,
        found:      true,
        available:  false,
        reason:     avail.reason,
        name,
        nextOpenAt: avail.nextOpenAt,
        lookupId:   displayId,
        _ctx:       this._buildCtx(_twilioCallSid),
        message:    `I found ${name} as the person handling your query ${displayId}. However, ${avail.message}`,
      };
    }

    if (!phone) {
      return {
        success:   true,
        found:     true,
        available: false,
        reason:    'no_phone_configured',
        name,
        lookupId:  displayId,
        _ctx:      this._buildCtx(_twilioCallSid),
        message:   `I found ${name} for your query ${displayId} but their direct number isn't configured yet. I can arrange a callback instead — shall I do that?`,
      };
    }

    return {
      success:   true,
      found:     true,
      available: true,
      name,
      phone,
      lookupId:  displayId,
      _ctx:      this._buildCtx(_twilioCallSid),
      message:   `I found ${name} as the person handling your query ${displayId}. They are currently available. Shall I connect you to them right now?`,
    };
  }

  // ── Tool: connectToSalesperson ────────────────────────────────────────────
  // Triggers a Twilio redirect to dial the salesperson directly.
  // MUST only be called after the caller has confirmed they want to connect.
  // On no-answer, /api/twilio/salesperson-fallback routes back to Vapi with
  // salespersonCallResult='no_answer' in session.

  async _connectToSalesperson({ phone, name, context, _twilioCallSid }) {
    const session = _twilioCallSid ? (callSession.get(_twilioCallSid) || {}) : {};

    if (!phone) {
      return {
        success: false,
        error:   'phone is required',
        _ctx:    this._buildCtx(_twilioCallSid),
        message: 'I don\'t have a direct number for this contact. Let me arrange a callback instead.',
      };
    }

    // Store in session so /connect-salesperson route can read it
    if (_twilioCallSid) {
      callSession.merge(_twilioCallSid, {
        pendingSalespersonPhone:   phone,
        pendingSalespersonName:    name  || 'your contact',
        pendingSalespersonContext: context || null,
        salespersonCallResult:     null,   // clear any previous result
      });
      await dbService.updateCallMaster({
        twilio_call_sid: _twilioCallSid,
        routing_reason:  `Connecting to salesperson ${name || 'unknown'} (${phone})`,
      }).catch(() => {});
    }

    // For web/dashboard calls there is no Twilio SID to redirect
    if (!_twilioCallSid || session.webCall) {
      return {
        success: false,
        error:   'direct salesperson connection requires a live phone call',
        _ctx:    this._buildCtx(_twilioCallSid),
        message: 'I can arrange a callback from your contact for you. Shall I do that?',
      };
    }

    // Redirect call to Twilio route that dials the salesperson
    try {
      const { getTwilioClient } = require('../integrations/twilio');
      const client = getTwilioClient();
      await client.calls(_twilioCallSid).update({
        url:    `${config.BASE_URL}/api/twilio/connect-salesperson`,
        method: 'POST',
      });
      logger.info(`[connectToSalesperson] Call redirected to /connect-salesperson`, {
        callSid: _twilioCallSid, phone, name,
      });
    } catch (err) {
      logger.warn(`[connectToSalesperson] Twilio redirect failed: ${err.message}`, { callSid: _twilioCallSid });
      return {
        success: false,
        error:   'Failed to connect — please try again or arrange a callback',
        _ctx:    this._buildCtx(_twilioCallSid),
        message: `I wasn't able to connect you to ${name || 'your contact'} right now. Would you like me to arrange a callback instead?`,
      };
    }

    return {
      success:     true,
      connecting:  true,
      name:        name || 'your contact',
      _ctx:        this._buildCtx(_twilioCallSid),
      message:     `Connecting you to ${name || 'your contact'} now. Please hold.`,
    };
  }

  // ── Tool: getBookingDetails ───────────────────────────────────────────────

  async _getBookingDetails({ bookingRef, agentId, _twilioCallSid, _conversationMessages, _lastUserText }) {
    const session         = _twilioCallSid ? (callSession.get(_twilioCallSid) || {}) : {};
    const resolvedAgentId = agentId || session.agentId;

    // Server-side bookingRef resolution — GPT-4o frequently calls this with no
    // bookingRef even after verbally confirming the booking with the caller.
    // Recover QueryID by scoring session.agentBookings against recent conversation.
    let resolvedRef = bookingRef;
    if (!resolvedRef) {
      resolvedRef = session.activeBookingRef || null;
    }
    if (!resolvedRef && session.agentBookings?.length > 0) {
      // _lastUserText comes from message.messages in the Vapi payload.
      // For web/dashboard calls Vapi may not include message.messages at all,
      // so fall back to session.lastUserText which is reliably captured from
      // conversation-update events that fire on every turn.
      const effectiveLastUserText  = _lastUserText || session.lastUserText || '';
      const effectiveLastAssistant = session.lastAssistantText || '';
      logger.info(`  getBookingDetails: resolving — lastUserText="${effectiveLastUserText.substring(0, 60)}"  lastAI="${effectiveLastAssistant.substring(0, 60)}"  bookings=${session.agentBookings.length}`);
      resolvedRef = _resolveBookingRefFromConversation(
        session.agentBookings, _conversationMessages, effectiveLastUserText, effectiveLastAssistant
      );
      if (resolvedRef) {
        logger.info(`  getBookingDetails: server-resolved bookingRef=${resolvedRef}`);
      } else {
        logger.warn(`  getBookingDetails: resolver returned null — no clear winner  lastUserText="${effectiveLastUserText.substring(0, 80)}"`);
      }
    }

    if (!resolvedRef) {
      return {
        success: false,
        error: 'bookingRef is required — use the QueryID from the agentBookings list that matches what the caller described',
        _ctx: this._buildCtx(_twilioCallSid),
      };
    }

    // Fetch ALL booking data in ONE DB call — store everything in session so
    // _getPaymentDetails and _getGuestDetails can serve from cache, no extra DB hits.
    const data = await dbService.getFullBookingDetails(resolvedRef, resolvedAgentId);
    if (!data.summary) {
      return {
        success: false, error: 'Booking not found', _ctx: this._buildCtx(_twilioCallSid),
        message: `I couldn't find a booking with reference ${resolvedRef}. Could you double-check the details?`,
      };
    }

    const s = data.summary;

    // Construct payment URL BEFORE callSession.merge so the reference is valid
    const bookingTravIds = (data.travellers || []).map(t => t.TRAV_ID).filter(Boolean);
    const bookingPaymentUrl = bookingTravIds.length > 0
      ? `https://cultureholidays.com/thankyou?travid=${bookingTravIds.join(',')}`
      : (s.PaymentUrl || null);

    if (_twilioCallSid) {
      callSession.merge(_twilioCallSid, {
        activeBookingRef:  resolvedRef,
        activeBooking:     data.summary,
        activeBookingData: data,                         // { summary, travellers, payments }
        activePackgId:     data.summary.PackgID || null, // exposed in _ctx for getPackageItinerary
        paymentUrl:        bookingPaymentUrl,            // constructed from TRAV_IDs, exposed in _ctx
      });
    }

    const parts = [
      s.BookingStatus   ? `Status: ${s.BookingStatus}`                                              : null,
      s.PackageName     ? `Package: ${s.PackageName}`                                               : null,
      s.Country         ? `Destination: ${s.Country}`                                               : null,
      s.CheckinDate     ? `Check-in: ${s.CheckinDate}`                                              : null,
      s.CheckoutDate    ? `Check-out: ${s.CheckoutDate}`                                            : null,
      s.DaysUntilTour  != null ? `Days Until Tour: ${s.DaysUntilTour}`                             : null,
      s.DurationDays    ? `Duration: ${s.DurationDays} days / ${s.DurationNights || '?'} nights`   : null,
      s.NumGuests       ? `Guests: ${s.NumGuests}`                                                  : null,
      s.TotalAmount     ? `Total Amount: USD ${s.TotalAmount}`                                      : null,
      s.AmountPaid      ? `Amount Paid: USD ${s.AmountPaid}`                                        : null,
      s.BalanceDue      ? `Balance Due: USD ${s.BalanceDue}`                                        : null,
      s.LastPaymentDate ? `Payment Due By: ${s.LastPaymentDate}`                                    : null,
      s.TripType        ? `Trip Type: ${s.TripType}`                                                : null,
    ].filter(Boolean).join(', ');

    return {
      success: true, booking: s, _ctx: this._buildCtx(_twilioCallSid),
      message: `Here are the details for booking ${resolvedRef}: ${parts}.`,
    };
  }

  // ── Tool: getPaymentDetails ───────────────────────────────────────────────

  async _getPaymentDetails({ bookingRef, agentId, _twilioCallSid }) {
    const session         = _twilioCallSid ? (callSession.get(_twilioCallSid) || {}) : {};
    const resolvedRef     = bookingRef || session.activeBookingRef;
    const resolvedAgentId = agentId    || session.agentId;
    if (!resolvedRef) return { success: false, error: 'bookingRef is required', _ctx: this._buildCtx(_twilioCallSid) };

    // ── Serve from in-memory cache if _getBookingDetails already ran ──────────
    let data = (session.activeBookingData?.summary?.BookingRef === resolvedRef)
      ? session.activeBookingData
      : null;

    if (!data) {
      // Cache miss — fetch full data and store in session
      data = await dbService.getFullBookingDetails(resolvedRef, resolvedAgentId);
      if (_twilioCallSid && data.summary) {
        const cacheTravIds = (data.travellers || []).map(t => t.TRAV_ID).filter(Boolean);
        const cachePaymentUrl = cacheTravIds.length > 0
          ? `https://cultureholidays.com/thankyou?travid=${cacheTravIds.join(',')}`
          : (data.summary.PaymentUrl || null);
        callSession.merge(_twilioCallSid, {
          activeBookingRef:  resolvedRef,
          activeBooking:     data.summary,
          activeBookingData: data,
          activePackgId:     data.summary.PackgID || null,
          paymentUrl:        cachePaymentUrl,
        });
      }
    }

    if (!data.summary) {
      return {
        success: false, error: 'Payment details not found', _ctx: this._buildCtx(_twilioCallSid),
        message: `I couldn't find payment details for booking ${resolvedRef}. Please check the reference number.`,
      };
    }

    const s    = data.summary;
    const txns = data.payments || [];

    // Construct payment URL from traveller IDs (format: travid=id1,id2,id3)
    const travIds = (data.travellers || []).map(t => t.TRAV_ID).filter(Boolean);
    const paymentUrl = travIds.length > 0
      ? `https://cultureholidays.com/thankyou?travid=${travIds.join(',')}`
      : (s.PaymentUrl || null);

    // Inject constructed paymentUrl into summary so Flow C finds it at payment.summary.PaymentUrl
    const summaryWithUrl = { ...s, PaymentUrl: paymentUrl };

    // Store in session so Communication assistant can read it from _ctx.paymentUrl
    if (_twilioCallSid && paymentUrl) {
      callSession.merge(_twilioCallSid, { paymentUrl });
    }

    // Transaction history for AI (exclude commission — not in txn rows anyway)
    const txnLines = txns.map(t => {
      const date = t.CreatedDate ? new Date(t.CreatedDate).toDateString() : 'unknown date';
      const mode = t.PayMode || t.bank || 'N/A';
      return `${t.TxnStatus} USD ${t.Amount} on ${date} via ${mode}`;
    });

    const payParts = [
      s.TotalAmount      ? `Total: USD ${s.TotalAmount}`           : null,
      s.AmountPaid       ? `Paid: USD ${s.AmountPaid}`             : null,
      s.BalanceDue       ? `Balance Due: USD ${s.BalanceDue}`      : null,
      s.LastPaymentDate  ? `Due By: ${s.LastPaymentDate}`          : null,
      paymentUrl         ? `Payment link available`                : null,
    ].filter(Boolean).join(', ');

    return {
      success: true,
      payment: { summary: summaryWithUrl, transactions: txns },
      _ctx: this._buildCtx(_twilioCallSid),
      message: `Payment details for booking ${resolvedRef}: ${payParts || 'No payment data available'}.`
        + (txnLines.length ? ` Transaction history: ${txnLines.join('; ')}.` : ''),
    };
  }

  // ── Tool: getGuestDetails ─────────────────────────────────────────────────

  async _getGuestDetails({ bookingRef, _twilioCallSid }) {
    const session     = _twilioCallSid ? (callSession.get(_twilioCallSid) || {}) : {};
    const resolvedRef = bookingRef || session.activeBookingRef;
    if (!resolvedRef) return { success: false, error: 'bookingRef is required', _ctx: this._buildCtx(_twilioCallSid) };

    // ── Serve from in-memory cache if _getBookingDetails already ran ──────────
    let data = (session.activeBookingData?.summary?.BookingRef === resolvedRef)
      ? session.activeBookingData
      : null;

    if (!data) {
      data = await dbService.getFullBookingDetails(resolvedRef, session.agentId);
      if (_twilioCallSid && data.summary) {
        callSession.merge(_twilioCallSid, {
          activeBookingRef:  resolvedRef,
          activeBooking:     data.summary,
          activeBookingData: data,
        });
      }
    }

    const travellers = data?.travellers || [];
    if (travellers.length === 0) {
      return {
        success: false, error: 'No guest details found', _ctx: this._buildCtx(_twilioCallSid),
        message: `I couldn't find guest details for booking ${resolvedRef}.`,
      };
    }

    const summary = travellers.map((g, i) => {
      const due  = Number(g.TotalDueAmount  || 0).toFixed(0);
      const paid = Number(g.PaxDepositAmount || 0).toFixed(0);
      const total = Number(g.TotalPaxCost   || 0).toFixed(0);
      const cancel = g.CancellationRequested ? ' [Cancellation Requested]' : '';
      return `${i + 1}. ${g.FullName} (${g.TRAVELLER_TYPE || 'Adult'}): Total USD ${total}, Deposit Paid USD ${paid}, Due USD ${due}${cancel}`;
    }).join('\n');

    return {
      success: true, guests: travellers, count: travellers.length,
      _ctx: this._buildCtx(_twilioCallSid),
      message: `Guest details for booking ${resolvedRef} — ${travellers.length} traveller(s):\n${summary}`,
    };
  }

  // ── Tool: saveAdjustmentRequest ───────────────────────────────────────────

  async _saveAdjustmentRequest({ bookingRef, agentId, requestType, details, _twilioCallSid }) {
    if (!bookingRef)   return { success: false, error: 'bookingRef is required', _ctx: this._buildCtx(_twilioCallSid) };
    if (!requestType)  return { success: false, error: 'requestType is required', _ctx: this._buildCtx(_twilioCallSid) };

    const session         = _twilioCallSid ? (callSession.get(_twilioCallSid) || {}) : {};
    const resolvedAgentId = agentId || session.agentId;

    await dbService.saveAdjustmentRequest({
      bookingRef, requestType, details: details || '',
      agentId: resolvedAgentId,
      callId:  session.callId || null,
    });

    // Write to TopicsJSON so the request is auditable during the call
    if (_twilioCallSid) {
      topicBuffer.push(_twilioCallSid, 'support', {
        ts: new Date().toISOString(), requestType, bookingRef,
        details: details || '', saved: true,
      });
    }

    return {
      success: true, saved: true, requestType, bookingRef,
      _ctx: this._buildCtx(_twilioCallSid),
      message: `I've noted your ${requestType} request for booking ${bookingRef}. Our team will reach out to you for final verification and confirmation.`,
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

  async _saveBookingEnquiry({ requirements, selectedPackages, selectedPkgIds, noPackageFound, customRequirements, additionalNotes, _twilioCallSid, _callerPhone, _conversationMessages }) {
    const session = _twilioCallSid ? (callSession.get(_twilioCallSid) || {}) : {};

    // Resolve packages: prefer full objects passed by LLM, fall back to pkgId lookup from session
    let resolvedPackages = [];
    if (Array.isArray(selectedPackages) && selectedPackages.length > 0) {
      resolvedPackages = selectedPackages.slice(0, 3);
    } else if (Array.isArray(selectedPkgIds) && selectedPkgIds.length > 0 && Array.isArray(session.lastPackages)) {
      // Coerce both sides to string so number/string mismatch from LLM never fails the lookup
      const ids = selectedPkgIds.map(String);
      // Preserve the ranked order the LLM specified
      resolvedPackages = ids
        .map(id => session.lastPackages.find(p => String(p.pkgId) === id))
        .filter(Boolean)
        .slice(0, 3);
    }

    let req = requirements || {};

    // When GPT-4o omits selectedPkgIds (and sometimes omits requirements entirely),
    // do server-side scoring rather than returning a failure that breaks the call.
    if (resolvedPackages.length === 0 && !noPackageFound && !customRequirements
        && Array.isArray(session.lastPackages) && session.lastPackages.length > 0) {

      // ── Extract requirements from conversation when model omitted them ──────
      if (!req.destination && !req.pax && !req.durationDays) {
        const extracted = _extractRequirementsFromConversation(_conversationMessages);
        req = { destination: session.destination || null, ...extracted, ...req };
        if (Object.keys(extracted).length > 0) {
          logger.info(`  saveBookingEnquiry: extracted requirements from conversation  ${JSON.stringify(extracted)}`);
        }
      }

      // ── Score all packages server-side and pick top 3 ─────────────────────
      const ranked = _scorePackages(session.lastPackages, req);
      resolvedPackages = ranked.slice(0, 3);
      logger.warn(`  saveBookingEnquiry: pkgIds omitted — server-side scored top 3: ${resolvedPackages.map(p => p.pkgId).join(', ')}  sessionKey=${_twilioCallSid?.substring(0, 20)}`);
    }

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

    const sess3 = _twilioCallSid ? (callSession.get(_twilioCallSid) || {}) : {};
    const isKnownCaller = ['agent_verified', 'existing_customer'].includes(sess3.callerType);
    const sendChannel = isKnownCaller ? 'email or phone number for SMS' : 'phone number for SMS';

    // ── Build match-aware intro so AI tells the caller honestly what was found ──
    const exactCount  = resolvedPackages.filter(p => p.matchType === 'exact').length;
    const similarCount = resolvedPackages.filter(p => p.matchType === 'similar').length;
    const requestedDays = req.durationDays ? `${req.durationDays}-day` : null;

    let matchIntro;
    if (exactCount === 3) {
      matchIntro = `Great news! I found 3 packages that exactly match your ${requestedDays || ''} requirement.`;
    } else if (exactCount >= 1) {
      matchIntro = `I found ${exactCount} exact match${exactCount > 1 ? 'es' : ''} for your ${requestedDays || ''} trip, plus ${3 - exactCount} very similar option${3 - exactCount > 1 ? 's' : ''}.`;
    } else if (similarCount >= 2) {
      matchIntro = `We don't have a package that's exactly ${requestedDays || 'that duration'} right now, but I have 3 very similar options — all within a day or two of what you're looking for.`;
    } else {
      matchIntro = `We don't have an exact match for your requirements right now, but here are our 3 best recommendations for ${req.destination || 'your destination'} that I think you'll love.`;
    }

    const rankedList = resolvedPackages
      .map(p => `${p.rank}. "${p.title}" — ${p.durationDays} days  [${p.matchType || 'recommendation'}]`)
      .join('\n');

    return {
      success:          true,
      enquirySaved:     true,
      packagesSelected: resolvedPackages.length,
      packages:         resolvedPackages.map(p => ({ pkgId: p.pkgId, title: p.title, durationDays: p.durationDays, matchType: p.matchType, rank: p.rank })),
      matchIntro,
      _ctx: this._buildCtx(_twilioCallSid),
      message: `Enquiry saved. Present EXACTLY these 3 packages — do not substitute:\n\n${rankedList}\n\nSpeak this script word for word:\n1. "${matchIntro}"\n2. "First option: [name1], [N] days. Second option: [name2], [N] days. Third option: [name3], [N] days."\n3. ${exactCount === 0 ? '"If none of these feel quite right, I can also arrange a callback from one of our destination experts who can build a custom itinerary for you."\n4. ' : ''}"Would you like me to explain any of these packages in detail, or shall I send the full itinerary to your phone via SMS?"\n\nIf caller wants one explained → ask "Which one — first, second, or third?" → call getPackageItinerary with that package's pkgId.\nIf caller wants details sent → ask for their ${sendChannel} → call sendPackageDetails.\nIf caller wants a callback → call scheduleCallback.\nDo NOT call sendPackageDetails before the caller confirms.`,
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
    // Server-side fallbacks — model frequently omits all params even though they're in _ctx.
    // The URL is constructed at getBookingDetails/getPaymentDetails time and stored in session.
    const session        = _twilioCallSid ? callSession.get(_twilioCallSid) : {};
    const resolvedUrl    = paymentUrl    || session.paymentUrl                || null;
    const resolvedAmount = amount        || session.activeBooking?.BalanceDue || null;
    const resolvedEmail  = email         || session.email                     || null;
    const resolvedPhone  = phone         || _callerPhone                      || session.phone || null;
    const resolvedName   = customerName  || session.name                      || null;

    if (!resolvedUrl) {
      return { success: false, error: 'paymentUrl is required — call getBookingDetails or getPaymentDetails first', _ctx: this._buildCtx(_twilioCallSid) };
    }

    const callId   = session.callId || null;
    const channels = [], errors = [];

    if (resolvedEmail) {
      try {
        await emailService.sendPaymentLinkEmail({ to: resolvedEmail, customerName: resolvedName, paymentUrl: resolvedUrl, amount: resolvedAmount });
        await dbService.insertCommunicationLog({ call_id: callId, channel: 'email', recipient_email: resolvedEmail, subject: 'Payment Link', body: resolvedUrl, status: 'sent' });
        channels.push('email');
      } catch (err) { errors.push(`Email: ${err.message}`); }
    }

    if (resolvedPhone) {
      try {
        const msg = await smsService.sendPaymentLinkSMS({ to: resolvedPhone, customerName: resolvedName, paymentUrl: resolvedUrl, amount: resolvedAmount });
        await dbService.insertCommunicationLog({ call_id: callId, channel: 'sms', recipient_phone: resolvedPhone, twilio_msg_sid: msg.sid, body: 'Payment link SMS', status: 'sent' });
        channels.push('SMS');
      } catch (err) { errors.push(`SMS: ${err.message}`); }
    }

    if (channels.length === 0 && errors.length === 0) {
      return { success: false, error: 'No email or phone available to send payment link. Ask the caller for their contact details.', _ctx: this._buildCtx(_twilioCallSid) };
    }

    const sent = channels.length > 0;
    return {
      success: sent, channelsSent: channels,
      _ctx: this._buildCtx(_twilioCallSid),
      message: sent
        ? `Payment link${resolvedAmount ? ' for USD ' + resolvedAmount : ''} sent to your ${channels.join(' and ')}. Please complete the payment at your earliest convenience.`
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
