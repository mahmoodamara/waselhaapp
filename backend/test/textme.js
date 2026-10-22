import assert from "node:assert/strict";
import { test } from "node:test";
import { createTextMeClient, TEXTME_URL } from "../src/services/textMe.js";

const cfg = { textMeApiToken: "private-test-token", textMeUsername: "private-account", textMeSource: "Waselha", textMeEnabled: true };
const input = { recipient: "٠٥٠-١٢٣-٤٥٦٧", message: "مرحباً 🌍\nرابط الطلب", externalId: "operation-1" };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("TextMe accepts numeric/string zero and uses the exact authenticated JSON contract", async () => {
  for (const status of [0, "0"]) {
    let calls = 0;
    const client = createTextMeClient({ cfg, fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, TEXTME_URL);
      assert.equal(options.method, "POST");
      assert.equal(options.headers.Authorization, "Bearer private-test-token");
      assert.equal(options.headers["Content-Type"], "application/json");
      assert.equal(options.redirect, "error");
      assert.deepEqual(JSON.parse(options.body), { sms: { user: { username: "private-account" }, source: "Waselha",
        destinations: { phone: { $: { id: "operation-1" }, _: "0501234567" } }, message: input.message } });
      return response({ status, shipment_id: "shipment-1", message: "sensitive-provider-text" });
    } });
    assert.deepEqual(await client.send(input), { state: "accepted", code: "sms_accepted", shipmentId: "shipment-1", providerStatus: 0 });
    assert.equal(calls, 1);
  }
});

test("TextMe application errors in HTTP 200 are rejected without exposing provider text", async () => {
  const client = createTextMeClient({ cfg, fetchImpl: async () => response({ status: "401", message: cfg.textMeApiToken }) });
  const result = await client.send(input);
  assert.equal(result.state, "rejected");
  assert.equal(result.providerStatus, 401);
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test("invalid/missing statuses, malformed JSON and incomplete successes remain uncertain", async () => {
  for (const value of [null, {}, [], { status: null }, { status: "" }, { status: " " }, { status: false },
    { status: [] }, { status: {} }, { status: "0.0" }, { status: 0 }, { status: 0, shipment_id: {} }]) {
    const client = createTextMeClient({ cfg, fetchImpl: async () => response(value) });
    assert.equal((await client.send(input)).state, "uncertain", JSON.stringify(value));
  }
  const client = createTextMeClient({ cfg, fetchImpl: async () => new Response("<html>secret</html>") });
  assert.equal((await client.send(input)).code, "sms_invalid_response");
});

test("HTTP and network failures are uncertain and never retried", async () => {
  for (const status of [400, 401, 429, 500, 503]) {
    let calls = 0;
    const client = createTextMeClient({ cfg, fetchImpl: async () => { calls++; return response({ status: 0 }, status); } });
    assert.equal((await client.send(input)).code, "sms_http_error");
    assert.equal(calls, 1);
  }
  let calls = 0;
  const client = createTextMeClient({ cfg, fetchImpl: async () => { calls++; throw new Error(cfg.textMeApiToken); } });
  assert.equal((await client.send(input)).code, "sms_network_error");
  assert.equal(calls, 1);
});

test("timeout covers request and body reading, without retries", async () => {
  for (const atBody of [false, true]) {
    let calls = 0;
    const client = createTextMeClient({ cfg, timeoutMs: 10, fetchImpl: async (url, { signal }) => {
      calls++;
      const pending = () => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("private timeout")), { once: true }));
      return atBody ? { ok: true, json: pending } : pending();
    } });
    assert.equal((await client.send(input)).code, "sms_timeout");
    assert.equal(calls, 1);
  }
});

test("/api/test validates without reporting accepted, persisting shipment IDs or requiring live enablement", async () => {
  const client = createTextMeClient({ cfg: { ...cfg, textMeEnabled: false }, fetchImpl: async url => {
    assert.equal(url, `${TEXTME_URL}/test`);
    return response({ status: "0", shipment_id: "not-a-real-shipment" });
  } });
  assert.deepEqual(await client.send({ ...input, dryRun: true }), { state: "validated", code: "sms_validated", shipmentId: null, providerStatus: 0 });
});

test("invalid inputs/configuration and disabled live mode never call TextMe", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; assert.fail("invalid inputs must not dispatch"); };
  for (const patch of [{ message: "" }, { message: " " }, { message: "x".repeat(1006) }, { message: {} },
    { recipient: "+972501234567" }, { recipient: "00972501234567" }, { recipient: "05012345678" },
    { recipient: { $ne: null } }, { externalId: "" }, { externalId: {} }, { dryRun: "true" }]) {
    await assert.rejects(createTextMeClient({ cfg, fetchImpl }).send({ ...input, ...patch }), error => error.status < 500);
  }
  for (const patch of [{ textMeApiToken: "" }, { textMeUsername: "" }, { textMeSource: "" },
    { textMeSource: "too-long-brand" }, { textMeApiToken: "token\r\nheader" }, { textMeEnabled: false }])
    await assert.rejects(createTextMeClient({ cfg: { ...cfg, ...patch }, fetchImpl }).send(input), error => error.status === 503);
  assert.equal(calls, 0);
});

test("local nine-digit numbers and the 1005 character boundary are preserved", async () => {
  const client = createTextMeClient({ cfg, fetchImpl: async (url, { body }) => {
    const data = JSON.parse(body).sms;
    assert.equal(data.destinations.phone._, "501234567");
    assert.equal(data.message, "ع".repeat(1005));
    return response({ status: 0, shipment_id: 123 });
  } });
  assert.equal((await client.send({ ...input, recipient: "501234567", message: "ع".repeat(1005) })).shipmentId, "123");
});

test("automated tests cannot enable the default real sending transport", async () => {
  await assert.rejects(createTextMeClient({ cfg }).send(input), { code: "sms_disabled" });
});
