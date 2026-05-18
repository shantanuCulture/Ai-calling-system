'use strict';

/**
 * topicBuffer.js — write-behind buffer for updateCallTopic DB writes.
 *
 * Problem: during an active call, Vapi may call updateCallTopic 15-20 times.
 * Each call hit SQL Server immediately, putting unnecessary load on the DB
 * and causing lock contention on the TopicsJSON column.
 *
 * Solution: accumulate entries in memory per call. Flush to DB every
 * FLUSH_INTERVAL_MS. If the call ends before the timer fires, flush
 * immediately so no data is lost.
 *
 * Buffer shape per call:
 *   { entries: [{topic_name, topic_entry}], timer: Timeout }
 *
 * Flush triggers:
 *   1. Timer fires (every 30 seconds of an active call)
 *   2. flush(sid) called explicitly (call end, summary save)
 *
 * Guarantees:
 *   - Entries written in the order they were pushed (sequential await)
 *   - Concurrent flush() calls are idempotent — the second is a no-op
 *   - Node.js single-thread: push() is synchronous, no interleaving mid-drain
 *   - Timer unref()'d so it never prevents process shutdown
 */

const dbService = require('../services/dbService');
const logger    = require('./logger');

const FLUSH_INTERVAL_MS = 30_000; // 30 seconds

// Map<twilioCallSid, { entries: Array<{topic_name, topic_entry}>, timer: Timeout }>
const _buffers = new Map();

async function _doFlush(twilioCallSid) {
  const buf = _buffers.get(twilioCallSid);

  // Already flushed (concurrent flush race or empty buffer)
  if (!buf || buf.entries.length === 0) {
    _buffers.delete(twilioCallSid);
    return 0;
  }

  clearTimeout(buf.timer);

  // Drain atomically (synchronous splice before any await)
  const entries = buf.entries.splice(0);
  _buffers.delete(twilioCallSid);

  logger.info(`TopicBuffer: flushing ${entries.length} entries`, { callSid: twilioCallSid });

  // Write sequentially — preserves entry order and serialises DB writes
  let written = 0;
  for (const { topic_name, topic_entry } of entries) {
    try {
      await dbService.updateCallTopic({ twilio_call_sid: twilioCallSid, topic_name, topic_entry });
      written++;
    } catch (err) {
      // Log but continue — partial write is better than losing all remaining entries
      logger.error(`TopicBuffer: failed to write topic "${topic_name}"`, {
        callSid: twilioCallSid,
        err:     err.message,
      });
    }
  }

  logger.info(`TopicBuffer: ${written}/${entries.length} entries written`, { callSid: twilioCallSid });
  return written;
}

/**
 * Add a topic entry to the buffer.
 * Starts a 30-second flush timer the first time a call's buffer is created.
 * Subsequent pushes within that window just append — no timer reset.
 */
const push = (twilioCallSid, topic_name, topic_entry) => {
  if (!_buffers.has(twilioCallSid)) {
    const timer = setTimeout(() => _doFlush(twilioCallSid), FLUSH_INTERVAL_MS);
    timer.unref();
    _buffers.set(twilioCallSid, { entries: [], timer });
  }
  _buffers.get(twilioCallSid).entries.push({ topic_name, topic_entry });
};

/**
 * Flush immediately. Called on call end and before saving summary.
 * Safe to call multiple times — second call is always a no-op.
 */
const flush = (twilioCallSid) => _doFlush(twilioCallSid);

/** How many entries are currently buffered for a call. */
const pendingCount = (twilioCallSid) => _buffers.get(twilioCallSid)?.entries.length || 0;

module.exports = { push, flush, pendingCount };
