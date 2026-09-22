'use strict';

// Tiny TTL cache that serves the last good value if a refresh fails, so a
// brief network drop never blanks the screen.
class Cache {
  constructor() {
    this.map = new Map();
  }

  // If a refresh fails we keep showing the last good value, but only for a while (default 6 hours), so a lasting
  // problem such as a lapsed Google sign-in eventually becomes visible instead of hiding behind old data.
  async get(key, ttlMs, loader, maxStaleMs = 6 * 3600 * 1000) {
    const now = Date.now();
    const hit = this.map.get(key);
    if (hit && now - hit.at < ttlMs) return hit.value;
    try {
      const value = await loader();
      this.map.set(key, { at: now, value });
      return value;
    } catch (err) {
      if (hit && now - hit.at < maxStaleMs) return { ...hit.value, stale: true };
      throw err;
    }
  }
}

module.exports = { Cache };
