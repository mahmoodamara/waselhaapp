// Explicit local nginx integration check; never connects to a deployment/database.
// NGINX_BIN and OPENSSL_BIN must point to installed executables.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import http from "node:http";
import https from "node:https";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import path from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
async function freePort() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening"); const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
function request(port, target, { tls = true, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const req = (tls ? https : http).request({ host: "127.0.0.1", port, path: target,
      rejectUnauthorized: false, timeout: 3000, ...options }, res => {
      let body = ""; res.on("data", b => { body += b; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("local proxy timeout")));
    req.end(options.method === "POST" ? "{bad-json" : undefined);
  });
}
test("real nginx HTTPS logs no synthetic customer token on 200, 400, 500, 502 or redirect", { timeout: 60000 }, async () => {
  assert.ok(process.env.NGINX_BIN && process.env.OPENSSL_BIN, "Set NGINX_BIN and OPENSSL_BIN to run this explicit integration check");
  const evidence = path.join(root, ".verification/pilot-2026-10-16");
  await mkdir(evidence, { recursive: true });
  const dir = await mkdtemp(path.join(evidence, "proxy-"));
  await mkdir(path.join(dir, "logs"));
  await mkdir(path.join(dir, "temp"));
  const cert = spawnSync(process.env.OPENSSL_BIN, ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"), "-days", "1", "-subj", "/CN=localhost"], { encoding: "utf8" });
  assert.equal(cert.status, 0, "local test certificate generation");
  process.env.NODE_ENV = "test";
  const { default: mongoose } = await import("mongoose");
  mongoose.set("bufferCommands", false); // Disconnected DB deliberately exercises the real app's 500 handler.
  const { createApp } = await import("../src/app.js");
  const server = createApp().listen(0, "127.0.0.1"); await once(server, "listening");
  const upstream = server.address().port, plain = await freePort(), secure = await freePort();
  const unix = value => value.replaceAll("\\", "/");
  const source = await readFile(path.join(root, "infra/deploy/nginx.conf.example"), "utf8");
  const config = source.replace("listen 80;", `listen 127.0.0.1:${plain};`)
    .replace("listen 443 ssl;", `listen 127.0.0.1:${secure} ssl;`)
    .replaceAll("app.example.invalid", "localhost")
    .replace("https://localhost$request_uri", `https://localhost:${secure}$request_uri`)
    .replace("/etc/waselha/tls/fullchain.pem", unix(path.join(dir, "cert.pem")))
    .replace("/etc/waselha/tls/privkey.pem", unix(path.join(dir, "key.pem")))
    .replace("127.0.0.1:3000", `127.0.0.1:${upstream}`)
    .replace("error_log /dev/null;", `error_log ${process.platform === "win32" ? "NUL" : "/dev/null"};`);
  await writeFile(path.join(dir, "nginx.conf"), config);
  const args = ["-p", `${unix(dir)}/`, "-c", "nginx.conf"];
  const check = spawnSync(process.env.NGINX_BIN, [...args, "-t"], { encoding: "utf8" });
  if (check.status !== 0) await new Promise(resolve => server.close(resolve));
  assert.equal(check.status, 0, "nginx -t must accept the adapted deployment template");
  let processLogs = "", appLogs = "";
  const originalError = console.error;
  console.error = line => { appLogs += `${line}\n`; };
  const nginx = spawn(process.env.NGINX_BIN, [...args, "-g", "daemon off;"], { stdio: ["ignore", "pipe", "pipe"] });
  nginx.stdout.on("data", b => { processLogs += b; }); nginx.stderr.on("data", b => { processLogs += b; });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await request(secure, "/api/health")).status === 200) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, "isolated proxy must start");
    const token = randomBytes(24).toString("hex");
    const page = `/customer/${token}`, api = `/api/customer/${token}`;
    const redirect = await request(plain, page, { tls: false });
    assert.equal(redirect.status, 308);
    const success = await request(secure, page);
    assert.equal(success.status, 200);
    assert.equal(success.headers["referrer-policy"], "no-referrer");
    assert.equal(success.headers["cache-control"], "no-store");
    assert.equal((await request(secure, `${api}/confirm`, { method: "POST", headers: { "Content-Type": "application/json", Referer: `https://localhost${page}` } })).status, 400);
    assert.equal((await request(secure, api)).status, 500);
    await new Promise(resolve => server.close(resolve));
    assert.equal((await request(secure, api)).status, 502);
    const stopped = once(nginx, "exit");
    assert.equal(spawnSync(process.env.NGINX_BIN, [...args, "-s", "quit"], { encoding: "utf8" }).status, 0);
    await stopped;
    const access = await readFile(path.join(dir, "logs/waselha-access.log"), "utf8");
    const allProxyLogs = (await Promise.all((await readdir(path.join(dir, "logs")))
      .filter(name => name.endsWith(".log")).map(name => readFile(path.join(dir, "logs", name), "utf8")))).join("\n");
    assert.ok(!`${allProxyLogs}${processLogs}${appLogs}`.includes(token), "customer token must be absent from all captured logs");
    const records = access.trim().split(/\r?\n/).map(JSON.parse);
    for (const status of [200, 308, 400, 500, 502]) assert.ok(records.some(r => r.status === status));
    assert.ok(records.some(r => r.route === "customer_api" && r.status === 500 && r.request_id !== "-"));
    assert.equal(JSON.parse(appLogs.trim()).event, "request_failed");
    await writeFile(path.join(dir, "app.log"), appLogs);
    console.log("PASS: nginx -t, HTTPS, redirect, safe proxy/app logs and 200/400/500/502 diagnostics");
  } finally {
    console.error = originalError;
    if (server.listening) await new Promise(resolve => server.close(resolve));
    if (nginx.exitCode === null) spawnSync(process.env.NGINX_BIN, [...args, "-s", "stop"], { encoding: "utf8" });
  }
});
