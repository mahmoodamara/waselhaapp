import { fail } from "./validation.js";

// Redis is authoritative across processes, reconnects, JWT rotations and IPs.
// Ten attempts/minute covers normal manual operation while bounding expensive
// creates/accepts, including invalid attempts and disabled SMS providers.
export function orderActionLimit(action) {
  return async (req, res, next) => {
    const store = req.app.locals.locationStore;
    if (!store?.takeActionLimit) fail("realtime_unavailable", 503);
    let result;
    try { result = await store.takeActionLimit(action, String(req.user._id), 10, 60000); }
    catch { fail("realtime_unavailable", 503); }
    if (!result.allowed) fail("rate_limited", 429, { retryAfterSeconds: result.retryAfterSeconds });
    next();
  };
}
