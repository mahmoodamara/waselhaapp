import { config } from "../config.js";
import { log } from "./log.js";
import { distanceMeters } from "./nearbyOffers.js";

// Driving time and distance from a driver to an offer's pickup, for the offer card.
// One plain route (no polyline) per (driver, offer), not a matrix. It only decorates
// the offers list: it never gates, orders or removes an offer, and any failure
// leaves the card with the straight-line distance it already had.
export function createOfferEtaService({ routesClient, settings = config, now = Date.now } = {}) {
  const cache = new Map();     // `${driverId}:${orderId}` -> { at, origin, destKey, result, failedAt }
  const inFlight = new Map();
  const metrics = { requested: 0, success: 0, failure: 0, cacheHit: 0, singleflightHit: 0, skippedBudget: 0 };
  let windowStart = 0, windowCount = 0;
  const MAX_ENTRIES = 1000, KEEP_ON_FAILURE_MS = 300000;

  function budgetLeft() {
    const time = now();
    if (time - windowStart >= 60000) { windowStart = time; windowCount = 0; }
    return windowCount < settings.offerEtaMaxPerMin;
  }
  function remember(key, entry) {
    cache.set(key, entry);
    if (cache.size <= MAX_ENTRIES) return;
    for (const [k, v] of cache) if (now() - v.at > 600000) cache.delete(k);
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  }

  // origin: { latitude, longitude } of the driver's fresh location. Resolves to
  // { distanceMeters, durationSeconds } or null; never rejects.
  async function etaFor(driver, order, origin) {
    try {
      const dest = order.pickupLocation;
      if (!routesClient?.configured || !dest) return null;
      const key = `${driver._id}:${order._id}`, destKey = `${dest.lat.toFixed(6)},${dest.lng.toFixed(6)}`, time = now();
      let entry = cache.get(key);
      if (entry && entry.destKey !== destKey) entry = undefined;
      if (entry?.failedAt && time - entry.failedAt < settings.offerEtaFailureRetrySeconds * 1000) return entry.result ?? null;
      if (entry?.result) {
        const age = time - entry.at;
        const moved = distanceMeters({ lat: entry.origin.latitude, lng: entry.origin.longitude }, origin);
        // Reuse while it is recent and the driver has not moved far; never recompute inside the minimum interval.
        if ((age < settings.offerEtaMaxAgeSeconds * 1000 && moved < settings.offerEtaMoveMeters) ||
            age < settings.offerEtaMinRecalcSeconds * 1000) { metrics.cacheHit++; return entry.result; }
      }
      const shared = inFlight.get(key);
      if (shared) { metrics.singleflightHit++; return await shared; }
      if (!budgetLeft()) { metrics.skippedBudget++; return entry?.result ?? null; }
      windowCount++; metrics.requested++;
      const started = time;
      const job = routesClient.computeRoute({ origin: { lat: origin.latitude, lng: origin.longitude }, destination: dest,
        vehicleType: driver.vehicleType, summary: true })
        .then(result => {
          remember(key, { at: now(), origin: { ...origin }, destKey, result, failedAt: 0 });
          metrics.success++;
          log("info", "offer_eta_computed", { orderId: String(order._id), driverId: String(driver._id), latencyMs: now() - started });
          return result;
        }, error => {
          metrics.failure++;
          const old = entry?.result && time - entry.at < KEEP_ON_FAILURE_MS ? entry.result : null;
          remember(key, { at: entry?.at ?? time, origin: entry?.origin ?? { ...origin }, destKey, result: old, failedAt: now() });
          log("warn", "offer_eta_failed", { orderId: String(order._id), driverId: String(driver._id), code: error?.code ?? "unknown", latencyMs: now() - started });
          return old;
        })
        .finally(() => { if (inFlight.get(key) === job) inFlight.delete(key); });
      inFlight.set(key, job);
      return await job;
    } catch { return null; }
  }

  return {
    metrics: () => ({ ...metrics }),
    // items: [{ offer, order }] with the raw order (its pickup point is never put in the offer).
    // Adds pickupRoute* to each offer that has an answer within the wait limit. A slow
    // answer is not discarded: it is cached and appears on the next refresh.
    async decorate(driver, items, origin) {
      if (!items.length || !origin) return items.map(item => item.offer);
      const answers = await Promise.all(items.map(({ order }) => {
        let timer;
        const limit = new Promise(resolve => { timer = setTimeout(() => resolve(null), settings.offerEtaWaitMs); });
        return Promise.race([etaFor(driver, order, origin), limit]).finally(() => clearTimeout(timer));
      }));
      return items.map(({ offer }, i) => answers[i]
        ? { ...offer, pickupRouteDistanceMeters: answers[i].distanceMeters, pickupRouteDurationSeconds: answers[i].durationSeconds }
        : offer);
    },
  };
}
