const { getPool, sql } = require('../database/connection');
const logger = require('../utils/logger');

class DbService {

  // ── Agent (existing tbl_agent table) ──────────────────────────────────────

  async getAgentByPhone(phone) {
    const pool = await getPool();
    const r = await pool.request()
      .input('phone', sql.VarChar(30), phone)
      .query(`SELECT TOP 1 EmailID, Contact, AgentID FROM tbl_agent WHERE Contact = @phone`);
    return r.recordset[0] || null;
  }

  async getAgentById(agentId) {
    const pool = await getPool();
    const r = await pool.request()
      .input('AgentId', sql.VarChar(50), agentId)
      .query(`SELECT TOP 1 EmailID, Contact, AgentID FROM tbl_agent WHERE AgentID = @AgentId`);
    return r.recordset[0] || null;
  }

  async getAgentByEmail(email) {
    const pool = await getPool();
    const r = await pool.request()
      .input('email', sql.VarChar(150), email)
      .query(`SELECT TOP 1 EmailID, Contact, AgentID FROM tbl_agent WHERE EmailID = @email`);
    return r.recordset[0] || null;
  }

  async getAgentBookings(agentId) {
    const pool = await getPool();
    const r = await pool.request()
      .input('AgentId', sql.VarChar(50), agentId)
      .execute('USP_GetAgentBookings_Ai_call_system');
    return r.recordset;
  }

  // ── Countries ──────────────────────────────────────────────────────────────

  async getCountryList(agentId = '') {
    const pool = await getPool();
    const r = await pool.request()
      .input('agentid', sql.VarChar(150), agentId)
      .execute('GetAllCountryList_Ai_call_system');
    return r.recordset;
  }

  // ── Packages ───────────────────────────────────────────────────────────────

  async getPackagesByCountry(countryCode, agentId = null) {
    const pool = await getPool();
    const r = await pool.request()
      .input('CountryCode', sql.NVarChar(50), countryCode)
      .input('AgentId', sql.NVarChar(50), agentId || '')
      .execute('USP_GetCountryPackagesWithTourDates_Ai_call_system');

    const map = new Map();
    for (const row of r.recordset) {
      if (!map.has(row.PKG_ID)) {
        map.set(row.PKG_ID, {
          pkgId: row.PKG_ID,
          title: row.PKG_TITLE,
          durationDays: row.PKG_NOOFDAY,
          agentId: row.AGENTID || null,
          availableDates: [],
        });
      }
      map.get(row.PKG_ID).availableDates.push({
        date: row.RATE_AVIAL_DATE,
        pdfUrl: row.pdfurl,
        bookingLink: row.link,
      });
    }
    return Array.from(map.values());
  }

  async getPackageItinerary(pkgId) {
    const pool = await getPool();
    const r = await pool.request()
      .input('PkgId', sql.Int, parseInt(pkgId, 10))
      .execute('USP_GetPackageItinerary_Ai_call_system');
    return r.recordset;
  }

  // ── Caller Registry (ai_call_system_caller_registry) ──────────────────────

  async getCallerByPhone(phone) {
    try {
      const pool = await getPool();
      const r = await pool.request()
        .input('phone', sql.VarChar(20), phone)
        .execute('sp_GetCallerByPhone_Ai_call_system');
      return r.recordset[0] || null;
    } catch (err) {
      logger.error('getCallerByPhone failed', { err: err.message });
      return null;
    }
  }

  async insertCallerRegistry({ phone, agent_id, caller_name, caller_email, customer_type, is_verified, verify_method }) {
    try {
      const pool = await getPool();
      const r = await pool.request()
        .input('phone',         sql.VarChar(20),  phone)
        .input('agent_id',      sql.VarChar(50),  agent_id     || null)
        .input('caller_name',   sql.VarChar(100), caller_name  || null)
        .input('caller_email',  sql.VarChar(150), caller_email || null)
        .input('customer_type', sql.VarChar(20),  customer_type || 'unknown')
        .input('is_verified',   sql.Bit,          is_verified  ?? 0)
        .input('verify_method', sql.VarChar(20),  verify_method || null)
        .execute('sp_InsertCallerRegistry_Ai_call_system');
      return r.recordset[0];
    } catch (err) {
      logger.error('insertCallerRegistry failed', { err: err.message });
      return null;
    }
  }

  async updateCallerRegistry({ phone, agent_id, caller_name, caller_email, customer_type, is_verified, verify_method, verified_at, notes }) {
    try {
      const pool = await getPool();
      const r = await pool.request()
        .input('phone',         sql.VarChar(20),  phone)
        .input('agent_id',      sql.VarChar(50),  agent_id      || null)
        .input('caller_name',   sql.VarChar(100), caller_name   || null)
        .input('caller_email',  sql.VarChar(150), caller_email  || null)
        .input('customer_type', sql.VarChar(20),  customer_type || null)
        .input('is_verified',   sql.Bit,          is_verified   ?? null)
        .input('verify_method', sql.VarChar(20),  verify_method || null)
        .input('verified_at',   sql.DateTime,     verified_at   || null)
        .input('notes',         sql.VarChar(500), notes         || null)
        .execute('sp_UpdateCallerRegistry_Ai_call_system');
      return r.recordset[0];
    } catch (err) {
      logger.error('updateCallerRegistry failed', { err: err.message });
      return null;
    }
  }

  // ── Call Master (ai_call_system_call_master) ───────────────────────────────

  async insertCallMaster({ twilio_call_sid, caller_phone, called_phone, direction, vapi_call_id }) {
    try {
      const pool = await getPool();
      const r = await pool.request()
        .input('twilio_call_sid', sql.VarChar(50),  twilio_call_sid)
        .input('caller_phone',    sql.VarChar(20),  caller_phone)
        .input('called_phone',    sql.VarChar(20),  called_phone)
        .input('direction',       sql.VarChar(10),  direction    || 'inbound')
        .input('vapi_call_id',    sql.VarChar(100), vapi_call_id || null)
        .execute('sp_InsertCallMaster_Ai_call_system');
      return r.recordset[0]; // { CallID }
    } catch (err) {
      logger.error('insertCallMaster failed', { err: err.message });
      return null;
    }
  }

  async updateCallMaster({ twilio_call_sid, caller_status, agent_id, caller_name, caller_email, call_status, vapi_call_id, routed_to, routing_reason, is_resolved, recording_sid, recording_url }) {
    try {
      const pool = await getPool();
      const r = await pool.request()
        .input('twilio_call_sid', sql.VarChar(50),   twilio_call_sid)
        .input('caller_status',   sql.VarChar(25),   caller_status   || null)
        .input('agent_id',        sql.VarChar(50),   agent_id        || null)
        .input('caller_name',     sql.VarChar(100),  caller_name     || null)
        .input('caller_email',    sql.VarChar(150),  caller_email    || null)
        .input('call_status',     sql.VarChar(20),   call_status     || null)
        .input('vapi_call_id',    sql.VarChar(100),  vapi_call_id    || null)
        .input('routed_to',       sql.VarChar(50),   routed_to       || null)
        .input('routing_reason',  sql.NVarChar(300), routing_reason  || null)
        .input('is_resolved',     sql.Bit,           is_resolved     ?? null)
        .input('recording_sid',   sql.VarChar(50),   recording_sid   || null)
        .input('recording_url',   sql.VarChar(500),  recording_url   || null)
        .execute('sp_UpdateCallMaster_Ai_call_system');
      return r.recordset[0];
    } catch (err) {
      logger.error('updateCallMaster failed', { err: err.message });
      return null;
    }
  }

  async updateCallTopic({ twilio_call_sid, topic_name, topic_entry }) {
    try {
      const pool = await getPool();
      const entry = typeof topic_entry === 'string' ? topic_entry : JSON.stringify(topic_entry);
      const r = await pool.request()
        .input('twilio_call_sid', sql.VarChar(50),   twilio_call_sid)
        .input('topic_name',      sql.VarChar(50),   topic_name)
        .input('topic_entry',     sql.NVarChar(sql.MAX), entry)
        .execute('sp_UpdateCallTopic_Ai_call_system');
      return r.recordset[0];
    } catch (err) {
      logger.error('updateCallTopic failed', { err: err.message });
      return null;
    }
  }

  async closeCallMaster({ twilio_call_sid, duration_secs, recording_sid, recording_url, call_summary, call_status, is_resolved }) {
    try {
      const pool = await getPool();
      const r = await pool.request()
        .input('twilio_call_sid', sql.VarChar(50),   twilio_call_sid)
        .input('duration_secs',   sql.Int,           duration_secs  || null)
        .input('recording_sid',   sql.VarChar(50),   recording_sid  || null)
        .input('recording_url',   sql.VarChar(500),  recording_url  || null)
        .input('call_summary',    sql.NVarChar(sql.MAX), call_summary || null)
        .input('call_status',     sql.VarChar(20),   call_status    || null)
        .input('is_resolved',     sql.Bit,           is_resolved    ?? null)
        .execute('sp_CloseCallMaster_Ai_call_system');
      return r.recordset[0];
    } catch (err) {
      logger.error('closeCallMaster failed', { err: err.message });
      return null;
    }
  }

  async getCallByTwilioSID(twilio_call_sid) {
    try {
      const pool = await getPool();
      const r = await pool.request()
        .input('twilio_call_sid', sql.VarChar(50), twilio_call_sid)
        .execute('sp_GetCallByTwilioSID_Ai_call_system');
      return r.recordset[0] || null;
    } catch (err) {
      logger.error('getCallByTwilioSID failed', { err: err.message });
      return null;
    }
  }

  // ── Communication Logs (ai_call_system_comm_logs) ─────────────────────────

  async insertCommunicationLog({ call_id, channel, recipient_phone, recipient_email, subject, body, twilio_msg_sid, status }) {
    try {
      const pool = await getPool();
      const r = await pool.request()
        .input('call_id',          sql.BigInt,           call_id          || null)
        .input('channel',          sql.VarChar(20),      channel)
        .input('recipient_phone',  sql.VarChar(20),      recipient_phone  || null)
        .input('recipient_email',  sql.VarChar(200),     recipient_email  || null)
        .input('subject',          sql.NVarChar(300),    subject          || null)
        .input('body',             sql.NVarChar(sql.MAX), body            || null)
        .input('twilio_msg_sid',   sql.VarChar(50),      twilio_msg_sid   || null)
        .input('status',           sql.VarChar(20),      status           || 'sent')
        .execute('sp_InsertCommLog_Ai_call_system');
      return r.recordset[0];
    } catch (err) {
      logger.error('insertCommunicationLog failed', { err: err.message });
      return null;
    }
  }

  // ── Callbacks (ai_call_system_callback_queue) ──────────────────────────────

  async scheduleCallback({ phone, call_id, reason, department, priority }) {
    try {
      const pool = await getPool();
      const r = await pool.request()
        .input('phone',      sql.VarChar(20),   phone)
        .input('call_id',    sql.BigInt,        call_id    || null)
        .input('reason',     sql.NVarChar(500), reason     || null)
        .input('department', sql.VarChar(20),   department || 'sales')
        .input('priority',   sql.Int,           priority   || 1)
        .execute('sp_InsertCallback_Ai_call_system');
      return r.recordset[0];
    } catch (err) {
      logger.error('scheduleCallback failed', { err: err.message });
      return null;
    }
  }

  async getPendingCallbacks() {
    const pool = await getPool();
    const r = await pool.request().execute('sp_GetPendingCallbacks_Ai_call_system');
    return r.recordset;
  }

  async updateCallbackStatus(queue_id, status, notes) {
    try {
      const pool = await getPool();
      await pool.request()
        .input('queue_id', sql.BigInt,     queue_id)
        .input('status',   sql.VarChar(20), status)
        .input('notes',    sql.NVarChar(300), notes || null)
        .execute('sp_UpdateCallbackStatus_Ai_call_system');
    } catch (err) {
      logger.error('updateCallbackStatus failed', { err: err.message });
    }
  }
}

module.exports = new DbService();
