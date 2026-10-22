import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "./worker.mjs";

const origin = "https://waselha-web.example.workers.dev";
const env = { BACKEND_ORIGIN: "https://waselhaapp.onrender.com", ASSETS: { fetch: async () => new Response("app") } };

test("static routes and customer deep links use the asset binding", async t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("must not proxy assets"); });
  for (const path of ["/", "/customer/test-secret", "/store/orders", "/assets/app.js", "/apiculture", "/socket.io-other"])
    assert.equal(await (await worker.fetch(new Request(origin + path), env)).text(), "app");
});

test("API proxy preserves method, JSON, auth, query and browser origin; never caches", async t => {
  let received;
  t.mock.method(globalThis, "fetch", async (request, options) => {
    received = { url: request.url, method: request.method, headers: request.headers, body: await request.json(), redirect: request.redirect, options };
    return Response.json({ priceStatus: "final" });
  });
  const response = await worker.fetch(new Request(origin + "/api/customer/test-secret/location?x=1", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test-only", Origin: origin,
      Forwarded: "for=spoof", "X-Forwarded-For": "spoof", "X-Forwarded-Host": "spoof", "CF-Connecting-IP": "192.0.2.1" },
    body: JSON.stringify({ lat: 32.75, lng: 35.35 }),
  }), env);
  assert.equal(received.url, env.BACKEND_ORIGIN + "/api/customer/test-secret/location?x=1");
  assert.equal(received.method, "POST");
  assert.deepEqual(received.body, { lat: 32.75, lng: 35.35 });
  assert.equal(received.headers.get("Authorization"), "Bearer test-only");
  assert.equal(received.headers.get("Origin"), origin);
  assert.equal(received.headers.get("Forwarded"), null);
  assert.equal(received.headers.get("X-Forwarded-For"), "192.0.2.1");
  assert.equal(received.headers.get("X-Forwarded-Host"), null);
  assert.equal(received.redirect, "manual");
  assert.equal(received.options.cf.cacheTtl, 0);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { priceStatus: "final" });
});

test("Socket.IO polling and WebSocket upgrades use Render and preserve the upgrade", async t => {
  const upgrade = { status: 101, webSocket: {} };
  t.mock.method(globalThis, "fetch", async request => {
    assert.equal(new URL(request.url).origin, env.BACKEND_ORIGIN);
    assert.equal(request.headers.get("Origin"), origin);
    return request.headers.get("Upgrade") === "websocket" ? upgrade : Response.json({ sid: "fixture" });
  });
  const headers = { Origin: origin };
  assert.equal((await worker.fetch(new Request(origin + "/socket.io/?EIO=4&transport=polling", { headers }), env)).status, 200);
  assert.equal(await worker.fetch(new Request(origin + "/socket.io/?EIO=4&transport=websocket", { headers: { ...headers, Upgrade: "websocket" } }), env), upgrade);
});

test("backend auth errors and redirects remain authoritative and uncacheable", async t => {
  for (const status of [401, 403, 302]) {
    t.mock.method(globalThis, "fetch", async () => new Response(null, { status, headers: { Location: "https://other.example" } }));
    const response = await worker.fetch(new Request(origin + "/api/orders"), env);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
});

test("invalid backend settings fail closed without making a request", async t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected upstream call"); });
  for (const BACKEND_ORIGIN of ["", "http://localhost", origin, "https://user:password@api.example", "https://api.example/path", "https://api.example?x=1"])
    assert.equal((await worker.fetch(new Request(origin + "/api/health"), { ...env, BACKEND_ORIGIN })).status, 503);
});

test("upstream failure returns a safe existing API error without private details", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("private provider and customer link"); });
  const response = await worker.fetch(new Request(origin + "/api/customer/private"), env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { code: "network_error" });
});
