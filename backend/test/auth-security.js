import assert from "node:assert/strict";
import { test } from "node:test";
import { request, loginStates, sessions, restart } from "./helpers/security.js";
const login = (name = "driver1", password = "WaselhaDemo123!", expected = 200) =>
  request("/auth/login", null, "POST", { login: name, password }, expected);
async function lock(name = "driver1") {
  await loginStates().insertOne({ _id: name, failures: 5, lockedUntil: new Date(Date.now() + 15 * 60 * 1000) });
}
test("AUTH-1: valid login/JWT and authenticated APIs remain unchanged with no security state in response", async () => {
  const { data } = await login();
  assert.equal(data.user._id, sessions.driver1.user._id);
  const payload = JSON.parse(Buffer.from(data.token.split(".")[1], "base64url"));
  assert.equal(payload.exp - payload.iat, 7 * 24 * 60 * 60);
  assert.equal((await request("/auth/me", data.token)).data._id, data.user._id);
  for (const field of ["passwordHash", "failures", "lockedUntil"])
    assert.ok(!Object.hasOwn(data.user, field));
});
test("AUTH-2: wrong password persists a failure under the normalized login", async () => {
  assert.deepEqual((await login(" DRIVER1 ", "wrong", 401)).data, { code: "invalid_credentials" });
  assert.equal((await loginStates().findOne({ _id: "driver1" }))?.failures, 1);
});
test("AUTH-3: fifth failure locks and returns stable 429/Retry-After without internal state", async () => {
  for (let i = 0; i < 4; i++) await login("driver1", "wrong", 401);
  const result = await login("driver1", "wrong", 429);
  assert.equal(result.data.code, "login_locked");
  assert.ok(result.data.retryAfterSeconds > 0 && result.data.retryAfterSeconds <= 900);
  assert.equal(result.retryAfter, String(result.data.retryAfterSeconds));
  assert.deepEqual(Object.keys(result.data).sort(), ["code", "retryAfterSeconds"].sort());
  const state = await loginStates().findOne({ _id: "driver1" });
  assert.equal(state.failures, 5);
  assert.ok(state.lockedUntil > new Date());
});
test("AUTH-4: correct password is refused during a persisted lock", async () => {
  await lock();
  assert.equal((await login("driver1", "WaselhaDemo123!", 429)).data.code, "login_locked");
  assert.equal((await loginStates().findOne({ _id: "driver1" })).failures, 5);
});
test("AUTH-5: lock persists across a real server process restart", async () => {
  await lock();
  await restart();
  assert.equal((await login("driver1", "WaselhaDemo123!", 429)).data.code, "login_locked");
});
test("AUTH-6: expired lock permits login and resets lock/failures", async () => {
  await loginStates().insertOne({ _id: "driver1", failures: 5, lockedUntil: new Date(Date.now() - 1000) });
  await login();
  const state = await loginStates().findOne({ _id: "driver1" });
  assert.equal(state.failures, 0);
  assert.equal(state.lockedUntil, null);
});
test("AUTH-7: successful login clears prior failures and the next failure starts at one", async () => {
  await login("driver1", "wrong", 401);
  await login("driver1", "wrong", 401);
  await login();
  assert.equal((await loginStates().findOne({ _id: "driver1" }))?.failures, 0);
  await login("driver1", "wrong", 401);
  assert.equal((await loginStates().findOne({ _id: "driver1" })).failures, 1);
});
test("AUTH-8: a locked identity does not block another account", async () => {
  await lock();
  await login("driver2");
  await login("driver1", "WaselhaDemo123!", 429);
});
test("AUTH-9: missing accounts use the same failure and lock responses", async () => {
  for (const name of ["driver1", "nonexistent-login"]) {
    for (let i = 0; i < 4; i++) assert.deepEqual((await login(name, "wrong", 401)).data, { code: "invalid_credentials" });
    assert.equal((await login(name, "wrong", 429)).data.code, "login_locked");
    assert.equal((await login(name, "WaselhaDemo123!", 429)).data.code, "login_locked");
  }
});
test("AUTH-10: parallel failures cannot exceed the configured budget", async () => {
  const results = await Promise.all(Array.from({ length: 30 }, () => login("driver1", "wrong", null)));
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 401).length, 4);
  assert.equal(statuses.filter((s) => s === 429).length, 26);
  assert.equal((await loginStates().findOne({ _id: "driver1" })).failures, 5);
});
test("AUTH-11: expired lock starts a fresh failure budget even for another wrong password", async () => {
  await loginStates().insertOne({ _id: "driver1", failures: 5, lockedUntil: new Date(Date.now() - 1000) });
  await login("driver1", "wrong", 401);
  const state = await loginStates().findOne({ _id: "driver1" });
  assert.equal(state.failures, 1);
  assert.equal(state.lockedUntil, null);
});
test("AUTH-12: object credentials are rejected before security state is written", async () => {
  for (const body of [{ login: { $ne: null }, password: "x" }, { login: "driver1", password: { $ne: null } }])
    await request("/auth/login", null, "POST", body, 400);
  assert.equal(await loginStates().countDocuments(), 0);
});
