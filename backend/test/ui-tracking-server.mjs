// Loopback-only, isolated fixture for the actual built customer UI + Redis +
// Socket.IO. Test-only controls never enter createApp or production routes.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
const uri = process.env.TRACKING_UI_TEST_URI;
if (!uri || !new URL(uri).pathname.endsWith("_test") || !process.env.REDIS_TEST_URL)
  throw new Error("Set TRACKING_UI_TEST_URI (*_test) and REDIS_TEST_URL");
process.env.MONGODB_URI = uri;
process.env.JWT_SECRET = "phase7-local-browser-only";
process.env.PUBLIC_BASE_URL = "http://127.0.0.1:3117";
const { User, Order, connectDatabase, CodeAttempt, CodeAttemptState } = await import("../src/models/index.js");
const { createApp } = await import("../src/app.js");
const { attachRealtime } = await import("../src/realtime/index.js");
const { createLocationStore } = await import("../src/services/locationStore.js");
const { issueCustomerToken } = await import("../src/services/customerLinks.js");
const { withTrackingOrder } = await import("../src/services/trackingGate.js");
const { ordersChanged } = await import("../src/services/orderSignals.js");
const { config } = await import("../src/config.js");
const { translations } = await import("../../web/src/translations.js");
await connectDatabase();
const redis = createClient({ url: process.env.REDIS_TEST_URL }); redis.on("error", () => {}); await redis.connect();
const store = createLocationStore(redis, { ...config, locationFreshMs: 2500 }, `phase7-ui:${randomUUID()}:`);
const app = createApp({ locationStore: store }), drivers = [], orders = [];
async function body(req) { let text = ""; for await (const chunk of req) text += chunk; return JSON.parse(text || "{}"); }
const server = createServer(async (req, res) => {
  if (req.url === "/__test/translations") return res.end(JSON.stringify(translations));
  if (req.url === "/__test/setup" && req.method === "POST") {
    const driver = await User.create({ login: randomUUID(), name: "Browser driver", passwordHash: "test-fixture",
      role: "driver", active: true, availableForOrders: true }); drivers.push(driver._id);
    const order = { _id: new mongoose.Types.ObjectId(), ...issueCustomerToken(), storeId: new mongoose.Types.ObjectId(),
      storeName: "Test Store", driverId: driver._id, activeAssignment: true, status: "driver_assigned", workflowVersion: 2,
      customerConfirmed: true, createdAt: new Date(), updatedAt: new Date(), priceSource: "manual", priceStatus: "final",
      recipientName: "Customer", customerPhone: "0500000000", deliveryCode: "123456", goodsAmountKnown: true,
      goodsAmountAgorot: 0, deliveryFeeAgorot: 0, deliveryFeePaidBy: "store", expectedCustomerCashAgorot: 0,
      destinationLocation: { lat: 32.76, lng: 35.35, confirmedAt: new Date(), address: "Destination" } };
    await Order.collection.insertOne(order); orders.push(order._id);
    const sessionId = randomUUID(); await store.activateSession(String(driver._id), sessionId);
    const driverToken = jwt.sign({ ver: 0 }, config.jwtSecret, { subject: String(driver._id), expiresIn: "10m" });
    return res.end(JSON.stringify({ token: order.customerToken, orderId: String(order._id), driverToken, sessionId }));
  }
  if (req.url === "/__test/status" && req.method === "POST") {
    const value = await body(req);
    const id = new mongoose.Types.ObjectId(value.orderId);
    if (!orders.some(order => order.equals(id))) { res.statusCode = 404; return res.end("{}"); }
    await withTrackingOrder(id, async () => {
      await Order.collection.updateOne({ _id: id }, { $set: { status: value.status, updatedAt: new Date() } }); ordersChanged();
    });
    return res.end("{}");
  }
  if (req.url === "/__test/disconnect" && req.method === "POST") {
    realtime.tracking.namespace.disconnectSockets(true); return res.end("{}");
  }
  app(req, res);
});
const realtime = attachRealtime(server, store);
server.listen(3117, "127.0.0.1", () => console.log("Phase7 UI fixture ready"));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await realtime.close();
  await redis.del([...drivers.flatMap(id => Object.values(store.keys(String(id)))), store.geoKey]); await redis.quit();
  await Promise.all([Order.deleteMany({ _id: { $in: orders } }), User.deleteMany({ _id: { $in: drivers } }),
    CodeAttempt.deleteMany({ orderId: { $in: orders } }), CodeAttemptState.deleteMany({ orderId: { $in: orders } })]);
  await mongoose.disconnect(); server.close();
}
process.on("SIGINT", () => { void stop(); }); process.on("SIGTERM", () => { void stop(); });
process.on("message", value => { if (value === "shutdown") void stop().then(() => { process.disconnect?.(); }); });
