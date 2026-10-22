// Real Socket.IO + existing JWT/Mongoose + real Redis Lua; isolated test data.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { createClient } from "redis";
const requireDriver = createRequire(new URL("../../driver-app/package.json", import.meta.url));
const { io } = requireDriver("socket.io-client");
const uri = process.env.REALTIME_TEST_URI;
if (!uri || !new URL(uri).pathname.endsWith("_test") || !process.env.REDIS_TEST_URL)
  throw new Error("Set REALTIME_TEST_URI to a dedicated *_test MongoDB and REDIS_TEST_URL to local test Redis; never production.");
process.env.MONGODB_URI = uri;
process.env.JWT_SECRET = "phase3-realtime-test-secret";
const { User, Order, connectDatabase } = await import("../src/models/index.js");
const { attachRealtime } = await import("../src/realtime/index.js");
const { createLocationStore } = await import("../src/services/locationStore.js");
const { REALTIME } = await import("../../shared/realtimeContract.js");
const { createDriverRealtime } = await import("../../driver-app/realtime.js");
const settings = { locationTtlSeconds: 2, presenceTtlSeconds: 3, locationFreshMs: 500, publicBaseUrl: "http://localhost",
  realtimeAllowedOrigins: ["http://192.168.0.105:3000"] };
const redis = createClient({ url: process.env.REDIS_TEST_URL, disableOfflineQueue: true });
redis.on("error", () => {});
const prefix = `phase3-test:${randomUUID()}:driver:`;
const store = createLocationStore(redis, settings, prefix), ids = new Set(), sockets = new Set();
let server, realtime, url, saved = 0;
const originalSave = store.saveLocation;
store.saveLocation = (...args) => { saved++; return originalSave(...args); };
const sign = (user, extra = {}, options = {}) => jwt.sign({ ver: user.authVersion ?? 0, ...extra }, process.env.JWT_SECRET,
  { subject: String(user._id), expiresIn: "5m", ...options });
async function user(extra = {}) {
  const u = await User.create({ login: randomUUID(), name: "Realtime test driver", passwordHash: "not-a-login-fixture",
    role: "driver", active: true, availableForOrders: true, ...extra });
  ids.add(String(u._id)); return u;
}
function client(token, options = {}) {
  const socket = io(url, { auth: { token }, autoConnect: false, transports: ["websocket"], forceNew: true,
    reconnection: false, ...options });
  sockets.add(socket); return socket;
}
function event(socket, name, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, done); reject(new Error(`Timed out: ${name}`)); }, timeoutMs);
    const done = value => { clearTimeout(timer); resolve(value); };
    socket.once(name, done);
  });
}
async function connect(token) {
  const socket = client(token), ready = event(socket, REALTIME.session);
  socket.connect(); const { sessionId } = await ready;
  return { socket, sessionId };
}
const point = (sessionId, sequence = 1, measuredAt = Date.now()) => ({
  latitude: 32.75, longitude: 35.34, accuracy: 8, heading: 90, speed: 2, measuredAt, sequence, sessionId,
});
const emit = (socket, payload) => socket.timeout(3000).emitWithAck(REALTIME.location, payload);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(predicate) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(20); }
  assert.fail("Expected observable state was not reached");
}
before(async () => {
  await connectDatabase(); await redis.connect();
  server = createServer((req, res) => res.end("test"));
  realtime = attachRealtime(server, store, settings);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  for (const socket of sockets) { socket.removeAllListeners(); socket.disconnect(); }
  await realtime?.close();
  if (redis.isReady) {
    const keys = [...ids].flatMap(id => Object.values(store.keys(id)));
    if (keys.length) await redis.del(keys);
    await redis.quit();
  }
  await User.deleteMany({ _id: { $in: [...ids].filter(id => mongoose.isValidObjectId(id)) } });
  await Order.deleteMany({ driverId: { $in: [...ids].filter(id => mongoose.isValidObjectId(id)) } });
  await mongoose.disconnect();
});

test("JWT: valid driver connects; missing, invalid, expired, missing user, inactive, non-driver and revoked rejected", async () => {
  const good = await user();
  const accepted = await connect(sign(good));
  assert.equal(accepted.socket.connected, true); accepted.socket.disconnect();
  const inactive = await user({ active: false }), admin = await user({ role: "admin" });
  for (const token of [undefined, "invalid", sign(good, {}, { expiresIn: -1 }), sign(inactive), sign(admin),
    sign(good, { ver: 999 }), sign({ _id: new mongoose.Types.ObjectId() }),
    jwt.sign({}, process.env.JWT_SECRET, { subject: String(good._id) })]) {
    const socket = client(token), rejected = event(socket, "connect_error");
    socket.connect(); const error = await rejected;
    assert.ok(["unauthenticated", "forbidden"].includes(error.data.code));
    assert.equal(socket.connected, false); socket.disconnect();
  }
});
test("Android default WebSocket Origin can authenticate and publish when explicitly configured", async () => {
  const driver = await user();
  const socket = client(sign(driver), { extraHeaders: { Origin: "http://192.168.0.105:3000" } });
  const result = new Promise((resolve, reject) => {
    socket.once(REALTIME.session, resolve);
    socket.once("connect_error", () => reject(new Error("Configured native API Origin was rejected before JWT authentication")));
  });
  try {
    socket.connect(); const { sessionId } = await result;
    assert.equal((await emit(socket, point(sessionId))).ok, true);
    assert.equal((await store.getLatestDriverLocation(String(driver._id))).fresh, true);
  } finally { socket.disconnect(); }
});

test("unlisted Origins stay blocked and configured Origins still require a valid driver JWT", async () => {
  for (const [origin, token, code] of [
    ["http://192.168.0.105:3000.attacker.invalid", sign(await user()), undefined],
    ["http://192.168.0.105:3000", "invalid-jwt", "unauthenticated"],
  ]) {
    const socket = client(token, { extraHeaders: { Origin: origin } });
    const rejected = event(socket, "connect_error"); socket.connect();
    const error = await rejected;
    assert.equal(socket.connected, false);
    if (code) assert.equal(error.data?.code, code);
    socket.disconnect();
  }
});

test("identity comes only from JWT; unknown/spoofed driverId cannot write another key", async () => {
  const a = await user(), b = await user(), { socket, sessionId } = await connect(sign(a));
  assert.equal((await emit(socket, { ...point(sessionId), driverId: String(b._id) })).code, "invalid_payload");
  assert.equal((await emit(socket, point(sessionId))).ok, true);
  assert.equal((await store.getLatestDriverLocation(String(b._id))).location, null);
  const latest = await store.getLatestDriverLocation(String(a._id));
  assert.equal(latest.location.sessionId, sessionId); assert.equal(latest.fresh, true);
  assert.ok(latest.receivedAt >= latest.location.measuredAt);
  assert.ok(await redis.ttl(store.keys(String(a._id)).location) > 0);
  const dbUser = await User.findById(a._id).lean();
  assert.equal(dbUser.availableForOrders, true); assert.equal(dbUser.latitude, undefined);
  assert.equal(await Order.countDocuments({ driverId: a._id }), 0);
  socket.disconnect();
});
test("transport rejects invalid and oversized payload without corrupting last accepted location", async () => {
  const u = await user(), { socket, sessionId } = await connect(sign(u));
  assert.equal((await emit(socket, point(sessionId))).ok, true);
  assert.equal((await emit(socket, { ...point(sessionId, 2), longitude: 181 })).code, "invalid_payload");
  assert.equal((await emit(socket, { ...point(sessionId, 2), measuredAt: Date.now() - 60000 })).code, "stale_location");
  const closed = event(socket, "disconnect");
  socket.emit(REALTIME.location, { ...point(sessionId), extra: "x".repeat(10000) });
  await closed;
  assert.equal((await store.getLatestDriverLocation(String(u._id))).location.sequence, 1);
});
test("Lua atomic ordering: seq10 wins over seq9, concurrent packets and older timestamps", async () => {
  const id = `ordering-${randomUUID()}`; ids.add(id);
  const sessionId = randomUUID(), measuredAt = Date.now() - 200;
  await store.activateSession(id, sessionId);
  assert.equal(await store.saveLocation(id, point(sessionId, 10, measuredAt)), "accepted");
  assert.equal(await store.saveLocation(id, point(sessionId, 9, measuredAt + 1)), "stale_location");
  assert.equal(await store.saveLocation(id, point(sessionId, 11, measuredAt - 1)), "stale_location");
  await Promise.all(Array.from({ length: 100 }, (_, i) => store.saveLocation(id, point(sessionId, 100 - i, measuredAt + 100 - i))));
  assert.equal((await store.getLatestDriverLocation(id)).location.sequence, 100);
});
test("newest session wins atomically; old write/heartbeat/disconnect cannot affect new presence", async () => {
  const id = `sessions-${randomUUID()}`; ids.add(id);
  const a = randomUUID(), b = randomUUID(), time = Date.now() - 100;
  await store.activateSession(id, a); await store.saveLocation(id, point(a, 10, time));
  await store.activateSession(id, b);
  assert.equal(await store.saveLocation(id, point(a, 999, time + 10)), "stale_session");
  assert.equal(await store.touchPresence(id, a), 0); assert.equal(await store.releaseSession(id, a), 0);
  assert.equal(await store.saveLocation(id, point(b, 1, time - 1)), "stale_location");
  assert.equal(await store.saveLocation(id, point(b, 1, time + 1)), "accepted");
  assert.equal((await store.getDriverPresence(id)).sessionId, b);
});
test("Redis freshness and actual expiry; session watermark outlives location; lost presence expires", async () => {
  const id = `ttl-${randomUUID()}`; ids.add(id);
  const short = createLocationStore(redis, { ...settings, locationTtlSeconds: 1, presenceTtlSeconds: 4 }, prefix);
  const sessionId = randomUUID(); await short.activateSession(id, sessionId);
  await short.saveLocation(id, point(sessionId, 10));
  for (const key of Object.values(short.keys(id))) assert.ok(await redis.ttl(key) > 0);
  await delay(600); assert.equal((await short.getLatestDriverLocation(id)).fresh, false);
  await delay(550); assert.equal((await short.getLatestDriverLocation(id)).location, null);
  assert.equal(await short.saveLocation(id, point(sessionId, 9)), "stale_location");
  await delay(3000); assert.equal((await short.getDriverPresence(id)).connected, false);
  assert.equal(await short.touchPresence(id, sessionId), -1, "expired sessions require a new authenticated handshake");
});
test("second device evicts first; reconnect reauthenticates and receives a new session", async () => {
  const u = await user(), token = sign(u), first = await connect(token);
  const closed = event(first.socket, "disconnect");
  const second = await connect(token); await closed;
  assert.notEqual(first.sessionId, second.sessionId);
  assert.equal((await emit(second.socket, point(second.sessionId))).ok, true);
  second.socket.disconnect();
  const third = await connect(token); assert.notEqual(third.sessionId, second.sessionId);
  third.socket.disconnect();
  await User.updateOne({ _id: u._id }, { $inc: { authVersion: 1 } });
  const reconnect = client(token), rejected = event(reconnect, "connect_error");
  reconnect.connect(); assert.equal((await rejected).data.code, "unauthenticated"); reconnect.disconnect();
});
test("long-lived token expiry, revocation and disabled account disconnect idle sockets", async () => {
  for (const change of ["expiry", "revoked", "disabled"]) {
    const u = await user(), token = sign(u, {}, change === "expiry" ? { expiresIn: 2 } : {});
    const { socket } = await connect(token), closed = event(socket, "disconnect", 4000);
    if (change !== "expiry") await User.updateOne({ _id: u._id }, change === "revoked" ? { $inc: { authVersion: 1 } } : { $set: { active: false } });
    await closed; assert.equal(socket.connected, false);
  }
});
test("offline without assignment cannot publish; offline active assignment can; no order transitions", async () => {
  const u = await user({ availableForOrders: false }), { socket, sessionId } = await connect(sign(u));
  assert.equal((await emit(socket, point(sessionId))).code, "tracking_disabled");
  const order = await Order.collection.insertOne({ driverId: u._id, activeAssignment: true, status: "driver_assigned" });
  assert.equal((await emit(socket, point(sessionId))).ok, true);
  assert.equal((await Order.findById(order.insertedId).lean()).status, "driver_assigned");
  socket.disconnect(); assert.equal((await User.findById(u._id).lean()).availableForOrders, false);
});
test("100 events/sec is bounded before Mongo/Redis work, also after reconnect", async () => {
  const u = await user(), token = sign(u), a = await connect(token), initial = saved;
  const results = await Promise.all(Array.from({ length: 100 }, (_, i) => emit(a.socket, point(a.sessionId, i + 1))));
  assert.ok(results.filter(r => r.code === "rate_limited").length >= 96);
  assert.ok(saved - initial <= 4);
  a.socket.disconnect(); const b = await connect(token);
  assert.equal((await emit(b.socket, point(b.sessionId))).code, "rate_limited"); b.socket.disconnect();
});
test("Redis unavailable fails closed without a memory fallback", async () => {
  const unavailable = createLocationStore({ isReady: false }, settings);
  await assert.rejects(unavailable.saveLocation("driver", point(randomUUID())), /realtime_unavailable/);
  await assert.rejects(unavailable.getLatestDriverLocation("driver"), /realtime_unavailable/);
});
test("Redis outage during disconnect returns a rejected promise that cleanup can safely handle", async () => {
  const unavailable = createLocationStore({ isReady: false }, settings);
  let cleanup;
  assert.doesNotThrow(() => { cleanup = unavailable.releaseSession("driver", randomUUID()); });
  await assert.rejects(cleanup, /realtime_unavailable/);
});
test("real socket disconnect during Redis outage does not crash the HTTP server", async () => {
  const u = await user();
  const connection = createClient({ url: process.env.REDIS_TEST_URL, disableOfflineQueue: true });
  connection.on("error", () => {}); await connection.connect();
  const isolatedStore = createLocationStore(connection, settings, prefix);
  const http = createServer((req, res) => res.end("alive"));
  const rt = attachRealtime(http, isolatedStore, settings);
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  const origin = `http://127.0.0.1:${http.address().port}`;
  const socket = io(origin, { auth: { token: sign(u) }, transports: ["websocket"], forceNew: true, autoConnect: false });
  sockets.add(socket);
  try {
    const ready = event(socket, REALTIME.session); socket.connect(); await ready;
    connection.destroy(); socket.disconnect();
    await eventually(() => Promise.resolve(rt.io.of("/").sockets.size === 0));
    assert.equal(await (await fetch(origin)).text(), "alive");
  } finally { socket.disconnect(); await rt.close(); if (connection.isOpen) connection.destroy(); }
});
test("lost Redis session state is recoverable, rather than confused with a newer competing device", async () => {
  const id = `restart-${randomUUID()}`; ids.add(id);
  const sessionId = randomUUID(); await store.activateSession(id, sessionId);
  await redis.del(store.keys(id).session); // isolated equivalent of ephemeral Redis restart
  assert.equal(await store.saveLocation(id, point(sessionId)), "session_expired");
  assert.equal(await store.touchPresence(id, sessionId), -1);
});
test("real publisher reauthenticates after lost Redis session state, then sends its latest sample", async () => {
  const u = await user(), id = String(u._id); let socket;
  const publisher = createDriverRealtime({ io: (origin, options) => {
    socket = io(origin, options); sockets.add(socket); return socket;
  }, url, token: sign(u), schedule: (fn, ms) => setTimeout(fn, Math.min(ms, 20)) });
  try {
    const initial = event(socket, REALTIME.session); publisher.setForeground(true);
    const a = await initial;
    await redis.del(store.keys(id).session);
    const recovered = event(socket, REALTIME.session);
    publisher.publish({ latitude: 32.75, longitude: 35.34, accuracy: 8, heading: null, speed: null, timestamp: Date.now() });
    const b = await recovered; assert.notEqual(a.sessionId, b.sessionId);
    await eventually(async () => (await store.getLatestDriverLocation(id)).location?.sessionId === b.sessionId);
  } finally { publisher.stop(); }
});
test("real app publisher -> Socket.IO -> Redis; transport loss sends only latest, logout ends presence and publishing", async () => {
  const u = await user(), id = String(u._id);
  let socket, factoryCount = 0;
  const publisher = createDriverRealtime({ io: (origin, options) => {
    factoryCount++; socket = io(origin, options); sockets.add(socket); return socket;
  }, url, token: sign(u) });
  try {
    const ready = event(socket, REALTIME.session);
    publisher.setForeground(true); const first = await ready;
    const sample = { latitude: 32.75, longitude: 35.34, accuracy: 8, heading: null, speed: null, timestamp: Date.now() - 500 };
    publisher.publish(sample);
    await eventually(async () => (await store.getLatestDriverLocation(id)).location?.sessionId === first.sessionId);
    const listenerCount = socket.listeners(REALTIME.session).length;
    socket.io.reconnection(false);
    const closed = event(socket, "disconnect"); socket.io.engine.close(); await closed;
    let latest;
    for (let i = 0; i < 100; i++) {
      latest = { ...sample, latitude: 32.75001 + i / 1000000, timestamp: Date.now() - 100 + i };
      publisher.publish(latest);
    }
    const next = event(socket, REALTIME.session);
    socket.io.reconnection(true); socket.connect(); const second = await next;
    assert.notEqual(second.sessionId, first.sessionId);
    await eventually(async () => (await store.getLatestDriverLocation(id)).location?.sessionId === second.sessionId);
    const stored = (await store.getLatestDriverLocation(id)).location;
    assert.equal(stored.latitude, latest.latitude); assert.equal(stored.sequence, 1);
    assert.equal(factoryCount, 1); assert.equal(socket.listeners(REALTIME.session).length, listenerCount);
    publisher.stop();
    await eventually(async () => (await store.getDriverPresence(id)).connected === false);
    assert.equal(socket.listeners(REALTIME.session).length, 0); assert.equal(socket.connected, false);
    publisher.publish({ ...latest, latitude: 1 });
    assert.equal((await store.getLatestDriverLocation(id)).location.latitude, latest.latitude);
    assert.equal((await User.findById(id).lean()).availableForOrders, true);
  } finally { publisher.stop(); }
});
