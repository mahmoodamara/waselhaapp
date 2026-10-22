import assert from "node:assert/strict";
import { test, beforeEach, after } from "node:test";
import { startFakeRouting } from "./helpers/routing.js";
const fake = await startFakeRouting();
const { getRouteDistance, normalizeRouteDistance } = await import("../src/services/routing.js");
const { config } = await import("../src/config.js");
const input = { pickup: { lat: 32.7459, lng: 35.3398 }, destination: { lat: 32.75, lng: 35.35 } };
beforeEach(() => fake.reset());
after(() => fake.close());
test("adapter: meters round once; reject malformed/unsafe results", () => {
  assert.equal(normalizeRouteDistance(1234.4), 1234);
  assert.equal(normalizeRouteDistance(1234.5), 1235);
  assert.equal(normalizeRouteDistance(0), 0);
  assert.equal(normalizeRouteDistance(0.1), 0);
  for (const value of [null, undefined, NaN, Infinity, -1, "1234", Number.MAX_SAFE_INTEGER])
    assert.throws(() => normalizeRouteDistance(value), (e) => e.code === "routing_unavailable");
});
test("adapter: OSRM driving request uses longitude/latitude and bounded response fields", async () => {
  fake.distance = 1234.5;
  assert.deepEqual(await getRouteDistance(input), { distanceMeters: 1235, provider: "osrm" });
  assert.equal(fake.calls[0], "/route/v1/driving/35.3398,32.7459;35.35,32.75?overview=false&steps=false&alternatives=false");
});
test("adapter: HTTP failure, malformed JSON and NoRoute stay operational errors", async () => {
  for (const mode of ["fail", "html", "no-route"]) {
    fake.mode = mode;
    await assert.rejects(getRouteDistance(input), (e) => e.status === 503 && e.code === "routing_unavailable" && !e.message.includes("private"));
  }
});
test("adapter: empty routes and malformed route distances stay operational errors", async () => {
  const bodies = [
    {}, { code: "Ok" }, { code: "Ok", routes: [] },
    ...[null, {}, { distance: null }, { distance: "1234" },
      { distance: -1 }, { distance: Number.MAX_SAFE_INTEGER }].map((route) => ({ code: "Ok", routes: [route] })),
  ];
  for (const body of bodies) {
    fake.handler = (_req, res) => res.end(JSON.stringify(body));
    await assert.rejects(getRouteDistance(input), (e) => e.status === 503 && e.code === "routing_unavailable");
  }
});
test("adapter: a valid zero-meter road route is returned, not a provider outage", async () => {
  fake.distance = 0;
  assert.deepEqual(await getRouteDistance(input), { distanceMeters: 0, provider: "osrm" });
});
test("adapter: OSRM works without a Google key in the process environment", async () => {
  // This changes only the disposable test process, never the developer's .env.
  delete process.env.GOOGLE_ROUTES_API_KEY;
  assert.ok(!("GOOGLE_ROUTES_API_KEY" in process.env));
  assert.deepEqual(await getRouteDistance(input), { distanceMeters: 1500, provider: "osrm" });
  assert.equal(fake.calls.length, 1);
});
test("adapter: missing configuration/invalid coordinates never call provider", async () => {
  const url = config.routingBaseUrl;
  try {
    config.routingBaseUrl = "";
    await assert.rejects(getRouteDistance(input), (e) => e.code === "routing_unavailable");
  } finally { config.routingBaseUrl = url; }
  await assert.rejects(getRouteDistance({ ...input, pickup: { lat: null, lng: 35 } }), (e) => e.code === "route_inputs_required");
  assert.equal(fake.calls.length, 0);
});
test("adapter: timeout covers a stalled response body", async () => {
  fake.handler = (_req, res) => { res.writeHead(200); res.write('{"code":"Ok",'); };
  const started = Date.now();
  await assert.rejects(getRouteDistance(input), (e) => e.code === "routing_unavailable");
  assert.ok(Date.now() - started < 2000);
});
test("adapter: oversized response rejected without persisting raw data", async () => {
  fake.handler = (_req, res) => res.end(" ".repeat(65537));
  await assert.rejects(getRouteDistance(input), (e) => e.code === "routing_unavailable");
});
test("adapter: concurrency is bounded without a queue", async () => {
  fake.mode = "timeout";
  const pending = Array.from({ length: 4 }, () => getRouteDistance(input).catch((e) => e));
  await fake.waitForCalls(4);
  await assert.rejects(getRouteDistance(input), (e) => e.code === "routing_unavailable");
  assert.equal(fake.calls.length, 4);
  assert.ok((await Promise.all(pending)).every((e) => e.code === "routing_unavailable"));
});
