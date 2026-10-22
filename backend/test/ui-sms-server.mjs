// Loopback-only fixture. All provider calls are simulated; there is no live transport.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { startFakeRouting } from "./helpers/routing.js";
import { offerLocationFixtures, closeOfferLocations } from "./helpers/offerLocations.js";
const uri = process.env.SMS_UI_TEST_URI;
if (!uri || !new URL(uri).pathname.endsWith("_test")) throw new Error("Set SMS_UI_TEST_URI to a dedicated *_test database");
process.env.MONGODB_URI = uri;
process.env.JWT_SECRET = "sms-local-browser-fixture";
process.env.PUBLIC_BASE_URL = "http://127.0.0.1:3159";
process.env.UNIFIED_DELIVERY_ENABLED = "true";
const routing = await startFakeRouting();
const { User, Order, connectDatabase } = await import("../src/models/index.js");
const { SmsOperation } = await import("../src/models/smsOperation.js");
const { createApp } = await import("../src/app.js");
const { createTextMeClient } = await import("../src/services/textMe.js");
const { translations } = await import("../../web/src/translations.js");
await connectDatabase();
const users = [];
let mode = "accepted", calls = 0;
const textMe = createTextMeClient({ cfg: { textMeApiToken: "mock-only", textMeUsername: "mock-only", textMeSource: "Waselha", textMeEnabled: true },
  timeoutMs: 500, fetchImpl: async (url, { signal }) => {
    calls++;
    if (mode === "timeout") return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("simulated timeout")), { once: true }));
    return new Response(JSON.stringify(mode === "rejected" ? { status: 12 } : { status: 0, shipment_id: "mock-shipment" }));
  } });
const app = createApp({ textMe, locationStore: await offerLocationFixtures() });
const server = createServer(async (req, res) => {
  if (req.url === "/__test/translations") return res.end(JSON.stringify(translations));
  if (req.url === "/__test/setup" && req.method === "POST") {
    let body = ""; for await (const chunk of req) body += chunk;
    mode = JSON.parse(body).mode || "accepted"; calls = 0;
    const user = await User.create({ login: randomUUID(), role: "store", name: "متجر الاختبار", storeName: "متجر الاختبار", passwordHash: "fixture", active: true,
      pickupServiceArea: "kafr-kanna", pickupLocation: { lat: 32.75, lng: 35.34, address: "Test pickup", source: "gps", confirmedAt: new Date() } });
    users.push(user._id);
    return res.end(JSON.stringify({ token: jwt.sign({ ver: 0 }, process.env.JWT_SECRET, { subject: String(user._id), expiresIn: "10m" }) }));
  }
  if (req.url === "/__test/calls") return res.end(JSON.stringify({ calls }));
  app(req, res);
});
server.listen(3159, "127.0.0.1", () => {
  console.log("SMS UI fixture ready (simulated provider)");
  process.send?.("ready");
});
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  await new Promise(resolve => server.close(resolve));
  const created = await Order.find({ storeId: { $in: users } }).select("_id").lean();
  await Promise.all([User.deleteMany({ _id: { $in: users } }), Order.deleteMany({ storeId: { $in: users } }), SmsOperation.deleteMany({ orderId: { $in: created.map(order => order._id) } })]);
  await mongoose.disconnect();
  await closeOfferLocations();
  await routing.close();
}
process.on("SIGINT", () => void stop()); process.on("SIGTERM", () => void stop());
process.on("message", message => { if (message === "shutdown") void stop().then(() => process.disconnect?.()); });
