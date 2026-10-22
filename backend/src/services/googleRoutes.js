import { config } from "../config.js";
import { validCoordinates } from "./location.js";
import { decodePolyline, MAX_POLYLINE_CHARS } from "../../../shared/polyline.js";

// The only place that talks to Google Routes API v2 (computeRoutes). Used for
// the driver's operational route; order prices come from OSRM and never from here.
export const ROUTES_ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";
// Exactly what the app uses. Never "*" or "routes": unrequested fields change the bill.
export const FIELD_MASK = "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline";
// Offer cards need only time and distance: no line is requested or returned.
export const SUMMARY_FIELD_MASK = "routes.duration,routes.distanceMeters";
const MAX_RESPONSE_CHARS = MAX_POLYLINE_CHARS + 2048;

// Errors carry a code only: no URL, key, coordinates or provider body.
export class RouteProviderError extends Error {
  constructor(code, { retryable = false, providerHealth = false } = {}) {
    super(code);
    this.code = code;
    this.retryable = retryable;          // worth another attempt inside this request
    this.providerHealth = providerHealth; // counts toward the temporary backoff
  }
}

export function travelModeFor(vehicleType, settings = config) {
  return settings.googleRoutesTravelModes[vehicleType] ?? settings.googleRoutesTravelModes.car;
}

// Google sends duration as a protobuf string such as "615s" (sometimes "615.5s").
// Zero values are omitted in proto3 JSON, so an absent number means zero.
export function parseDurationSeconds(value) {
  if (value === undefined) return 0;
  const match = typeof value === "string" ? /^(\d{1,9})(?:\.\d{1,9})?s$/.exec(value) : null;
  if (!match) throw new RouteProviderError("malformed_response");
  return Number(match[1]);
}

export function normalizeRoute(data, { summary = false } = {}) {
  const route = Array.isArray(data?.routes) ? data.routes[0] : undefined;
  if (!route) throw new RouteProviderError("no_route");
  const meters = route.distanceMeters === undefined ? 0 : route.distanceMeters;
  if (!Number.isSafeInteger(meters) || meters < 0) throw new RouteProviderError("malformed_response");
  if (summary) return { distanceMeters: meters, durationSeconds: parseDurationSeconds(route.duration) };
  const encodedPolyline = route.polyline?.encodedPolyline ?? "";
  if (typeof encodedPolyline !== "string") throw new RouteProviderError("malformed_response");
  // A real route always has a line; only a zero-length one may omit it.
  if (encodedPolyline === "" ? meters > 0 : !decodePolyline(encodedPolyline))
    throw new RouteProviderError("malformed_response");
  return { distanceMeters: meters, durationSeconds: parseDurationSeconds(route.duration), encodedPolyline };
}

function requestBody(origin, destination, travelMode, preference) {
  const waypoint = point => ({ location: { latLng: { latitude: point.lat, longitude: point.lng } } });
  return { origin: waypoint(origin), destination: waypoint(destination), travelMode, routingPreference: preference };
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createGoogleRoutesClient({ settings = config, fetchImpl = globalThis.fetch, sleep = delay,
  random = Math.random, now = Date.now, failureThreshold = 5, backoffMs = 30000 } = {}) {
  let consecutiveFailures = 0, openUntil = 0;
  const noteHealth = healthy => {
    if (healthy) { consecutiveFailures = 0; return; }
    if (++consecutiveFailures >= failureThreshold) { openUntil = now() + backoffMs; consecutiveFailures = 0; }
  };

  async function attempt(body, summary) {
    let response, text;
    try {
      response = await fetchImpl(ROUTES_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": settings.googleRoutesApiKey, "X-Goog-FieldMask": summary ? SUMMARY_FIELD_MASK : FIELD_MASK },
        body: JSON.stringify(body), redirect: "error",
        signal: AbortSignal.timeout(settings.googleRoutesTimeoutMs),
      });
      text = response.ok ? await response.text() : "";
    } catch (error) {
      const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
      throw new RouteProviderError(timedOut ? "timeout" : "network_error", { retryable: true, providerHealth: true });
    }
    if (!response.ok) {
      const status = response.status;
      if (status === 429) throw new RouteProviderError("quota_exceeded", { providerHealth: true });
      if (status === 401 || status === 403) throw new RouteProviderError("provider_auth", { providerHealth: true });
      if (status >= 500) throw new RouteProviderError("provider_error", { retryable: true, providerHealth: true });
      throw new RouteProviderError("bad_request"); // 400/404: our input, not provider health
    }
    if (text.length > MAX_RESPONSE_CHARS) throw new RouteProviderError("malformed_response");
    let data;
    try { data = JSON.parse(text); } catch { throw new RouteProviderError("malformed_response"); }
    return normalizeRoute(data, { summary });
  }

  return {
    get configured() { return settings.googleRoutesEnabled === true && !!settings.googleRoutesApiKey; },
    get backingOff() { return now() < openUntil; },
    // origin/destination: { lat, lng }. One Google request per call (plus bounded
    // retries of transient failures). Callers decide when a call is justified.
    // summary: duration and distance only (no polyline), for offer cards.
    async computeRoute({ origin, destination, vehicleType, summary = false }) {
      if (!this.configured) throw new RouteProviderError("not_configured");
      if (!validCoordinates(origin?.lat, origin?.lng) || !validCoordinates(destination?.lat, destination?.lng))
        throw new RouteProviderError("invalid_coordinates");
      if (now() < openUntil) throw new RouteProviderError("provider_backoff");
      const body = requestBody(origin, destination, travelModeFor(vehicleType, settings), settings.googleRoutesRoutingPreference);
      let last;
      for (let n = 1; n <= settings.googleRoutesMaxAttempts; n++) {
        try {
          const route = await attempt(body, summary);
          noteHealth(true);
          return route;
        } catch (error) {
          last = error instanceof RouteProviderError ? error : new RouteProviderError("malformed_response");
          if (last.providerHealth) noteHealth(false);
          if (!last.retryable || n === settings.googleRoutesMaxAttempts || now() < openUntil) break;
          // Exponential backoff with jitter, bounded: 200-300 ms, then 400-600 ms.
          await sleep(200 * 2 ** (n - 1) * (1 + random() * 0.5));
        }
      }
      throw last;
    },
  };
}
