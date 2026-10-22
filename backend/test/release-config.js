import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { productionConfigProblems } from "../src/services/startupChecks.js";

const good = { jwtSecret: "k3Jd9fQ2xL0pVb7TzW1mNc8RhY4uGa6E", publicBaseUrl: "https://waselha.app" };
test("release URLs must be public HTTPS origins without credentials, paths or queries", () => {
  assert.deepEqual(productionConfigProblems(good), []);
  for (const publicBaseUrl of ["https://", "https://localhost", "https://127.0.0.1", "https://[::1]",
    "https://user:secret@waselha.example", "https://waselha.example/customer", "https://waselha.example?secret=x"]) {
    assert.ok(productionConfigProblems({ ...good, publicBaseUrl }).length > 0);
  }
});
test("release secrets reject common development placeholders", () => {
  for (const word of ["changeme", "replace_me", "your-local", "workflow-test"]) {
    assert.ok(productionConfigProblems({ ...good, jwtSecret: word.padEnd(48, "x") }).length > 0);
  }
});

test("public release origin rejects private networks, nonpublic hosts and temporary tunnels", () => {
  for (const publicBaseUrl of [
    "https://0.0.0.0", "https://127.0.0.2", "https://10.1.2.3", "https://172.16.0.1",
    "https://192.168.1.50", "https://169.254.169.254", "https://[fc00::1]", "https://[fe80::1]",
    "https://[::ffff:192.168.1.1]", "https://intranet", "https://api.local", "https://api.internal",
    "https://localhost.", "https://x.ngrok.io", "https://x.ngrok-free.app", "https://x.trycloudflare.com",
    "https://x.loca.lt", "https://x.localtunnel.me", "https://x.exp.direct",
  ]) {
    assert.ok(productionConfigProblems({ ...good, publicBaseUrl }).some(p => p.includes("PUBLIC_BASE_URL")), publicBaseUrl);
  }
});
function readConfig(environment) {
  const env = { ...process.env, NODE_ENV: environment };
  for (const key of ["MONGODB_URI", "JWT_SECRET", "PUBLIC_BASE_URL", "LOCAL_DELIVERY_ESTIMATE_AGOROT", "GOOGLE_ROUTES_API_KEY", "REALTIME_ALLOWED_ORIGINS"]) delete env[key];
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    'import {config} from "./src/config.js"; console.log(JSON.stringify({jwt:!!config.jwtSecret,mongo:!!config.mongoUri,public:!!config.publicBaseUrl,estimate:config.localDeliveryEstimateAgorot,google:!!process.env.GOOGLE_ROUTES_API_KEY}));'],
  { cwd: new URL("../", import.meta.url), env, encoding: "utf8" });
  assert.equal(result.status, 0, "config child must load");
  return JSON.parse(result.stdout);
}
test("staging and production do not inherit the developer .env or default database", () => {
  for (const environment of ["staging", "production"]) {
    assert.deepEqual(readConfig(environment), { jwt: false, mongo: false, public: false, estimate: 1500, google: false });
  }
});
test("protected environments require database and routing settings before connecting", () => {
  const problems = productionConfigProblems({ ...good, protectedEnvironment: true });
  assert.ok(problems.some(p => p.includes("MONGODB_URI")));
  assert.ok(problems.some(p => p.includes("ROUTING_BASE_URL")));
  assert.ok(problems.some(p => p.includes("REDIS_URL")));
});
test("demo seed refuses protected environments before any database connection", () => {
  for (const NODE_ENV of ["staging", "production"]) {
    const result = spawnSync(process.execPath, ["src/scripts/seed.js"], {
      cwd: new URL("../", import.meta.url), encoding: "utf8", timeout: 5000,
      env: { ...process.env, NODE_ENV, REALTIME_ALLOWED_ORIGINS: "", ALLOW_DEMO_SEED: "false", MONGODB_URI: "mongodb://127.0.0.1:1/unreachable" },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, NODE_ENV === "production" ? /disabled in production/ : /ALLOW_DEMO_SEED=true/);
    assert.doesNotMatch(result.stderr, /ECONNREFUSED|MongoServerSelectionError/);
  }
});
test("a deployed mode set only inside .env cannot bypass startup protection", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "waselha-env-check-"));
  try {
    mkdirSync(path.join(dir, "src"));
    const source = readFileSync(new URL("../src/config.js", import.meta.url), "utf8")
      .replace('from "dotenv"', `from ${JSON.stringify(import.meta.resolve("dotenv"))}`);
    writeFileSync(path.join(dir, "src/config.mjs"), source);
    writeFileSync(path.join(dir, ".env"), "NODE_ENV=production\nJWT_SECRET=synthetic-test-secret\n");
    const env = { ...process.env }; delete env.NODE_ENV;
    const result = spawnSync(process.execPath, [path.join(dir, "src/config.mjs")], { env, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /NODE_ENV.*host environment/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
