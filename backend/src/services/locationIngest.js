import { Order } from "../models/index.js";
import { validateLocation, createDriverLimiter } from "../realtime/driverLocation.js";
import { log } from "./log.js";
import { driverLocationAccepted } from "./locationSignals.js";

// One limiter and validation pipeline per authoritative store, across HTTP and
// Socket.IO. Pruning is driven by work, with no extra background timer.
const pipelines = new WeakMap();
export function locationIngest(store) {
  if (pipelines.has(store)) return pipelines.get(store);
  const limiter = createDriverLimiter();
  let lastPrune = 0;
  const ingest = async ({ payload, sessionId, authenticate, source, stillCurrent = () => true }) => {
    const { user } = await authenticate();
    const id = String(user._id);
    const reply = value => {
      if (!value.ok) log("warn", "driver_location_rejected", { driverId: id, source,
        code: value.code, ageMs: Number.isFinite(payload?.measuredAt) ? Date.now() - payload.measuredAt : null });
      return value;
    };
    const invalid = validateLocation(payload);
    if (invalid) return reply({ ok: false, code: invalid });
    if (payload.sessionId !== sessionId || !stillCurrent()) return reply({ ok: false, code: "stale_session" });
    if (!user.availableForOrders && !await Order.exists({ driverId: user._id, activeAssignment: true })) {
      await store.clearDriverLocation(id);
      return reply({ ok: false, code: "tracking_disabled" });
    }
    if (!stillCurrent()) return reply({ ok: false, code: "stale_session" });
    const result = await store.saveLocation(id, payload);
    if (result === "accepted") await driverLocationAccepted(store, id);
    return reply(result === "accepted" ? { ok: true, sequence: payload.sequence } : { ok: false, code: result });
  };
  ingest.take = id => {
    if (Date.now() - lastPrune > 60000) { limiter.prune(); lastPrune = Date.now(); }
    return limiter.take(id);
  };
  pipelines.set(store, ingest);
  return ingest;
}
