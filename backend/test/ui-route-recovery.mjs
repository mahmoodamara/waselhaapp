// Disposable browser fixture, loopback only; never part of the application.
import { createServer } from "node:http";
import { startFakeRouting } from "./helpers/routing.js";
process.env.MONGODB_URI = process.env.UI_ROUTE_TEST_URI;
if (!process.env.MONGODB_URI || !new URL(process.env.MONGODB_URI).pathname.endsWith("_test"))
  throw new Error("Set UI_ROUTE_TEST_URI to a dedicated *_test database (it will be reset)");
process.env.JWT_SECRET = "route-browser-isolated-secret";
process.env.PUBLIC_BASE_URL = "http://127.0.0.1:3109";
const fake = await startFakeRouting();
fake.distance = 0;
const { connectDatabase, Order, User } = await import("../src/models/index.js");
await connectDatabase();
await Order.db.dropDatabase();
await Promise.all([Order, User].map(m => m.syncIndexes()));
await (await import("../src/scripts/seed.js")).seed();
await Order.deleteMany({});
await User.updateOne({ login: "driver1" }, { $set: { availableForOrders: true, serviceAreas: ["kafr-kanna"] } });
const { createApp } = await import("../src/app.js");
const { translations } = await import("../../web/src/translations.js");
const app = createApp();
const server = createServer((req, res) => {
  if (req.url === "/__test/translations") return res.end(JSON.stringify(translations));
  if (req.url === "/__test/fail" && req.method === "POST") { fake.mode = "fail"; return res.end("{}"); }
  if (req.url === "/__test/zero" && req.method === "POST") { fake.mode = "ok"; fake.distance = 0; return res.end("{}"); }
  if (req.url === "/__test/route" && req.method === "POST") { fake.mode = "ok"; fake.distance = 1500; return res.end("{}"); }
  app(req, res);
}).listen(3109, "127.0.0.1", () => console.log("Route recovery browser fixture ready"));
async function stop() { server.close(); await fake.close(); await Order.db.close(); }
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
