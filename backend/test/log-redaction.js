import assert from "node:assert/strict";
import { test } from "node:test";
import { log } from "../src/services/log.js";
import { once } from "node:events";
import { randomBytes } from "node:crypto";

test('structured logs redact delivery PII, OTPs and complete request bodies recursively', () => {
  const original = console.error;
  let output = '';
  console.error = value => { output += value; };
  try {
    log('error', 'privacy_probe', { requestId:'safe-diagnostic-id',
      phone:'private-phone', finalAddress:'private-address', recipientName:'private-recipient',
      otp:'private-otp', pickupCode:'private-pickup', deliveryCode:'private-delivery',
      customerData:{ name:'private-name' }, requestBody:{ value:'private-body' },
      nested:[{ destinationLocation:{ lat:32.712345, lng:35.312345 } }],
    });
  } finally { console.error = original; }
  assert.doesNotMatch(output, /private-|32\.712345|35\.312345/);
  assert.match(output, /safe-diagnostic-id/);
});

test("structured logs redact customer path secrets, nested credentials and retain diagnostics", () => {
  const secret = "synthetic-private-link-123456789";
  const original = console.error;
  let output = "";
  console.error = value => { output += `${value}\n`; };
  try {
    log("error", "request_failed", { requestId: "test-request", status: 500,
      error: `GET /customer/${secret}?x=1 failed at /api/customer/${secret}/confirm`,
      nested: { authorization: "Bearer synthetic-bearer", customerToken: secret, password: "synthetic-password" } });
    log("error", "realtime_operation_failed", { latitude: 32.751234567, longitude: 35.341234567,
      redisUrl: "redis://user:synthetic-redis-password@host", apiKey: "synthetic-api-key" });
    log("info", "route_computed", { encodedPolyline: "synthetic_polyline_value", googleKey: "synthetic-goog-key" });
    log("error", "background_rejected", { backgroundCredential: "synthetic-background-secret" });
  } finally { console.error = original; }
  assert.ok(!output.includes(secret));
  assert.ok(!output.includes("synthetic-bearer"));
  assert.ok(!output.includes("synthetic-password"));
  assert.ok(!output.includes("32.751234567")); assert.ok(!output.includes("35.341234567"));
  assert.ok(!output.includes("synthetic-redis-password")); assert.ok(!output.includes("synthetic-api-key"));
  assert.ok(!output.includes("synthetic_polyline_value")); assert.ok(!output.includes("synthetic-goog-key"));
  assert.ok(!output.includes("synthetic-background-secret"));
  const record = JSON.parse(output.trim().split("\n")[0]);
  assert.equal(record.requestId, "test-request");
  assert.equal(record.status, 500);
  assert.equal(record.error, "[REDACTED]");
});

test("synthetic customer HTTP requests expose no token in application logs or error responses", async () => {
  const { default: mongoose } = await import("mongoose");
  mongoose.set("bufferCommands", false);
  const { createApp } = await import("../src/app.js");
  const server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  const original = console.error;
  let logs = "";
  console.error = line => { logs += `${line}\n`; };
  try {
    const secret = randomBytes(24).toString("hex");
    const origin = `http://127.0.0.1:${server.address().port}`;
    const page = await fetch(`${origin}/customer/${secret}`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.equal(page.headers.get("cache-control"), "no-store");
    const response = await fetch(`${origin}/api/customer/${secret}`);
    assert.equal(response.status, 500, "disconnected database exercises the real error handler");
    assert.deepEqual(await response.json(), { code: "server_error" });
    assert.ok(!logs.includes(secret));
    const record = JSON.parse(logs.trim());
    assert.equal(record.event, "request_failed");
    assert.equal(record.status, 500);
    assert.equal(record.requestId, response.headers.get("x-request-id"));
    assert.equal(record.route, "/:token");
  } finally {
    console.error = original;
    await new Promise(resolve => server.close(resolve));
  }
});
