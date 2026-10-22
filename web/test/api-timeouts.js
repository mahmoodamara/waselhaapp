import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";

test("web and driver requests time out when headers arrive but the response body stalls", { timeout: 30000 }, async () => {
  const sockets = new Set();
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"unfinished":');
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const nativeFetch = globalThis.fetch, storage = globalThis.localStorage;
  const oldApiUrl = process.env.EXPO_PUBLIC_API_URL;
  globalThis.localStorage = { getItem: () => null };
  globalThis.fetch = (url, options) => nativeFetch(url.startsWith("/") ? `${base}${url}` : url, options);
  process.env.EXPO_PUBLIC_API_URL = `${base}/api`;
  // Bound the pre-fix failure too: a broken client reaches this server-side
  // disconnect instead of hanging the test process forever.
  const fallback = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 22000);
  try {
    const web = await import("../src/api.js");
    const driver = await import("../../driver-app/api.js");
    await Promise.all([
      assert.rejects(web.api("/stalled"), e => e.code === "request_timeout"),
      assert.rejects(driver.api("/stalled", null), e => e.code === "request_timeout"),
    ]);
  } finally {
    clearTimeout(fallback);
    globalThis.fetch = nativeFetch;
    if (storage === undefined) delete globalThis.localStorage; else globalThis.localStorage = storage;
    if (oldApiUrl === undefined) delete process.env.EXPO_PUBLIC_API_URL; else process.env.EXPO_PUBLIC_API_URL = oldApiUrl;
    for (const socket of sockets) socket.destroy();
    await new Promise(r => server.close(r));
  }
});
