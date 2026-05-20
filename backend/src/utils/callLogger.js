'use strict';

const fs     = require('fs').promises;
const path   = require('path');
const logger = require('./logger');

const LOG_DIR = path.join(__dirname, '../../logs/calls');

// Fields injected by the server — strip from logged params so they don't bloat the file.
const INTERNAL_PARAMS = new Set(['_twilioCallSid', '_vapiCallId', '_callerPhone', '_lastUserText', '_conversationMessages']);

class CallLogger {
  constructor() {
    this._store = new Map(); // callSid → call log object
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  start(callSid, { phone, direction, callId }) {
    if (this._store.has(callSid)) return; // Twilio may retry the webhook
    this._store.set(callSid, {
      callSid,
      startedAt:    new Date().toISOString(),
      caller:       { phone, direction, callId },
      events:       [],
      finalSession: null,
      callSummary:  null,
      endedAt:      null,
    });
  }

  has(callSid) {
    return this._store.has(callSid);
  }

  // ── Event writers ───────────────────────────────────────────────────────────

  toolCall(callSid, toolName, params) {
    this._push(callSid, {
      ts:     new Date().toISOString(),
      type:   'tool_call',
      tool:   toolName,
      params: this._clean(params),
    });
  }

  toolResponse(callSid, toolName, result, durationMs) {
    this._push(callSid, {
      ts:         new Date().toISOString(),
      type:       'tool_response',
      tool:       toolName,
      durationMs,
      success:    result?.success,
      result:     this._clean(result),
    });
  }

  sessionSnap(callSid, session) {
    if (!session) return;
    // Omit large arrays from snapshot to keep files readable.
    const { lastPackages, filteredPackages, ...rest } = session;
    const snap = {
      ...rest,
      lastPackagesCount:     Array.isArray(lastPackages)     ? lastPackages.length     : 0,
      filteredPackagesCount: Array.isArray(filteredPackages) ? filteredPackages.length : 0,
    };
    this._push(callSid, {
      ts:       new Date().toISOString(),
      type:     'session',
      snapshot: snap,
    });
  }

  callEvent(callSid, event, data) {
    this._push(callSid, { ts: new Date().toISOString(), type: event, ...(data || {}) });
  }

  // ── Flush to disk ───────────────────────────────────────────────────────────

  async flush(callSid, { session, summary } = {}) {
    const log = this._store.get(callSid);
    if (!log) return;

    log.endedAt     = new Date().toISOString();
    log.callSummary = summary || null;

    if (session) {
      const { lastPackages, filteredPackages, ...rest } = session;
      log.finalSession = {
        ...rest,
        lastPackagesCount:     Array.isArray(lastPackages)     ? lastPackages.length     : 0,
        filteredPackagesCount: Array.isArray(filteredPackages) ? filteredPackages.length : 0,
        filteredPackages:      Array.isArray(filteredPackages) ? filteredPackages.map(p => ({ pkgId: p.pkgId, title: p.title })) : [],
      };
    }

    try {
      await fs.mkdir(LOG_DIR, { recursive: true });
      const date     = log.startedAt.slice(0, 10);
      const filename = `${date}_${callSid}.json`;
      await fs.writeFile(
        path.join(LOG_DIR, filename),
        JSON.stringify(log, null, 2),
        'utf8',
      );
      logger.info(`callLogger: saved  ${filename}  (${log.events.length} events)`);
    } catch (err) {
      logger.error('callLogger: flush failed', { err: err.message, callSid });
    }

    // Keep the entry in memory so end-of-call-report can append its summary
    // event and re-save without overwriting this complete log with a 1-event file.
    // The Map is cleared on process restart (nodemon handles this in dev).
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  _push(callSid, entry) {
    const log = this._store.get(callSid);
    if (log) log.events.push(entry);
  }

  _clean(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
    return Object.fromEntries(
      Object.entries(obj).filter(([k]) => !INTERNAL_PARAMS.has(k))
    );
  }
}

module.exports = new CallLogger();
