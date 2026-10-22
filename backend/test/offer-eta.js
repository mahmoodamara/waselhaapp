import assert from "node:assert/strict";
import { ageJourneyFixture } from './helpers/journey.js';
import { before, beforeEach, after, test } from "node:test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { createClient } from "redis";
const uri = process.env.ROUTES_TEST_URI;
if (!uri || !new URL(uri).pathname.endsWith("_test") || !process.env.REDIS_TEST_URL)
  throw new Error("Set ROUTES_TEST_URI to a dedicated *_test database and REDIS_TEST_URL to test Redis.");
process.env.MONGODB_URI = uri;
process.env.JWT_SECRET = "phase5-offer-eta-test-secret";
delete process.env.GOOGLE_ROUTES_API_KEY;
const { User, Order, connectDatabase } = await import("../src/models/index.js");
const { createApp } = await import("../src/app.js");
const { createLocationStore } = await import("../src/services/locationStore.js");
const { createGoogleRoutesClient, SUMMARY_FIELD_MASK } = await import("../src/services/googleRoutes.js");
const { createOfferEtaService } = await import("../src/services/offerEta.js");
const { config } = await import("../src/config.js");
const redis = createClient({ url: process.env.REDIS_TEST_URL, disableOfflineQueue: true });
redis.on("error", () => {});
const prefix = `phase5-eta-test:${randomUUID()}:driver:`;
const store = createLocationStore(redis, config, prefix);
const KEY = "synthetic-offer-eta-key-never-printed";
const PICKUP = { lat: 32.75, lng: 35.34 };
let server, base, merchant, google, eta, offset;

function fakeGoogle() {
  const state = { calls: [], mode: "ok", delayMs: 0 };
  state.fetch = async (url, init) => {
    state.calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    if (state.delayMs) await new Promise(resolve => setTimeout(resolve, state.delayMs));
    if (state.mode === "down") return { ok: false, status: 503, text: async () => "" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ routes: [{ duration: "420s", distanceMeters: 2150 }] }) };
  };
  return state;
}
const sign = account => jwt.sign({ ver: account.authVersion ?? 0 }, process.env.JWT_SECRET, { subject: String(account._id), expiresIn: "5m" });
async function request(path, account, method = "GET", body) {
  const response = await fetch(`${base}/api${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${sign(account)}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}
async function user(extra = {}) {
  return (await User.create({ login: randomUUID(), name: "Offer ETA fixture", passwordHash: "not-a-login-fixture",
    role: "driver", active: true, availableForOrders: true, vehicleType: "car", serviceAreas: ["kafr-kanna"], ...extra })).toObject();
}
const sessions = new Map();
async function locate(driver, lat = 32.751, lng = 35.341) {
  const id = String(driver._id);
  let state = sessions.get(id);
  if (!state) { state = { sessionId: randomUUID(), sequence: 0, measuredAt: 0 }; sessions.set(id, state); await store.activateSession(id, state.sessionId); }
  state.measuredAt = Math.max(Date.now(), state.measuredAt + 1);
  await ageJourneyFixture(redis, store, id, lat, lng);
  assert.equal(await store.saveLocation(id, { sessionId: state.sessionId, latitude: lat, longitude: lng, accuracy: 8, heading: null, speed: null,
    measuredAt: state.measuredAt, sequence: ++state.sequence }), "accepted");
}
async function placeOrder() {
  const created = await request("/orders", merchant, "POST", { serviceArea: "kafr-kanna", area: "Public area", customerPhone: "private-phone",
    recipientName: "private-person", finalAddress: "private-destination", deliveryInstructions: "x", parcelDescription: "Box",
    goodsAmountAgorot: 10000, deliveryFeePaidBy: "customer" });
  assert.equal(created.status, 201);
  return created.data._id;
}
const makeEta = (overrides = {}) => createOfferEtaService({ now: () => Date.now() + offset, settings: { ...config, ...overrides },
  routesClient: createGoogleRoutesClient({ settings: { ...config, googleRoutesEnabled: true, googleRoutesApiKey: KEY }, fetchImpl: google.fetch, sleep: async () => {} }) });
const offers = driver => request("/driver/orders/available", driver);
const advance = seconds => { offset += seconds * 1000; };

before(async () => {
  await connectDatabase(); await redis.connect();
  server = createServer(createApp({ locationStore: store, redis, driverRoutes: { currentRoute: async () => ({}) },
    offerEta: { decorate: (...args) => eta.decorate(...args) } }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
  await Order.deleteMany({}); await User.deleteMany({}); sessions.clear();
  offset = 0; google = fakeGoogle(); eta = makeEta();
  merchant = await user({ role: "store", storeName: "Public merchant", pickupAddress: "Public pickup", pickupServiceArea: "kafr-kanna",
    pickupLocation: { ...PICKUP, address: "Public pickup", source: "gps", confirmedAt: new Date() } });
});
after(async () => {
  const keys = []; for await (const key of redis.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) keys.push(...key);
  if (keys.length) await redis.del(keys);
  await Order.deleteMany({}); await User.deleteMany({});
  server.close(); redis.destroy(); await mongoose.disconnect();
});

test("each offer card gets driving time and distance to the pickup, from a summary-only request", async () => {
  const driver = await user(); await locate(driver);
  await placeOrder(); await placeOrder();
  const { status, data } = await offers(driver);
  assert.equal(status, 200);
  assert.equal(data.length, 2);
  for (const offer of data) {
    assert.equal(offer.pickupRouteDurationSeconds, 420);
    assert.equal(offer.pickupRouteDistanceMeters, 2150);
    assert.ok(Number.isFinite(offer.approximateDistanceMeters), "straight-line distance is still there");
  }
  assert.equal(google.calls.length, 2, "one plain route per offer, no matrix");
  for (const call of google.calls) {
    assert.equal(call.headers["X-Goog-FieldMask"], SUMMARY_FIELD_MASK);
    assert.ok(!call.headers["X-Goog-FieldMask"].includes("polyline"));
    assert.equal(call.body.routingPreference, "TRAFFIC_UNAWARE");
    assert.deepEqual(call.body.origin.location.latLng, { latitude: 32.751, longitude: 35.341 });
    assert.deepEqual(call.body.destination.location.latLng, { latitude: PICKUP.lat, longitude: PICKUP.lng });
  }
  assert.ok(!JSON.stringify(data).includes(KEY));
});

test("refreshing the list does not ask Google again while the answer is recent and the driver has not moved", async () => {
  const driver = await user(); await locate(driver);
  await placeOrder();
  await offers(driver);
  for (let i = 0; i < 5; i++) { await locate(driver, 32.7511, 35.3411); assert.equal((await offers(driver)).data[0].pickupRouteDurationSeconds, 420); }
  assert.equal(google.calls.length, 1);
  assert.equal(eta.metrics().cacheHit, 5);
});

test("moving far or waiting long recalculates, but never inside the minimum interval", async () => {
  const driver = await user(); await locate(driver);
  await placeOrder();
  await offers(driver);
  await locate(driver, 32.76, 35.35); // about 1.4 km away
  await offers(driver);
  assert.equal(google.calls.length, 1, "inside the minimum interval");
  advance(config.offerEtaMinRecalcSeconds + 1);
  await offers(driver);
  assert.equal(google.calls.length, 2);
  assert.equal(google.calls[1].body.origin.location.latLng.latitude, 32.76);
  advance(config.offerEtaMaxAgeSeconds + 1);
  await offers(driver);
  assert.equal(google.calls.length, 3);
});

test("Google down: every offer is still listed with its straight-line distance, and Google is not hammered", async () => {
  const driver = await user(); await locate(driver);
  const id = await placeOrder();
  google.mode = "down";
  const { status, data } = await offers(driver);
  assert.equal(status, 200);
  assert.equal(data.length, 1);
  assert.equal(data[0]._id, id);
  assert.ok(!("pickupRouteDurationSeconds" in data[0]));
  assert.ok(Number.isFinite(data[0].approximateDistanceMeters));
  const attempts = google.calls.length;
  await offers(driver); await offers(driver);
  assert.equal(google.calls.length, attempts, "inside the failure window Google is not retried");
  advance(config.offerEtaFailureRetrySeconds + 1); google.mode = "ok";
  assert.equal((await offers(driver)).data[0].pickupRouteDurationSeconds, 420);
});

test("disabled or unconfigured Google changes nothing about the offers", async () => {
  const driver = await user(); await locate(driver);
  await placeOrder();
  eta = createOfferEtaService({ routesClient: createGoogleRoutesClient({ settings: { ...config, googleRoutesEnabled: false, googleRoutesApiKey: KEY }, fetchImpl: google.fetch }) });
  const { status, data } = await offers(driver);
  assert.equal(status, 200); assert.equal(data.length, 1);
  assert.ok(!("pickupRouteDurationSeconds" in data[0]));
  assert.equal(google.calls.length, 0);
});

test("a global per-minute cap leaves the extra cards on straight-line distance", async () => {
  eta = makeEta({ offerEtaMaxPerMin: 2 });
  const driver = await user(); await locate(driver);
  for (let i = 0; i < 4; i++) await placeOrder();
  const { data } = await offers(driver);
  assert.equal(data.length, 4);
  assert.equal(data.filter(o => o.pickupRouteDurationSeconds === 420).length, 2);
  assert.equal(google.calls.length, 2);
  assert.equal(eta.metrics().skippedBudget, 2);
  advance(61);
  assert.equal((await offers(driver)).data.filter(o => o.pickupRouteDurationSeconds === 420).length, 4);
});

test("a slow Google answer never holds the list; it is cached for the next refresh", async () => {
  eta = makeEta({ offerEtaWaitMs: 200 });
  const driver = await user(); await locate(driver);
  await placeOrder();
  google.delayMs = 500;
  const started = Date.now();
  const first = await offers(driver);
  assert.ok(Date.now() - started < 450, "the list does not wait for Google");
  assert.equal(first.data.length, 1);
  assert.ok(!("pickupRouteDurationSeconds" in first.data[0]));
  await new Promise(resolve => setTimeout(resolve, 500));
  const second = await offers(driver);
  assert.equal(second.data[0].pickupRouteDurationSeconds, 420);
  assert.equal(google.calls.length, 1);
});

test("simultaneous list requests share one Google call per offer", async () => {
  const driver = await user(); await locate(driver);
  await placeOrder();
  google.delayMs = 80;
  const results = await Promise.all(Array.from({ length: 5 }, () => offers(driver)));
  assert.ok(results.every(r => r.status === 200 && r.data[0].pickupRouteDurationSeconds === 420));
  assert.equal(google.calls.length, 1);
});

test("a driver without a fresh location gets no offers and no Google call", async () => {
  const driver = await user();
  await placeOrder();
  const { status, data } = await offers(driver);
  assert.equal(status, 200); assert.deepEqual(data, []);
  assert.equal(google.calls.length, 0);
});
