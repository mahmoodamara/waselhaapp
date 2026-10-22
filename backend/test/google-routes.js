import assert from "node:assert/strict";
import { test } from "node:test";
import { createGoogleRoutesClient, parseDurationSeconds, travelModeFor, RouteProviderError,
  FIELD_MASK, ROUTES_ENDPOINT } from "../src/services/googleRoutes.js";
import { encodePolyline, decodePolyline, distanceToPolylineMeters } from "../../shared/polyline.js";

// No test here may reach Google: every client receives a fake transport.
const SECRET = "synthetic-google-key-never-printed";
const settings = { googleRoutesEnabled: true, googleRoutesApiKey: SECRET, googleRoutesTimeoutMs: 1000, googleRoutesMaxAttempts: 2,
  googleRoutesRoutingPreference: "TRAFFIC_UNAWARE", googleRoutesTravelModes: { car: "DRIVE", motorcycle: "TWO_WHEELER" } };
const line = encodePolyline([{ latitude: 32.7456, longitude: 35.337 }, { latitude: 32.75, longitude: 35.34 }]);
const ok = body => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const status = code => ({ ok: false, status: code, text: async () => "provider body that must never surface" });
const good = () => ok({ routes: [{ duration: "615s", distanceMeters: 3420, polyline: { encodedPolyline: line } }] });
const origin = { lat: 32.75, lng: 35.34 }, destination = { lat: 32.7456, lng: 35.337 };
function client(responses, extra = {}) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, api: createGoogleRoutesClient({ settings: { ...settings, ...extra.settings }, fetchImpl, sleep: async () => {}, random: () => 0, ...extra }) };
}
const reject = async (promise, code) => assert.rejects(promise, error => error instanceof RouteProviderError && error.code === code && !error.message.includes(SECRET));

test("request: POST to the v2 endpoint with key header, exact field mask, origin, destination, mode and preference", async () => {
  const { calls, api } = client([good()]);
  const route = await api.computeRoute({ origin, destination, vehicleType: "car" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ROUTES_ENDPOINT);
  assert.equal(new URL(calls[0].url).host, "routes.googleapis.com");
  assert.equal(new URL(calls[0].url).pathname, "/directions/v2:computeRoutes");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["X-Goog-FieldMask"], "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline");
  assert.equal(FIELD_MASK, calls[0].init.headers["X-Goog-FieldMask"]);
  assert.ok(!FIELD_MASK.includes("*"));
  assert.equal(calls[0].init.headers["X-Goog-Api-Key"], SECRET);
  assert.ok(!calls[0].url.includes(SECRET), "key must not be in the URL");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.origin.location.latLng, { latitude: 32.75, longitude: 35.34 });
  assert.deepEqual(body.destination.location.latLng, { latitude: 32.7456, longitude: 35.337 });
  assert.equal(body.travelMode, "DRIVE");
  assert.equal(body.routingPreference, "TRAFFIC_UNAWARE");
  assert.ok(!JSON.stringify(body).includes(SECRET));
  assert.deepEqual(route, { distanceMeters: 3420, durationSeconds: 615, encodedPolyline: line });
});

test("travel mode comes from one central mapping", async () => {
  assert.equal(travelModeFor("car", settings), "DRIVE");
  assert.equal(travelModeFor("motorcycle", settings), "TWO_WHEELER");
  assert.equal(travelModeFor(undefined, settings), "DRIVE");
  const { calls, api } = client([good()]);
  await api.computeRoute({ origin, destination, vehicleType: "motorcycle" });
  assert.equal(JSON.parse(calls[0].init.body).travelMode, "TWO_WHEELER");
});

test("duration wire format is normalised to whole seconds and absent zero values are zero", async () => {
  assert.equal(parseDurationSeconds("615s"), 615);
  assert.equal(parseDurationSeconds("12.9s"), 12);
  assert.equal(parseDurationSeconds(undefined), 0);
  for (const bad of ["615", "-5s", "abc", 615, null, "1e3s"]) assert.throws(() => parseDurationSeconds(bad), RouteProviderError);
  const { api } = client([ok({ routes: [{ polyline: { encodedPolyline: "" } }] })]);
  assert.deepEqual(await api.computeRoute({ origin, destination }), { distanceMeters: 0, durationSeconds: 0, encodedPolyline: "" });
});

test("invalid coordinates and a missing key never call Google", async () => {
  const { calls, api } = client([good()]);
  for (const bad of [{ lat: 91, lng: 0 }, { lat: NaN, lng: 1 }, null, { lat: "32", lng: 35 }])
    await reject(api.computeRoute({ origin: bad, destination }), "invalid_coordinates");
  await reject(api.computeRoute({ origin, destination: { lat: 0, lng: 999 } }), "invalid_coordinates");
  const unconfigured = client([good()], { settings: { googleRoutesApiKey: "" } });
  await reject(unconfigured.api.computeRoute({ origin, destination }), "not_configured");
  assert.equal(unconfigured.api.configured, false);
  const disabled = client([good()], { settings: { googleRoutesEnabled: false } });
  await reject(disabled.api.computeRoute({ origin, destination }), "not_configured");
  assert.equal(disabled.api.configured, false);
  assert.equal(calls.length + unconfigured.calls.length + disabled.calls.length, 0);
});

test("no routes and malformed payloads are normalised errors, never retried", async () => {
  for (const [body, code] of [
    [{ routes: [] }, "no_route"], [{}, "no_route"],
    [{ routes: [{ duration: "10s", distanceMeters: -4, polyline: { encodedPolyline: line } }] }, "malformed_response"],
    [{ routes: [{ duration: "10s", distanceMeters: 5, polyline: { encodedPolyline: "\u0001bad" } }] }, "malformed_response"],
    [{ routes: [{ duration: "10s", distanceMeters: 5 }] }, "malformed_response"],
    [{ routes: [{ duration: 10, distanceMeters: 5, polyline: { encodedPolyline: line } }] }, "malformed_response"],
  ]) {
    const { calls, api } = client([ok(body)]);
    await reject(api.computeRoute({ origin, destination }), code);
    assert.equal(calls.length, 1);
  }
  const garbage = client([{ ok: true, status: 200, text: async () => "<html>" }]);
  await reject(garbage.api.computeRoute({ origin, destination }), "malformed_response");
});

test("HTTP failures map to codes; only transient ones retry, with a bounded attempt count", async () => {
  for (const [code, expected, attempts] of [[400, "bad_request", 1], [404, "bad_request", 1], [401, "provider_auth", 1],
    [403, "provider_auth", 1], [429, "quota_exceeded", 1], [500, "provider_error", 2], [503, "provider_error", 2]]) {
    const { calls, api } = client([status(code)]);
    await reject(api.computeRoute({ origin, destination }), expected);
    assert.equal(calls.length, attempts, `HTTP ${code}`);
  }
});

test("timeout and network failure retry once, then recover or fail", async () => {
  const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
  const recovered = client([timeout, good()]);
  assert.equal((await recovered.api.computeRoute({ origin, destination })).distanceMeters, 3420);
  assert.equal(recovered.calls.length, 2);
  const slow = client([timeout]);
  await reject(slow.api.computeRoute({ origin, destination }), "timeout");
  assert.equal(slow.calls.length, 2);
  assert.ok(slow.calls[0].init.signal, "every request carries an abort signal");
  const down = client([new TypeError("fetch failed")]);
  await reject(down.api.computeRoute({ origin, destination }), "network_error");
  const transientThenBad = client([status(503), status(400)]);
  await reject(transientThenBad.api.computeRoute({ origin, destination }), "bad_request");
  assert.equal(transientThenBad.calls.length, 2);
});

test("repeated provider failures open a temporary backoff, then Google is tried again", async () => {
  let time = 1_000_000;
  const { calls, api } = client([status(503)], { now: () => time, failureThreshold: 3, backoffMs: 30000 });
  await reject(api.computeRoute({ origin, destination }), "provider_error"); // 2 failures
  await reject(api.computeRoute({ origin, destination }), "provider_error"); // opens
  assert.equal(api.backingOff, true);
  const before = calls.length;
  await reject(api.computeRoute({ origin, destination }), "provider_backoff");
  assert.equal(calls.length, before, "no request while backing off");
  time += 31000;
  assert.equal(api.backingOff, false);
  await reject(api.computeRoute({ origin, destination }), "provider_error");
  assert.ok(calls.length > before);
});

test("caller input errors never open the provider backoff", async () => {
  const { api } = client([status(400)], { failureThreshold: 2 });
  for (let i = 0; i < 6; i++) await reject(api.computeRoute({ origin, destination }), "bad_request");
  assert.equal(api.backingOff, false);
});

test("polyline codec round-trips and measures distance to the line", () => {
  const points = [{ latitude: 32.7456, longitude: 35.337 }, { latitude: 32.75, longitude: 35.34 }, { latitude: 32.76, longitude: 35.35 }];
  const decoded = decodePolyline(encodePolyline(points));
  assert.equal(decoded.length, 3);
  for (const [i, p] of decoded.entries()) {
    assert.ok(Math.abs(p.latitude - points[i].latitude) < 1e-5 && Math.abs(p.longitude - points[i].longitude) < 1e-5);
  }
  assert.ok(distanceToPolylineMeters(points[1], decoded) < 2);
  // ~0.001 deg of longitude at this latitude is ~93 m, perpendicular to a N-S line.
  const ns = decodePolyline(encodePolyline([{ latitude: 32.74, longitude: 35.34 }, { latitude: 32.76, longitude: 35.34 }]));
  const away = distanceToPolylineMeters({ latitude: 32.75, longitude: 35.341 }, ns);
  assert.ok(away > 85 && away < 100, `got ${away}`);
  for (const bad of [null, "", 5, "!!!!", "\u0001", "_".repeat(10)]) assert.equal(decodePolyline(bad), null);
  assert.equal(distanceToPolylineMeters(points[0], []), Infinity);
});

test("an automated test process can never enable the real Google client, whatever .env says", async () => {
  const saved = { enabled: process.env.GOOGLE_ROUTES_ENABLED, context: process.env.NODE_TEST_CONTEXT };
  process.env.GOOGLE_ROUTES_ENABLED = "true"; process.env.NODE_TEST_CONTEXT = "child-v8";
  try {
    const { pathToFileURL } = await import("node:url");
    const fresh = await import(`${pathToFileURL(new URL("../src/config.js", import.meta.url).pathname.replace(/^\/(\w:)/, "$1")).href}?guard=${Date.now()}`);
    assert.equal(fresh.config.googleRoutesEnabled, false);
  } finally {
    for (const [key, name] of [["enabled", "GOOGLE_ROUTES_ENABLED"], ["context", "NODE_TEST_CONTEXT"]])
      saved[key] === undefined ? delete process.env[name] : process.env[name] = saved[key];
  }
});
