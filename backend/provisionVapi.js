'use strict';

/**
 * provisionVapi.js — Idempotent Vapi provisioning script.
 *
 * Reads vapi-config.js (single source of truth) and syncs your Vapi account:
 *   - 20 tools  → PATCH server URL if exists, POST if new
 *   - 6 assistants → PATCH if exists, POST if new (tool names resolved to IDs)
 *
 * Usage:
 *   node provisionVapi.js              # live run
 *   node provisionVapi.js --dry-run    # print what WOULD happen, no API calls
 *
 * Required env vars (read from .env):
 *   VAPI_API_KEY  — your Vapi private key
 *   BASE_URL      — public URL of this server, e.g. https://api.cultureholidays.com
 *
 * After this script completes:
 *   1. Copy the 6 assistant IDs printed at the end.
 *   2. Create a Squad in the Vapi dashboard and add all 6 assistants.
 *   3. Set VAPI_ASSISTANT_ID in .env to the Squad ID.
 */

require('dotenv').config();
const axios = require('axios');
const { TOOLS, ASSISTANTS, ASSISTANT_DEFAULTS } = require('./vapi-config');

// ── Config ────────────────────────────────────────────────────────────────────

const VAPI_API_KEY  = process.env.VAPI_API_KEY;
const BASE_URL      = process.env.BASE_URL || 'http://localhost:3001';
const VAPI_SQUAD_ID = process.env.VAPI_SQUAD_ID || null;
const DRY_RUN       = process.argv.includes('--dry-run');
const TOOL_WEBHOOK  = `${BASE_URL}/api/vapi/tool-call`;
const EVENT_WEBHOOK = `${BASE_URL}/api/vapi/events`;

if (!VAPI_API_KEY) {
  console.error('[ERROR] VAPI_API_KEY is not set in .env — aborting.');
  process.exit(1);
}

const api = axios.create({
  baseURL: 'https://api.vapi.ai',
  headers: {
    Authorization: `Bearer ${VAPI_API_KEY}`,
    'Content-Type': 'application/json',
  },
  timeout: 30_000,
});

const log   = (...args) => console.log('[INFO]', ...args);
const warn  = (...args) => console.warn('[WARN]', ...args);
const error = (...args) => console.error('[ERROR]', ...args);
const dryLog = (...args) => DRY_RUN && console.log('[DRY-RUN]', ...args);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Delay between every mutating API call to avoid Vapi rate limits
const CALL_DELAY_MS = 600;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Retry a function up to maxRetries times on HTTP 429, with exponential backoff */
async function withRetry(fn, label, maxRetries = 3) {
  let delay = 6000;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err.response?.status === 429 && attempt < maxRetries) {
        warn(`Rate limited on ${label} — waiting ${delay / 1000}s (attempt ${attempt}/${maxRetries})`);
        await sleep(delay);
        delay *= 2;
      } else {
        throw err;
      }
    }
  }
}

async function vapiList(path) {
  return withRetry(async () => {
    const res = await api.get(path);
    return Array.isArray(res.data) ? res.data : (res.data?.items || []);
  }, `GET ${path}`);
}

async function vapiPost(path, body) {
  if (DRY_RUN) { dryLog(`POST ${path}`, JSON.stringify(body, null, 2)); return { id: `dry-run-${Date.now()}` }; }
  await sleep(CALL_DELAY_MS);
  return withRetry(async () => {
    const res = await api.post(path, body);
    return res.data;
  }, `POST ${path}`);
}

async function vapiPatch(path, body) {
  if (DRY_RUN) { dryLog(`PATCH ${path}`, JSON.stringify(body, null, 2)); return body; }
  await sleep(CALL_DELAY_MS);
  return withRetry(async () => {
    const res = await api.patch(path, body);
    return res.data;
  }, `PATCH ${path}`);
}

/** Build the Vapi tool payload.
 *  POST requires `type`; PATCH rejects it ("property type should not exist"). */
function buildToolPayload(tool, { forPatch = false } = {}) {
  const payload = {
    function: {
      name:        tool.name,
      description: tool.description,
      parameters:  tool.parameters,
    },
    server: { url: TOOL_WEBHOOK },
  };
  if (!forPatch) payload.type = 'function';
  return payload;
}

/** Build the Vapi assistant payload from our config entry + resolved toolIds.
 *  transferDestinations: array of { assistantName, message, description }
 *  — added as an inline transferCall tool so the LLM can hand off in a Squad. */
function buildAssistantPayload(assistant, toolIds, transferDestinations = []) {
  const inlineTools = transferDestinations.length > 0
    ? [{ type: 'transferCall', destinations: transferDestinations.map(d => ({
        type:          'assistant',
        assistantName: d.assistantName,
        message:       d.message,
        description:   d.description,
      })) }]
    : [];

  const payload = {
    name:         assistant.name,
    firstMessage: assistant.firstMessage,
    transcriber:  assistant.transcriber ?? ASSISTANT_DEFAULTS.transcriber,
    server:       { url: EVENT_WEBHOOK },
    model: {
      ...ASSISTANT_DEFAULTS.model,
      messages: [{ role: 'system', content: assistant.systemPrompt }],
      toolIds,
      ...(inlineTools.length > 0 && { tools: inlineTools }),
    },
    voice:                 ASSISTANT_DEFAULTS.voice,
    maxDurationSeconds:    assistant.maxDurationSeconds    ?? ASSISTANT_DEFAULTS.maxDurationSeconds,
    silenceTimeoutSeconds: assistant.silenceTimeoutSeconds ?? ASSISTANT_DEFAULTS.silenceTimeoutSeconds,
    backgroundSound:       assistant.backgroundSound       ?? ASSISTANT_DEFAULTS.backgroundSound,
    endCallPhrases:        assistant.endCallPhrases        ?? ASSISTANT_DEFAULTS.endCallPhrases,
    responseDelaySeconds:  assistant.responseDelaySeconds  ?? ASSISTANT_DEFAULTS.responseDelaySeconds,
  };
  // firstMessageMode: when set to 'assistant-speaks-first-with-model-generated-message'
  // the model generates its first utterance (may include a tool call) and speaks it
  // immediately — no user input required to trigger the first AI response.
  // This eliminates the silence after firstMessage plays on call-start / squad transfer.
  if (assistant.firstMessageMode) {
    payload.firstMessageMode = assistant.firstMessageMode;
    // Model-generated first message — static firstMessage is unused
    delete payload.firstMessage;
  }
  return payload;
}

// ── Phase 1: Tools ────────────────────────────────────────────────────────────

async function provisionTools() {
  log('');
  log('=== PHASE 1: TOOLS ===');
  log(`Webhook URL: ${TOOL_WEBHOOK}`);

  // Fetch existing tools
  log('Fetching existing tools from Vapi...');
  const existing = await vapiList('/tool');
  const existingMap = new Map(); // name → { id, ... }
  for (const t of existing) {
    const name = t.function?.name || t.name;
    if (name) existingMap.set(name, t);
  }
  log(`Found ${existingMap.size} existing tools in Vapi.`);

  const nameToId = new Map(); // filled as we create/update
  const results  = { created: [], updated: [], failed: [] };

  for (const tool of TOOLS) {
    try {
      if (existingMap.has(tool.name)) {
        const existing = existingMap.get(tool.name);
        const payload = buildToolPayload(tool, { forPatch: true });
        log(`PATCH  tool "${tool.name}" (id: ${existing.id})`);
        await vapiPatch(`/tool/${existing.id}`, payload);
        nameToId.set(tool.name, existing.id);
        results.updated.push(tool.name);
      } else {
        const payload = buildToolPayload(tool);
        log(`POST   tool "${tool.name}" (new)`);
        const created = await vapiPost('/tool', payload);
        nameToId.set(tool.name, created.id);
        results.created.push(tool.name);
        log(`       -> created with id: ${created.id}`);
      }
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      error(`FAILED tool "${tool.name}": ${msg}`);
      results.failed.push({ name: tool.name, reason: msg });
      // Still try to map the ID if it existed before
      if (existingMap.has(tool.name)) {
        nameToId.set(tool.name, existingMap.get(tool.name).id);
      }
    }
  }

  log('');
  log(`Tools summary: ${results.created.length} created, ${results.updated.length} updated, ${results.failed.length} failed`);
  if (results.failed.length > 0) {
    warn('Failed tools:', results.failed.map(f => `${f.name} (${f.reason})`).join(', '));
  }

  return nameToId;
}

// ── Phase 2: Assistants ───────────────────────────────────────────────────────

async function provisionAssistants(toolNameToId) {
  log('');
  log('=== PHASE 2: ASSISTANTS ===');

  // Build a name → destinations map from SQUAD_WIRING for inline transferCall tools
  const wiringMap = new Map(SQUAD_WIRING.map(w => [w.assistantName, w.destinations]));

  // Fetch existing assistants
  log('Fetching existing assistants from Vapi...');
  const existing = await vapiList('/assistant');
  const existingMap = new Map(); // name → { id, ... }
  for (const a of existing) {
    if (a.name) existingMap.set(a.name, a);
  }
  log(`Found ${existingMap.size} existing assistants in Vapi.`);

  const assistantResults = [];
  const results = { created: [], updated: [], failed: [] };

  for (const assistant of ASSISTANTS) {
    try {
      // Resolve tool names → IDs; warn on any that are missing
      const toolIds = [];
      const missingTools = [];
      for (const toolName of (assistant.tools || [])) {
        if (toolNameToId.has(toolName)) {
          toolIds.push(toolNameToId.get(toolName));
        } else {
          missingTools.push(toolName);
        }
      }
      if (missingTools.length > 0) {
        warn(`Assistant "${assistant.name}" — unresolved tools: ${missingTools.join(', ')} (skipped in toolIds)`);
      }

      // Resolve transfer destinations for this assistant's inline transferCall tool
      const transferDestinations = wiringMap.get(assistant.name) || [];

      const payload = buildAssistantPayload(assistant, toolIds, transferDestinations);

      let resultId;
      if (existingMap.has(assistant.name)) {
        const existing = existingMap.get(assistant.name);
        log(`PATCH  assistant "${assistant.name}" (id: ${existing.id})`);
        await vapiPatch(`/assistant/${existing.id}`, payload);
        resultId = existing.id;
        results.updated.push(assistant.name);
      } else {
        log(`POST   assistant "${assistant.name}" (new)`);
        const created = await vapiPost('/assistant', payload);
        resultId = created.id;
        results.created.push(assistant.name);
        log(`       -> created with id: ${resultId}`);
      }

      assistantResults.push({ name: assistant.name, id: resultId });
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      error(`FAILED assistant "${assistant.name}": ${msg}`);
      results.failed.push({ name: assistant.name, reason: msg });
    }
  }

  log('');
  log(`Assistants summary: ${results.created.length} created, ${results.updated.length} updated, ${results.failed.length} failed`);
  if (results.failed.length > 0) {
    warn('Failed assistants:', results.failed.map(f => `${f.name} (${f.reason})`).join(', '));
  }

  return assistantResults;
}

// ── Phase 3: Squad wiring ─────────────────────────────────────────────────────
//
// Each entry defines which assistants a given assistant can hand off to, and
// the description that the LLM reads to decide WHEN to transfer.
// assistantName references are resolved to IDs at runtime.

const SQUAD_WIRING = [
  {
    assistantName: 'Receptionist',
    destinations: [
      {
        assistantName: 'Verification',
        message: '',
        description: 'Transfer when the caller says they are a registered agent and need to verify their identity, or when identifyCaller returns unknown and caller says they are an agent.',
      },
      {
        assistantName: 'New Booking',
        message: '',
        description: 'Transfer when caller wants to enquire about new tour packages, destinations, or wants to make a new booking.',
      },
      {
        assistantName: 'Existing Booking',
        message: '',
        description: 'Transfer when a verified agent asks about their existing bookings, current trips, or specific booking details.',
      },
      {
        assistantName: 'Sales Connect',
        message: '',
        description: 'Transfer when a verified agent wants to speak to their assigned salesperson or account manager, or mentions a query ID (CHAM-...) or wants to connect about a booking (CHOQ-...).',
      },
      {
        assistantName: 'Communication',
        message: '',
        description: 'Transfer when caller asks to receive package details, booking links, payment links, or any information via email or SMS.',
      },
      {
        assistantName: 'Human Support Router',
        message: '',
        description: 'Transfer when caller explicitly asks to speak to a human, manager, or real person.',
      },
    ],
  },
  {
    assistantName: 'Verification',
    destinations: [
      {
        // SECURITY RULE: OTP success ALWAYS goes to Receptionist, NEVER directly to Existing Booking.
        // Verification only registers the calling number; it does NOT grant booking access on the same call.
        // The caller must hang up and call back from their now-registered number to access bookings.
        assistantName: 'Receptionist',
        message: '',
        description: 'Transfer back to Receptionist after successful OTP verification, regardless of the original intent. The caller is now registered and can be routed correctly on this or a future call.',
      },
      {
        assistantName: 'Human Support Router',
        message: '',
        description: "Transfer when the agent's ID or email cannot be found in the system, or when OTP verification fails after maximum attempts.",
      },
    ],
  },
  {
    assistantName: 'New Booking',
    destinations: [
      {
        assistantName: 'Existing Booking',
        message: '',
        description: 'Transfer when the caller is a verified agent AND verbally confirms they want to switch to their existing bookings.',
      },
      {
        assistantName: 'Sales Connect',
        message: '',
        description: 'Transfer when caller mentions a CHAM-... query ID or wants to speak to their salesperson about an enquiry.',
      },
      {
        assistantName: 'Communication',
        message: '',
        description: 'Transfer when caller needs to receive package details, booking links, or payment links via email or SMS.',
      },
      {
        assistantName: 'Human Support Router',
        message: '',
        description: 'Transfer when caller asks for a human agent, or after 2 consecutive tool failures.',
      },
    ],
  },
  {
    assistantName: 'Existing Booking',
    destinations: [
      {
        assistantName: 'New Booking',
        message: '',
        description: 'Transfer when caller asks about a new booking, new tour enquiry, or wants to enquire about a new destination — even mid-conversation about an existing booking.',
      },
      {
        assistantName: 'Sales Connect',
        message: '',
        description: 'Transfer when caller wants to speak to their assigned salesperson or account manager, or mentions a CHAM-... or CHOQ-... reference and wants to connect with the person handling it.',
      },
      {
        assistantName: 'Payment',
        message: '',
        description: 'Transfer when the caller raises ANY payment-related query: failed payment, outstanding balance, guest payment, refund request, payment link needed, or any payment discrepancy.',
      },
      {
        assistantName: 'Communication',
        message: '',
        description: 'Transfer when caller needs to receive an itinerary PDF, booking confirmation, or other booking documents via email or SMS.',
      },
      {
        assistantName: 'Human Support Router',
        message: '',
        description: 'Transfer when caller is unverified, or for visa queries, complex hotel changes, or any issue that cannot be resolved after 2 attempts.',
      },
    ],
  },
  {
    assistantName: 'Communication',
    destinations: [
      {
        assistantName: 'Receptionist',
        message: '',
        description: 'Transfer back to Receptionist after all communications have been sent and caller has no further immediate requests.',
      },
    ],
  },
  {
    // Terminal node — no outbound transfers
    assistantName: 'Human Support Router',
    destinations: [],
  },
  {
    assistantName: 'Payment',
    destinations: [
      {
        assistantName: 'Existing Booking',
        message: '',
        description: 'Transfer back to Existing Booking when the caller wants to discuss non-payment booking issues such as itinerary changes, date changes, or general booking queries after payment issue is resolved.',
      },
      {
        assistantName: 'Human Support Router',
        message: '',
        description: 'Transfer when caller insists on speaking to a human agent immediately after their payment issue has been logged.',
      },
    ],
  },
  {
    assistantName: 'Sales Connect',
    destinations: [
      {
        assistantName: 'Human Support Router',
        message: '',
        description: 'Transfer when the salesperson cannot be found, caller is unverified, or caller wants to speak to the general support team after salesperson is unavailable.',
      },
      {
        assistantName: 'Existing Booking',
        message: '',
        description: 'Transfer when the caller also wants to discuss their existing booking details after the salesperson connection attempt.',
      },
    ],
  },
];

function provisionSquad(squadId, assistantResults) {
  log('');
  log('=== PHASE 3: SQUAD WIRING (applied via assistant transferCall tools) ===');
  log('Transfer destinations are embedded in each assistant\'s model tools.');
  log('');
  for (const { assistantName, destinations } of SQUAD_WIRING) {
    const id = assistantResults.find(a => a.name === assistantName)?.id || '(not found)';
    const destNames = destinations.map(d => d.assistantName).join(', ') || 'terminal';
    log(`  ${assistantName.padEnd(25)} → [${destNames}]`);
  }
  if (!squadId) {
    log('');
    warn('VAPI_SQUAD_ID not set — cannot confirm Squad exists.');
    warn('Set VAPI_SQUAD_ID in .env to enable future Squad PATCH operations.');
  }
}

function printFinalSummary(assistantResults, squadId) {
  log('');
  log('=================================================================');
  log('PROVISIONING COMPLETE');
  log('=================================================================');
  log('');
  log('Assistant IDs:');
  for (const { name, id } of assistantResults) {
    log(`  ${name.padEnd(25)} ${id}`);
  }
  log('');
  if (squadId) {
    log(`Squad ID: ${squadId}`);
    log('');
    log('Squad wiring: DONE (handoff conditions applied via API)');
    log('');
    log('REMAINING STEPS:');
    log('  1. Verify the wiring looks correct in the Vapi dashboard.');
    log(`  2. Set in .env:  VAPI_ASSISTANT_ID=${squadId}`);
    log('  3. Set in .env:  BASE_URL=<your public server URL>');
    log('  4. Restart the backend server.');
  } else {
    log('Squad wiring: SKIPPED (VAPI_SQUAD_ID not set)');
    log('');
    log('REMAINING STEPS:');
    log('  1. Open the Squad in the Vapi dashboard.');
    log('  2. Add VAPI_SQUAD_ID=<squad id from URL> to .env');
    log('  3. Re-run:  node provisionVapi.js');
    log('     (tools + assistants will be skipped as already up-to-date,');
    log('      only the squad wiring will be applied)');
    log('  4. Set in .env:  VAPI_ASSISTANT_ID=<Squad ID>');
    log('  5. Set in .env:  BASE_URL=<your public server URL>');
    log('  6. Restart the backend server.');
  }
  log('');
  log('=================================================================');
}

// ── Phase 4: Create or Update Squad ──────────────────────────────────────────

// Canonical member order — Receptionist is always first (default entry point).
// This list is the single source of truth for squad membership.
// Add new assistants here whenever a new assistant is added to ASSISTANTS in vapi-config.js.
const SQUAD_MEMBER_ORDER = [
  'Receptionist',
  'Verification',
  'New Booking',
  'Existing Booking',
  'Communication',
  'Human Support Router',
  'Payment',
  'Sales Connect',
];

async function upsertSquad(existingSquadId, assistantResults) {
  log('');
  log('=== PHASE 4: SQUAD UPSERT ===');

  const members = SQUAD_MEMBER_ORDER.map(name => {
    const found = assistantResults.find(a => a.name === name);
    if (!found) { warn(`Assistant "${name}" not found in provisioned list — skipping from squad`); return null; }
    return { assistantId: found.id };
  }).filter(Boolean);

  const payload = { name: 'Culture Holidays AI', members };

  if (DRY_RUN) {
    dryLog(existingSquadId ? `PATCH /squad/${existingSquadId}` : 'POST /squad', JSON.stringify(payload, null, 2));
    return existingSquadId || 'dry-run-squad-id';
  }

  await sleep(CALL_DELAY_MS);

  if (existingSquadId) {
    // Always PATCH so new assistants are added and old ones are removed
    log(`PATCH squad (id: ${existingSquadId}) — ${members.length} members: ${SQUAD_MEMBER_ORDER.join(', ')}`);
    await withRetry(async () => {
      await api.patch(`/squad/${existingSquadId}`, payload);
    }, `PATCH /squad/${existingSquadId}`);
    log(`Squad updated.`);
    return existingSquadId;
  } else {
    log(`Creating new squad with ${members.length} members...`);
    const res = await withRetry(async () => {
      const r = await api.post('/squad', payload);
      return r.data;
    }, 'POST /squad');
    log(`Squad created! ID: ${res.id}`);
    return res.id;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (DRY_RUN) {
    log('DRY-RUN MODE — no API calls will be made.');
    log(`Would use webhook: ${TOOL_WEBHOOK}`);
  }

  let squadId = VAPI_SQUAD_ID;
  log(`Provisioning ${TOOLS.length} tools and ${ASSISTANTS.length} assistants to Vapi...`);
  log(`Server webhook URL: ${TOOL_WEBHOOK}`);
  if (squadId) log(`Squad ID: ${squadId}`);

  try {
    const toolNameToId     = await provisionTools();
    const assistantResults = await provisionAssistants(toolNameToId);

    // Always upsert the squad — creates it if VAPI_SQUAD_ID is not set,
    // or PATCHes the existing squad to ensure all members are current.
    squadId = await upsertSquad(squadId, assistantResults);

    provisionSquad(squadId, assistantResults);
    printFinalSummary(assistantResults, squadId);
  } catch (err) {
    const status = err.response?.status;
    const msg    = err.response?.data?.message || err.message;
    error(`Unhandled error${status ? ` (HTTP ${status})` : ''}: ${msg}`);
    if (err.response?.data) {
      error('Response body:', JSON.stringify(err.response.data, null, 2));
    }
    process.exit(1);
  }
}

main();
