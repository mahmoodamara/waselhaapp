import { REALTIME } from "../../../shared/realtimeContract.js";
const fields = ["latitude", "longitude", "accuracy", "heading", "speed", "measuredAt", "sequence", "sessionId"];
const finite = value => typeof value === "number" && Number.isFinite(value);
export function validateLocation(payload, now = Date.now()) {
  if (!payload || Object.getPrototypeOf(payload) !== Object.prototype ||
      Object.keys(payload).length !== fields.length || fields.some(key => !Object.hasOwn(payload, key))) return "invalid_payload";
  if (!finite(payload.latitude) || Math.abs(payload.latitude) > 90 ||
      !finite(payload.longitude) || Math.abs(payload.longitude) > 180 ||
      !finite(payload.accuracy) || payload.accuracy <= 0 || payload.accuracy > REALTIME.maxAccuracy ||
      (payload.heading !== null && (!finite(payload.heading) || payload.heading < 0 || payload.heading >= 360)) ||
      (payload.speed !== null && (!finite(payload.speed) || payload.speed < 0 || payload.speed > REALTIME.maxSpeed)) ||
      !Number.isSafeInteger(payload.measuredAt) || payload.measuredAt <= 0 ||
      !Number.isSafeInteger(payload.sequence) || payload.sequence < 1 || payload.sequence > REALTIME.maxSequence ||
      typeof payload.sessionId !== "string" || !/^[a-f\d-]{36}$/.test(payload.sessionId)) return "invalid_payload";
  if (Buffer.byteLength(JSON.stringify(payload)) > REALTIME.maxPayloadBytes) return "invalid_payload";
  if (payload.measuredAt < now - REALTIME.maxAgeMs || payload.measuredAt > now + REALTIME.futureSkewMs) return "stale_location";
  return null;
}

// Shared across sockets/reconnects of a driver. Rejected events never reach Redis.
export function createDriverLimiter(now = Date.now) {
  const buckets = new Map();
  return {
    take(id) {
      const time = now(), previous = buckets.get(id) || { tokens: 4, at: time };
      // A backwards clock step (NTP correction) must not drain the bucket.
      const tokens = Math.min(4, previous.tokens + Math.max(0, time - previous.at) / REALTIME.publishIntervalMs);
      const allowed = tokens >= 1;
      buckets.set(id, { tokens: allowed ? tokens - 1 : tokens, at: time });
      return allowed;
    },
    prune() { for (const [id, bucket] of buckets) if (now() - bucket.at > 60000) buckets.delete(id); },
  };
}
