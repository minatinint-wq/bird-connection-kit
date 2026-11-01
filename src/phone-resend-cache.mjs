// Sender retry receipts and live transport remain independent of this bounded
// phone-only recovery path. Expiry/response must not restart the same PDO loop.
export function createPhoneResendCache({ now = Date.now, intervalMs = 600_000, limit = 4, ttlMs = 86_400_000, maxEntries = 1000 } = {}) {
  const entries = new Map();
  let requests = [];
  function prune() {
    const time = now();
    requests = requests.filter(at => time - at < intervalMs);
    for (const [key,entry] of entries) if (entry.until <= time) entries.delete(key);
  }
  return {
    get(key) {
      prune();
      if (!key) return true;
      const entry = entries.get(key);
      // A truthy miss at the account limit means "already requested" to Baileys.
      return entry ? entry.value : requests.length >= limit ? true : undefined;
    },
    set(key, value) {
      prune();
      if (!key || entries.has(key) || requests.length >= limit) return;
      entries.set(key, { value: value || true, until: now() + ttlMs });
      requests.push(now());
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },
    del(key) {
      const entry = entries.get(key);
      if (entry) entry.value = true;
    },
    flushAll() { entries.clear(); requests = []; },
  };
}
