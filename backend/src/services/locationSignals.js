import { log } from "./log.js";
// Store-scoped, process-local accepted-location hook. It carries identity only,
// never samples/history. Both transports use it AFTER the authoritative write.
const subscriptions = new WeakMap();
export function onDriverLocationAccepted(store, listener) {
  if (!subscriptions.has(store)) subscriptions.set(store, new Set());
  const listeners = subscriptions.get(store);
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export async function driverLocationAccepted(store, driverId) {
  await Promise.all([...subscriptions.get(store) ?? []].map(async listener => {
    try { await listener(driverId); }
    catch { log("error", "tracking_publish_failed", { code: "realtime_unavailable" }); }
  }));
}
