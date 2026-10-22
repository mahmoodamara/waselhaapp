import assert from "node:assert/strict";
import { test } from "node:test";
import { api } from "../src/api.js";

test("customer location waits for the server routing deadline and can receive final pricing", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis, "fetch", (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")), { once: true });
    setTimeout(() => resolve({ ok: true, json: async () => ({ priceStatus: "final", expectedCustomerCashAgorot: 13268 }) }), 31000);
  }));
  const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null } });
  try {
    const result = api("/customer/test/location", { method: "POST", body: { lat: 32.75, lng: 35.35 } });
    const assertion = assert.doesNotReject(result);
    t.mock.timers.tick(31000);
    await assertion;
    assert.deepEqual(await result, { priceStatus: "final", expectedCustomerCashAgorot: 13268 });
  } finally {
    if (storage) Object.defineProperty(globalThis, "localStorage", storage);
    else delete globalThis.localStorage;
  }
});

test("web requests still abort when routing or the response body hangs", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => ({ ok: true,
    json: () => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")), { once: true });
    }),
  }));
  const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null } });
  try {
    const assertion = assert.rejects(api("/customer/test/location"), error => error.code === "request_timeout");
    await Promise.resolve();
    t.mock.timers.tick(40000);
    await assertion;
  } finally {
    if (storage) Object.defineProperty(globalThis, "localStorage", storage);
    else delete globalThis.localStorage;
  }
});
