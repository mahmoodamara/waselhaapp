import assert from "node:assert/strict";
import { ageJourneyFixture } from './helpers/journey.js';
import { before, beforeEach, after, test } from "node:test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { createClient } from "redis";
const uri = process.env.ROUTES_TEST_URI;
if (!uri || !new URL(uri).pathname.endsWith("_test") || !process.env.REDIS_TEST_URL)
  throw new Error("Set ROUTES_TEST_URI to a dedicated *_test database and REDIS_TEST_URL to test Redis.");
process.env.MONGODB_URI = uri;
process.env.JWT_SECRET = "phase5-isolated-test-secret";
// Never reach Google from tests: the key is synthetic and every client gets a fake transport.
delete process.env.GOOGLE_ROUTES_API_KEY;
const { User, Order, connectDatabase } = await import("../src/models/index.js");
const { createApp } = await import("../src/app.js");
const { createLocationStore } = await import("../src/services/locationStore.js");
const { createGoogleRoutesClient } = await import("../src/services/googleRoutes.js");
const { createDriverRouteService, resolveDriverRouteDestination } = await import("../src/services/driverRoute.js");
const { config } = await import("../src/config.js");
const { encodePolyline, decodePolyline } = await import("../../shared/polyline.js");
const redis = createClient({ url: process.env.REDIS_TEST_URL, disableOfflineQueue: true });
redis.on("error", () => {});
const prefix = `phase5-test:${randomUUID()}:driver:`;
const store = createLocationStore(redis, config, prefix);
const KEY = "synthetic-phase5-key-never-printed";
const PICKUP = { lat: 32.75, lng: 35.34 }, DROPOFF = { lat: 32.76, lng: 35.35 };
let server, base, merchant, google, service, offset;

function fakeGoogle() {
  const state = { calls: [], mode: "ok", delayMs: 0 };
  state.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    state.calls.push({ url, body, headers: init.headers });
    if (state.delayMs) await new Promise(resolve => setTimeout(resolve, state.delayMs));
    if (state.mode === "down") return { ok: false, status: 503, text: async () => "" };
    const from = body.origin.location.latLng, to = body.destination.location.latLng;
    const middle = { latitude: (from.latitude + to.latitude) / 2, longitude: (from.longitude + to.longitude) / 2 };
    return { ok: true, status: 200, text: async () => JSON.stringify({ routes: [{ duration: "615s", distanceMeters: 3420,
      polyline: { encodedPolyline: encodePolyline([from, middle, to]) } }] }) };
  };
  return state;
}
const sign = account => jwt.sign({ ver: account.authVersion ?? 0 }, process.env.JWT_SECRET, { subject: String(account._id), expiresIn: "5m" });
async function request(path, account, method = "GET", body) {
  const response = await fetch(`${base}/api${path}`, { method,
    headers: { "Content-Type": "application/json", ...(account ? { Authorization: `Bearer ${sign(account)}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}
const route = account => request("/driver/orders/current/route", account);
async function user(extra = {}) {
  return (await User.create({ login: randomUUID(), name: "Phase 5 fixture", passwordHash: "not-a-login-fixture",
    role: "driver", active: true, availableForOrders: true, vehicleType: "car", serviceAreas: ["kafr-kanna"], ...extra })).toObject();
}
const sessions = new Map();
async function locate(driver, lat = PICKUP.lat, lng = PICKUP.lng, accuracy = 8) {
  const id = String(driver._id);
  let state = sessions.get(id);
  if (!state) { state = { sessionId: randomUUID(), sequence: 0, measuredAt: 0 }; sessions.set(id, state); await store.activateSession(id, state.sessionId); }
  state.measuredAt = Math.max(Date.now(), state.measuredAt + 1);
  await ageJourneyFixture(redis, store, id, lat, lng);
  const result = await store.saveLocation(id, { sessionId: state.sessionId, latitude: lat, longitude: lng, accuracy,
    heading: null, speed: null, measuredAt: state.measuredAt, sequence: ++state.sequence });
  assert.equal(result, "accepted");
}
async function assigned(driver) {
  const created = await request("/orders", merchant, "POST", { serviceArea: "kafr-kanna", area: "Public area",
    customerPhone: "private-phone", recipientName: "private-person", finalAddress: "private-destination",
    deliveryInstructions: "private-instructions", parcelDescription: "Box", goodsAmountAgorot: 10000, deliveryFeePaidBy: "customer" });
  assert.equal(created.status, 201);
  await locate(driver);
  assert.equal((await request(`/orders/${created.data._id}/accept`, driver, "POST", {})).status, 200);
  await Order.updateOne({ _id: created.data._id }, { $set: { destinationLocation: { ...DROPOFF, address: "Customer", source: "pin", confirmedAt: new Date() } } });
  return Order.findById(created.data._id).lean();
}
// Same service, but with limits high enough for tests that poll many times in one real minute.
const relaxedLimits = () => {
  service = createDriverRouteService({ locationStore: store, now: () => Date.now() + offset,
    settings: { ...config, routeRateLimitPerMin: 1000, routeOrderRateLimitPerMin: 1000 },
    routesClient: createGoogleRoutesClient({ settings: { ...config, googleRoutesEnabled: true, googleRoutesApiKey: KEY }, fetchImpl: google.fetch, sleep: async () => {} }) });
};
const setStatus = (order, status) => Order.updateOne({ _id: order._id }, { $set: { status } });
const advance = seconds => { offset += seconds * 1000; };

before(async () => {
  await connectDatabase(); await redis.connect();
  server = createServer(createApp({ locationStore: store, redis, driverRoutes: { currentRoute: driver => service.currentRoute(driver) } }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
  await Order.deleteMany({}); await User.deleteMany({}); sessions.clear();
  offset = 0; google = fakeGoogle();
  service = createDriverRouteService({ locationStore: store, now: () => Date.now() + offset,
    routesClient: createGoogleRoutesClient({ settings: { ...config, googleRoutesEnabled: true, googleRoutesApiKey: KEY }, fetchImpl: google.fetch, sleep: async () => {} }) });
  merchant = await user({ role: "store", storeName: "Public merchant", pickupAddress: "Public pickup", pickupServiceArea: "kafr-kanna",
    pickupLocation: { ...PICKUP, address: "Public pickup", source: "gps", confirmedAt: new Date() } });
});
after(async () => {
  const keys = []; for await (const key of redis.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) keys.push(...key);
  if (keys.length) await redis.del(keys);
  await Order.deleteMany({}); await User.deleteMany({});
  server.close(); redis.destroy(); await mongoose.disconnect();
});

test("authentication and authorization: only the assigned driver, only their own route", async () => {
  const driver = await user(), other = await user(), idle = await user();
  const placed = await assigned(driver);
  const mine = await route(driver);
  assert.equal(mine.status, 200);
  assert.equal(mine.data.orderId, String(placed._id));
  assert.equal((await route(idle)).status, 404);
  assert.equal((await route(idle)).data.code, "no_active_assignment");
  assert.equal((await route(merchant)).status, 403);
  assert.equal((await route(null)).status, 401);
  await User.updateOne({ _id: other._id }, { $set: { active: false } });
  assert.equal((await route(other)).status, 401);
  const second = await user(); const secondOrder = await assigned(second);
  await locate(second, 32.7, 35.3); // a different origin proves each route uses its own driver's data
  const theirs = await route(second);
  assert.equal(theirs.data.orderId, String(secondOrder._id));
  assert.notEqual(theirs.data.orderId, mine.data.orderId);
  assert.equal(google.calls.at(-1).body.origin.location.latLng.latitude, 32.7);
});

test("the client cannot choose origin, destination or driver", async () => {
  const driver = await user(); await assigned(driver);
  const hostile = new URLSearchParams({ origin: "1,1", destination: "2,2", driverId: String(new mongoose.Types.ObjectId()), orderId: "x" });
  const response = await fetch(`${base}/api/driver/orders/current/route?${hostile}`, { headers: { Authorization: `Bearer ${sign(driver)}` } });
  assert.equal(response.status, 200);
  const sent = google.calls[0].body;
  assert.deepEqual(sent.origin.location.latLng, { latitude: PICKUP.lat, longitude: PICKUP.lng });
  assert.deepEqual(sent.destination.location.latLng, { latitude: PICKUP.lat, longitude: PICKUP.lng });
});

test("destination follows the real order state; stationary and non-trip states cost nothing", async () => {
  const driver = await user(); const placed = await assigned(driver);
  const expectations = [
    ["driver_assigned", "pickup", PICKUP], ["collected", "customer", DROPOFF], ["returning", "return", PICKUP],
  ];
  for (const [status, type, point] of expectations) {
    await setStatus(placed, status);
    const response = await route(driver);
    assert.equal(response.status, 200, status);
    assert.equal(response.data.stage, status);
    assert.equal(response.data.destinationType, type);
    const sent = google.calls.at(-1).body.destination.location.latLng;
    assert.deepEqual([sent.latitude, sent.longitude], [point.lat, point.lng], status);
  }
  const before = google.calls.length;
  for (const status of ["driver_at_store", "driver_at_destination", "delivery_failed", "delivered", "returned", "cancelled", "searching_driver"]) {
    await setStatus(placed, status);
    const response = await route(driver);
    // Terminal states also drop the assignment in the real flow; either way: no route, no Google.
    assert.ok([404, 409].includes(response.status), status);
  }
  assert.equal(google.calls.length, before);
});

test("server destination rules stay in step with the driver app's navigation stages", async () => {
  const source = readFileSync(new URL("../../driver-app/stages.js", import.meta.url), "utf8");
  const stages = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const order = status => ({ status, pickupLocation: { ...PICKUP }, destinationLocation: { ...DROPOFF } });
  for (const status of ["driver_assigned", "driver_at_store", "collected", "driver_at_destination", "returning", "delivery_failed", "delivered", "cancelled"]) {
    const server = resolveDriverRouteDestination(order(status)), app = stages.navigationDestination(order(status));
    if (server.routable) assert.deepEqual(server.location, app, status);
  }
});

test("fresh Redis location is required; stale, missing or invalid never call Google", async () => {
  const driver = await user(); const placed = await assigned(driver);
  const id = String(driver._id), key = store.keys(id).location;
  const point = JSON.parse(await redis.get(key));
  await redis.del(key);
  assert.equal((await route(driver)).data.code, "location_unavailable");
  await redis.set(key, JSON.stringify({ ...point, measuredAt: Date.now() - 60000 }));
  assert.equal((await route(driver)).data.code, "location_stale");
  await redis.set(key, JSON.stringify({ ...point, latitude: 999 }));
  assert.equal((await route(driver)).data.code, "location_stale");
  assert.equal(google.calls.length, 0);
  await setStatus(placed, "driver_assigned");
});

test("GPS samples alone never call Google; one request, then cache hits", async () => {
  const driver = await user(); await assigned(driver);
  for (let i = 0; i < 6; i++) await locate(driver, PICKUP.lat + i * 1e-5);
  assert.equal(google.calls.length, 0);
  const first = await route(driver);
  assert.equal(first.status, 200);
  for (let i = 0; i < 5; i++) { await locate(driver, PICKUP.lat + i * 1e-5); await route(driver); }
  assert.equal(google.calls.length, 1);
  assert.equal(service.metrics()["routes.cacheHit"], 5);
  assert.equal(service.metrics()["routes.requested"], 1);
});

test("simultaneous identical requests share one upstream call", async () => {
  const driver = await user(); await assigned(driver);
  google.delayMs = 60;
  const results = await Promise.all(Array.from({ length: 6 }, () => route(driver)));
  assert.ok(results.every(r => r.status === 200));
  assert.equal(google.calls.length, 1);
  assert.ok(service.metrics()["routes.singleflightHit"] >= 1);
  assert.equal(new Set(results.map(r => r.data.calculatedAt)).size, 1);
});

test("normalised response DTO: no Google metadata, no secrets", async () => {
  const driver = await user(); await assigned(driver);
  const { status, data } = await route(driver);
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(data).sort(), ["calculatedAt", "destinationType", "distanceMeters", "durationSeconds", "encodedPolyline",
    "orderId", "originMeasuredAt", "source", "stage", "stale"]);
  assert.equal(data.source, "google_routes");
  assert.equal(data.distanceMeters, 3420);
  assert.equal(data.durationSeconds, 615);
  assert.equal(typeof data.durationSeconds, "number");
  assert.ok(decodePolyline(data.encodedPolyline).length >= 2);
  assert.equal(data.stale, false);
  assert.ok(!JSON.stringify(data).includes(KEY));
  assert.ok(Date.parse(data.calculatedAt) > 0 && Date.parse(data.originMeasuredAt) > 0);
});

test("stage change replaces the route immediately, bypassing cooldown, and never serves the old one", async () => {
  const driver = await user(); const placed = await assigned(driver);
  const pickup = await route(driver);
  assert.equal(pickup.data.destinationType, "pickup");
  await setStatus(placed, "collected");
  const customer = await route(driver);
  assert.equal(customer.data.destinationType, "customer");
  assert.notEqual(customer.data.encodedPolyline, pickup.data.encodedPolyline);
  const end = decodePolyline(customer.data.encodedPolyline).at(-1);
  assert.ok(Math.abs(end.latitude - DROPOFF.lat) < 1e-4 && Math.abs(end.longitude - DROPOFF.lng) < 1e-4);
  await setStatus(placed, "returning");
  const back = await route(driver);
  assert.equal(back.data.destinationType, "return");
  assert.notEqual(back.data.encodedPolyline, customer.data.encodedPolyline);
  assert.equal(google.calls.length, 3);
  // Back to a stage whose entry was replaced: it is recomputed, never reused from before.
  await setStatus(placed, "collected");
  assert.equal((await route(driver)).data.destinationType, "customer");
  assert.equal(google.calls.length, 4);
});

test("max age recalculates once; cooldown holds otherwise", async () => {
  const driver = await user(); await assigned(driver);
  await route(driver);
  advance(config.routeMinRecalcSeconds + 1); await route(driver);
  assert.equal(google.calls.length, 1, "cooldown elapsed but route is neither old nor off-route");
  advance(config.routeMaxAgeSeconds); await route(driver);
  assert.equal(google.calls.length, 2);
  assert.equal(service.metrics()["routes.recalculated"], 1);
  await route(driver);
  assert.equal(google.calls.length, 2);
});

test("off-route needs distinct, accurate, consecutive confirmations and the cooldown", async () => {
  relaxedLimits();
  const driver = await user(); await assigned(driver);
  await route(driver); // route runs from the pickup toward the drop-off
  advance(config.routeMinRecalcSeconds + 1);
  const away = [PICKUP.lat + 0.02, PICKUP.lng - 0.02]; // kilometres off the line
  // Inaccurate samples never count.
  for (let i = 0; i < 4; i++) { await locate(driver, ...away, 90); await route(driver); }
  assert.equal(google.calls.length, 1);
  // One outlier, then back on route: the count resets.
  await locate(driver, ...away, 10); await route(driver);
  await locate(driver, PICKUP.lat, PICKUP.lng, 10); await route(driver);
  // The same sample polled repeatedly counts once.
  await locate(driver, ...away, 10);
  for (let i = 0; i < 5; i++) await route(driver);
  assert.equal(google.calls.length, 1);
  await locate(driver, ...away, 10); await route(driver);
  assert.equal(google.calls.length, 1, "only two confirmations so far");
  await locate(driver, ...away, 10);
  await route(driver);
  assert.equal(google.calls.length, 2, "third distinct confirmation recalculates");
  const origin = google.calls[1].body.origin.location.latLng;
  assert.equal(origin.latitude, away[0]);
});

test("off-route inside the cooldown does not call Google", async () => {
  relaxedLimits();
  const driver = await user(); await assigned(driver);
  await route(driver);
  for (let i = 0; i < 6; i++) { await locate(driver, PICKUP.lat + 0.02, PICKUP.lng - 0.02, 10); await route(driver); }
  assert.equal(google.calls.length, 1);
});

test("excessive refresh is rate limited per driver and per order without more Google calls", async () => {
  const driver = await user(); await assigned(driver);
  const statuses = [];
  for (let i = 0; i < config.routeRateLimitPerMin + 3; i++) statuses.push((await route(driver)).status);
  assert.equal(statuses.filter(s => s === 200).length, config.routeRateLimitPerMin);
  assert.equal(statuses.filter(s => s === 429).length, 3);
  assert.equal(google.calls.length, 1);
  assert.equal(service.metrics()["routes.rateLimited"], 3);
  advance(61);
  assert.equal((await route(driver)).status, 200);
});

test("Google outage: clean error, no retry storm, old route kept as stale, order untouched", async () => {
  const driver = await user(); const placed = await assigned(driver);
  google.mode = "down";
  const initial = await route(driver);
  assert.equal(initial.status, 503);
  assert.equal(initial.data.code, "route_unavailable");
  const attempts = google.calls.length;
  assert.equal((await route(driver)).status, 503);
  assert.equal(google.calls.length, attempts, "inside the failure window Google is not retried");
  advance(config.routeFailureRetrySeconds + 1);
  google.mode = "ok";
  assert.equal((await route(driver)).status, 200);
  // Now it breaks while a route is cached and due for renewal.
  advance(config.routeMaxAgeSeconds + 1); google.mode = "down";
  const stale = await route(driver);
  assert.equal(stale.status, 200);
  assert.equal(stale.data.stale, true);
  assert.equal(stale.data.distanceMeters, 3420);
  const fresh = await Order.findById(placed._id).lean();
  assert.equal(fresh.status, "driver_assigned");
  assert.equal(fresh.activeAssignment, true);
});

test("routing never changes an order: price, finance, status, assignment", async () => {
  const driver = await user(); const placed = await assigned(driver);
  const snapshot = async () => JSON.stringify(await Order.findById(placed._id).lean());
  const before = await snapshot();
  await route(driver);
  await locate(driver, PICKUP.lat + 0.02, PICKUP.lng - 0.02, 10);
  advance(config.routeMaxAgeSeconds + 1); await route(driver);
  google.mode = "down"; advance(config.routeMaxAgeSeconds + 1); await route(driver);
  assert.equal(await snapshot(), before);
  const order = JSON.parse(before);
  for (const field of ["deliveryFeeAgorot", "routeDistanceMeters", "platformCommissionAgorot", "driverEarningsAgorot", "expectedCustomerCashAgorot"])
    assert.equal(JSON.parse(await snapshot())[field], order[field], field);
  assert.notEqual(order.routeDistanceMeters, 3420, "the Google distance is a different number from the priced distance");
});

test("logs and metrics carry no key, polyline or coordinates", async () => {
  const driver = await user(); await assigned(driver);
  const lines = [];
  const originals = { log: console.log, error: console.error };
  console.log = line => lines.push(String(line)); console.error = console.log;
  try { await route(driver); google.mode = "down"; advance(config.routeMaxAgeSeconds + 1); await route(driver); }
  finally { console.log = originals.log; console.error = originals.error; }
  const output = lines.join("\n");
  assert.ok(output.includes("route_computed"));
  for (const secret of [KEY, "32.75", "35.34", "_p~", "private-destination"]) assert.ok(!output.includes(secret), secret);
  const metrics = JSON.stringify(service.metrics());
  assert.ok(metrics.includes("routes.requested") && metrics.includes("routes.success") && metrics.includes("routes.failure"));
});

test("unconfigured Google disables only routing", async () => {
  const driver = await user(); await assigned(driver);
  service = createDriverRouteService({ locationStore: store, routesClient: createGoogleRoutesClient({ settings: { ...config, googleRoutesEnabled: true, googleRoutesApiKey: "" }, fetchImpl: google.fetch }) });
  const response = await route(driver);
  assert.equal(response.status, 503);
  assert.equal(response.data.code, "route_unavailable");
  assert.equal(google.calls.length, 0);
  assert.equal((await request("/driver/orders/current", driver)).status, 200);
});
