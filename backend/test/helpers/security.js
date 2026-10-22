// Real HTTP server and isolated MongoDB. Each test file runs sequentially.
import assert from "node:assert/strict";
import { before, beforeEach, after } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { startFakeRouting } from "./routing.js";
import { refreshOfferLocations, closeOfferLocations, resetOrderActionLimits } from "./offerLocations.js";

const uri = process.env.SECURITY_TEST_URI;
if (!uri || !new URL(uri).pathname.endsWith("_test"))
  throw new Error("Set SECURITY_TEST_URI to a dedicated *_test MongoDB database. It will be reset.");
process.env.MONGODB_URI = uri;
process.env.JWT_SECRET = "access-security-test-secret";
process.env.RATE_LIMIT_LOGIN_PER_MIN = process.env.RATE_LIMIT_CUSTOMER_PER_MIN = "1000000"; // suites log in/call constantly
process.env.CUSTOMER_LINK_TTL_HOURS = "24";
process.env.LOGIN_MAX_ATTEMPTS = "5";
process.env.LOGIN_LOCK_MINUTES = "15";
export const router = await startFakeRouting();
export const models = await import("../../src/models/index.js");
const { seed } = await import("../../src/scripts/seed.js");
export const loginStates = () => mongoose.connection.collection("loginattemptstates");
export const sessions = {};
let server, port;
let capturedAuditServerLogs = "";
// Opt-in, in-memory evidence for the follow-up audit; never prints raw logs.
export const auditServerLogs = () => capturedAuditServerLogs;
export const apiUrl = (path) => `http://127.0.0.1:${port}/api${path}`;
// retry-search and link reissue are idempotent commands that need a request ID.
// Most suites just click "again", so a bodiless call gets a fresh ID; tests of
// replay semantics pass their own.
const commandPath = /\/(retry-search|customer-link\/reissue)$/;
export async function request(path, token, method = "GET", body, expected = 200, headers = {}) {
  if (path === "/driver/orders/available") await refreshOfferLocations(models.User);
  if (method === "POST" && commandPath.test(path) && (body === undefined || (body && !body.requestId)))
    body = { ...body, requestId: randomUUID() };
  const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    // Each test command owns a connection. A pooled socket can be closed by a
    // restarted/idle fixture while Node's Windows client still considers it reusable.
    // Never auto-retry a state-changing command to hide that transport failure.
    headers: { "Content-Type": "application/json", Connection: "close", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (expected !== null)
    assert.equal(response.status, expected, `${method} ${path}: expected ${expected}, received ${response.status}`);
  return { status: response.status, data, retryAfter: response.headers.get("retry-after") };
}
async function start() {
  server = spawn(process.execPath, [fileURLToPath(new URL("../../src/server.js", import.meta.url))], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", PUBLIC_BASE_URL: `http://127.0.0.1:${port}`, GOOGLE_ROUTES_ENABLED: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  server.stdout.on("data", (chunk) => { logs += chunk; if (process.env.SECURITY_CAPTURE_LOGS === "true") capturedAuditServerLogs += chunk; });
  server.stderr.on("data", (chunk) => { logs += chunk; if (process.env.SECURITY_CAPTURE_LOGS === "true") capturedAuditServerLogs += chunk; });
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`Test server exited: ${logs}`);
    try { if ((await request("/health")).data.ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Test server failed to start: ${logs}`);
}
async function stop() {
  if (server?.exitCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    await exited;
  }
}
export async function restart() { await stop(); await start(); }
before(async () => {
  await models.connectDatabase();
  await mongoose.connection.dropDatabase();
  await Promise.all([models.User, models.Order, models.DriverCashRecord, models.CodeAttemptState, models.CodeAttempt].map((m) => m.syncIndexes()));
  await seed();
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  await start();
  for (const login of ["admin", "store1", "driver1", "driver2"])
    sessions[login] = (await request("/auth/login", null, "POST", { login, password: "WaselhaDemo123!" })).data;
});
beforeEach(async () => {
  await resetOrderActionLimits(models.User);
  // Explicit eligible fixtures for earlier workflow suites, never a production migration.
  await models.User.updateMany({ login: { $in: ["driver1", "driver2"] } },
    { $set: { availableForOrders: true, serviceAreas: ["kafr-kanna"] } });
  // driver1 drives a car, driver2 a motorcycle (vehicle-based offers).
  await models.User.updateOne({ login: "driver1" }, { $set: { vehicleType: "car" } });
  await models.User.updateOne({ login: "driver2" }, { $set: { vehicleType: "motorcycle" } });
  await Promise.all([models.Order, models.DriverCashRecord, models.CodeAttemptState, models.CodeAttempt].map((m) => m.deleteMany({})));
  await loginStates().deleteMany({});
});
after(async () => { await stop(); await closeOfferLocations(); await mongoose.disconnect(); await router.close(); });

// Deactivation and password resets revoke sessions on purpose; tests that do either sign in again.
export const relogin = async (login) => Object.assign(sessions[login],
  (await request("/auth/login", null, "POST", { login, password: "WaselhaDemo123!" })).data);
export const tokenOf = (order) => order.customerLink.split("/").at(-1);
export const create = async (extra = {}) => (await request("/orders", sessions.store1.token, "POST", {
  serviceArea: "kafr-kanna",
  deliveryFeePaidBy: "customer",
  area: "Central area", customerPhone: "0501234567", recipientName: "Customer name",
  preliminaryAddress: "Preliminary address", finalAddress: "Final address",
  parcelDescription: "Sealed box", parcelReady: true,
  goodsAmountAgorot: 10000, deliveryFeeAgorot: 2000, ...extra,
}, 201)).data;
export async function confirm(token) {
  let view = (await request(`/customer/${token}`)).data;
  // Successful financial-confirmation fixtures need a final server price.
  // Failure tests call the endpoint directly without this fixture preparation.
  if (view.priceSource === "route" && view.deliveryFeeAgorot === null) {
    await confirmLocation(token);
    view = (await request(`/customer/${token}`)).data;
  }
  return (await request(`/customer/${token}/confirm`, null, "POST", {
    observed: view.confirmationSnapshot, recipientName: "Customer name",
    finalAddress: "Final address", deliveryInstructions: "Door instructions",
  })).data;
}
// STEP 4: pickup needs a confirmed destination. Confirming the same one again
// is a no-op, so tests may confirm a different one first.
export const destination = { lat: 32.75, lng: 35.35, address: "Customer street 5", source: "gps" };
export const confirmLocation = async (token, location = destination, expected = 200) =>
  request(`/customer/${token}/location`, null, "POST", location, expected);
export async function pickedUp(order, token = tokenOf(order)) {
  await confirm(token);
  await confirmLocation(token);
  await request(`/orders/${order._id}/accept`, sessions.driver1.token, "POST", {});
  for (const actor of [sessions.store1.token, sessions.driver1.token]) {
    const view = (await request(`/orders/${order._id}`, actor)).data;
    await request(`/orders/${order._id}/confirm`, actor, "POST", { observed: view.confirmationSnapshot });
  }
  await request(`/orders/${order._id}/arrive-store`, sessions.driver1.token, "POST", {});
  await request(`/orders/${order._id}/pickup`, sessions.driver1.token, "POST", { code: order.pickupCode });
}
