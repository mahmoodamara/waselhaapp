import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { createClient } from "redis";
const uri = process.env.OFFERS_TEST_URI;
if (!uri || !new URL(uri).pathname.endsWith("_test") || !process.env.REDIS_TEST_URL)
  throw new Error("Set OFFERS_TEST_URI to a dedicated *_test database and REDIS_TEST_URL to test Redis.");
process.env.MONGODB_URI = uri;
process.env.JWT_SECRET = "phase4-isolated-test-secret";
process.env.OFFER_CANDIDATE_LIMIT = "2";
const { User, Order, connectDatabase } = await import("../src/models/index.js");
const { createApp } = await import("../src/app.js");
const { attachRealtime } = await import("../src/realtime/index.js");
const { createLocationStore } = await import("../src/services/locationStore.js");
const { selectNearbyDrivers, offerDto } = await import("../src/services/nearbyOffers.js");
const { processExpiredSearches } = await import("../src/services/orderTimeouts.js");
const { startReadyDispatches } = await import("../src/services/orders.js");
const { calculateRoutePrice } = await import("../src/services/money.js");
const { financeAmounts } = await import("../src/services/orderFinance.js");
const { config } = await import("../src/config.js");
const { REALTIME, OFFER_FIELDS } = await import("../../shared/realtimeContract.js");
const { io } = createRequire(new URL("../../driver-app/package.json", import.meta.url))("socket.io-client");
const redis = createClient({ url: process.env.REDIS_TEST_URL, disableOfflineQueue: true });
redis.on("error", () => {});
const prefix = `phase4-test:${randomUUID()}:driver:`;
const store = createLocationStore(redis, config, prefix);
const sockets = new Set();
let server, realtime, base, merchant;
const sign = user => jwt.sign({ ver: user.authVersion ?? 0 }, process.env.JWT_SECRET,
  { subject: String(user._id), expiresIn: "5m" });
async function user(extra = {}) {
  return (await User.create({ login: randomUUID(), name: "Phase 4 fixture", passwordHash: "not-a-login-fixture",
    role: "driver", active: true, availableForOrders: true, vehicleType: "car", serviceAreas: ["kafr-kanna"], ...extra })).toObject();
}
async function request(path, account, method = "GET", body) {
  const response = await fetch(`${base}/api${path}`, { method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${sign(account)}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}
async function order(extra = {}) {
  const response = await request("/orders", merchant, "POST", { serviceArea: "kafr-kanna", area: "Public area",
    customerPhone: "private-phone", recipientName: "private-person", finalAddress: "private-destination",
    deliveryInstructions: "private-instructions", parcelDescription: "Box", goodsAmountAgorot: 10000,
    deliveryFeePaidBy: "customer", ...extra });
  assert.equal(response.status, 201);
  return Order.findById(response.data._id).lean();
}
const quickOrder = () => order({ workflowVersion: 2, vehicleType: "car", parcelSize: "small", storeAuthorization: true });
// What a quick order looks like once its customer placed the destination, the route was
// priced (1.5 km), and they confirmed the total and said "ready now". No router runs here.
async function makeReady(placed) {
  const priced = calculateRoutePrice(1500);
  await Order.updateOne({ _id: placed._id }, { $set: { ...priced,
    ...financeAmounts(placed.goodsAmountAgorot, priced.deliveryFeeAgorot, "customer"),
    destinationLocation: { lat: 32.76, lng: 35.35, address: "Customer street", source: "gps", confirmedAt: new Date() },
    priceStatus: "final", routeCalculatedAt: new Date(), routeProvider: "osrm",
    recipientName: "Customer", customerPhone: "0501234567", customerConfirmed: true, customerAvailable: true } });
}
const point = (sessionId, lat = 32.75, sequence = 1, measuredAt = Date.now()) => ({ sessionId, latitude: lat,
  longitude: 35.34, accuracy: 8, heading: null, speed: null, measuredAt, sequence });
async function locate(driver, lat = 32.75, locationStore = store) {
  const sessionId = randomUUID(), id = String(driver._id);
  await locationStore.activateSession(id, sessionId);
  assert.equal(await locationStore.saveLocation(id, point(sessionId, lat)), "accepted");
  return sessionId;
}
async function connect(driver, lat, supportedWorkflowVersion) {
  const socket = io(base, { auth: { token: sign(driver), supportedWorkflowVersion }, transports: ["websocket"], reconnection: false, autoConnect: false });
  sockets.add(socket);
  const events = [];
  socket.onAny((event, payload) => events.push({ event, payload }));
  const session = once(socket, REALTIME.session, { signal: AbortSignal.timeout(5000) });
  socket.connect();
  const [{ sessionId }] = await session;
  if (lat !== undefined) {
    const ack = await new Promise(resolve => socket.emit(REALTIME.location, point(sessionId, lat), resolve));
    assert.equal(ack.ok, true);
  }
  return { socket, sessionId, events };
}
async function eventually(predicate) {
  for (let i = 0; i < 150; i++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("Expected realtime state did not arrive");
}
const has = (connection, event, id) => connection.events.some(e => e.event === event && e.payload.orderId === String(id));

before(async () => {
  await connectDatabase(); await redis.connect();
  server = createServer(createApp({ locationStore: store, redis }));
  realtime = attachRealtime(server, store);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
  for (const socket of sockets) socket.disconnect(); sockets.clear();
  await Order.deleteMany({}); await User.deleteMany({});
  await realtime.offers.refresh();
  merchant = await user({ role: "store", storeName: "Public merchant", pickupAddress: "Public pickup", pickupServiceArea: "kafr-kanna",
    pickupLocation: { lat: 32.75, lng: 35.34, address: "Public pickup", source: "gps", confirmedAt: new Date() } });
});
after(async () => {
  for (const socket of sockets) socket.disconnect();
  await realtime.close();
  const keys = []; for await (const key of redis.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) keys.push(...key);
  if (keys.length) await redis.del(keys);
  await Order.deleteMany({}); await User.deleteMany({});
  redis.destroy(); await mongoose.disconnect();
});

for (const [name, overrides] of [
  ["unavailable", { availableForOrders: false }], ["inactive", { active: false }],
  ["wrong vehicle", { vehicleType: "motorcycle" }], ["wrong service area", { serviceAreas: [] }],
]) test(`${name} driver excluded before geographic ranking`, async () => {
  const driver = await user(overrides); await locate(driver);
  const created = await quickOrder();
  await makeReady(created); assert.equal(await startReadyDispatches(), 1);
  const placed = await Order.findById(created._id).lean();
  assert.deepEqual((await selectNearbyDrivers(placed, store)).candidates, []);
  // The same order is offered to a driver who fits.
  const fits = await user(); await locate(fits);
  assert.deepEqual((await selectNearbyDrivers(placed, store)).candidates.map(c => c.driverId), [String(fits._id)]);
});

test("a quick order reaches no socket until its customer is ready; 'not now' removes the offer", async () => {
  const driver = await user(), connection = await connect(driver, 32.751);
  const placed = await quickOrder();
  await realtime.offers.refresh();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok(!has(connection, REALTIME.offerCreated, placed._id), "no offer while waiting for the customer");
  await makeReady(placed);
  assert.equal(await startReadyDispatches(), 1);
  await eventually(() => has(connection, REALTIME.offerCreated, placed._id));
  const token = (await request(`/orders/${placed._id}`, merchant)).data.customerLink.split("/").at(-1);
  assert.equal((await request(`/customer/${token}/availability`, merchant, "POST", { available: false })).status, 200);
  await eventually(() => has(connection, REALTIME.offerRemoved, placed._id));
  assert.equal((await request(`/orders/${placed._id}/accept`, driver, "POST", {})).status, 409);
});

test("busy driver excluded using existing eligibility and unique assignment", async () => {
  const driver = await user(); await locate(driver);
  const first = await order(); assert.equal((await request(`/orders/${first._id}/accept`, driver, "POST", {})).status, 200);
  const second = await order(); assert.deepEqual((await selectNearbyDrivers(second, store)).candidates, []);
});

test("fresh nearby included; stale, missing, invalid and far locations excluded even with GEO membership", async () => {
  // The live dispatcher also prunes stale GEO members. Use a separate real Redis
  // namespace so its asynchronous refresh cannot consume this test's stale samples
  // before the explicit selector call measures them. Keep all behavioral assertions.
  const selectorStore = createLocationStore(redis, config, `${prefix}selector:`);
  const fresh = await user(), stale = await user(), missing = await user(), invalid = await user(), far = await user();
  for (const driver of [fresh, stale, missing, invalid]) await locate(driver, 32.75, selectorStore);
  await locate(far, 33.75, selectorStore);
  const stalePoint = (await selectorStore.getLatestDriverLocation(String(stale._id))).location;
  await redis.set(selectorStore.keys(String(stale._id)).location, JSON.stringify({ ...stalePoint, measuredAt: Date.now() - 60000 }));
  await redis.del(selectorStore.keys(String(missing._id)).location); // GEO has no member TTL.
  await redis.set(selectorStore.keys(String(invalid._id)).location, JSON.stringify({ ...stalePoint, latitude: 999 }));
  const result = await selectNearbyDrivers(await order(), selectorStore);
  assert.deepEqual(result.candidates.map(c => c.driverId), [String(fresh._id)]);
  assert.equal(result.stats.staleLocationCount, 3);
  assert.equal(await redis.zScore(selectorStore.geoKey, String(missing._id)), null);
  assert.equal(await redis.zScore(selectorStore.geoKey, String(stale._id)), null);
});

test("closer before farther; final limit applies after stale rejection", async () => {
  const stale = await user(), near = await user(), middle = await user(), third = await user();
  await locate(stale); await redis.del(store.keys(String(stale._id)).location);
  await locate(third, 32.78); await locate(middle, 32.76); await locate(near, 32.751);
  const result = await selectNearbyDrivers(await order(), store);
  assert.deepEqual(result.candidates.map(c => c.driverId), [String(near._id), String(middle._id)]);
  assert.ok(result.candidates[0].distance < result.candidates[1].distance);
});

test("accepted raw sample updates GEO; rejected ordering cannot move GEO; cleanup preserves a fresh concurrent sample", async () => {
  const driver = await user(), id = String(driver._id), sessionId = await locate(driver);
  const before = await redis.geoPos(store.geoKey, id);
  assert.equal(await store.saveLocation(id, point(sessionId, 33, 1)), "stale_location");
  assert.deepEqual(await redis.geoPos(store.geoKey, id), before);
  await store.removeStaleGeoMember(id);
  assert.notEqual(await redis.zScore(store.geoKey, id), null);
  assert.equal((await store.getLatestDriverLocation(id)).fresh, true);
});

test("only selected authenticated rooms receive offers; unrelated clients cannot join driver rooms", async () => {
  const a = await user(), b = await user(), unrelated = await user(), far = await user();
  const ca = await connect(a, 32.751), cb = await connect(b, 32.76), cu = await connect(unrelated, 32.78), cf = await connect(far, 33.75);
  cu.socket.emit("join", `driver:${a._id}`);
  const placed = await order();
  await eventually(() => has(ca, REALTIME.offerCreated, placed._id) && has(cb, REALTIME.offerCreated, placed._id));
  assert.equal(has(cu, REALTIME.offerCreated, placed._id), false);
  assert.equal(has(cf, REALTIME.offerCreated, placed._id), false);
  const dto = ca.events.find(e => e.event === REALTIME.offerCreated).payload;
  assert.deepEqual(Object.keys(dto).sort(), [...OFFER_FIELDS].sort());
  assert.equal(dto.expiresAt, placed.searchDeadlineAt.toISOString());
  for (const secret of [placed.customerToken, placed.customerPhone, placed.finalAddress, placed.deliveryInstructions])
    assert.equal(JSON.stringify(dto).includes(secret), false);
});

test("disconnect does not change availability; reconnect plus REST snapshot recovers without event history", async () => {
  const driver = await user(), connection = await connect(driver, 32.751), placed = await order();
  await eventually(() => has(connection, REALTIME.offerCreated, placed._id));
  connection.socket.disconnect();
  await eventually(async () => !(await store.getDriverPresence(String(driver._id))).connected);
  assert.equal((await User.findById(driver._id).lean()).availableForOrders, true);
  const snapshot = await request("/driver/orders/available", driver);
  assert.equal(snapshot.status, 200); assert.equal(snapshot.data[0].orderId, String(placed._id));
  await connect(driver);
  assert.equal((await request("/driver/orders/available", driver)).data.length, 1);
  assert.equal((await request("/driver/orders/current", driver)).data, null);
});

test("actual concurrent HTTP accept race has exactly one Mongo winner and losers receive removal", async () => {
  const drivers = await Promise.all(Array.from({ length: 8 }, () => user()));
  const a = await connect(drivers[0], 32.751), b = await connect(drivers[1], 32.752), placed = await order();
  await eventually(() => has(a, REALTIME.offerCreated, placed._id) && has(b, REALTIME.offerCreated, placed._id));
  const results = await Promise.all(drivers.map(driver => request(`/orders/${placed._id}/accept`, driver, "POST", {})));
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal(results.filter(r => r.status === 409).length, 7);
  assert.equal(await Order.countDocuments({ _id: placed._id, activeAssignment: true }), 1);
  assert.equal((await Order.findById(placed._id).lean()).events.filter(e => e.type === "driver_assigned").length, 1);
  await eventually(() => has(a, REALTIME.offerRemoved, placed._id) && has(b, REALTIME.offerRemoved, placed._id));
  for (const driver of drivers) assert.deepEqual((await request("/driver/orders/available", driver)).data, []);
  const winner = drivers[results.findIndex(r => r.status === 200)];
  assert.equal((await request("/driver/orders/current", winner)).data._id, String(placed._id));
  const loser = drivers[results.findIndex(r => r.status !== 200)];
  const retry = await request(`/orders/${placed._id}/accept`, loser, "POST", {});
  assert.equal(retry.status, 409); assert.equal(retry.data.code, "order_unavailable");
});

test("two simultaneous orders cannot create two active assignments for one driver", async () => {
  const driver = await user(), first = await order(), second = await order();
  const results = await Promise.all([first, second].map(o => request(`/orders/${o._id}/accept`, driver, "POST", {})));
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal(await Order.countDocuments({ driverId: driver._id, activeAssignment: true }), 1);
});

for (const action of ["cancel", "expire", "unavailable"]) test(`${action} withdraws offers and REST reflects truth`, async () => {
  const driver = await user(), connection = await connect(driver, 32.751), placed = await order();
  await eventually(() => has(connection, REALTIME.offerCreated, placed._id));
  if (action === "cancel") assert.equal((await request(`/orders/${placed._id}/cancel`, merchant, "POST", {})).status, 200);
  else if (action === "expire") await processExpiredSearches(new Date(placed.searchDeadlineAt.getTime() + 1));
  else assert.equal((await request("/driver/availability", driver, "PATCH", { available: false })).status, 200);
  await eventually(() => has(connection, REALTIME.offerRemoved, placed._id));
  assert.deepEqual((await request("/driver/orders/available", driver)).data, []);
});

test("privacy DTO is allow-listed independently of full documents and restricted nested fields", async () => {
  const placed = await order();
  const dto = offerDto({ ...placed, financialSnapshot: { private: "secret" }, authToken: "secret", notes: "secret" }, 123);
  assert.deepEqual(Object.keys(dto).sort(), [...OFFER_FIELDS].sort());
  assert.equal(JSON.stringify(dto).includes("secret"), false);
  assert.equal(dto.approximateDistanceMeters, 123);
});

test("actual Redis location TTL expiry leaves a GEO member that receives no offer", async () => {
  const driver = await user(), connection = await connect(driver, 32.751), id = String(driver._id);
  await redis.pExpire(store.keys(id).location, 20);
  await eventually(async () => !(await redis.exists(store.keys(id).location)));
  assert.notEqual(await redis.zScore(store.geoKey, id), null);
  const placed = await order(); await realtime.offers.refresh();
  assert.equal(has(connection, REALTIME.offerCreated, placed._id), false);
  assert.deepEqual((await request("/driver/orders/available", driver)).data, []);
  assert.equal(await redis.zScore(store.geoKey, id), null);
});

test("searchable order edit emits offer-updated and active status emits only a small invalidation", async () => {
  const driver = await user(), connection = await connect(driver, 32.751), placed = await order();
  await eventually(() => has(connection, REALTIME.offerCreated, placed._id));
  const view = (await request(`/orders/${placed._id}`, merchant)).data;
  assert.equal((await request(`/orders/${placed._id}`, merchant, "PATCH", { observed: view.confirmationSnapshot, parcelReady: true })).status, 200);
  await eventually(() => has(connection, REALTIME.offerUpdated, placed._id));
  assert.equal((await request(`/orders/${placed._id}/accept`, driver, "POST", {})).status, 200);
  await eventually(() => has(connection, REALTIME.orderChanged, placed._id));
  const notification = connection.events.find(e => e.event === REALTIME.orderChanged);
  assert.deepEqual(notification.payload, { orderId: String(placed._id) });
  const count = connection.events.filter(e => e.event === REALTIME.orderChanged).length;
  assert.equal((await request(`/orders/${placed._id}/arrive-store`, driver, "POST", {})).status, 200);
  await eventually(() => connection.events.filter(e => e.event === REALTIME.orderChanged).length > count);
});

test("offers endpoint limits refresh per authenticated driver, not a shared IP", async () => {
  const driver = await user(), other = await user();
  for (let i = 0; i < config.rateLimitOffersPerMin; i++)
    assert.equal((await request("/driver/orders/available", driver)).status, 200);
  const rejected = await request("/driver/orders/available", driver);
  assert.equal(rejected.status, 429); assert.equal(rejected.data.code, "rate_limited");
  assert.equal((await request("/driver/orders/available", other)).status, 200);
});


test("v3 offers reach only a capable socket, even when an old socket shares an upgraded account", async () => {
  const modern = await user({ supportedWorkflowVersion: 3 });
  const legacy = await user({ supportedWorkflowVersion: 3 });
  const oldClient = await connect(legacy, 32.75);
  const newClient = await connect(modern, 32.75, 3);
  const placed = await order({ workflowVersion: 3, customerPhone: "0501234567", parcelReady: true,
    vehicleType: "car", parcelSize: "small", storeAuthorization: true });
  await makeReady(placed);
  await Order.updateOne({ _id: placed._id }, { $set: { customerConfirmedRevision: 1 } });
  await startReadyDispatches(); await realtime.offers.refresh();
  await eventually(() => newClient.events.some(e => e.event === REALTIME.offerCreated && e.payload.orderId === String(placed._id)));
  assert.equal(oldClient.events.filter(e => [REALTIME.offerCreated, REALTIME.offerUpdated].includes(e.event)).length, 0);
});

test("audit S23: v3 geographic search expands to real candidates in three waves", async () => {
  const selectorStore = createLocationStore(redis, config, `${prefix}waves:`);
  const drivers = await Promise.all([0, 1, 2].map(() => user({ supportedWorkflowVersion: 3 })));
  for (const [index, driver] of drivers.entries()) await locate(driver, [32.755, 32.79, 32.82][index], selectorStore);
  const placed = await order({ workflowVersion: 3, customerPhone: '0501234567', parcelReady: true,
    vehicleType: 'car', parcelSize: 'small', storeAuthorization: true });
  await makeReady(placed);
  for (const [index, elapsedMinutes] of [1, 10, 50].entries()) {
    await Order.updateOne({ _id: placed._id }, { $set: { customerConfirmedRevision: 1,
      driverSearchStatus: 'searching', searchStartedAt: new Date(Date.now() - elapsedMinutes * 60000),
      searchDeadlineAt: new Date(Date.now() + 10 * 60000) } });
    const result = await selectNearbyDrivers(await Order.findById(placed._id).lean(), selectorStore);
    assert.deepEqual(result.candidates.map(c => c.driverId), drivers.slice(0, index + 1).map(d => String(d._id)));
  }
});

test("audit S24: a driver moving out of range during candidate lookup is not offered the order", async t => {
  const selectorStore = createLocationStore(redis, config, `${prefix}moving:`);
  const driver = await user();
  const sessionId = await locate(driver, 32.8395, selectorStore);
  const placed = await order();
  const original = selectorStore.nearbyDrivers;
  t.mock.method(selectorStore, 'nearbyDrivers', async (...args) => {
    const indexed = await original(...args);
    assert.ok(indexed.includes(String(driver._id)));
    assert.equal(await selectorStore.saveLocation(String(driver._id), point(sessionId, 32.8405, 2, (await selectorStore.getLatestDriverLocation(String(driver._id))).location.measuredAt + 1)), 'accepted');
    return indexed;
  });
  assert.deepEqual((await selectNearbyDrivers(placed, selectorStore)).candidates, []);
});
