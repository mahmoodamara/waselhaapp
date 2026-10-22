import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
const protectedEnvironment = ["staging", "production"].includes(process.env.NODE_ENV);
// Deployed instances receive secrets from the host, never a developer's .env.
if (!protectedEnvironment) dotenv.config({
  path: fileURLToPath(new URL("../.env", import.meta.url)),
  quiet: true,
});
if (!protectedEnvironment && ["staging", "production"].includes(process.env.NODE_ENV))
  throw new Error("Set NODE_ENV in the host environment before starting a deployed instance; .env is development only");
function positiveInteger(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value;
}
function nonNegativeInteger(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer`);
  return value;
}
function enumValue(name, fallback, allowed) {
  const value = (process.env[name] || fallback).trim();
  if (!allowed.includes(value)) throw new Error(`${name} must be one of ${allowed.join(", ")}`);
  return value;
}
function boundedInteger(name, fallback, min, max) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
function httpUrl(name, fallback) {
  const value = (process.env[name] || fallback).replace(/\/$/, "");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an http(s) URL`);
  }
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error(`${name} must be an http(s) URL`);
  return value;
}
function countryCodes(name) {
  const value = (process.env[name] || "").replace(/\s/g, "").toLowerCase();
  if (value && !/^[a-z]{2}(,[a-z]{2})*$/.test(value))
    throw new Error(`${name} must be comma-separated two-letter country codes`);
  return value;
}
function realtimeOrigins() {
  const values = (process.env.REALTIME_ALLOWED_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean);
  return [...new Set(values.map(value => {
    let url;
    try { url = new URL(value); } catch { throw new Error("REALTIME_ALLOWED_ORIGINS must contain explicit HTTP(S) origins"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash || value.includes("*") ||
        (protectedEnvironment && url.protocol !== "https:"))
      throw new Error("REALTIME_ALLOWED_ORIGINS must contain explicit origins (HTTPS in staging/production), without paths or credentials");
    return url.origin;
  }))];
}
function routingUrl() {
  const value = (process.env.ROUTING_BASE_URL || "").trim().replace(/\/$/, "");
  if (!value) return ""; // No public/demo router is enabled implicitly.
  const url = new URL(httpUrl("ROUTING_BASE_URL", value));
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !local) || url.username || url.password || url.search || url.hash)
    throw new Error("ROUTING_BASE_URL must use HTTPS (or local HTTP), without credentials/query/fragment");
  return value;
}
// Hosted OSRM may need time to wake after idling. Keep the wait bounded while
// allowing its first response to complete before leaving a price pending.
const routingTimeoutMs = positiveInteger("ROUTING_TIMEOUT_MS", 30000);
if (routingTimeoutMs > 30000) throw new Error("ROUTING_TIMEOUT_MS must be at most 30000");
// Number of reverse-proxy hops to trust for the client IP (X-Forwarded-For).
// Unset = none: req.ip is the direct peer. Required behind a proxy, otherwise
// every client shares the proxy's IP in rate limits and audit records.
function trustProxy() {
  const value = (process.env.TRUST_PROXY || "").trim();
  if (!value || value === "false") return false;
  const hops = Number(value);
  if (!Number.isInteger(hops) || hops < 1 || hops > 5) throw new Error("TRUST_PROXY must be a number of proxy hops (1-5)");
  return hops;
}
export const config = {
  textMeApiToken: (process.env.TEXTME_API_TOKEN || "").trim(),
  textMeUsername: (process.env.TEXTME_USERNAME || "").trim(),
  textMeSource: (process.env.TEXTME_SOURCE || "").trim(),
  // Credentials alone never start billing. Automated tests use an injected transport.
  textMeEnabled: process.env.TEXTME_ENABLED === "true" && !process.env.NODE_TEST_CONTEXT,
  backgroundCredentialTtlSeconds: boundedInteger("BACKGROUND_CREDENTIAL_TTL_SECONDS", 3600, 60, 14400),
  realtimeAllowedOrigins: realtimeOrigins(),
  offerRadiusKm: positiveInteger("OFFER_RADIUS_KM", 10),
  offerCandidateLimit: positiveInteger("OFFER_CANDIDATE_LIMIT", 5),
  offerReconcileIntervalMs: positiveInteger("OFFER_RECONCILE_INTERVAL_MS", 5000),
  rateLimitOffersPerMin: positiveInteger("RATE_LIMIT_OFFERS_PER_MIN", 60),
  redisUrl: process.env.REDIS_URL || (protectedEnvironment ? "" : "redis://127.0.0.1:6379"),
  locationTtlSeconds: positiveInteger("LOCATION_TTL_SECONDS", 90),
  presenceTtlSeconds: positiveInteger("PRESENCE_TTL_SECONDS", 45),
  locationFreshMs: positiveInteger("LOCATION_FRESH_MS", 15000),
  // Push notifications for offers (closed or background app). Off unless explicitly enabled, and never
  // inside an automated test process, so a test can not message a real phone.
  pushEnabled: process.env.PUSH_ENABLED === "true" && !process.env.NODE_TEST_CONTEXT,
  expoPushAccessToken: (process.env.EXPO_PUSH_ACCESS_TOKEN || "").trim(),
  // A closed app stops reporting its position, so a push may rely on the last position the phone reported
  // within this many seconds (the live offer path still needs a fresh position, LOCATION_FRESH_MS).
  pushLocationMaxAgeSeconds: boundedInteger("PUSH_LOCATION_MAX_AGE_SECONDS", 600, 60, 3600),
  quickDeliveryEnabled: process.env.QUICK_DELIVERY_ENABLED !== "false",
  unifiedDeliveryEnabled: protectedEnvironment ? process.env.UNIFIED_DELIVERY_ENABLED === "true" : process.env.UNIFIED_DELIVERY_ENABLED !== "false",
  localDeliveryEstimateAgorot: positiveInteger("LOCAL_DELIVERY_ESTIMATE_AGOROT", 1500),
  production: process.env.NODE_ENV === "production",
  protectedEnvironment,
  trustProxy: trustProxy(),
  rateLimitLoginPerMin: positiveInteger("RATE_LIMIT_LOGIN_PER_MIN", 60),
  rateLimitCustomerPerMin: positiveInteger("RATE_LIMIT_CUSTOMER_PER_MIN", 120),
  stuckOrderHours: positiveInteger("STUCK_ORDER_HOURS", 3),
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || "0.0.0.0",
  mongoUri: process.env.MONGODB_URI || (protectedEnvironment ? undefined : "mongodb://127.0.0.1:27017/waselha"),
  jwtSecret: process.env.JWT_SECRET,
  // Configurable pilot defaults, not permanent business policy.
  customerLinkTtlMs: positiveInteger("CUSTOMER_LINK_TTL_HOURS", 24) * 60 * 60 * 1000,
  loginMaxAttempts: positiveInteger("LOGIN_MAX_ATTEMPTS", 5),
  loginLockMs: positiveInteger("LOGIN_LOCK_MINUTES", 15) * 60 * 1000,
  driverSearchTimeoutMs: positiveInteger("DRIVER_SEARCH_TIMEOUT_MINUTES", 10) * 60 * 1000,
  driverArrivalTimeoutMs: positiveInteger("DRIVER_ARRIVAL_TIMEOUT_MINUTES", 20) * 60 * 1000,
  orderTimeoutSweepIntervalMs: positiveInteger("ORDER_TIMEOUT_SWEEP_INTERVAL_MS", 60000),
  // Address search/reverse geocoding: any Nominatim-compatible service. The
  // default public instance is for pilot-scale use only. No key is involved.
  mapsGeocoderUrl: httpUrl("MAPS_GEOCODER_URL", "https://nominatim.openstreetmap.org"),
  mapsContact: (process.env.MAPS_CONTACT || "").trim().slice(0, 100),
  mapsCountryCodes: countryCodes("MAPS_COUNTRY_CODES"),
  // Public Nominatim allows at most one request per second.
  mapsMinIntervalMs: nonNegativeInteger("MAPS_MIN_INTERVAL_MS", 1000),
  // Phase 5: the driver's operational route (distance, ETA, polyline) comes from
  // Google Routes, called by the backend only. OSRM above stays the only price source.
  // Off unless explicitly enabled, so a key sitting in .env never starts billing by itself.
  // Never inside an automated test process (node --test sets NODE_TEST_CONTEXT): tests must not bill Google.
  googleRoutesEnabled: process.env.GOOGLE_ROUTES_ENABLED === "true" && !process.env.NODE_TEST_CONTEXT,
  googleRoutesApiKey: (process.env.GOOGLE_ROUTES_API_KEY || "").trim(),
  googleRoutesTimeoutMs: boundedInteger("GOOGLE_ROUTES_TIMEOUT_MS", 4000, 500, 15000),
  googleRoutesMaxAttempts: boundedInteger("GOOGLE_ROUTES_MAX_ATTEMPTS", 2, 1, 3),
  // TRAFFIC_AWARE and TRAFFIC_AWARE_OPTIMAL bill under a higher Google SKU
  // (Compute Routes Pro). The pilot default is the cheapest option.
  googleRoutesRoutingPreference: enumValue("GOOGLE_ROUTES_ROUTING_PREFERENCE", "TRAFFIC_UNAWARE",
    ["TRAFFIC_UNAWARE", "TRAFFIC_AWARE", "TRAFFIC_AWARE_OPTIMAL"]),
  googleRoutesTravelModes: {
    car: enumValue("GOOGLE_ROUTES_CAR_TRAVEL_MODE", "DRIVE", ["DRIVE"]),
    // TWO_WHEELER coverage is not verified for Israel; DRIVE is the safe default.
    motorcycle: enumValue("GOOGLE_ROUTES_MOTORCYCLE_TRAVEL_MODE", "DRIVE", ["DRIVE", "TWO_WHEELER"]),
  },
  routeMinRecalcSeconds: boundedInteger("ROUTE_MIN_RECALC_SECONDS", 30, 5, 600),
  routeMaxAgeSeconds: boundedInteger("ROUTE_MAX_AGE_SECONDS", 120, 15, 3600),
  routeFailureRetrySeconds: boundedInteger("ROUTE_FAILURE_RETRY_SECONDS", 10, 1, 300),
  routeOffRouteThresholdMeters: boundedInteger("ROUTE_OFF_ROUTE_THRESHOLD_METERS", 100, 30, 1000),
  routeOffRouteConfirmations: boundedInteger("ROUTE_OFF_ROUTE_CONFIRMATIONS", 3, 2, 10),
  routeOffRouteMaxAccuracyMeters: boundedInteger("ROUTE_OFF_ROUTE_MAX_ACCURACY_METERS", 50, 10, 100),
  // Offer-card ETA (driver -> pickup): one plain route per (driver, offer), cached by time and
  // movement, with a global per-minute cap. Beyond the cap the card shows the straight-line distance.
  offerEtaMaxAgeSeconds: boundedInteger("OFFER_ETA_MAX_AGE_SECONDS", 90, 15, 3600),
  offerEtaMinRecalcSeconds: boundedInteger("OFFER_ETA_MIN_RECALC_SECONDS", 45, 5, 600),
  offerEtaMoveMeters: boundedInteger("OFFER_ETA_MOVE_METERS", 250, 50, 5000),
  offerEtaFailureRetrySeconds: boundedInteger("OFFER_ETA_FAILURE_RETRY_SECONDS", 30, 5, 600),
  offerEtaMaxPerMin: boundedInteger("OFFER_ETA_MAX_PER_MIN", 30, 1, 600),
  offerEtaWaitMs: boundedInteger("OFFER_ETA_WAIT_MS", 2500, 200, 10000),
  routeRateLimitPerMin: boundedInteger("ROUTE_RATE_LIMIT_PER_MIN", 12, 1, 120),
  routeOrderRateLimitPerMin: boundedInteger("ROUTE_ORDER_RATE_LIMIT_PER_MIN", 20, 1, 240),
  routingBaseUrl: routingUrl(),
  routingTimeoutMs,
  publicBaseUrl: (
    process.env.PUBLIC_BASE_URL || (protectedEnvironment ? "" : "http://localhost:3000")
  ).replace(/\/$/, ""),
};
if (config.routeMaxAgeSeconds < config.routeMinRecalcSeconds)
  throw new Error("ROUTE_MAX_AGE_SECONDS must not be below ROUTE_MIN_RECALC_SECONDS");
