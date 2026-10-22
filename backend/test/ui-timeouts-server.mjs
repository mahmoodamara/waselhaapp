// Isolated local browser fixture only. Never mounted by the application server.
import { fileURLToPath } from "node:url";
import { startFakeRouting } from "./helpers/routing.js";
process.env.MONGODB_URI = process.env.UI_TIMEOUT_TEST_URI || "mongodb://127.0.0.1:27017/waselha_step6_browser_test";
if (!new URL(process.env.MONGODB_URI).pathname.endsWith("_test")) throw new Error("Use a dedicated *_test database");
process.env.JWT_SECRET = "step6-isolated-browser-secret";
process.env.PUBLIC_BASE_URL = "http://127.0.0.1:3106";
const fake = await startFakeRouting();
const { Order, connectDatabase } = await import("../src/models/index.js");
await connectDatabase(); await Order.db.dropDatabase();
const { seed } = await import("../src/scripts/seed.js");
await seed();
const { runTimeoutSweep } = await import("../src/services/orderTimeouts.js");
const { createApp } = await import("../src/app.js");
const { translations } = await import("../../web/src/translations.js");
const driverTranslations = (await import("../../driver-app/translations.js")).translations;
const { buildDriverBundle, driverFontsCSS, readDriverFont } = await import("../../driver-app/test/browser-bundle.mjs");
const bundle = await buildDriverBundle("http://127.0.0.1:3106/api", fileURLToPath(new URL("./ui/driver-harness.jsx", import.meta.url)));
const app = createApp();
// Separate wrapper: test controls cannot be reached through production createApp.
const { createServer } = await import("node:http");
const server = createServer(async (req, res) => {
  if (req.url === "/__test/translations") return res.end(JSON.stringify(translations));
  if (req.url === "/__test/driver-translations") return res.end(JSON.stringify(driverTranslations));
  if (req.url === "/__test/driver.js") { res.setHeader("Content-Type", "text/javascript"); return res.end(bundle); }
  const font = /^\/fonts\/(400Regular|500Medium|700Bold)\.ttf$/.exec(req.url);
  if (font) { res.setHeader("Content-Type", "font/ttf"); return res.end(await readDriverFont(font[1])); }
  if (req.url.startsWith("/__test/driver?")) {
    res.setHeader("Content-Type", "text/html");
    return res.end('<!doctype html><html dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + driverFontsCSS + 'html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}*{box-sizing:border-box}</style><div id="root"></div><script type="module" src="/__test/driver.js"></script></html>');
  }
  if (req.method === "POST" && req.url.startsWith("/__test/expire/")) {
    const parts = req.url.split("/"); const field = parts[3] === "search" ? "searchDeadlineAt" : "storeArrivalDeadlineAt";
    await Order.updateOne({ _id: parts[4] }, { $set: { [field]: new Date(Date.now() - 1000) } });
    await runTimeoutSweep(); return res.end("{}");
  }
  if (req.method === "POST" && req.url === "/__test/reset") { await Order.deleteMany({}); return res.end("{}"); }
  app(req, res);
}).listen(3106, "127.0.0.1", () => console.log("STEP 6 isolated UI fixture ready"));
async function stop() { server.close(); await fake.close(); await Order.db.close(); }
process.on("SIGTERM", stop); process.on("SIGINT", stop);
