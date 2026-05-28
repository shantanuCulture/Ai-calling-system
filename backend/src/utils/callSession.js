'use strict';

/**
 * callSession.js
 * In-memory call state keyed by TwilioCallSID.
 * Created in the Twilio inbound webhook, destroyed on call end.
 *
 * Session shape:
 * {
 *   callId,        // ai_call_system_call_master CallID (BIGINT)
 *   phone,         // caller E.164 phone
 *   vapiCallId,    // Vapi call UUID
 *   callerType,    // 'agent_verified' | 'new_customer' | 'unverified' | 'unknown'
 *   agentId,       // if known
 *   name,          // caller name
 *   email,         // caller email
 *   isVerified,    // boolean
 *   destination,   // last destination mentioned
 *   pax,           // number of travellers
 *   budget,        // budget string
 *   // verification flow scratch
 *   pendingAgentId,
 *   pendingAgentPhone,
 *   pendingAgentEmail,
 * }
 */

const sessions = new Map();

const set   = (sid, data)  => sessions.set(sid, { ...data });
const get   = (sid)        => sessions.get(sid) || {};
const merge = (sid, patch) => sessions.set(sid, { ...get(sid), ...patch });
const remove = (sid)       => sessions.delete(sid);
const has   = (sid)        => sessions.has(sid);

// Returns the SID of an existing session whose phone matches, or null.
// Used to link the Vapi SIP dial-leg SID back to the parent PSTN session.
const findSidByPhone = (phone) => {
  if (!phone) return null;
  for (const [sid, data] of sessions) {
    if (data.phone === phone) return sid;
  }
  return null;
};

module.exports = { set, get, merge, remove, has, findSidByPhone };
