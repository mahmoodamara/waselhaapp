import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { createClient } from "redis";
const uri = process.env.BACKGROUND_TEST_URI;
if (!uri || !new URL(uri).pathname.endsWith("_test") || !process.env.REDIS_TEST_URL)
  throw new Error("Set BACKGROUND_TEST_URI to an isolated *_test MongoDB and REDIS_TEST_URL to local Redis.");
process.env.MONGODB_URI = uri;
process.env.JWT_SECRET = "phase8-isolated-test-secret";
const { User, Order, connectDatabase } = await import("../src/models/index.js");
const { createApp } = await import("../src/app.js");
const { createLocationStore } = await import("../src/services/locationStore.js");
const { attachRealtime } = await import("../src/realtime/index.js");
const { BACKGROUND, REALTIME } = await import("../../shared/realtimeContract.js");
const { config } = await import("../src/config.js");
const { io } = createRequire(new URL("../../driver-app/package.json", import.meta.url))("socket.io-client");
const redis = createClient({ url: process.env.REDIS_TEST_URL, disableOfflineQueue: true });
redis.on("error", () => {});
const store = createLocationStore(redis, config, `phase8-test:${randomUUID()}:`);
const ids = [], sockets = [];
let http, realtime, base, routeCalls = 0, etaCalls = 0;
const sign = user => jwt.sign({ ver: user.authVersion ?? 0 }, config.jwtSecret, { subject: String(user._id), expiresIn: "5m" });
const point = (sessionId, sequence = 1, measuredAt = Date.now()) => ({ sessionId, sequence, measuredAt,
  latitude: 32.75, longitude: 35.34, accuracy: 8, heading: null, speed: 2 });
async function user(extra = {}) {
  const driver = await User.create({ login: randomUUID(), passwordHash: "not-a-login-fixture", name: "Phase8",
    role: "driver", active: true, availableForOrders: true, ...extra });
  ids.push(String(driver._id)); return driver;
}
async function request(path, token, body, method = "POST") {
  const response = await fetch(`${base}/api${path}`, { method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }) });
  return { status: response.status, ...await response.json() };
}
async function foreground(driver) {
  const socket = io(base, { auth: { token: sign(driver) }, transports: ["websocket"], autoConnect: false, reconnection: false });
  sockets.push(socket);
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket session timeout")), 4000);
    socket.once(REALTIME.session, value => { clearTimeout(timer); resolve(value); });
  });
  socket.connect(); return { ...await ready, socket };
}
async function background(driver) {
  const fg = await foreground(driver);
  const bg = await request(BACKGROUND.session, sign(driver), { sessionId: fg.sessionId });
  assert.equal(bg.status, 200); fg.socket.disconnect(); return { ...bg, oldSessionId: fg.sessionId };
}
before(async () => {
  await connectDatabase(); await redis.connect();
  const app = createApp({ locationStore: store, redis,
    driverRoutes: { currentRoute: () => { routeCalls++; throw new Error("Background must not compute routes"); } },
    offerEta: { enrich: () => { etaCalls++; throw new Error("Background must not compute ETA"); } } });
  http = createServer(app); realtime = attachRealtime(http, store);
  http.listen(0, "127.0.0.1"); await once(http, "listening"); base = `http://127.0.0.1:${http.address().port}`;
});
after(async () => {
  for (const socket of sockets) socket.disconnect(); await realtime?.close();
  await redis.del([...ids.flatMap(id => Object.values(store.keys(id))), store.geoKey]); await redis.quit();
  await Order.deleteMany({ driverId: { $in: ids } }); await User.deleteMany({ _id: { $in: ids } }); await mongoose.disconnect();
});
test("HTTPS endpoint identity comes from scoped credential; writes same latest Redis and preserves socket presence=false", async () => {
  const driver = await user(), bg = await background(driver);
  assert(bg.expiresAt <= jwt.decode(sign(driver)).exp * 1000, "scoped credential cannot outlive the account token");
  assert.equal((await request(BACKGROUND.upload, bg.credential, point(bg.sessionId))).ok, true);
  const latest = await store.getLatestDriverLocation(String(driver._id));
  assert.equal(latest.location.sessionId, bg.sessionId); assert.equal(latest.fresh, true);
  assert.equal((await store.getDriverPresence(String(driver._id))).connected, false);
  assert(await redis.ttl(store.keys(String(driver._id)).location) > 0);
  assert((await redis.ttl(store.keys(String(driver._id)).session)) > config.locationTtlSeconds);
  assert.equal(await store.releaseSession(String(driver._id), bg.oldSessionId), 0);
  assert.equal((await request(BACKGROUND.upload, bg.credential, { ...point(bg.sessionId, 2), driverId: "spoof" })).code, "invalid_payload");
  assert.equal(routeCalls, 0); assert.equal(etaCalls, 0);
});
test("background credential cannot act as account JWT or socket JWT, nor write a different session/driver", async () => {
  const a = await user(), b = await user(), bg = await background(a), other = await background(b);
  for (const path of ["/auth/me", "/driver/summary", "/driver/orders/current"])
    assert.equal((await request(path, bg.credential, null, "GET")).status, 401);
  assert.equal((await request("/driver/availability", bg.credential, { available: false }, "PATCH")).status, 401);
  assert.equal((await request(BACKGROUND.upload, sign(a), point(bg.sessionId))).status, 401);
  assert.equal((await request(BACKGROUND.upload, bg.credential, point(other.sessionId))).code, "stale_session");
  const socket = io(base, { auth: { token: bg.credential }, autoConnect: false, transports: ["websocket"], reconnection: false }); sockets.push(socket);
  const rejected = once(socket, "connect_error"); socket.connect(); const [error] = await rejected;
  assert.equal(error.data.code, "unauthenticated"); assert.equal(socket.connected, false);
});
test("credential expiry, authVersion revocation and inactive driver reject updates", async () => {
  for (const condition of ["expired", "revoked", "inactive"]) {
    const driver = await user(), bg = await background(driver); let token = bg.credential;
    if (condition === "expired") {
      const { sub, aud, iss, exp, iat, ...claims } = jwt.decode(token);
      token = jwt.sign(claims, config.jwtSecret, { subject: sub, audience: aud, issuer: iss, expiresIn: -1 });
    } else await User.updateOne({ _id: driver._id }, condition === "revoked" ? { $inc: { authVersion: 1 } } : { $set: { active: false } });
    assert.equal((await request(BACKGROUND.upload, token, point(bg.sessionId))).status, 401);
    assert.equal((await store.getLatestDriverLocation(String(driver._id))).location, null);
  }
});
test("seq10 wins; delayed seq9, stale timestamp and inaccurate sample cannot overwrite it", async () => {
  const driver = await user(), bg = await background(driver), time = Date.now() - 100;
  assert.equal((await request(BACKGROUND.upload, bg.credential, point(bg.sessionId, 10, time))).ok, true);
  assert.equal((await request(BACKGROUND.upload, bg.credential, point(bg.sessionId, 9, time + 1))).code, "stale_location");
  assert.equal((await request(BACKGROUND.upload, bg.credential, point(bg.sessionId, 11, time - 1))).code, "stale_location");
  assert.equal((await request(BACKGROUND.upload, bg.credential, { ...point(bg.sessionId, 11), accuracy: 101 })).code, "invalid_payload");
  assert.equal((await store.getLatestDriverLocation(String(driver._id))).location.sequence, 10);
});
test("device B supersedes background A; delayed A handoff and old upload cannot reclaim session", async () => {
  const driver = await user(), a = await background(driver), b = await foreground(driver);
  assert.equal((await request(BACKGROUND.upload, a.credential, point(a.sessionId))).code, "stale_session");
  assert.equal((await request(BACKGROUND.session, sign(driver), { sessionId: a.oldSessionId })).code, "stale_session");
  assert.equal(await store.touchPresence(String(driver._id), b.sessionId), 1);
});
test("server policy checks every upload: Offline with assignment allowed, Offline without assignment tracking_disabled", async () => {
  for (const [online, assignment] of [[true, false], [false, true], [true, true]]) {
    const driver = await user({ availableForOrders: online });
    if (assignment) await Order.collection.insertOne({ customerToken: randomUUID(), driverId: driver._id, activeAssignment: true, status: "driver_assigned" });
    const bg = await background(driver);
    assert.equal((await request(BACKGROUND.upload, bg.credential, point(bg.sessionId))).ok, true);
    await User.updateOne({ _id: driver._id }, { $set: { availableForOrders: false } });
    await Order.updateMany({ driverId: driver._id }, { $set: { activeAssignment: false } });
    assert.equal((await request(BACKGROUND.upload, bg.credential, point(bg.sessionId, 2))).code, "tracking_disabled");
    if (assignment) assert.equal((await Order.findOne({ driverId: driver._id }).lean()).status, "driver_assigned");
  }
  const driver = await user({ availableForOrders: false }), fg = await foreground(driver);
  assert.equal((await request(BACKGROUND.session, sign(driver), { sessionId: fg.sessionId })).code, "tracking_disabled");
});
test("logout revokes scoped and account credentials and Lua session; delayed callback is rejected", async () => {
  const driver = await user(), bg = await background(driver);
  assert.equal((await request("/auth/logout", sign(driver))).ok, true);
  assert.equal((await request(BACKGROUND.upload, bg.credential, point(bg.sessionId))).status, 401);
  assert.equal(await store.saveLocation(String(driver._id), point(bg.sessionId)), "stale_session");
  assert.equal((await request("/auth/me", sign(driver), null, "GET")).status, 401);
});
test("shared per-driver limiter cannot be reset by switching Socket to HTTP, with no Google/OSRM calls", async () => {
  const driver = await user(), fg = await foreground(driver);
  const replies = await Promise.all(Array.from({ length: 4 }, (_, i) => fg.socket.timeout(3000).emitWithAck(REALTIME.location, point(fg.sessionId, i + 1))));
  assert(replies.some(r => r.ok));
  const bg = await request(BACKGROUND.session, sign(driver), { sessionId: fg.sessionId }); assert.equal(bg.status, 200);
  assert.equal((await request(BACKGROUND.upload, bg.credential, point(bg.sessionId))).code, "rate_limited");
  assert.equal(routeCalls, 0); assert.equal(etaCalls, 0);
});
