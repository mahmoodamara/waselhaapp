import assert from "node:assert/strict";
import { before, beforeEach, after, afterEach, test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { offerLocationFixtures, closeOfferLocations } from "./helpers/offerLocations.js";

const uri = process.env.SMS_TEST_URI;
if (!uri || !new URL(uri).pathname.endsWith("_test"))
  throw new Error("Set SMS_TEST_URI to a dedicated *_test database. Its SMS, order and user fixtures will be reset.");
process.env.MONGODB_URI = uri;
process.env.JWT_SECRET = "sms-isolated-test-secret";
process.env.TRUST_PROXY = "1";
process.env.UNIFIED_DELIVERY_ENABLED = "true";
const { User, Order, connectDatabase } = await import("../src/models/index.js");
const { SmsOperation } = await import("../src/models/smsOperation.js");
const { createApp } = await import("../src/app.js");
const { createTextMeClient } = await import("../src/services/textMe.js");
const { customerLinkSms } = await import("../src/services/orderSms.js");
const cfg = { textMeApiToken: "private-sms-test-token", textMeUsername: "private-sms-account", textMeSource: "Waselha", textMeEnabled: true };
let reply, calls, payloads, merchant, foreign, driver, admin, order, server, base;
let testNumber = 0;
const fakeTransport = async (url, options) => { calls++; payloads.push(JSON.parse(options.body)); return reply(url, options); };
const client = createTextMeClient({ cfg, fetchImpl: fakeTransport, timeoutMs: 30 });
const account = role => User.create({ login: randomUUID(), role, name: "SMS fixture", passwordHash: "not-a-login", active: true });
async function orderRequest(path, method = "POST", body = {}, actor = merchant) {
  const token = jwt.sign({ ver: 0 }, process.env.JWT_SECRET, { subject: String(actor._id), expiresIn: "5m" });
  const response = await fetch(`${base}/api/orders${path}`, { method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Forwarded-For": `127.0.0.${testNumber}` },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}
const newOrderBody = () => ({ operationId: String(new mongoose.Types.ObjectId()), workflowVersion: 3, storeAuthorization: true,
  customerPhone: "0501234567", vehicleType: "motorcycle", parcelSize: "medium", parcelReady: true,
  goodsAmountAgorot: 10000, goodsPaymentStatus: "unpaid", deliveryFeePaidBy: "customer" });
async function request(actor = merchant, method = "POST", body = {}, target = order._id) {
  const token = actor && jwt.sign({ ver: 0 }, process.env.JWT_SECRET, { subject: String(actor._id), expiresIn: "5m" });
  const response = await fetch(`${base}/api/orders/${target}/customer-link/sms`, {
    method, headers: { "Content-Type": "application/json", "X-Forwarded-For": `127.0.0.${testNumber}`, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json() };
}
const openServer = async () => {
  server = createServer(createApp({ textMe: client, locationStore: await offerLocationFixtures() }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
};
const closeServer = () => new Promise(resolve => server.close(resolve));
before(async () => { await connectDatabase(); });
beforeEach(async () => {
  testNumber++;
  calls = 0; payloads = [];
  reply = async () => new Response(JSON.stringify({ status: 0, shipment_id: "shipment-1" }));
  await Promise.all([User.deleteMany({}), Order.deleteMany({}), SmsOperation.deleteMany({})]);
  [merchant, foreign, driver, admin] = await Promise.all([account("store"), account("store"), account("driver"), account("admin")]);
  await User.updateOne({ _id: merchant._id }, { $set: { pickupServiceArea: "kafr-kanna",
    pickupLocation: { lat: 32.75, lng: 35.34, source: "gps", confirmedAt: new Date(), address: "Test pickup" } } });
  order = await Order.create({ storeId: merchant._id, storeName: "Fixture store", customerPhone: "0501234567",
    customerToken: randomUUID(), customerTokenExpiresAt: new Date(Date.now() + 3600000), deliveryCode: "123456", pickupCode: "654321" });
  await openServer();
});
after(async () => { await closeOfferLocations(); await Promise.all([User.deleteMany({}), Order.deleteMany({}), SmsOperation.deleteMany({})]); await mongoose.disconnect(); });
afterEach(closeServer);

test("real HTTP route checks authentication, roles, ownership and input before dispatch", async () => {
  assert.equal((await request(null)).status, 401);
  assert.equal((await request(driver)).status, 403);
  assert.equal((await request(foreign)).status, 404);
  assert.equal((await request(foreign, "GET")).status, 404);
  assert.equal((await request(merchant, "POST", {}, "bad-id")).status, 400);
  for (const body of [{ recipient: "0507654321" }, { message: "spam" }, { source: "Other" }, { dryRun: true }, { token: "x" }])
    assert.equal((await request(await account("admin"), "POST", body)).status, 400);
  assert.equal(calls, 0);
  assert.equal(await SmsOperation.countDocuments(), 0);
});

test("concurrent requests create one durable event, return status and never trust client SMS fields", async () => {
  const results = await Promise.all([request(), request(), request()]);
  assert.ok(results.every(r => r.status === 200 && ["pending", "accepted"].includes(r.data.state)));
  assert.equal(calls, 1);
  assert.equal(await SmsOperation.countDocuments(), 1);
  assert.equal(await SmsOperation.collection.indexExists("_id_"), true);
  const saved = await SmsOperation.findOne().lean();
  assert.equal(saved.state, "accepted");
  assert.equal(saved.externalId, payloads[0].sms.destinations.phone.$.id);
  assert.equal(saved.shipmentId, "shipment-1");
  assert.equal(payloads[0].sms.destinations.phone._, order.customerPhone);
  assert.ok(payloads[0].sms.message.includes(`/customer/${order.customerToken}`));
  assert.doesNotMatch(JSON.stringify(saved), /0501234567|private-sms|\/customer\//);
  assert.equal((await request(merchant, "GET")).data.state, "accepted");
  assert.equal((await request(admin)).data.state, "accepted");
  // Recreate the app (no in-memory sending map) and replay the same event.
  await closeServer(); await openServer();
  assert.equal((await request()).data.state, "accepted");
  assert.equal(calls, 1);
});

test("timeout persists uncertain and a replay cannot resend", async () => {
  reply = async (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("private")), { once: true }));
  const result = await request();
  assert.equal(result.data.state, "uncertain");
  assert.equal(result.data.code, "sms_timeout");
  assert.equal((await request()).data.state, "uncertain");
  assert.equal(calls, 1);
  assert.equal((await SmsOperation.findOne()).state, "uncertain");
});

test("provider rejection is saved and not retried; raw provider text never reaches HTTP", async () => {
  reply = async () => new Response(JSON.stringify({ status: 123, message: cfg.textMeApiToken }));
  const result = await request();
  assert.equal(result.data.state, "rejected");
  assert.doesNotMatch(JSON.stringify(result), /private-sms/);
  assert.equal((await request()).data.state, "rejected");
  assert.equal(calls, 1);
});

test("missing config, unsupported numbers, expired links and terminal orders create no attempts", async () => {
  for (const patch of [{ customerPhone: "+972501234567" }, { customerTokenExpiresAt: new Date(0) }, { status: "cancelled" }]) {
    const original = order.toObject();
    await Order.updateOne({ _id: order._id }, { $set: patch });
    assert.ok([409, 422].includes((await request()).status));
    await Order.updateOne({ _id: order._id }, { $set: Object.fromEntries(Object.keys(patch).map(k => [k, original[k]])) });
  }
  const unconfigured = createTextMeClient({ cfg: { ...cfg, textMeApiToken: "" }, fetchImpl: fakeTransport });
  await assert.rejects(customerLinkSms(merchant, String(order._id), { send: true, client: unconfigured }), { code: "sms_not_configured" });
  assert.equal(calls, 0);
  assert.equal(await SmsOperation.countDocuments(), 0);
});

test("a stale pending event becomes uncertain after an interrupted process; it is never reclaimed", async () => {
  await request();
  await SmsOperation.collection.updateOne({}, { $set: { state: "pending", code: "sms_pending", shipmentId: null, createdAt: new Date(0) } });
  assert.equal((await request(merchant, "GET")).data.state, "uncertain");
  assert.equal((await request()).data.code, "sms_interrupted");
  assert.equal(calls, 1);
});

test("a database failure prevents dispatch; a lost result write leaves a claim that blocks replay", async () => {
  const originalCreate = SmsOperation.create, originalUpdate = SmsOperation.findOneAndUpdate;
  try {
    SmsOperation.create = async () => { throw new Error("private-db-error"); };
    const failedClaim = await request();
    assert.equal(failedClaim.status, 500);
    assert.doesNotMatch(JSON.stringify(failedClaim), /private-db/);
    assert.equal(calls, 0);
    SmsOperation.create = originalCreate;
    SmsOperation.findOneAndUpdate = () => { throw new Error("private-db-error"); };
    assert.equal((await request()).status, 500);
    assert.equal(calls, 1);
    SmsOperation.findOneAndUpdate = originalUpdate;
    assert.equal((await request()).data.state, "pending");
    assert.equal(calls, 1);
  } finally { SmsOperation.create = originalCreate; SmsOperation.findOneAndUpdate = originalUpdate; }
});

test("rate limiting rejects excess authenticated requests before an SMS is sent", async () => {
  for (let i = 0; i < 5; i++) assert.equal((await request()).status, 200);
  const limited = await request();
  assert.equal(limited.status, 429);
  assert.equal(limited.data.code, "rate_limited");
  assert.equal(calls, 1);
});

test("reissuing the link creates a distinct tracked event; retrying either event cannot resend it", async () => {
  const first = await request();
  await Order.updateOne({ _id: order._id }, { $set: { customerToken: randomUUID() } });
  const second = await request();
  assert.notEqual(first.data.externalId, second.data.externalId);
  assert.equal(await SmsOperation.countDocuments(), 2);
  assert.equal(calls, 2);
  await request(); assert.equal(calls, 2);
});

test("creating an order automatically sends its link once, including concurrent create replays", async () => {
  const body = newOrderBody();
  const results = await Promise.all([orderRequest("", "POST", body), orderRequest("", "POST", body)]);
  assert.ok(results.every(value => [200, 201].includes(value.status)), JSON.stringify(results));
  assert.equal(calls, 1, "creation sends without calling the SMS endpoint");
  assert.equal(payloads[0].sms.destinations.phone._, body.customerPhone);
  const savedId = results[0].data._id;
  assert.equal(results[1].data._id, savedId);
  assert.equal(await SmsOperation.countDocuments({ orderId: savedId }), 1);
  assert.equal((await request(merchant, "GET", {}, savedId)).data.state, "accepted");
  await orderRequest("", "POST", body);
  assert.equal(calls, 1);
});

test("automatic timeout keeps the created order and its uncertain claim without replaying SMS", async () => {
  reply = async (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("private")), { once: true }));
  const body = newOrderBody();
  const created = await orderRequest("", "POST", body);
  assert.equal(created.status, 201);
  assert.equal((await request(merchant, "GET", {}, created.data._id)).data.state, "uncertain");
  assert.ok(await Order.exists({ _id: created.data._id }));
  await orderRequest("", "POST", body);
  assert.equal(calls, 1);
});

test("automatic provider rejection is visible while order creation remains successful", async () => {
  reply = async () => new Response(JSON.stringify({ status: 515 }));
  const body = newOrderBody();
  const created = await orderRequest("", "POST", body);
  assert.equal(created.status, 201);
  assert.equal((await request(merchant, "GET", {}, created.data._id)).data.state, "rejected");
  assert.equal(calls, 1);
});

test("saving a missing customer phone triggers automatic SMS; ordinary edits and reloads never resend", async () => {
  await Order.updateOne({ _id: order._id }, { $unset: { customerPhone: "" }, $set: { area: "Test area" } });
  const before = (await orderRequest(`/${order._id}`, "GET")).data;
  const saved = await orderRequest(`/${order._id}`, "PATCH", { customerPhone: "0501234567", observed: before.confirmationSnapshot });
  assert.equal(saved.status, 200);
  assert.equal(calls, 1);
  const next = (await orderRequest(`/${order._id}`, "GET")).data;
  assert.equal((await orderRequest(`/${order._id}`, "PATCH", { customerPhone: "0501234567", observed: next.confirmationSnapshot })).status, 200);
  assert.equal(calls, 1);
});

test("a merchant's replacement link is automatically sent once and command replay cannot send twice", async () => {
  const body = { requestId: randomUUID() };
  assert.equal((await orderRequest(`/${order._id}/customer-link/reissue`, "POST", body)).status, 200);
  assert.equal(calls, 1);
  assert.equal((await orderRequest(`/${order._id}/customer-link/reissue`, "POST", body)).status, 200);
  assert.equal(calls, 1);
});

test("a failed automatic SMS claim does not send and does not undo the created order", async () => {
  const original = SmsOperation.create;
  const body = newOrderBody();
  try {
    SmsOperation.create = async () => { throw new Error("private-db-error"); };
    const result = await orderRequest("", "POST", body);
    assert.equal(result.status, 201);
    assert.match(result.data._id, /^[a-f0-9]{24}$/);
    assert.notEqual(result.data._id, body.operationId);
    assert.equal(calls, 0);
    assert.ok(await Order.exists({ _id: result.data._id }));
  } finally { SmsOperation.create = original; }
});

test("automatic sending is rate limited before another order or provider request is created", async () => {
  for (let n = 0; n < 5; n++) assert.equal((await orderRequest("", "POST", newOrderBody())).status, 201);
  const denied = newOrderBody();
  const count = await Order.countDocuments();
  assert.equal((await orderRequest("", "POST", denied)).status, 429);
  assert.equal(await Order.countDocuments(), count);
  assert.equal(calls, 5);
});
