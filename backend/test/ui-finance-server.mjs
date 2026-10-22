// Isolated browser fixture; never mounted by the production application.
import { createServer } from "node:http";
import { Types } from "mongoose";
import { startFakeRouting } from "./helpers/routing.js";
import { offerLocationFixtures, refreshOfferLocations, closeOfferLocations, resetOrderActionLimits } from "./helpers/offerLocations.js";
process.env.MONGODB_URI = process.env.UI_FINANCE_TEST_URI || "mongodb://127.0.0.1:27119/waselha_step8_browser_test";
if (!new URL(process.env.MONGODB_URI).pathname.endsWith("_test")) throw new Error("Use a dedicated *_test database");
process.env.JWT_SECRET = "step8-isolated-browser-secret";
process.env.PUBLIC_BASE_URL = "http://127.0.0.1:3108";
const fake = await startFakeRouting(); fake.distance = 1500;
const { Order, User, connectDatabase } = await import("../src/models/index.js");
await connectDatabase(); await Order.db.dropDatabase();
await Promise.all([Order, User].map(m => m.syncIndexes()));
const { seed } = await import("../src/scripts/seed.js"); await seed(); await Order.deleteMany({});
await User.updateOne({ login: "driver1" }, { $set: { availableForOrders: true, serviceAreas: ["kafr-kanna"], vehicleType: "car" } });
const { createApp } = await import("../src/app.js");
const { translations } = await import("../../web/src/translations.js");
const driverTexts = (await import("../../driver-app/translations.js")).translations;
const { buildDriverBundle, driverFontsCSS, readDriverFont } = await import("../../driver-app/test/browser-bundle.mjs");
const bundle = await buildDriverBundle("http://127.0.0.1:3108/api");
const app = createApp({ locationStore: await offerLocationFixtures() });
const server = createServer(async (req, res) => {
  if (req.url === '/__test/reset-action-limits' && req.method === 'POST') {
    await resetOrderActionLimits(User); return res.end('{}');
  }
  if (req.url.startsWith("/api/driver/orders/available")) await refreshOfferLocations(User);
  if (req.method === "POST" && /^\/__test\/age\/[a-f0-9]{24}$/.test(req.url)) {
    await Order.collection.updateOne({ _id: new Types.ObjectId(req.url.split("/").at(-1)) },
      { $set: { updatedAt: new Date(Date.now() - 5 * 3600 * 1000) } });
    return res.end("{}");
  }
  if (req.url === "/__test/translations") return res.end(JSON.stringify({ web: translations, driver: driverTexts }));
  if (req.url === "/__test/driver.js") { res.setHeader("Content-Type", "text/javascript"); return res.end(bundle); }
  const font = /^\/fonts\/(400Regular|500Medium|700Bold)\.ttf$/.exec(req.url);
  if (font) { res.setHeader("Content-Type", "font/ttf"); return res.end(await readDriverFont(font[1])); }
  if (req.url === "/__test/driver") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end('<!doctype html><html dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + driverFontsCSS + 'html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}*{box-sizing:border-box}body{font-family:Arial}input{min-width:0;max-width:100%}</style><div id="root"></div><script type="module" src="/__test/driver.js"></script></html>');
  }
  app(req, res);
}).listen(3108, "127.0.0.1", () => console.log("STEP 8 isolated UI fixture ready"));
async function stop() { server.close(); await closeOfferLocations(); await fake.close(); await Order.db.close(); }
process.on("SIGTERM", stop); process.on("SIGINT", stop);
