import { config } from "../config.js";
import { Order } from "../models/index.js";
import { fail } from "./validation.js";
import { validCoordinates } from "./location.js";
import { log } from "./log.js";
import { RouteProviderError } from "./googleRoutes.js";
import { decodePolyline, distanceToPolylineMeters } from "../../../shared/polyline.js";

// The driver's operational route. Read-only with respect to orders: it never
// writes an order, a price or a status, and a Google failure never blocks delivery.

// Order status -> where the driver is heading. Mirrors driver-app/stages.js
// navigationDestination (a test keeps the two in step). Stationary stages (the driver
// has arrived) and non-trip states get no route and cost no Google call.
export function resolveDriverRouteDestination(order) {
  const base = { stage: order?.status ?? null };
  switch (order?.status) {
    case "driver_assigned":
      return { ...base, destinationType: "pickup", location: order.pickupLocation ?? null, routable: true };
    case "collected":
      return { ...base, destinationType: "customer", location: order.destinationLocation ?? null, routable: true };
    // There is no separate return-location field: a returning driver goes back to the store.
    case "returning":
      return { ...base, destinationType: "return", location: order.pickupLocation ?? null, routable: true };
    case "driver_at_store":
      return { ...base, destinationType: "pickup", location: order.pickupLocation ?? null, routable: false };
    case "driver_at_destination":
      return { ...base, destinationType: "customer", location: order.destinationLocation ?? null, routable: false };
    default:
      return { ...base, destinationType: null, location: null, routable: false };
  }
}

const counters = ["requested", "success", "failure", "timeout", "rateLimited", "cacheHit", "singleflightHit", "recalculated"];
const distanceBucket = meters => meters < 1000 ? "<1km" : meters < 5000 ? "1-5km" : meters < 15000 ? "5-15km" : ">15km";

export function createDriverRouteService({ routesClient, locationStore, settings = config, now = Date.now, orders = Order } = {}) {
  const cache = new Map();       // `${driverId}:${orderId}` -> entry
  const inFlight = new Map();    // same key -> Promise (singleflight)
  const windows = new Map();     // rate limit buckets
  const metrics = Object.fromEntries(counters.map(name => [`routes.${name}`, 0]));
  const count = name => { metrics[`routes.${name}`]++; };
  const MAX_ENTRIES = 500;

  function take(key, max) {
    const time = now();
    if (windows.size > 5000) for (const [k, v] of windows) if (v.resetAt <= time) windows.delete(k);
    let entry = windows.get(key);
    if (!entry || entry.resetAt <= time) windows.set(key, entry = { count: 0, resetAt: time + 60000 });
    if (++entry.count > max) {
      count("rateLimited");
      log("warn", "route_rate_limited", { scope: key.split(":")[0] });
      fail("rate_limited", 429, { retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - time) / 1000)) });
    }
  }
  function remember(key, entry) {
    cache.set(key, entry);
    if (cache.size <= MAX_ENTRIES) return;
    const oldest = [...cache.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  const destinationKey = dest => `${dest.stage}|${dest.destinationType}|${dest.location.lat.toFixed(6)},${dest.location.lng.toFixed(6)}`;
  const dto = (order, dest, entry, stale) => ({
    orderId: String(order._id), stage: dest.stage, destinationType: dest.destinationType,
    distanceMeters: entry.route.distanceMeters, durationSeconds: entry.route.durationSeconds,
    encodedPolyline: entry.route.encodedPolyline, calculatedAt: new Date(entry.calculatedAt).toISOString(),
    originMeasuredAt: new Date(entry.originMeasuredAt).toISOString(), source: "google_routes", stale,
  });

  async function freshOrigin(driverId) {
    let latest;
    try { latest = await locationStore.getLatestDriverLocation(driverId); }
    catch { fail("route_unavailable", 503); }
    if (!latest.location) fail("location_unavailable", 409);
    const point = latest.location;
    if (!latest.fresh || !validCoordinates(point.latitude, point.longitude)) fail("location_stale", 409);
    return point;
  }

  // The single place a Google request can start. `reason` is for logs/metrics only.
  async function requestRoute({ key, order, dest, driver, reason, previous }) {
    const origin = await freshOrigin(String(driver._id));
    const destKey = destinationKey(dest), started = now();
    count("requested");
    try {
      const route = await routesClient.computeRoute({ origin: { lat: origin.latitude, lng: origin.longitude },
        destination: dest.location, vehicleType: driver.vehicleType ?? order.vehicleType });
      const entry = { destKey, route, polyline: decodePolyline(route.encodedPolyline) ?? [], calculatedAt: now(),
        originMeasuredAt: origin.measuredAt, offCount: 0, lastOffSample: 0, failedAt: 0, touchedAt: now() };
      remember(key, entry);
      count("success"); if (previous) count("recalculated");
      log("info", "route_computed", { orderId: String(order._id), driverId: String(driver._id), stage: dest.stage, reason,
        latencyMs: now() - started, distanceBucket: distanceBucket(route.distanceMeters) });
      return entry;
    } catch (error) {
      const code = error instanceof RouteProviderError ? error.code : "unknown";
      count("failure"); if (code === "timeout") count("timeout");
      // A failure is remembered so repeated polls do not retry Google every time.
      if (previous) previous.failedAt = now(); else remember(key, { destKey, route: null, failedAt: now(), touchedAt: now() });
      log("warn", "route_failed", { orderId: String(order._id), driverId: String(driver._id), stage: dest.stage, reason, code,
        latencyMs: now() - started });
      throw error;
    }
  }

  // Decides whether a cached route is still good, or which reason justifies a new one.
  async function recalcReason(entry, driverId) {
    const age = now() - entry.calculatedAt;
    if (age >= settings.routeMaxAgeSeconds * 1000) return "max_age";
    if (age < settings.routeMinRecalcSeconds * 1000) return null;
    try {
      const latest = await locationStore.getLatestDriverLocation(driverId);
      const point = latest.location;
      // One noisy or inaccurate sample never counts; only fresh, precise, distinct ones do.
      if (!latest.fresh || !validCoordinates(point.latitude, point.longitude) ||
          !(point.accuracy > 0 && point.accuracy <= settings.routeOffRouteMaxAccuracyMeters)) return null;
      if (distanceToPolylineMeters(point, entry.polyline) <= settings.routeOffRouteThresholdMeters) { entry.offCount = 0; return null; }
      if (point.measuredAt > entry.lastOffSample) { entry.offCount++; entry.lastOffSample = point.measuredAt; }
      return entry.offCount >= settings.routeOffRouteConfirmations ? "off_route" : null;
    } catch { return null; }
  }

  function share(key, factory) {
    const running = inFlight.get(key);
    if (running) { count("singleflightHit"); return running; }
    const promise = factory().finally(() => { if (inFlight.get(key) === promise) inFlight.delete(key); });
    inFlight.set(key, promise);
    return promise;
  }

  return {
    metrics: () => ({ ...metrics }),
    // The driver's own active assignment only. Origin, destination and stage all
    // come from the server; the caller supplies nothing but its identity.
    async currentRoute(driver) {
      take(`driver:${driver._id}`, settings.routeRateLimitPerMin);
      const order = await orders.findOne({ driverId: driver._id, activeAssignment: true }).lean();
      if (!order) {
        for (const key of cache.keys()) if (key.startsWith(`${driver._id}:`)) cache.delete(key);
        fail("no_active_assignment", 404);
      }
      if (order.workflowVersion === 3 && driver.supportedWorkflowVersion !== 3) fail("app_update_required", 409);
      take(`order:${order._id}`, settings.routeOrderRateLimitPerMin);
      const dest = resolveDriverRouteDestination(order);
      if (!dest.routable || !validCoordinates(dest.location?.lat, dest.location?.lng)) fail("route_not_applicable", 409, { stage: dest.stage });
      if (!routesClient.configured) fail("route_unavailable", 503);
      const key = `${driver._id}:${order._id}`, destKey = destinationKey(dest);
      let entry = cache.get(key), changed = false;
      // A route for another stage or destination is never served for this one.
      if (entry && entry.destKey !== destKey) { cache.delete(key); entry = undefined; changed = true; }
      const previous = entry?.route ? entry : undefined;

      let reason = null;
      if (previous) {
        reason = await recalcReason(previous, String(driver._id));
        if (reason && now() - previous.failedAt < settings.routeFailureRetrySeconds * 1000) reason = null;
      } else if (entry?.failedAt && now() - entry.failedAt < settings.routeFailureRetrySeconds * 1000) {
        fail("route_unavailable", 503);
      } else reason = changed ? "stage_changed" : "initial";

      if (!reason) { count("cacheHit"); previous.touchedAt = now(); return dto(order, dest, previous, now() - previous.calculatedAt >= settings.routeMaxAgeSeconds * 1000); }
      try {
        const fresh = await share(`${key}|${destKey}`, () => requestRoute({ key, order, dest, driver, reason, previous }));
        return dto(order, dest, fresh, false);
      } catch (error) {
        // A usable older route for the same stage beats an error screen.
        if (previous) return dto(order, dest, previous, true);
        if (error?.status) throw error;
        fail("route_unavailable", 503);
      }
    },
  };
}
