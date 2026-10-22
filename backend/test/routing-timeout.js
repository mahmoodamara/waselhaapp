import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";

function environment(overrides = {}) {
  const env = { ...process.env, NODE_ENV: "production", REALTIME_ALLOWED_ORIGINS: "", ...overrides };
  delete env.ROUTING_TIMEOUT_MS;
  return env;
}

test("routing timeout defaults to 30 seconds and retains bounded explicit overrides", () => {
  for (const [value, expected] of [[undefined, 30000], ["5000", 5000], ["30000", 30000], ["30001", null], ["0", null]]) {
    const env = environment();
    if (value !== undefined) env.ROUTING_TIMEOUT_MS = value;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e",
      'import { config } from "./src/config.js"; console.log(config.routingTimeoutMs);'],
    { cwd: new URL("../", import.meta.url), env, encoding: "utf8", timeout: 5000 });
    if (expected === null) assert.equal(child.status, 1, `reject ${value}`);
    else {
      assert.equal(child.status, 0, child.stderr);
      assert.equal(Number(child.stdout.trim()), expected);
    }
  }
});

test("a router waking after the old five-second limit still returns the final road distance", { timeout: 12000 }, async () => {
  const server = createServer((_req, res) => {
    const timer = setTimeout(() => res.end(JSON.stringify({ code: "Ok", routes: [{ distance: 1634 }] })), 5500);
    res.on("close", () => clearTimeout(timer));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { getRouteDistance } from "./src/services/routing.js";
      console.log(JSON.stringify(await getRouteDistance({
        pickup: { lat: 32.7459, lng: 35.3398 }, destination: { lat: 32.75, lng: 35.35 }
      })));
    `], { cwd: new URL("../", import.meta.url), env: environment({ ROUTING_BASE_URL: `http://127.0.0.1:${server.address().port}` }), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    const [code] = await once(child, "exit");
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), { distanceMeters: 1634, provider: "osrm" });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
