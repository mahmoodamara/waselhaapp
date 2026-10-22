import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { createClient } from "redis";
import { createLocationStore } from "../../src/services/locationStore.js";
import { orderActionLimit } from "../../src/services/orderActionLimit.js";
import { config } from "../../src/config.js";

const url = process.env.REDIS_TEST_URL;
if (!url || new URL(url).hostname !== "127.0.0.1" || new URL(url).port !== "6398")
  throw new Error("Isolated local audit Redis required");
const client = createClient({ url, disableOfflineQueue: true });
client.on("error", () => {});
const prefix = `security-controls:${randomUUID()}:`;
const store = createLocationStore(client, config, prefix);
const replica = createLocationStore(client, config, prefix);
const ids = ["driver-a", "driver-b"];
const rateKey = (action, id) => `${prefix}action-limit:${action}:${id}`;
const sample = (sessionId, sequence, measuredAt, extra = {}) => ({ sessionId, sequence, measuredAt,
  latitude: 32.75, longitude: 35.34, accuracy: 8, speed: 0, heading: null, ...extra });
before(() => client.connect());
after(async () => {
  await client.del([store.geoKey, ...ids.flatMap(id => Object.values(store.keys(id))),
    ...["create", "accept"].flatMap(action => ids.map(id => rateKey(action, id)))]);
  await client.quit();
});

test("account action limits are atomic across instances, separate accounts/actions, and expire", async () => {
  const results = await Promise.all(Array.from({ length: 25 }, (_, i) =>
    (i % 2 ? store : replica).takeActionLimit("create", ids[0], 10, 100)));
  assert.equal(results.filter(r => r.allowed).length, 10);
  assert.ok(results.filter(r => !r.allowed).every(r => r.retryAfterSeconds === 1));
  assert.equal((await store.takeActionLimit("create", ids[1], 10, 100)).allowed, true);
  assert.equal((await store.takeActionLimit("accept", ids[0], 10, 100)).allowed, true);
  assert.ok(await client.pTTL(rateKey("create", ids[0])) > 0);
  await setTimeout(120);
  assert.equal((await replica.takeActionLimit("create", ids[0], 10, 100)).allowed, true);
});

test("order mutation limits fail closed when the authoritative counter is missing or unavailable", async () => {
  for (const locationStore of [undefined, { takeActionLimit: async () => { throw new Error("offline"); } }]) {
    let proceeded = false;
    await assert.rejects(orderActionLimit("create")({ app: { locals: { locationStore } }, user: { _id: ids[0] } }, {},
      () => { proceeded = true; }), error => error.status === 503 && error.code === "realtime_unavailable");
    assert.equal(proceeded, false);
  }
});

test("GPS teleport never mutates location/GEO/counters and cannot reset through logout/reconnect/TTL", async () => {
  const id = ids[0], session = randomUUID(), t = Date.now() - 5000;
  await store.activateSession(id, session);
  assert.equal(await store.saveLocation(id, sample(session, 1, t)), "accepted");
  const keys = store.keys(id), original = await client.mGet([keys.location, keys.lastKnown, keys.plausibility]);
  const geo = await client.geoPos(store.geoKey, id);
  assert.equal(await replica.saveLocation(id, sample(session, 2, t + 1, { latitude: 0, longitude: 0 })), "implausible_location");
  assert.deepEqual(await client.mGet([keys.location, keys.lastKnown, keys.plausibility]), original);
  assert.deepEqual(await client.geoPos(store.geoKey, id), geo);
  assert.equal(await client.hGet(keys.session, "lastSequence"), "1");
  await store.invalidateDriver(id);
  await client.del(keys.location); // live TTL may expire while baseline remains
  const next = randomUUID();
  await replica.activateSession(id, next);
  assert.equal(await store.saveLocation(id, sample(next, 1, t + 2, { latitude: 0, longitude: 0 })), "implausible_location");
  // A good fix recovers immediately, without consuming the rejected sequence.
  assert.equal(await store.saveLocation(id, sample(next, 1, t + 3, { latitude: 32.75001 })), "accepted");
  const concurrent = await Promise.all([
    store.saveLocation(id, sample(next, 2, t + 4, { latitude: 0, longitude: 0 })),
    replica.saveLocation(id, sample(next, 3, t + 5, { latitude: 32.75002 })),
  ]);
  assert.deepEqual(concurrent, ["implausible_location", "accepted"]);
});

test("GPS tolerates accuracy jitter and reasonable movement based on elapsed sample time", async () => {
  const id = ids[1], session = randomUUID(), t = Date.now() - 10000;
  await store.activateSession(id, session);
  assert.equal(await store.saveLocation(id, sample(session, 1, t)), "accepted");
  assert.equal(await store.saveLocation(id, sample(session, 2, t + 1, { latitude: 32.751 })), "accepted");
  assert.equal(await store.saveLocation(id, sample(session, 3, t + 10000, { latitude: 32.76 })), "accepted");
});
