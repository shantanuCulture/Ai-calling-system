'use strict';

/**
 * businessHours.js
 *
 * Checks whether a given team is currently available to take calls.
 * Also loads active support agents from DB for the human-support ring group.
 *
 * Teams:
 *   'support' — Customer Support: available 24×7 (holidays still apply)
 *   'sales'   — Sales team: Mon–Sat 09:00–18:00 IST (from team_schedules table)
 *
 * Data is cached for 5 minutes to avoid a DB hit on every tool call.
 * Call invalidateCache() after any admin update to support_holidays / team_schedules.
 */

const { getPool, sql } = require('../database/connection');
const logger = require('./logger');

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let _holidays      = null; let _holidaysAt      = 0;
let _schedules     = null; let _schedulesAt     = 0;
let _agents        = null; let _agentsAt        = 0;

// ── Cache loaders ─────────────────────────────────────────────────────────────

async function _loadHolidays() {
  const now = Date.now();
  if (_holidays && (now - _holidaysAt) < CACHE_TTL_MS) return _holidays;
  try {
    const pool = getPool();
    const r = await pool.request().query(`
      SELECT holiday_date, holiday_name, affected_teams, custom_message
      FROM   support_holidays
      WHERE  holiday_date >= CAST(GETDATE() AS DATE)
      ORDER  BY holiday_date
    `);
    _holidays   = r.recordset || [];
    _holidaysAt = now;
  } catch (err) {
    logger.error('businessHours: _loadHolidays failed', { err: err.message });
    _holidays = _holidays || []; // keep stale cache rather than failing
  }
  return _holidays;
}

async function _loadSchedules() {
  const now = Date.now();
  if (_schedules && (now - _schedulesAt) < CACHE_TTL_MS) return _schedules;
  try {
    const pool = getPool();
    const r = await pool.request().query(`
      SELECT team_type, day_of_week, start_time, end_time
      FROM   team_schedules
      WHERE  is_active = 1
    `);
    _schedules   = r.recordset || [];
    _schedulesAt = now;
  } catch (err) {
    logger.error('businessHours: _loadSchedules failed', { err: err.message });
    _schedules = _schedules || [];
  }
  return _schedules;
}

async function _loadAgents() {
  const now = Date.now();
  if (_agents && (now - _agentsAt) < CACHE_TTL_MS) return _agents;
  try {
    const pool = getPool();
    const r = await pool.request().query(`
      SELECT id, name, phone, team_type, priority
      FROM   support_agents
      WHERE  is_active = 1
      ORDER  BY team_type, priority ASC
    `);
    _agents   = r.recordset || [];
    _agentsAt = now;
  } catch (err) {
    logger.error('businessHours: _loadAgents failed', { err: err.message });
    _agents = _agents || [];
  }
  return _agents;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Normalise a SQL TIME value to "HH:MM" string */
function _toHHMM(raw) {
  if (!raw) return '00:00';
  const s = String(raw);           // might be "09:00:00.0000000" from SQL Server
  return s.substring(0, 5);        // take only "HH:MM"
}

/** Parse "HH:MM" → total minutes since midnight */
function _toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Return a human-readable description of next open time for a team */
function _nextOpenTime(schedules, teamType, fromIST) {
  const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const teamRows  = schedules.filter(s => s.team_type === teamType);
  if (!teamRows.length) return null;
  for (let d = 1; d <= 7; d++) {
    const next   = new Date(fromIST);
    next.setDate(next.getDate() + d);
    const dow    = next.getDay();
    const row    = teamRows.find(s => s.day_of_week === dow);
    if (row) {
      const hhmm = _toHHMM(row.start_time);
      return `${DAY_NAMES[dow]} at ${hhmm} IST`;
    }
  }
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check whether a team is currently available.
 *
 * @param {'support'|'sales'} teamType
 * @returns {Promise<{
 *   available: boolean,
 *   reason: 'holiday'|'closed_today'|'before_hours'|'after_hours'|null,
 *   holidayName?: string,
 *   message: string|null,
 *   nextOpenAt: string|null
 * }>}
 */
async function checkAvailability(teamType = 'support') {
  // ── Get current IST date/time ──────────────────────────────────────────────
  const nowUtc = new Date();
  // toLocaleString in the 'Asia/Kolkata' zone gives us IST wall-clock time
  const istStr = nowUtc.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
  const nowIST = new Date(istStr);

  const yyyy    = nowIST.getFullYear();
  const mm      = String(nowIST.getMonth() + 1).padStart(2, '0');
  const dd      = String(nowIST.getDate()).padStart(2, '0');
  const todayStr = `${yyyy}-${mm}-${dd}`;  // "2025-10-20"

  // ── Holiday check (applies to all teams) ──────────────────────────────────
  const holidays = await _loadHolidays();
  const todayHol = holidays.find(h => {
    const hDate  = (h.holiday_date instanceof Date)
      ? `${h.holiday_date.getFullYear()}-${String(h.holiday_date.getMonth()+1).padStart(2,'0')}-${String(h.holiday_date.getDate()).padStart(2,'0')}`
      : String(h.holiday_date).substring(0, 10);
    const teams  = String(h.affected_teams || 'all').split(',').map(t => t.trim().toLowerCase());
    return hDate === todayStr && (teams.includes('all') || teams.includes(teamType));
  });

  if (todayHol) {
    const defaultMsg = teamType === 'sales'
      ? `Due to the ${todayHol.holiday_name} festival, our sales team is currently unavailable. We'll be back tomorrow. Would you like me to arrange a callback?`
      : `Due to the ${todayHol.holiday_name} festival, our support team is currently unavailable. We'll be back tomorrow. Would you like me to arrange a callback?`;
    return {
      available:   false,
      reason:      'holiday',
      holidayName: todayHol.holiday_name,
      message:     todayHol.custom_message || defaultMsg,
      nextOpenAt:  null,
    };
  }

  // ── Support is 24×7 — no time check needed beyond holidays ────────────────
  if (teamType === 'support') {
    return { available: true, reason: null, message: null, nextOpenAt: null };
  }

  // ── Sales / other teams: check team_schedules ─────────────────────────────
  const schedules = await _loadSchedules();
  const dayOfWeek = nowIST.getDay();   // 0=Sun … 6=Sat
  const todaySched = schedules.find(s => s.team_type === teamType && s.day_of_week === dayOfWeek);

  if (!todaySched) {
    const nextOpen = _nextOpenTime(schedules, teamType, nowIST);
    return {
      available:  false,
      reason:     'closed_today',
      message:    `Our sales team is not available today. ${nextOpen ? `We're next available ${nextOpen}.` : ''} Would you like me to arrange a callback?`,
      nextOpenAt: nextOpen,
    };
  }

  const startMins   = _toMinutes(_toHHMM(todaySched.start_time));
  const endMins     = _toMinutes(_toHHMM(todaySched.end_time));
  const currentMins = nowIST.getHours() * 60 + nowIST.getMinutes();

  if (currentMins < startMins) {
    const startStr = _toHHMM(todaySched.start_time) + ' IST';
    return {
      available:  false,
      reason:     'before_hours',
      message:    `Our sales team is available from ${startStr} today. Would you like me to arrange a callback?`,
      nextOpenAt: startStr,
    };
  }

  if (currentMins >= endMins) {
    const nextOpen = _nextOpenTime(schedules, teamType, nowIST);
    return {
      available:  false,
      reason:     'after_hours',
      message:    `Our sales team's hours are 9 AM to 6 PM IST. ${nextOpen ? `We'll be back ${nextOpen}.` : ''} Would you like me to arrange a callback?`,
      nextOpenAt: nextOpen,
    };
  }

  return { available: true, reason: null, message: null, nextOpenAt: null };
}

/**
 * Returns active agents for a given team, ordered by priority (lowest first).
 * @param {'support'|'sales'} teamType
 * @returns {Promise<Array<{id, name, phone, team_type, priority}>>}
 */
async function getActiveAgents(teamType) {
  const agents = await _loadAgents();
  return teamType ? agents.filter(a => a.team_type === teamType) : agents;
}

/**
 * Force-clear the in-memory cache (call after any admin update).
 */
function invalidateCache() {
  _holidays  = null; _holidaysAt  = 0;
  _schedules = null; _schedulesAt = 0;
  _agents    = null; _agentsAt    = 0;
  logger.info('businessHours: cache invalidated');
}

module.exports = { checkAvailability, getActiveAgents, invalidateCache };
