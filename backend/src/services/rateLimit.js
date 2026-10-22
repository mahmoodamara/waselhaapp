import { fail } from "./validation.js";

// Fixed-window limiter per client IP, held in memory. It bounds abuse of the
// unauthenticated endpoints on a single pilot instance; use the reverse proxy
// for anything stricter. Set TRUST_PROXY so `req.ip` is the real client.
export function rateLimit(max, windowMs = 60 * 1000, keyOf = req => req.ip) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now(), key = keyOf(req);
    if (hits.size > 10000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) hits.set(key, entry = { count: 0, resetAt: now + windowMs });
    if (++entry.count > max) fail("rate_limited", 429, { retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) });
    next();
  };
}
