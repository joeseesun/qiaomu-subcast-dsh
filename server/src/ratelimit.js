// Fixed-window counters per (bucket, ip), kept only in memory so no IP ever reaches disk.
export class RateLimiter {
  constructor({ windowMs, limits }) {
    this.windowMs = windowMs;
    this.limits = limits;
    this.hits = new Map();
    this.timer = setInterval(() => this.sweep(), Math.min(windowMs, 10 * 60 * 1000));
    this.timer.unref();
  }

  hit(bucket, ip, now = Date.now()) {
    const limit = this.limits[bucket];
    if (!limit) return { ok: true };
    const key = `${bucket}|${ip}`;
    let entry = this.hits.get(key);
    if (!entry || now - entry.start >= this.windowMs) {
      if (this.hits.size >= 200_000) this.sweep(now);
      entry = { start: now, count: 0 };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > limit) {
      return { ok: false, retryAfter: Math.max(1, Math.ceil((entry.start + this.windowMs - now) / 1000)) };
    }
    return { ok: true, remaining: limit - entry.count };
  }

  sweep(now = Date.now()) {
    for (const [key, entry] of this.hits) {
      if (now - entry.start >= this.windowMs) this.hits.delete(key);
    }
  }

  get size() {
    return this.hits.size;
  }

  stop() {
    clearInterval(this.timer);
  }
}
