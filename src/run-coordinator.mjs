import { createHash } from 'node:crypto';

/**
 * Bounded process-local idempotency example.
 *
 * All in-flight entries count toward maxEntries; duplicates join their original
 * promise even at capacity. Completed entries may be evicted to admit new work.
 * A still-running task is NEVER evicted: only the caller can time out/cancel it.
 *
 * This is not a distributed queue or a substitute for durable production leases.
 */
export function createRunCoordinator({ ttlMs = 5 * 60_000, maxEntries = 200, now = () => Date.now() } = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1)
    throw new RangeError('ttlMs must be a positive integer');
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10_000)
    throw new RangeError('maxEntries must be between 1 and 10000');
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  const runs = new Map();

  function prune() {
    for (const [key, entry] of runs) {
      if (entry.settled && now() - entry.settledAt >= ttlMs) runs.delete(key);
    }
  }

  function makeRoom() {
    // Retain in-flight work and its idempotency key. An older completed result
    // is safe to evict only when admitting a new, distinct request.
    while (runs.size >= maxEntries) {
      const oldestCompleted = [...runs].filter(([, entry]) => entry.settled)
        .sort((a, b) => a[1].settledAt - b[1].settledAt)[0];
      if (!oldestCompleted) break;
      runs.delete(oldestCompleted[0]);
    }
    if (runs.size >= maxEntries)
      throw Object.assign(new Error('Too many concurrent tasks'), { code: 'RUN_CAPACITY_EXCEEDED' });
  }

  return {
    async executeOnce(key, input, run) {
      if (typeof key !== 'string' || !/^[\w-]{8,100}$/.test(key))
        throw Object.assign(new Error('Invalid request key'), { code: 'INVALID_KEY' });
      if (typeof run !== 'function') throw new TypeError('run must be a function');
      const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      prune();

      const existing = runs.get(key);
      if (existing) {
        if (existing.inputHash !== hash)
          throw Object.assign(new Error('Request key reused with different input'), { code: 'KEY_CONFLICT' });
        return existing.promise;
      }

      makeRoom(); // checked synchronously before scheduling or reserving the new run
      const entry = { inputHash: hash, settled: false, settledAt: null, promise: null };
      entry.promise = Promise.resolve().then(run).then(
        result => { entry.settled = true; entry.settledAt = now(); return result; },
        error => { runs.delete(key); throw error; }
      );
      runs.set(key, entry);
      return entry.promise;
    },
    size() { prune(); return runs.size; },
    activeCount() { prune(); return [...runs.values()].filter(entry => !entry.settled).length; }
  };
}
