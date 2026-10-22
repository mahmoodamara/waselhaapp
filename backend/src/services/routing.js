import { config } from "../config.js";
import { fail } from "./validation.js";
import { validCoordinates } from "./location.js";

// One OSRM driving adapter. Configure an authorized service; the public demo
// is deliberately not a default. No geocoder or straight-line fallback.
let inFlight = 0;
const maxInFlight = 4;
const maxResponseBytes = 64 * 1024;
export function normalizeRouteDistance(value) {
  if (!Number.isFinite(value) || value < 0) fail("routing_unavailable", 503);
  const meters = Math.round(value);
  if (!Number.isSafeInteger(meters) || meters < 0 || !Number.isSafeInteger(meters * 2 + 5))
    fail("routing_unavailable", 503);
  return meters;
}
// Whether the configured routing service answers a small real request. Cached for
// half a minute so a monitor polling /api/ready does not hammer it. Reported only:
// a down router does not make the app "not ready" (orders are still taken and are
// priced later), but it is the first thing to check when prices are missing.
let health = { at: 0, value: "unknown" };
export async function routingHealth(now = Date.now()) {
  if (!config.routingBaseUrl) return "not_configured";
  if (now - health.at < 30000) return health.value;
  let value = "ok";
  try {
    await getRouteDistance({ pickup: { lat: 32.7459862, lng: 35.3398025 }, destination: { lat: 32.7477, lng: 35.3427 } });
  } catch { value = "unreachable"; }
  health = { at: now, value };
  return value;
}
export async function getRouteDistance({ pickup, destination }) {
  if (!validCoordinates(pickup?.lat, pickup?.lng) || !validCoordinates(destination?.lat, destination?.lng))
    fail("route_inputs_required", 422);
  if (!config.routingBaseUrl || inFlight >= maxInFlight) fail("routing_unavailable", 503);
  inFlight++;
  try {
    const coordinates = `${pickup.lng},${pickup.lat};${destination.lng},${destination.lat}`;
    const response = await fetch(`${config.routingBaseUrl}/route/v1/driving/${coordinates}?overview=false&steps=false&alternatives=false`, {
      headers: { Accept: "application/json", "User-Agent": "Waselha/0.1" },
      signal: AbortSignal.timeout(config.routingTimeoutMs), redirect: "error",
    });
    if (!response.ok) throw new Error("provider failed");
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > maxResponseBytes) throw new Error("provider response too large");
      chunks.push(chunk);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (data.code !== "Ok" || !Array.isArray(data.routes) || !data.routes.length)
      throw new Error("no route");
    return { distanceMeters: normalizeRouteDistance(data.routes[0].distance), provider: "osrm" };
  } catch {
    // No coordinates, request URLs, provider payloads or stack traces in errors.
    fail("routing_unavailable", 503);
  } finally { inFlight--; }
}
