import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { validateLocation, createDriverLimiter } from "../src/realtime/driverLocation.js";
const now = Date.now();
const point = () => ({ latitude: 32.75, longitude: 35.34, accuracy: 8, heading: null, speed: null,
  measuredAt: now, sequence: 1, sessionId: randomUUID() });

test("strict location shape, finite numbers, accuracy, speed, heading and timestamp", () => {
  assert.equal(validateLocation(point(), now), null);
  for (const change of [
    { latitude: NaN }, { latitude: Infinity }, { latitude: 91 }, { latitude: "32" },
    { longitude: -181 }, { longitude: {} }, { accuracy: 0 }, { accuracy: 101 },
    { accuracy: null }, { speed: -1 }, { speed: 101 }, { speed: "2" },
    { heading: 360 }, { heading: NaN }, { heading: "90" }, { measuredAt: "today" },
    { measuredAt: Infinity }, { measuredAt: 0 }, { sequence: 0 }, { sequence: 1.5 }, { sequence: Number.MAX_SAFE_INTEGER },
    { sessionId: "forged" }, { driverId: "another-driver" }, { extra: "x".repeat(10000) },
  ]) assert.equal(validateLocation({ ...point(), ...change }, now), "invalid_payload");
  for (const invalid of [null, [], "x", 1, {}, Object.create(null)])
    assert.equal(validateLocation(invalid, now), "invalid_payload");
  assert.equal(validateLocation({ ...point(), measuredAt: now - 15001 }, now), "stale_location");
  assert.equal(validateLocation({ ...point(), measuredAt: now + 5001 }, now), "stale_location");
});
test("driver bucket bounds abuse independently of reconnect and recovers after jitter", () => {
  let time = 0;
  const limiter = createDriverLimiter(() => time);
  assert.equal(Array.from({ length: 100 }, () => limiter.take("driver1")).filter(Boolean).length, 4);
  assert.equal(limiter.take("driver2"), true);
  time = 3000; assert.equal(limiter.take("driver1"), true);
  assert.equal(limiter.take("driver1"), false);
  time = 100000; limiter.prune(); assert.equal(limiter.take("driver1"), true);
});

test("driver bucket recovers when the server clock steps backwards", () => {
  let time = 1_000_000;
  const limiter = createDriverLimiter(() => time);
  for (let i = 0; i < 4; i++) limiter.take("driver1");
  assert.equal(limiter.take("driver1"), false);
  time -= 136000; // NTP correction of a fast clock
  assert.equal(limiter.take("driver1"), false); // no refill from time travel
  time += 3000;
  assert.equal(limiter.take("driver1"), true); // normal refill resumes immediately
});
