'use strict';

// Manages SSE client connections for the live log stream.
// Called by the custom Winston transport on every log entry.

const clients = new Set();

function addClient(res) {
  clients.add(res);
  return () => clients.delete(res);
}

function broadcast(entry) {
  if (clients.size === 0) return;
  let data;
  try {
    data = `data: ${JSON.stringify(entry, _safeReplacer())}\n\n`;
  } catch {
    return; // malformed entry — skip rather than crash all clients
  }
  for (const res of clients) {
    try {
      res.write(data);
    } catch {
      clients.delete(res);
    }
  }
}

// Returns a replacer that breaks circular references instead of throwing.
function _safeReplacer() {
  const seen = new WeakSet();
  return (_key, value) => {
    if (value instanceof Error) return { message: value.message, stack: value.stack };
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  };
}

module.exports = { addClient, broadcast };
