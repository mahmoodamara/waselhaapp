import { Order, User } from "../models/index.js";
import { eligibleOrderFilter, driverEligibleForOrder } from "./driverEligibility.js";
import { searchableFilter } from "./orderTimeouts.js";
import { validCoordinates } from "./location.js";
import { deliveryFlowView } from "./deliveryFlow.js";
import { config } from "../config.js";
import { OFFER_FIELDS } from "../../../shared/realtimeContract.js";
import { orderView } from "./orders.js";
import { dispatchWave, isUnifiedOrder } from "../../../shared/workflow.js";

export function distanceMeters(a, b) {
  const radians = value => value * Math.PI / 180;
  const dLat = radians(b.latitude - a.lat), dLng = radians(b.longitude - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

// Reuse the exact existing Mongo predicate, including vehicle compatibility,
// canonical area, exclusions, search deadline and conflicting assignment.
// `wakeCandidates` (only with includeLastKnown) are eligible drivers with no fresh position whose last
// reported position is recent and within the radius: a closed app that a push may still wake.
export async function eligibilitySnapshot() {
  // Explicit pilot capacity bounds the per-round snapshot; fail closed rather
  // than silently omitting candidates if deployment exceeds this capacity.
  const capacity = 10000;
  const [drivers, busy] = await Promise.all([
    User.find({ role: 'driver', active: true, availableForOrders: true }).select('_id role active availableForOrders serviceAreas vehicleType supportedWorkflowVersion').limit(capacity + 1).lean(),
    Order.find({ activeAssignment: true }).select('driverId').limit(capacity + 1).lean(),
  ]);
  if (drivers.length > capacity || busy.length > capacity) throw Object.assign(new Error('offer_capacity_exceeded'), { code: 'realtime_unavailable' });
  return { drivers, busyIds: new Set(busy.map(order => String(order.driverId))), now: new Date() };
}
export async function selectNearbyDrivers(order, store, settings = config, { includeLastKnown = false, snapshot } = {}) {
  const wave = dispatchWave(order);
  const radiusKm = settings.offerRadiusKm * (isUnifiedOrder(order) ? wave / 3 : 1);
  const candidateLimit = settings.offerCandidateLimit * (isUnifiedOrder(order) ? wave : 1);
  const stats = { eligibleCount: 0, candidateCount: 0, staleLocationCount: 0 };
  if (!validCoordinates(order.pickupLocation?.lat, order.pickupLocation?.lng)) return { candidates: [], wakeCandidates: [], stats };
  const eligible = new Set();
  const batch = snapshot ?? await eligibilitySnapshot();
  for (const driver of batch.drivers) {
    if (driverEligibleForOrder(driver, order, batch.busyIds, new Date())) eligible.add(String(driver._id));
  }
  stats.eligibleCount = eligible.size;
  if (!eligible.size) return { candidates: [], wakeCandidates: [], stats };
  const nearby = await store.nearbyDrivers(order.pickupLocation, radiusKm);
  const candidates = [], freshIds = new Set();
  for (const driverId of nearby) {
    if (!eligible.has(driverId)) continue;
    stats.candidateCount++;
    const latest = await store.getLatestDriverLocation(driverId);
    if (!latest.fresh || !validCoordinates(latest.location?.latitude, latest.location?.longitude)) {
      stats.staleLocationCount++;
      await store.removeStaleGeoMember(driverId);
      continue;
    }
    freshIds.add(driverId);
    // GEO is an index only. A sample may move during lookup; rank/recheck the
    // radius using the latest accepted raw measurement, never client animation.
    const distance = distanceMeters(order.pickupLocation, latest.location);
    if (distance <= radiusKm * 1000) candidates.push({ driverId, distance });
  }
  const byDistance = (a, b) => a.distance - b.distance || a.driverId.localeCompare(b.driverId);
  candidates.sort(byDistance);
  const wakeCandidates = [];
  if (includeLastKnown) {
    for (const driverId of eligible) {
      if (freshIds.has(driverId)) continue; // already reachable with a live position (or beyond the limit on purpose)
      const known = await store.getLastKnownDriverLocation(driverId);
      if (!known.location || known.ageMs > settings.pushLocationMaxAgeSeconds * 1000 ||
        !validCoordinates(known.location.latitude, known.location.longitude)) continue;
      const distance = distanceMeters(order.pickupLocation, known.location);
      if (distance <= radiusKm * 1000) wakeCandidates.push({ driverId, distance });
    }
    wakeCandidates.sort(byDistance);
  }
  return { candidates: candidates.slice(0, candidateLimit),
    wakeCandidates: wakeCandidates.slice(0, candidateLimit), stats };
}

export function offerDto(order, distance) {
  const flow = deliveryFlowView(order);
  const values = {
    workflowVersion: order.workflowVersion ?? 1,
    dispatchVersion: order.dispatchVersion ?? null,
    expectedCustomerCashAgorot: order.expectedCustomerCashAgorot ?? null,
    orderId: String(order._id),
    // Opaque revision hint; REST replaces snapshots, clients never order events
    // by wall-clock time. Mongo assignment remains the authority.
    offerVersion: new Date(order.updatedAt ?? order.createdAt).toISOString(),
    status: order.status, storeName: order.storeName, pickupAddress: order.pickupAddress,
    serviceArea: order.serviceArea, pickupServiceArea: order.pickupServiceArea ?? null,
    vehicleType: order.vehicleType ?? null, parcelSize: order.parcelSize ?? null,
    parcelReady: order.parcelReady, driverEarningsAgorot: order.driverEarningsAgorot ?? null,
    estimatedDriverEarningsAgorot: flow.estimatedDriverEarningsAgorot,
    priceStatus: order.priceStatus ?? (order.deliveryFeeAgorot == null ? "pending" : "final"),
    approximateDistanceMeters: Math.round(distance),
    expiresAt: new Date(order.searchDeadlineAt).toISOString(),
    createdAt: new Date(order.createdAt).toISOString(),
  };
  return Object.fromEntries(OFFER_FIELDS.map(key => [key, values[key]]));
}

export async function availableNearbyOffers(driver, store, settings = config, eta = null) {
  const filter = await eligibleOrderFilter(driver);
  if (!filter) return [];
  const items = [];
  const snapshot = await eligibilitySnapshot();
  for await (const order of Order.find(filter).sort({ createdAt: 1 }).lean().cursor({ batchSize: 100 })) {
    const { candidates } = await selectNearbyDrivers(order, store, settings, { snapshot });
    const candidate = candidates.find(c => c.driverId === String(driver._id));
    // Recheck after async GEO work, including the deadline and assignment.
    if (candidate && await Order.exists({ _id: order._id, ...searchableFilter(driver._id) }))
      items.push({ order, offer: { ...await orderView(order, "driver"), ...offerDto(order, candidate.distance),
        offerExpiresAt: new Date(order.searchDeadlineAt).toISOString() } });
  }
  if (!eta || !items.length) return items.map(item => item.offer);
  // Driving time/distance to the pickup is decoration only: it can fail or be slow
  // without hiding, reordering or delaying an offer beyond a short wait.
  let origin = null;
  try {
    const latest = await store.getLatestDriverLocation(String(driver._id));
    if (latest.fresh && validCoordinates(latest.location?.latitude, latest.location?.longitude)) origin = latest.location;
  } catch { /* straight-line distance stays */ }
  return eta.decorate(driver, items, origin);
}
