// Canonical, additive Phase 3 wire contract, consumed by backend and driver app.
export const REALTIME = Object.freeze({
  location: "driver:location", session: "driver:session", error: "driver:realtime-error",
  offerCreated: "driver:offer-created", offerUpdated: "driver:offer-updated",
  offerRemoved: "driver:offer-removed", orderChanged: "driver:order-changed",
  maxPayloadBytes: 2048, maxAgeMs: 15000, futureSkewMs: 5000,
  maxAccuracy: 100, maxSpeed: 100, maxSequence: 2147483647, publishIntervalMs: 3000,
});

// Additive Phase 8 endpoints; samples use the exact Phase 3 eight-field DTO.
export const BACKGROUND = Object.freeze({
  session: "/driver/location/background/session",
  renew: "/driver/location/background/renew",
  maxShiftSeconds: 12 * 60 * 60,
  renewBeforeMs: 5 * 60 * 1000,
  upload: "/driver/location/background",
  scope: "driver-location:upload", audience: "waselha-background-location",
  terminalCodes: ["tracking_disabled", "stale_session", "session_expired", "unauthorized", "unauthenticated", "forbidden"],
});

// Phase 7: a separate read-only namespace. Clients cannot choose a room or order.
export const TRACKING = Object.freeze({
  namespace: "/customer-tracking", snapshotEndpoint: "/tracking/snapshot",
  snapshot: "customer:tracking-snapshot", location: "customer:driver-location",
  ended: "customer:tracking-ended", orderChanged: "customer:order-changed",
  error: "customer:tracking-error", resync: "customer:tracking-resync",
  audience: "waselha-customer-tracking", purpose: "tracking", credentialTtlSeconds: 4 * 60 * 60,
  allowedStatuses: Object.freeze(["collected", "driver_at_destination"]),
  endedStatuses: Object.freeze(["delivered", "cancelled", "delivery_failed", "returning", "returned"]),
});
// Every location is allow-listed; no driver/session/sequence/speed/route data.
export const CUSTOMER_LOCATION_FIELDS = Object.freeze([
  "latitude", "longitude", "accuracy", "heading", "measuredAt", "receivedAt", "fresh",
]);
// Customer-only orderId is the same opaque publicReference as the customer
// REST view, never the MongoDB ID used by driver/admin APIs.
// Snapshots/location events: { orderId, status, state, location: DTO|null,
// freshForMs, serverTime }. state = not_started|unavailable|stale|live|ended.
// ended/orderChanged: { orderId, status }; error: { code }.

// Offer events carry this allow-listed DTO; removed/orderChanged carry only
// { orderId }. Events invalidate REST state and never grant an assignment.
export const OFFER_FIELDS = Object.freeze([
  "workflowVersion", "dispatchVersion", "expectedCustomerCashAgorot",
  "orderId", "offerVersion", "status", "storeName", "pickupAddress",
  "serviceArea", "pickupServiceArea", "vehicleType", "parcelSize", "parcelReady",
  "driverEarningsAgorot", "estimatedDriverEarningsAgorot", "priceStatus",
  "approximateDistanceMeters", "expiresAt", "createdAt",
]);
