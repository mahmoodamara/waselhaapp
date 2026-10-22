// Real HTTP/Socket.IO/MongoDB/Redis. Never use a production database or keys.
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { createClient } from "redis";
const uri = process.env.TRACKING_TEST_URI;
if (!uri || !new URL(uri).pathname.endsWith("_test") || !process.env.REDIS_TEST_URL)
  throw new Error("Set isolated TRACKING_TEST_URI (*_test) and REDIS_TEST_URL");
process.env.MONGODB_URI = uri;
process.env.JWT_SECRET = "isolated-phase7-test-secret";
const { User, Order, CodeAttempt, CodeAttemptState, connectDatabase } = await import("../src/models/index.js");
const { createApp } = await import("../src/app.js");
const { attachRealtime } = await import("../src/realtime/index.js");
const { createLocationStore } = await import("../src/services/locationStore.js");
const { config } = await import("../src/config.js");
const { issueCustomerToken } = await import("../src/services/customerLinks.js");
const { issueTrackingCredential } = await import("../src/services/customerTracking.js");
const { reissueCustomerLink } = await import("../src/services/orders.js");
const { REALTIME, BACKGROUND } = await import("../../shared/realtimeContract.js");
const { io } = createRequire(new URL("../../driver-app/package.json", import.meta.url))("socket.io-client");
const redis = createClient({ url: process.env.REDIS_TEST_URL, disableOfflineQueue: true });
redis.on("error", () => {});
const settings = { ...config, locationFreshMs: 600 };
const store = createLocationStore(redis, settings, `phase7-test:${randomUUID()}:`);
const ids = [], orderIds = [], sockets = [];
let realtime, http, base;
const sign = driver => jwt.sign({ ver: 0 }, config.jwtSecret, { subject: String(driver._id), expiresIn: "5m" });
const point = (sessionId, sequence = 1, measuredAt = Date.now()) => ({ sessionId, sequence, measuredAt,
  latitude: 32.75, longitude: 35.34, accuracy: 8, heading: 90, speed: 2 });
async function request(path, token, body, method = "GET") {
  const res = await fetch(`${base}/api${path}`, { method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }) });
  return { ...await res.json(), httpStatus: res.status };
}
async function fixture(status = "collected") {
  const driver = await User.create({ login: randomUUID(), name: "Phase7", passwordHash: "fixture-only",
    role: "driver", active: true, availableForOrders: true }); ids.push(driver._id);
  const order = { _id: new mongoose.Types.ObjectId(), ...issueCustomerToken(), driverId: driver._id,
    storeId: new mongoose.Types.ObjectId(), storeName: "Test store", status, activeAssignment: true,
    createdAt: new Date(), updatedAt: new Date(), customerConfirmed: true,
    deliveryCode: "123456", expectedCustomerCashAgorot: 0,
    destinationLocation: { lat: 32.76, lng: 35.35, confirmedAt: new Date(), address: "Destination" },
    encodedPolyline: "must-never-leak", routeGeometry: { secret: true } };
  await Order.collection.insertOne(order); orderIds.push(order._id);
  const access = issueTrackingCredential(order);
  return { driver, order, credential: access.credential };
}
function event(socket, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, done); reject(new Error(`Timeout: ${name}`)); }, 5000);
    const done = data => { clearTimeout(timer); resolve(data); }; socket.once(name, done);
  });
}
async function viewer(credential, extra = {}) {
  const socket = io(`${base}/customer-tracking`, { auth: { credential, ...extra }, transports: ["websocket"],
    autoConnect: false, reconnection: false, forceNew: true }); sockets.push(socket);
  const snapshot = event(socket, "customer:tracking-snapshot"); socket.connect();
  return { socket, snapshot: await snapshot };
}
async function foreground(driver) {
  const socket = io(base, { auth: { token: sign(driver) }, transports: ["websocket"], autoConnect: false, reconnection: false });
  sockets.push(socket); const ready = event(socket, REALTIME.session); socket.connect();
  return { socket, ...await ready };
}
before(async () => {
  await connectDatabase(); await redis.connect(); http = createServer(createApp({ locationStore: store }));
  realtime = attachRealtime(http, store, settings); http.listen(0, "127.0.0.1");
  await once(http, "listening"); base = `http://127.0.0.1:${http.address().port}`;
});
after(async () => {
  sockets.forEach(s => s.disconnect()); await realtime?.close();
  await redis.del([...ids.flatMap(id => Object.values(store.keys(String(id)))), store.geoKey]); await redis.quit();
  await Promise.all([Order.deleteMany({ _id: { $in: orderIds } }), User.deleteMany({ _id: { $in: ids } }),
    CodeAttempt.deleteMany({ orderId: { $in: orderIds } }), CodeAttemptState.deleteMany({ orderId: { $in: orderIds } })]); await mongoose.disconnect();
});
test("existing customer link exchanges for read-only, expiring order credential; ID alone grants nothing", async () => {
  const a = await fixture(), b = await fixture();
  assert.equal((await request(`/customer/${a.order.customerToken}/tracking-credential`, null, {}, "POST")).httpStatus, 200);
  assert.equal((await request(`/customer/${a.order._id}/tracking-credential`, null, {}, "POST")).httpStatus, 404);
  assert.equal((await request(`/customer/${a.order.customerToken}/tracking-credential`, null, { orderId: b.order._id }, "POST")).httpStatus, 400);
  const snapshot = await request("/tracking/snapshot", a.credential);
  const customer = await request(`/customer/${a.order.customerToken}`);
  assert.equal(snapshot.orderId, customer.publicReference); assert.equal(snapshot.location, null);
  assert.equal(customer._id, undefined);
  assert.ok(!JSON.stringify(jwt.decode(a.credential)).includes(String(a.order._id)));
  assert.equal((await request("/auth/me", a.credential)).httpStatus, 401);
  assert.equal((await request(`/orders/${a.order._id}/deliver`, a.credential, {}, "POST")).httpStatus, 401);
  const claims = jwt.decode(a.credential);
  assert.equal(claims.purpose, "tracking"); assert(claims.exp * 1000 <= Date.now() + 4 * 3600000);
  assert(!JSON.stringify(claims).includes(a.order.customerToken));
  for (const credential of [null, "bad", jwt.sign({ ...claims, sub: String(b.order._id) }, "wrong-secret")])
    assert.equal((await request("/tracking/snapshot", credential)).httpStatus, 401);
});

test("forged order/customer binding, expired JWT/link, rotated link, account JWT and arbitrary room are denied", async () => {
  const a = await fixture(), b = await fixture(), claims = jwt.decode(a.credential);
  for (const credential of [sign(a.driver), jwt.sign({ ...claims, exp: claims.iat - 1 }, config.jwtSecret),
    jwt.sign({ ...claims, sub: jwt.decode(b.credential).sub }, config.jwtSecret)]) {
    assert.equal((await request("/tracking/snapshot", credential)).httpStatus, 401);
    const socket = io(`${base}/customer-tracking`, { auth: { credential }, transports: ["websocket"], autoConnect: false, reconnection: false });
    sockets.push(socket); const rejected = event(socket, "connect_error"); socket.connect();
    assert.equal((await rejected).data.code, "unauthorized"); socket.disconnect();
  }
  const socket = io(`${base}/customer-tracking`, { auth: { credential: a.credential, orderId: String(b.order._id) },
    transports: ["websocket"], autoConnect: false, reconnection: false }); sockets.push(socket);
  const denied = event(socket, "connect_error"); socket.connect(); assert.equal((await denied).data.code, "unauthorized");
  const c = await viewer(a.credential), ended = event(c.socket, "customer:tracking-ended");
  await reissueCustomerLink(await Order.findById(a.order._id).lean(), { _id: a.order.storeId, role: "store" }, { requestId: randomUUID() });
  await realtime.tracking.refresh(); await ended;
  assert.equal((await request("/tracking/snapshot", a.credential)).httpStatus, 401);
  await Order.collection.updateOne({ _id: b.order._id }, { $set: { customerTokenExpiresAt: new Date(Date.now() - 1) } });
  assert.equal((await request("/tracking/snapshot", b.credential)).httpStatus, 401);
  assert.equal((await request(`/customer/${b.order.customerToken}/tracking-credential`, null, {}, "POST")).httpStatus, 404);
});

test("fresh/missing/stale snapshots minimize DTO, use server freshness, and never expose Google geometry", async () => {
  const f = await fixture(), fg = await foreground(f.driver);
  assert.equal((await request("/tracking/snapshot", f.credential)).state, "unavailable");
  await fg.socket.timeout(3000).emitWithAck(REALTIME.location, point(fg.sessionId));
  const live = await request("/tracking/snapshot", f.credential);
  assert.equal(live.state, "live"); assert.equal(live.freshForMs, settings.locationFreshMs);
  assert.deepEqual(Object.keys(live.location).sort(), ["latitude", "longitude", "accuracy", "heading", "measuredAt", "receivedAt", "fresh"].sort());
  const stored = JSON.parse(await redis.get(store.keys(String(f.driver._id)).location));
  stored.measuredAt -= 1000; stored.receivedAt -= 1000;
  await redis.set(store.keys(String(f.driver._id)).location, JSON.stringify(stored), { EX: 60 });
  const stale = await viewer(f.credential);
  assert.equal(stale.snapshot.state, "stale"); assert.equal(stale.snapshot.location.fresh, false);
  for (const key of ["encodedPolyline", "routeGeometry", "driverId", "sessionId", "sequence", "speed", "customerToken"])
    assert(!JSON.stringify(stale.snapshot).includes(key), key);
});

test("foreground Socket AND background HTTPS publish the same contract; rejected GPS/session never broadcast", async () => {
  const f = await fixture(), fg = await foreground(f.driver), customer = await viewer(f.credential);
  const updates = []; customer.socket.on("customer:driver-location", data => updates.push(data));
  const received = event(customer.socket, "customer:driver-location");
  assert.equal((await fg.socket.timeout(3000).emitWithAck(REALTIME.location, point(fg.sessionId, 10, Date.now() - 10))).ok, true);
  const front = await received; assert.equal(front.state, "live");
  assert.equal((await fg.socket.timeout(3000).emitWithAck(REALTIME.location, point(fg.sessionId, 9))).code, "stale_location");
  const bg = await request(BACKGROUND.session, sign(f.driver), { sessionId: fg.sessionId }, "POST");
  assert.equal(bg.httpStatus, 200); fg.socket.disconnect();
  const receivedBg = event(customer.socket, "customer:driver-location");
  assert.equal((await request(BACKGROUND.upload, bg.credential, point(bg.sessionId), "POST")).ok, true);
  const back = await receivedBg;
  assert.deepEqual(Object.keys(back), Object.keys(front)); assert.deepEqual(Object.keys(back.location), Object.keys(front.location));
  assert.equal((await request(BACKGROUND.upload, bg.credential, point(fg.sessionId, 11), "POST")).code, "stale_session");
  const barrier = event(customer.socket, "customer:tracking-snapshot"); await realtime.tracking.refresh(); await barrier;
  assert.equal(updates.length, 2);
  assert.equal((await store.getDriverPresence(String(f.driver._id))).connected, false);
});

test("reconnect/duplicate viewers receive latest only, never another order or driver room", async () => {
  const f = await fixture(), fg = await foreground(f.driver), other = await fixture(), first = await viewer(f.credential);
  first.socket.disconnect();
  await fg.socket.timeout(3000).emitWithAck(REALTIME.location, point(fg.sessionId, 1, Date.now() - 20));
  const latestPoint = { ...point(fg.sessionId, 2, Date.now() - 5), latitude: 32.7501 };
  await fg.socket.timeout(3000).emitWithAck(REALTIME.location, latestPoint);
  const a = await viewer(f.credential), b = await viewer(f.credential), c = await viewer(other.credential);
  assert.equal(a.snapshot.location.latitude, 32.7501); assert.deepEqual(a.snapshot.location, b.snapshot.location);
  assert.equal(c.snapshot.location, null);
  for (const client of [a, b]) {
    const serverSocket = realtime.tracking.namespace.sockets.get(client.socket.id);
    assert(serverSocket.rooms.has(`tracking:order:${f.order._id}`));
    assert(![...serverSocket.rooms].some(room => room.startsWith("driver:")));
    client.socket.emit("join", `driver:${other.driver._id}`);
    client.socket.emit("join", `tracking:order:${other.order._id}`);
  }
  const barrier = event(a.socket, "customer:tracking-snapshot"); await realtime.tracking.refresh(); await barrier;
  assert(!realtime.tracking.namespace.sockets.get(a.socket.id).rooms.has(`tracking:order:${other.order._id}`));
});

test("real workflow transition immediately starts/ends tracking without waiting for GPS", async () => {
  const f = await fixture("driver_assigned"), fg = await foreground(f.driver), c = await viewer(f.credential);
  await fg.socket.timeout(3000).emitWithAck(REALTIME.location, point(fg.sessionId));
  assert.equal(c.snapshot.location, null);
  // Simulate an already-validated pickup commit at the production signal boundary.
  const { withTrackingOrder } = await import("../src/services/trackingGate.js");
  const { ordersChanged } = await import("../src/services/orderSignals.js");
  let snapshot = event(c.socket, "customer:tracking-snapshot");
  await withTrackingOrder(f.order._id, async () => {
    await Order.collection.updateOne({ _id: f.order._id }, { $set: { status: "collected" } }); ordersChanged();
  });
  assert.equal((await snapshot).state, "live");
  // The arrive-customer and deliver writes below use actual authorized routes.
  snapshot = event(c.socket, "customer:tracking-snapshot");
  assert.equal((await request(`/orders/${f.order._id}/arrive-customer`, sign(f.driver), {}, "POST")).httpStatus, 200);
  assert.equal((await snapshot).status, "driver_at_destination");
  const ended = event(c.socket, "customer:tracking-ended");
  assert.equal((await request(`/orders/${f.order._id}/deliver`, sign(f.driver), { code: "123456", actualCashCollectedAgorot: 0, observedExpectedAgorot: 0 }, "POST")).httpStatus, 200);
  assert.equal((await ended).status, "delivered");
  assert(!realtime.tracking.namespace.sockets.get(c.socket.id).rooms.has(`tracking:order:${f.order._id}`));
  let updates = 0; c.socket.on("customer:driver-location", () => updates++);
  await fg.socket.timeout(3000).emitWithAck(REALTIME.location, { ...point(fg.sessionId, 2), latitude: 33 });
  const barrier = event(c.socket, "customer:tracking-snapshot"); await realtime.tracking.refresh(); await barrier;
  assert.equal(updates, 0);
  const refreshed = await request("/tracking/snapshot", f.credential);
  assert.equal(refreshed.state, "ended"); assert.equal(refreshed.location, null);
  const reconnected = await viewer(f.credential); assert.equal(reconnected.snapshot.location, null);
});

test("delivered commit concurrent with a suspended Redis snapshot cannot disclose post-delivery coordinates", async () => {
  const f = await fixture("driver_at_destination"), fg = await foreground(f.driver), c = await viewer(f.credential);
  let release, entered;
  const blocked = new Promise(resolve => { entered = resolve; }), proceed = new Promise(resolve => { release = resolve; });
  const original = store.getLatestDriverLocation;
  let once = true, ended = false, postDelivery = 0;
  c.socket.on("customer:tracking-ended", () => { ended = true; });
  c.socket.on("customer:driver-location", () => { if (ended) postDelivery++; });
  store.getLatestDriverLocation = async id => {
    if (id === String(f.driver._id) && once) { once = false; entered(); await proceed; }
    return original(id);
  };
  try {
    const upload = fg.socket.timeout(5000).emitWithAck(REALTIME.location, point(fg.sessionId));
    await blocked;
    const deliver = request(`/orders/${f.order._id}/deliver`, sign(f.driver), { code: "123456", actualCashCollectedAgorot: 0, observedExpectedAgorot: 0 }, "POST");
    release(); assert.equal((await deliver).httpStatus, 200); await upload;
    await fg.socket.timeout(3000).emitWithAck(REALTIME.location, point(fg.sessionId, 2));
    const barrier = event(c.socket, "customer:tracking-snapshot"); await realtime.tracking.refresh(); await barrier;
    assert.equal(postDelivery, 0); assert.equal((await request("/tracking/snapshot", f.credential)).location, null);
  } finally { release(); store.getLatestDriverLocation = original; }
});
test("delivery winning the race after Redis acceptance suppresses the delayed accepted-location publisher", async () => {
  const f = await fixture("driver_at_destination"), fg = await foreground(f.driver), c = await viewer(f.credential);
  const original = store.saveLocation;
  let release, enter, updates = 0;
  const paused = new Promise(resolve => { enter = resolve; }), proceed = new Promise(resolve => { release = resolve; });
  c.socket.on("customer:driver-location", () => updates++);
  store.saveLocation = async (...args) => {
    const result = await original(...args);
    if (args[0] === String(f.driver._id)) { enter(); await proceed; }
    return result;
  };
  try {
    const upload = fg.socket.timeout(5000).emitWithAck(REALTIME.location, point(fg.sessionId));
    await paused;
    const ended = event(c.socket, "customer:tracking-ended");
    assert.equal((await request(`/orders/${f.order._id}/deliver`, sign(f.driver),
      { code: "123456", actualCashCollectedAgorot: 0, observedExpectedAgorot: 0 }, "POST")).httpStatus, 200);
    await ended; release(); assert.equal((await upload).ok, true);
    const barrier = event(c.socket, "customer:tracking-snapshot"); await realtime.tracking.refresh(); await barrier;
    assert.equal(updates, 0); assert.equal((await request("/tracking/snapshot", f.credential)).location, null);
  } finally { release(); store.saveLocation = original; }
});

test("all ten order states enforce the exact two-state coordinate allowlist", async () => {
  for (const status of ["searching_driver", "driver_assigned", "driver_at_store", "collected", "driver_at_destination",
    "delivered", "cancelled", "delivery_failed", "returning", "returned"]) {
    const f = await fixture(status), session = await foreground(f.driver);
    await session.socket.timeout(3000).emitWithAck(REALTIME.location, point(session.sessionId));
    const snapshot = await request("/tracking/snapshot", f.credential);
    const allowed = ["collected", "driver_at_destination"].includes(status);
    assert.equal(!!snapshot.location, allowed, status);
    assert.equal(snapshot.state, allowed ? "live" : status.startsWith("driver_") || status === "searching_driver" ? "not_started" : "ended");
    assert(!JSON.stringify(snapshot).includes("Polyline")); assert(!JSON.stringify(snapshot).includes("routeGeometry"));
    session.socket.disconnect();
  }
});

test("failure and return workflow revoke the location subscription immediately; cancellation never enables one", async () => {
  const f = await fixture(), fg = await foreground(f.driver), c = await viewer(f.credential);
  await fg.socket.timeout(3000).emitWithAck(REALTIME.location, point(fg.sessionId));
  const ended = event(c.socket, "customer:tracking-ended");
  assert.equal((await request(`/orders/${f.order._id}/fail`, sign(f.driver), { reason: "Customer unavailable" }, "POST")).httpStatus, 200);
  assert.equal((await ended).status, "delivery_failed");
  let count = 0; c.socket.on("customer:driver-location", () => count++);
  // Admin-only return commands retain their existing authorization; invoke the
  // same service with a verified actor fixture to exercise actual transitions.
  const { transition } = await import("../src/services/orders.js");
  for (const [action, status] of [["authorize-return", "returning"], ["confirm-return", "returned"]]) {
    await transition(await Order.findById(f.order._id).lean(), action, {}, { actor: { role: "admin", _id: f.order.storeId } });
    const snapshot = await request("/tracking/snapshot", f.credential);
    assert.equal(snapshot.status, status); assert.equal(snapshot.location, null);
    await fg.socket.timeout(3000).emitWithAck(REALTIME.location, point(fg.sessionId, status === "returning" ? 2 : 3));
  }
  const barrier = event(c.socket, "customer:tracking-snapshot"); await realtime.tracking.refresh(); await barrier;
  assert.equal(count, 0);
  const cancelled = await fixture("driver_assigned"), viewerBefore = await viewer(cancelled.credential);
  await transition(await Order.findById(cancelled.order._id).lean(), "cancel", { reason: "Cancelled" });
  const terminalSnapshot = event(viewerBefore.socket, "customer:tracking-snapshot"); await realtime.tracking.refresh();
  assert.equal((await terminalSnapshot).location, null);
});

test("credential expiry terminates a connected viewer and clears their tracking room", async () => {
  const f = await fixture(), claims = jwt.decode(f.credential);
  const credential = jwt.sign({ ...claims, exp: Math.floor(Date.now() / 1000) + 2 }, config.jwtSecret);
  const c = await viewer(credential), ended = event(c.socket, "customer:tracking-ended"), disconnected = event(c.socket, "disconnect");
  await ended; await disconnected;
  assert.equal((await request("/tracking/snapshot", credential)).httpStatus, 401);
});

test("v3 customer coordinates appear after collection and disappear after completion", async () => {
  const f = await fixture("driver_assigned");
  await Order.collection.updateOne({ _id: f.order._id }, { $set: { workflowVersion: 3 } });
  const sessionId = randomUUID();
  await store.activateSession(String(f.driver._id), sessionId);
  await store.saveLocation(String(f.driver._id), { sessionId, measuredAt: Date.now(), sequence: 1,
    latitude: 32.75, longitude: 35.34, accuracy: 8, heading: null, speed: null });
  assert.equal((await request("/tracking/snapshot", f.credential)).location, null);
  await Order.collection.updateOne({ _id: f.order._id }, { $set: { status: "collected" } });
  const moving = await request("/tracking/snapshot", f.credential);
  assert.equal(moving.state, "live"); assert.equal(moving.location.latitude, 32.75);
  await Order.collection.updateOne({ _id: f.order._id }, { $set: { status: "delivered", activeAssignment: false } });
  const ended = await request("/tracking/snapshot", f.credential);
  assert.equal(ended.state, "ended"); assert.equal(ended.location, null);
});

// This saturation test stays last: its purpose is to exhaust the shared limiter.
test("auth, snapshot and reconnect abuse have independent bounded rate limits", async () => {
  const f = await fixture();
  let limited = false;
  for (let i = 0; i < 25; i++) {
    const r = await request(`/customer/${f.order.customerToken}/tracking-credential`, null, {}, "POST");
    if (r.httpStatus === 429) { limited = true; break; }
  }
  assert(limited, "credential issuance bounded"); limited = false;
  for (let i = 0; i < 65; i++) {
    const r = await request("/tracking/snapshot", f.credential);
    if (r.httpStatus === 429) { limited = true; break; }
  }
  assert(limited, "snapshot recovery bounded"); limited = false;
  for (let i = 0; i < 31; i++) {
    const socket = io(`${base}/customer-tracking`, { auth: { credential: "invalid" }, autoConnect: false,
      transports: ["websocket"], reconnection: false, forceNew: true }); sockets.push(socket);
    const rejected = event(socket, "connect_error"); socket.connect();
    const error = await rejected; socket.disconnect();
    if (error.data.code === "rate_limited") { limited = true; break; }
  }
  assert(limited, "namespace reconnect bounded across sockets");
});


