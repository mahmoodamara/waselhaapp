import jwt from "jsonwebtoken";
import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Order } from "../models/index.js";
import { config } from "../config.js";
import { fail } from "./validation.js";
import { withTrackingOrder } from "./trackingGate.js";
import { TRACKING, CUSTOMER_LOCATION_FIELDS } from "../../../shared/realtimeContract.js";
import { publicOrderReference } from "./publicOrderReference.js";
// JWTs are readable by their holder. Encrypt the internal subject as well as
// signing it, so customer credentials cannot reintroduce a database-ID leak.
const subjectKey = () => createHash("sha256").update(`tracking-subject:${config.jwtSecret}`).digest();
function sealSubject(id) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", subjectKey(), iv);
  const value = Buffer.concat([cipher.update(String(id), "utf8"), cipher.final()]);
  return Buffer.concat([iv, value, cipher.getAuthTag()]).toString("base64url");
}
function openSubject(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{70}$/.test(value)) throw new Error();
  const bytes = Buffer.from(value, "base64url"), decipher = createDecipheriv("aes-256-gcm", subjectKey(), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(-16));
  const id = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8");
  if (!/^[a-f\d]{24}$/i.test(id)) throw new Error();
  return id;
}
const fingerprint = token => createHash("sha256").update(token).digest("hex");
const linkExpiry = order => new Date(order.customerTokenExpiresAt ??
  new Date(order.createdAt).getTime() + config.customerLinkTtlMs).getTime();
export function issueTrackingCredential(order) {
  const ttl = Math.min(TRACKING.credentialTtlSeconds, Math.floor((linkExpiry(order) - Date.now()) / 1000));
  if (!(ttl > 0)) fail("not_found", 404);
  const credential = jwt.sign({ purpose: TRACKING.purpose, link: fingerprint(order.customerToken) }, config.jwtSecret,
    { algorithm: "HS256", subject: sealSubject(order._id), audience: TRACKING.audience, issuer: "waselha", expiresIn: ttl });
  return { credential, expiresAt: jwt.decode(credential).exp * 1000 };
}
export function verifyTrackingCredential(token) {
  try {
    if (typeof token !== "string" || token.length > 2048) throw new Error();
    const claims = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"], audience: TRACKING.audience, issuer: "waselha" });
    if (claims.purpose !== TRACKING.purpose ||
      typeof claims.link !== "string" || !/^[a-f\d]{64}$/.test(claims.link) || !Number.isSafeInteger(claims.exp)) throw new Error();
    return Object.freeze({ orderId: openSubject(claims.sub), link: claims.link, expiresAt: claims.exp * 1000 });
  } catch { fail("unauthorized", 401); }
}
export async function trackingOrder(claims) {
  if (Date.now() >= claims.expiresAt) fail("unauthorized", 401);
  const order = await Order.findById(claims.orderId).select("_id status driverId activeAssignment customerToken customerTokenExpiresAt createdAt updatedAt").lean();
  if (!order || fingerprint(order.customerToken) !== claims.link || linkExpiry(order) <= Date.now()) fail("unauthorized", 401);
  return order;
}
export const trackingAllowed = order => TRACKING.allowedStatuses.includes(order.status) && order.activeAssignment === true && !!order.driverId;
export const trackingRoom = orderId => `tracking:order:${orderId}`;
export const customerOrderRoom = orderId => `customer:order:${orderId}`;
export async function trackingSnapshot(order, store) {
  let state = TRACKING.endedStatuses.includes(order.status) ? "ended" : "not_started", location = null;
  if (trackingAllowed(order)) {
    const latest = store ? await store.getLatestDriverLocation(String(order.driverId)) : { location: null };
    state = !latest.location ? "unavailable" : latest.fresh ? "live" : "stale";
    if (latest.location) location = Object.fromEntries(CUSTOMER_LOCATION_FIELDS.map(key => [key,
      key === "fresh" ? latest.fresh : latest.location[key] ?? null]));
  }
  return { orderId: publicOrderReference(order), status: order.status, state, location,
    freshForMs: store?.locationFreshMs ?? config.locationFreshMs, serverTime: Date.now() };
}
// Keep serialization through res.json/socket.emit, not just through the read.
export function discloseTracking(claims, store, send) {
  return withTrackingOrder(claims.orderId, async () => {
    const order = await trackingOrder(claims), snapshot = await trackingSnapshot(order, store);
    if (Date.now() >= claims.expiresAt || linkExpiry(order) <= Date.now()) fail("unauthorized", 401);
    return send(snapshot, order);
  });
}
