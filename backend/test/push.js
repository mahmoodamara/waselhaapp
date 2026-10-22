import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { createClient } from "redis";
const uri = process.env.OFFERS_TEST_URI;
if (!uri || !new URL(uri).pathname.endsWith("_test") || !process.env.REDIS_TEST_URL)
  throw new Error("Set OFFERS_TEST_URI to a dedicated *_test database and REDIS_TEST_URL to test Redis.");
process.env.MONGODB_URI = uri;
process.env.JWT_SECRET = "push-isolated-test-secret";
const { User, Order, PushDevice, connectDatabase } = await import("../src/models/index.js");
const { createApp } = await import("../src/app.js");
const { attachRealtime } = await import("../src/realtime/index.js");
const { createLocationStore } = await import("../src/services/locationStore.js");
const { createPushNotifier, offerMessage, validPushToken, sendTestPush, RECEIPT_DELAY_MS, RECEIPT_GIVE_UP_MS } = await import("../src/services/push.js");
const { config } = await import("../src/config.js");
const redis = createClient({ url: process.env.REDIS_TEST_URL, disableOfflineQueue: true });
redis.on("error", () => {});
const prefix = `push-test:${randomUUID()}:driver:`;
const store = createLocationStore(redis, config, prefix);
const TOKEN = "ExponentPushToken[abcdefghijklmnopqrstuv]";
const sent = [];
// The fake transport: nothing here can reach a real phone or the Expo service.
let reply = messages => messages.map(() => ({ status: "ok" }));
const notifier = createPushNotifier({ ...config, pushEnabled: true }, async messages => { sent.push(...messages); return reply(messages); });
let server, realtime, base, merchant;
const sign = user => jwt.sign({ ver: user.authVersion ?? 0 }, process.env.JWT_SECRET, { subject: String(user._id), expiresIn: "5m" });
async function user(extra = {}) {
  return (await User.create({ login: randomUUID(), name: "Push fixture", passwordHash: "not-a-login-fixture",
    role: "driver", active: true, availableForOrders: true, vehicleType: "car", serviceAreas: ["kafr-kanna"], ...extra })).toObject();
}
async function request(path, account, method = "GET", body) {
  const response = await fetch(`${base}/api${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${sign(account)}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}
async function order(extra = {}) {
  const response = await request("/orders", merchant, "POST", { serviceArea: "kafr-kanna", area: "Public area", customerPhone: "private-phone",
    recipientName: "private-person", finalAddress: "private-destination", deliveryInstructions: "private-instructions", parcelDescription: "Box",
    goodsAmountAgorot: 10000, deliveryFeePaidBy: "customer", ...extra });
  assert.equal(response.status, 201);
  // A quick order reaches drivers only once its customer is ready (dispatch-gate.js covers
  // that); these push tests start from a ready order whose search has begun.
  if (extra.workflowVersion === 2) await Order.updateOne({ _id: response.data._id }, { $set: { customerAvailable: true,
    driverSearchStatus: "searching", searchStartedAt: new Date(), searchDeadlineAt: new Date(Date.now() + 600000) } });
  return Order.findById(response.data._id).lean();
}
async function locate(driver, lat = 32.75) {
  const sessionId = randomUUID(), id = String(driver._id);
  await store.activateSession(id, sessionId);
  assert.equal(await store.saveLocation(id, { sessionId, latitude: lat, longitude: 35.34, accuracy: 8, heading: null, speed: null, measuredAt: Date.now(), sequence: 1 }), "accepted");
}
async function eventually(predicate) {
  for (let i = 0; i < 150; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail("Expected push did not arrive");
}
const quiet = () => new Promise(resolve => setTimeout(resolve, 400));

test("logout invalidates push devices and retained GEO without a later search", async () => {
  const driver = await user(); await locate(driver);
  assert.equal((await request('/driver/push-token', driver, 'PUT', { token: TOKEN, platform: 'android' })).status, 200);
  assert.equal((await request('/auth/logout', driver, 'POST', {})).status, 200);
  assert.equal((await request('/driver/push-token', driver, 'DELETE', { token: TOKEN })).status, 401);
  assert.equal(await PushDevice.countDocuments({ userId: driver._id }), 0);
  assert.equal(await notifier.offer(driver._id, { orderId: 'logged-out' }), 0);
  assert.equal(await redis.zScore(store.geoKey, String(driver._id)), null);
  assert.equal((await store.getLatestDriverLocation(String(driver._id))).location, null);
});

test("notifier ignores registrations from a revoked auth version even if deletion failed", async () => {
  const driver = await user();
  await request('/driver/push-token', driver, 'PUT', { token: TOKEN, platform: 'android' });
  await User.updateOne({ _id: driver._id }, { $inc: { authVersion: 1 } });
  assert.equal(await notifier.offer(driver._id, { orderId: 'revoked' }), 0);
  assert.equal(sent.length, 0);
});
test('registration that authenticated before logout cannot recreate a retained device afterwards', async () => {
  const driver = await user();
  const original = PushDevice.updateOne;
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  PushDevice.updateOne = async function (...args) {
    entered(); await blocked; return original.apply(this, args);
  };
  let registration;
  try {
    registration = request('/driver/push-token', driver, 'PUT', { token: TOKEN, platform: 'android' });
    await started;
    assert.equal((await request('/auth/logout', driver, 'POST', {})).status, 200);
    release();
    assert.equal((await registration).status, 401);
    assert.equal(await PushDevice.countDocuments({ userId: driver._id }), 0);
  } finally { release(); await registration; PushDevice.updateOne = original; }
});

before(async () => {
  await connectDatabase(); await redis.connect();
  server = createServer(createApp({ locationStore: store, redis }));
  realtime = attachRealtime(server, store, undefined, notifier);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
  sent.length = 0; reply = messages => messages.map(() => ({ status: "ok" }));
  await Order.deleteMany({}); await User.deleteMany({}); await PushDevice.deleteMany({});
  await realtime.offers.refresh();
  merchant = await user({ role: "store", storeName: "Public merchant", pickupAddress: "Public pickup", pickupServiceArea: "kafr-kanna",
    pickupLocation: { lat: 32.75, lng: 35.34, address: "Public pickup", source: "gps", confirmedAt: new Date() } });
});
after(async () => {
  await realtime.close();
  const keys = []; for await (const key of redis.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) keys.push(...key);
  if (keys.length) await redis.del(keys);
  await Order.deleteMany({}); await User.deleteMany({}); await PushDevice.deleteMany({});
  redis.destroy(); await mongoose.disconnect();
});

test("push token registration validates input, belongs to the signed-in driver and moves with the phone", async () => {
  const a = await user(), b = await user();
  for (const body of [{}, { token: "nope", platform: "android" }, { token: TOKEN, platform: "windows" }, { token: TOKEN, platform: "ios", language: "fr" },
    { token: TOKEN, platform: "ios", extra: 1 }, { token: { $ne: null }, platform: "ios" }])
    assert.equal((await request("/driver/push-token", a, "PUT", body)).status, 400);
  assert.equal((await request("/driver/push-token", merchant, "PUT", { token: TOKEN, platform: "android" })).status, 403);
  assert.equal((await request("/driver/push-token", a, "PUT", { token: TOKEN, platform: "android", language: "he" })).status, 200);
  assert.equal((await request("/driver/push-token", a, "PUT", { token: TOKEN, platform: "android", language: "he" })).status, 200);
  assert.equal(await PushDevice.countDocuments({ token: TOKEN }), 1, "registering twice never duplicates");
  // The same phone signed in by another driver now belongs to that driver.
  assert.equal((await request("/driver/push-token", b, "PUT", { token: TOKEN, platform: "android" })).status, 200);
  assert.equal(String((await PushDevice.findOne({ token: TOKEN })).userId), String(b._id));
  // A driver cannot remove someone else's phone; the owner can.
  assert.equal((await request("/driver/push-token", a, "DELETE", { token: TOKEN })).status, 200);
  assert.equal(await PushDevice.countDocuments({ token: TOKEN }), 1);
  assert.equal((await request("/driver/push-token", b, "DELETE", { token: TOKEN })).status, 200);
  assert.equal(await PushDevice.countDocuments({ token: TOKEN }), 0);
  assert.equal(validPushToken(TOKEN), true);
  assert.equal(validPushToken("ExpoPushToken[abcdefghijkl]"), true);
  assert.equal(validPushToken("fcm:APA91b"), false);
});

test("the message shows the store and the fare only, expires with the offer, and follows the driver's language", () => {
  const dto = { orderId: "o1", storeName: "متجر الريان", driverEarningsAgorot: 1200, expiresAt: new Date(Date.now() + 25000).toISOString(),
    customerPhone: "private-phone", finalAddress: "private-destination", recipientName: "private-person" };
  const ar = offerMessage(dto, "ar");
  assert.deepEqual([ar.title, ar.body], ["طلب جديد", "متجر الريان · أجرة 12 ₪"]);
  assert.equal(ar.channelId, "offers"); assert.equal(ar.priority, "high");
  assert.ok(ar.ttl >= 24 && ar.ttl <= 25, `ttl ${ar.ttl}`);
  assert.deepEqual(ar.data, { type: "offer", orderId: "o1" });
  assert.doesNotMatch(JSON.stringify(ar), /private/);
  assert.equal(offerMessage(dto, "he").title, "הזמנה חדשה");
  assert.equal(offerMessage({ ...dto, driverEarningsAgorot: null, estimatedDriverEarningsAgorot: 950 }, "ar").body, "متجر الريان · أجرة 9.5 ₪");
  assert.equal(offerMessage({ orderId: "o2", storeName: "X" }, "ar").body, "X", "an unknown fare is left out, not shown as zero");
  assert.equal(offerMessage({ ...dto, expiresAt: new Date(Date.now() - 5000).toISOString() }).ttl, 1);
});

test("a dead token is forgotten, a failing transport never throws, and switched-off push sends nothing", async () => {
  const driver = await user();
  await PushDevice.create([{ userId: driver._id, token: TOKEN, platform: "android" }, { userId: driver._id, token: "ExponentPushToken[zzzzzzzzzzzzzzzz]", platform: "ios", language: "he" }]);
  reply = messages => messages.map(m => m.to.includes("zzzz") ? { status: "error", details: { error: "DeviceNotRegistered" } } : { status: "ok" });
  assert.equal(await notifier.offer(driver._id, { orderId: "o", storeName: "S" }), 2);
  assert.deepEqual((await PushDevice.find({ userId: driver._id })).map(d => d.token), [TOKEN]);
  assert.equal(sent.filter(m => m.to.includes("zzzz"))[0].title, "הזמנה חדשה", "each phone gets its own language");
  const failing = createPushNotifier({ ...config, pushEnabled: true }, async () => { throw new Error("offline"); });
  assert.equal(await failing.offer(driver._id, { orderId: "o", storeName: "S" }), 0);
  const off = createPushNotifier({ ...config, pushEnabled: false }, async () => assert.fail("must not send"));
  assert.equal(await off.offer(driver._id, { orderId: "o", storeName: "S" }), 0);
  assert.equal(off.enabled, false);
  assert.equal(createPushNotifier({ ...config }).enabled, false, "never enabled inside a test process");
});

test("an eligible nearby driver without a live connection is pushed once; others never", async () => {
  const away = await user(), far = await user(), unavailable = await user(), unregistered = await user();
  await locate(away); await locate(far, 33.75); await locate(unavailable); await locate(unregistered);
  await User.updateOne({ _id: unavailable._id }, { availableForOrders: false });
  await PushDevice.create([{ userId: away._id, token: TOKEN, platform: "android" },
    { userId: far._id, token: "ExponentPushToken[farfarfarfarfar]", platform: "android" },
    { userId: unavailable._id, token: "ExponentPushToken[offoffoffoffoff]", platform: "android" }]);
  const placed = await order({ workflowVersion: 2, vehicleType: "car", parcelSize: "small", storeAuthorization: true });
  await realtime.offers.refresh();
  await eventually(() => sent.length === 1);
  assert.equal(sent[0].to, TOKEN);
  assert.equal(sent[0].data.orderId, String(placed._id));
  assert.match(sent[0].body, /Public merchant/);
  assert.doesNotMatch(JSON.stringify(sent), /private-/);
  // Reconciling again, or the offer changing, never sends the same driver a second push.
  await realtime.offers.refresh(); await realtime.offers.refresh(); await quiet();
  assert.equal(sent.length, 1);
  // A new order is a new push.
  const second = await order({ workflowVersion: 2, vehicleType: "car", parcelSize: "small", storeAuthorization: true });
  await realtime.offers.refresh();
  await eventually(() => sent.length === 2);
  assert.equal(sent[1].data.orderId, String(second._id));
});

// ---- Waking a closed app from its last known position ------------------------------------------------
const lastKey = driver => store.keys(String(driver._id)).lastKnown;
// A phone whose app was closed: its live position expired, its last reported one is still stored.
async function closeApp(driver) { await redis.del(store.keys(String(driver._id)).location); }
async function ageLastKnown(driver, ms) {
  const stored = JSON.parse(await redis.get(lastKey(driver)));
  await redis.set(lastKey(driver), JSON.stringify({ ...stored, receivedAt: Date.now() - ms }), { EX: 600 });
}
const placeOrder = () => order({ workflowVersion: 2, vehicleType: "car", parcelSize: "small", storeAuthorization: true });
const deviceToken = driver => `ExponentPushToken[device${String(driver._id)}]`;

test("the last known position outlives the live one and is dropped when the driver signs out", async () => {
  const driver = await user(), id = String(driver._id);
  await locate(driver);
  assert.ok(await redis.ttl(lastKey(driver)) > config.locationTtlSeconds, "kept longer than the live position");
  assert.ok(await redis.ttl(lastKey(driver)) <= config.pushLocationMaxAgeSeconds);
  await closeApp(driver);
  assert.equal((await store.getLatestDriverLocation(id)).fresh, false);
  const known = await store.getLastKnownDriverLocation(id);
  assert.equal(known.location.latitude, 32.75);
  assert.ok(known.ageMs >= 0 && known.ageMs < 5000);
  await store.invalidateDriver(id);
  assert.equal((await store.getLastKnownDriverLocation(id)).location, null, "signing out forgets where the phone was");
  assert.equal((await store.getLastKnownDriverLocation("nobody")).location, null);
});

test("a closed app with no live position is still pushed from its last known position, within the radius and the age limit", async () => {
  const closed = await user(), old = await user(), far = await user(), never = await user();
  for (const d of [closed, old, far, never]) await PushDevice.create({ userId: d._id, token: deviceToken(d), platform: "android" });
  await locate(closed); await locate(old); await locate(far, 33.75);
  for (const d of [closed, old, far]) await closeApp(d);
  await ageLastKnown(old, (config.pushLocationMaxAgeSeconds + 60) * 1000);
  await ageLastKnown(closed, 120000); // two minutes old: far past "fresh", well inside the limit
  const placed = await placeOrder();
  await realtime.offers.refresh();
  await eventually(() => sent.length === 1);
  await quiet();
  assert.equal(sent.length, 1, "only the nearby driver with a recent last position");
  assert.equal(sent[0].to, deviceToken(closed));
  assert.equal(sent[0].data.orderId, String(placed._id));
  assert.doesNotMatch(JSON.stringify(sent), /private-/);
});

test("a signed-out or unavailable driver is never woken from a remembered position", async () => {
  const out = await user(), off = await user();
  for (const d of [out, off]) await PushDevice.create({ userId: d._id, token: deviceToken(d), platform: "android" });
  await locate(out); await locate(off);
  await closeApp(out); await closeApp(off);
  await store.invalidateDriver(String(out._id));
  await User.updateOne({ _id: off._id }, { availableForOrders: false });
  await placeOrder();
  await realtime.offers.refresh(); await quiet();
  assert.equal(sent.length, 0);
});

test("a push that reached nobody is retried a few times, then given up; a delivered one is never repeated", async () => {
  const { createOfferDispatcher } = await import("../src/realtime/offers.js");
  const io = { to: () => ({ emit() {} }), sockets: { adapter: { rooms: new Map() } } };
  const driver = await user();
  await PushDevice.create({ userId: driver._id, token: TOKEN, platform: "android" });
  await locate(driver); await closeApp(driver);
  await placeOrder();
  const run = async transport => {
    const dispatcher = createOfferDispatcher(io, store, { ...config, offerReconcileIntervalMs: 3600000 }, createPushNotifier({ ...config, pushEnabled: true }, transport));
    try { for (let i = 0; i < 6; i++) { await dispatcher.refresh(); await quiet(); } } finally { await dispatcher.close(); }
  };
  let calls = 0;
  await run(async messages => { calls++; if (calls <= 2) throw new Error("offline"); return messages.map(() => ({ status: "ok" })); });
  assert.equal(calls, 3, "two failures and then one delivery, never a fourth try");
  calls = 0;
  await run(async () => { calls++; throw new Error("offline"); });
  assert.equal(calls, 3, "gives up after three attempts");
});

// ---- Receipts and the reasons a push is refused ----------------------------------------------------------
async function logged(action) {
  const lines = [], original = console.log, originalError = console.error;
  console.log = console.error = (...args) => { lines.push(args.join(" ")); };
  try { await action(); } finally { console.log = original; console.error = originalError; }
  return lines.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

test("a refused ticket is logged with its reason, never with the phone's token", async () => {
  const driver = await user();
  await PushDevice.create({ userId: driver._id, token: TOKEN, platform: "android" });
  const refusing = createPushNotifier({ ...config, pushEnabled: true }, async () => [{ status: "error", message: `"${TOKEN}" is not a registered push notification recipient`, details: { error: "DeviceNotRegistered" } }]);
  const lines = await logged(() => refusing.offer(driver._id, { orderId: "o9", storeName: "S" }));
  const rejected = lines.find(line => line.event === "offer_push_rejected");
  assert.equal(rejected.expoError, "DeviceNotRegistered");
  assert.equal(rejected.orderId, "o9");
  assert.doesNotMatch(JSON.stringify(lines), /abcdefghijklmnopqrstuv/);
  assert.equal(await PushDevice.countDocuments({ token: TOKEN }), 0);
  assert.equal(lines.find(line => line.event === "offer_push_sent").rejected, 1);
});

test("receipts are followed up: delivered, refused by Google, uninstalled, and not-ready-yet are told apart", async () => {
  const driver = await user();
  const tokens = ["ExponentPushToken[okokokokokokok]", "ExponentPushToken[credcredcredcred]", "ExponentPushToken[deaddeaddeaddead]", "ExponentPushToken[latelatelatelate]"];
  await PushDevice.create(tokens.map(token => ({ userId: driver._id, token, platform: "android" })));
  const requested = [];
  const receipts = {
    t0: { status: "ok" },
    t1: { status: "error", message: "Unable to retrieve the FCM server key for the recipient's app.", details: { error: "InvalidCredentials" } },
    t2: { status: "error", message: `"${tokens[2]}" is not a registered push notification recipient`, details: { error: "DeviceNotRegistered" } },
  };
  const notifier = createPushNotifier({ ...config, pushEnabled: true }, async messages => messages.map(message => ({ status: "ok", id: `t${tokens.indexOf(message.to)}` })),
    async ids => { requested.push([...ids]); return Object.fromEntries(ids.filter(id => receipts[id]).map(id => [id, receipts[id]])); });
  await notifier.offer(driver._id, { orderId: "o1", storeName: "S" });
  assert.equal(notifier.pending(), 4);
  assert.equal(await notifier.checkReceipts(), 0, "too early: nothing is asked of the push service");
  assert.equal(requested.length, 0);
  const later = Date.now() + RECEIPT_DELAY_MS + 1000;
  const lines = await logged(() => notifier.checkReceipts(later));
  assert.equal(requested.length, 1);
  assert.equal(notifier.pending(), 1, "the receipt that is not ready yet stays queued");
  assert.equal(lines.find(line => line.event === "offer_push_receipt").status, "ok");
  const credentials = lines.find(line => line.event === "offer_push_receipt_error" && line.expoError === "InvalidCredentials");
  assert.equal(credentials.level, "error");
  assert.match(credentials.reason, /FCM server key/);
  assert.doesNotMatch(JSON.stringify(lines), /deaddeaddeaddead|okokokokokokok|credcredcredcred|latelatelatelate/, "no token is ever logged");
  assert.deepEqual((await PushDevice.find({ userId: driver._id })).map(d => d.token).sort(), [tokens[0], tokens[1], tokens[3]].sort(), "only the uninstalled phone is forgotten");
  // A receipt that never becomes available is reported once, then dropped.
  const unconfirmed = await logged(() => notifier.checkReceipts(Date.now() + RECEIPT_GIVE_UP_MS + 5000));
  assert.ok(unconfirmed.some(line => line.event === "offer_push_unconfirmed"));
  assert.equal(notifier.pending(), 0);
  // A receipt service outage is logged and changes nothing.
  const down = createPushNotifier({ ...config, pushEnabled: true }, async messages => messages.map((_, i) => ({ status: "ok", id: `x${i}` })), async () => { throw new Error("offline"); });
  await down.offer(driver._id, { orderId: "o2", storeName: "S" });
  const outage = await logged(async () => assert.equal(await down.checkReceipts(Date.now() + RECEIPT_DELAY_MS + 1000), 0));
  assert.ok(outage.some(line => line.event === "push_receipts_failed"));
  assert.equal(down.pending(), 3);
});

test("the operations test push reports the ticket and the receipt, and explains an unregistered phone", async () => {
  const driver = await user();
  assert.deepEqual(await sendTestPush(driver._id, config, async () => assert.fail("nothing to send"), async () => assert.fail("nothing to read")), { devices: 0, results: [] });
  await PushDevice.create({ userId: driver._id, token: TOKEN, platform: "android", language: "he" });
  const messages = [];
  let polls = 0;
  const result = await sendTestPush(driver._id, config, async batch => { messages.push(...batch); return [{ status: "ok", id: "r1" }]; },
    async ids => { polls++; return polls < 2 ? {} : { [ids[0]]: { status: "error", message: "bad key", details: { error: "InvalidCredentials" } } }; },
    { waitMs: 5000, pollMs: 1, sleep: () => new Promise(resolve => setTimeout(resolve, 1)) });
  assert.equal(messages[0].title, "בדיקת התראות");
  assert.deepEqual(result.results, [{ platform: "android", ticket: "ok", ticketError: null, receipt: "error", receiptError: "InvalidCredentials", reason: "bad key" }]);
  assert.doesNotMatch(JSON.stringify(result), /abcdefghijklmnopqrstuv/);
});


test("v3 notifications exclude devices running the old workflow", async () => {
  const driver = await user({ supportedWorkflowVersion: 3 });
  const modernToken = "ExponentPushToken[modernworkflowdevice]";
  await PushDevice.create([{ userId: driver._id, token: TOKEN, platform: "android" },
    { userId: driver._id, token: modernToken, platform: "android", supportedWorkflowVersion: 3 }]);
  await notifier.offer(String(driver._id), { orderId: "v3-device-check", workflowVersion: 3,
    storeName: "Store", driverEarningsAgorot: 2700, expiresAt: new Date(Date.now() + 60000).toISOString() });
  assert.deepEqual(sent.map(message => message.to), [modernToken]);
});
