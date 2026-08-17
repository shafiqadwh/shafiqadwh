/**
 * Small in-memory sliding-window limiter. Enough to stop one misbehaving phone
 * (or a bored guest) from filling the NAS, without adding a Redis dependency.
 */
const buckets = new Map();

let counter = 0;

export function createLimiter({ limit, windowMs, name, key = (req) => req.ip }) {
  // Each limiter counts in its own namespace. Sharing one bucket per IP would
  // mean a guest who uploads a batch of photos is then refused a guest-book
  // message — and the hosts locked out of /admin after a busy hour.
  const scope = name ?? `limiter-${(counter += 1)}`;

  return function limiter(req, res, next) {
    if (limit <= 0) return next();

    const now = Date.now();
    const id = `${scope}:${key(req)}`;
    const hits = (buckets.get(id) ?? []).filter((time) => now - time < windowMs);

    if (hits.length >= limit) {
      buckets.set(id, hits);
      res.status(429);
      return res.json({ error: req.t('errors.rate_limited') });
    }

    hits.push(now);
    buckets.set(id, hits);
    next();
  };
}

/** Drop stale buckets so a long-running party does not leak memory. */
export function startLimiterCleanup(windowMs = 60 * 60 * 1000) {
  const timer = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [id, hits] of buckets) {
      const fresh = hits.filter((time) => time > cutoff);
      if (fresh.length === 0) buckets.delete(id);
      else buckets.set(id, fresh);
    }
  }, windowMs);
  timer.unref();
  return timer;
}

export function resetLimiters() {
  buckets.clear();
}
