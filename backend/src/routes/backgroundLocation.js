import { Router } from "express";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { auth, roles } from "../middleware/auth.js";
import { User, Order } from "../models/index.js";
import { config } from "../config.js";
import { fail } from "../services/validation.js";
import { rateLimit } from "../services/rateLimit.js";
import { locationIngest } from "../services/locationIngest.js";
import { BACKGROUND } from "../../../shared/realtimeContract.js";

const router = Router();
const sessionIdValid = value => typeof value === "string" && /^[a-f\d-]{36}$/.test(value);
const storeFor = req => {
  const store = req.app.locals.locationStore;
  if (!store) fail("realtime_unavailable", 503);
  return store;
};
router.post("/session", rateLimit(120), auth, roles("driver"), rateLimit(12, 60000, req => String(req.user._id)), async (req, res) => {
  if (Object.keys(req.body).length !== 1 || !sessionIdValid(req.body.sessionId)) fail("invalid_payload");
  if (!req.user.availableForOrders && !await Order.exists({ driverId: req.user._id, activeAssignment: true }))
    fail("tracking_disabled", 403);
  const sessionId = randomUUID(), ttl = Math.min(config.backgroundCredentialTtlSeconds,
    Math.floor(req.authExpiresAt / 1000) - Math.floor(Date.now() / 1000));
  if (ttl <= 0) fail("unauthorized", 401);
  const renewalUntil = Math.min(Math.floor(req.authExpiresAt / 1000), Math.floor(Date.now() / 1000) + BACKGROUND.maxShiftSeconds);
  const credential = jwt.sign({ scope: BACKGROUND.scope, sessionId, ver: req.user.authVersion ?? 0, renewalUntil }, config.jwtSecret,
    { subject: String(req.user._id), audience: BACKGROUND.audience, issuer: "waselha", expiresIn: ttl });
  const expiresAt = jwt.decode(credential).exp * 1000;
  if (!await storeFor(req).handoffBackground(String(req.user._id), req.body.sessionId, sessionId, ttl)) fail("stale_session", 409);
  res.json({ sessionId, credential, expiresAt });
});

export async function authenticateBackground(token) {
  let payload;
  try {
    if (typeof token !== "string" || token.length > 4096) throw new Error();
    payload = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"], audience: BACKGROUND.audience, issuer: "waselha" });
    if (payload.scope !== BACKGROUND.scope || !sessionIdValid(payload.sessionId) ||
        typeof payload.sub !== "string" || !/^[a-f\d]{24}$/i.test(payload.sub) || !Number.isSafeInteger(payload.exp)) throw new Error();
  } catch { fail("unauthorized", 401); }
  const user = await User.findById(payload.sub).lean();
  if (!user?.active || user.role !== "driver" || payload.ver !== (user.authVersion ?? 0)) fail("unauthorized", 401);
  return { user, sessionId: payload.sessionId, renewalUntil: payload.renewalUntil };
}
router.post('/renew', rateLimit(120), async (req, res) => {
  if (Object.keys(req.body).length) fail('invalid_payload');
  const parts = req.headers.authorization?.split(' ');
  if (parts?.[0] !== 'Bearer') fail('unauthorized', 401);
  const session = await authenticateBackground(parts[1]);
  if (!session.user.availableForOrders && !await Order.exists({ driverId: session.user._id, activeAssignment: true })) fail('tracking_disabled', 403);
  if (!Number.isSafeInteger(session.renewalUntil)) fail('unauthorized', 401);
  const ttl = Math.min(config.backgroundCredentialTtlSeconds, session.renewalUntil - Math.floor(Date.now() / 1000));
  if (ttl <= 0) fail('session_expired', 409);
  const credential = jwt.sign({ scope: BACKGROUND.scope, sessionId: session.sessionId,
    ver: session.user.authVersion ?? 0, renewalUntil: session.renewalUntil }, config.jwtSecret,
    { subject: String(session.user._id), audience: BACKGROUND.audience, issuer: 'waselha', expiresIn: ttl });
  const expiresAt = jwt.decode(credential).exp * 1000;
  if (!await storeFor(req).renewBackground(String(session.user._id), session.sessionId, Math.floor(expiresAt / 1000))) fail('stale_session', 409);
  res.json({ sessionId: session.sessionId, credential, expiresAt });
});
router.post("/", rateLimit(120), async (req, res) => {
  const token = req.headers.authorization?.split(" ");
  if (token?.[0] !== "Bearer") fail("unauthorized", 401);
  const store = storeFor(req);
  const session = await authenticateBackground(token[1]);
  const ingest = locationIngest(store);
  if (!ingest.take(String(session.user._id))) return res.status(429).json({ ok: false, code: "rate_limited" });
  const result = await ingest({ payload: req.body, sessionId: session.sessionId,
    source: "background_https", authenticate: async () => session });
  const status = result.ok ? 200 : result.code === "rate_limited" ? 429 : result.code === "tracking_disabled" ? 403
    : ["stale_session", "session_expired"].includes(result.code) ? 409 : 400;
  res.status(status).json(result);
});
export default router;
