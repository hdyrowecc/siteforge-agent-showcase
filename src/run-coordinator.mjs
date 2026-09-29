import { createHash } from 'node:crypto';

/**
 * Small process-local idempotency example. This deliberately does NOT replace
 * database-backed leases, durable job state or CAS used by production systems.
 */
export function createRunCoordinator({ ttlMs = 5 * 60_000, maxEntries = 200, now = () => Date.now() } = {}) {
  const runs = new Map();
  function prune() {
    for (const [key, entry] of runs) {
      if (entry.settled && now() - entry.createdAt > ttlMs) runs.delete(key);
    }
    while (runs.size > maxEntries) {
      const oldestSettled = [...runs].find(([, entry]) => entry.settled);
      if (!oldestSettled) break;
      runs.delete(oldestSettled[0]);
    }
  }
  return {
    async executeOnce(key, input, run) {
      if (typeof key !== 'string' || !/^[\w-]{8,100}$/.test(key)) throw Object.assign(new Error('Invalid request key'), { code: 'INVALID_KEY' });
      if (typeof run !== 'function') throw new TypeError('run must be a function');
      const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      prune();
      const existing = runs.get(key);
      if (existing) {
        if (existing.inputHash !== hash) throw Object.assign(new Error('Request key reused with different input'), { code: 'KEY_CONFLICT' });
        return existing.promise;
      }
      const entry = { inputHash: hash, createdAt: now(), settled: false, promise: null };
      // Promise.resolve().then defers work until the map has been populated.
      entry.promise = Promise.resolve().then(() => run()).then(
        result => { entry.settled = true; return result; },
        error => { runs.delete(key); throw error; }
      );
      runs.set(key, entry);
      return entry.promise;
    },
    size() { prune(); return runs.size; }
  };
}
