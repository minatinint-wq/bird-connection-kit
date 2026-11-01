const fatalDisconnectCodes = new Set([401, 403, 411, 440, 500]);
const stableConnectionMs = 5 * 60_000;
const maxUnstableRetries = 6;

export function reconnectDecision({ code, previousAttempts = 0, connectedForMs = 0, maxRetries = maxUnstableRetries, random = Math.random() } = {}) {
  if (fatalDisconnectCodes.has(Number(code))) return { retry: false, attempts: previousAttempts, reason: 'session' };
  const attempts = connectedForMs >= stableConnectionMs ? 1 : previousAttempts + 1;
  if (attempts > maxRetries) return { retry: false, attempts, reason: 'unstable' };
  const baseDelayMs = Math.min(300_000, 15_000 * 2 ** (attempts - 1));
  const jitter = Math.min(1, Math.max(0, Number(random) || 0));
  return { retry: true, attempts, delayMs: Math.round(baseDelayMs * (0.9 + jitter * 0.2)) };
}

export function shouldIgnoreWhatsAppJid(jid, isolatedCrmInstance) {
  return isolatedCrmInstance === true && typeof jid === 'string' && jid.endsWith('@g.us');
}

// Baileys calls del() when its retry limit is reached. Retaining that count
// prevents the same undecryptable message from starting a new retry cycle.
export function createMessageRetryBudget({ now = Date.now, ttlMs = 60 * 60_000, maxEntries = 10_000, limit = 2 } = {}) {
  const entries = new Map();
  function current(key) {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) { entries.delete(key); return undefined; }
    return entry.value;
  }
  return {
    get: current,
    set(key, value) {
      current(key);
      entries.delete(key);
      entries.set(key, { value, expiresAt: now() + ttlMs });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },
    del(key) { if ((current(key) || 0) < limit) entries.delete(key); },
    flushAll() { entries.clear(); },
  };
}
