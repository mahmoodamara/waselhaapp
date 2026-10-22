import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";

function readOrigins(value, mode = "development") {
  return spawnSync(process.execPath, ["--input-type=module", "-e",
    'import {config} from "./src/config.js"; console.log(JSON.stringify(config.realtimeAllowedOrigins));'], {
    cwd: new URL("../", import.meta.url), encoding: "utf8", timeout: 5000,
    env: { ...process.env, NODE_ENV: mode, REALTIME_ALLOWED_ORIGINS: value },
  });
}
test("explicit API aliases are normalized and deduplicated without widening default Origin access", () => {
  assert.deepEqual(JSON.parse(readOrigins("").stdout), []);
  const result = readOrigins("http://192.168.0.105:3000/, http://192.168.0.105:3000, https://api.example.invalid");
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), ["http://192.168.0.105:3000", "https://api.example.invalid"]);
});
test("wildcards, credentials, paths, query strings, fragments and invalid schemes are rejected", () => {
  for (const value of ["*", "https://*.example.invalid", "https://user:password@example.invalid",
    "https://example.invalid/api", "https://example.invalid?token=private", "https://example.invalid#path",
    "file:///tmp", "not-a-url"])
    assert.notEqual(readOrigins(value).status, 0, value);
});
test("staging and production reject plain HTTP aliases and accept explicit HTTPS origins", () => {
  for (const mode of ["staging", "production"]) {
    assert.notEqual(readOrigins("http://192.168.0.105:3000", mode).status, 0);
    assert.equal(readOrigins("https://api.example.invalid", mode).status, 0);
  }
});
