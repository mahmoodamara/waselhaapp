// Explicit fresh foreground-GPS fixtures for pre-Phase-4 regression suites.
// They exercise the strict production GEO path; no missing-location fallback.
import { createClient } from "redis";
import { randomUUID } from "node:crypto";
let client, store;
const ids = new Set();
export async function offerLocationFixtures() {
  if (!new URL(process.env.MONGODB_URI).pathname.endsWith("_test")) throw new Error("Offer fixtures require a *_test database");
  if (!client) {
    const { createLocationStore } = await import("../../src/services/locationStore.js");
    const { config } = await import("../../src/config.js");
    client = createClient({ url: process.env.REDIS_URL || config.redisUrl });
    client.on("error", () => {});
    await client.connect(); store = createLocationStore(client);
  }
  return store;
}
export async function refreshOfferLocations(User) {
  const current = await offerLocationFixtures();
  for (const driver of await User.find({ role: "driver" }).select("_id").lean()) {
    const id = String(driver._id), sessionId = randomUUID(); ids.add(id);
    const measuredAt = Math.max(Date.now(), Number(await client.hGet(current.keys(id).session, "lastMeasuredAt") || 0) + 1);
    await current.activateSession(id, sessionId);
    const result = await current.saveLocation(id, { sessionId, measuredAt, sequence: 1,
      latitude: 32.75, longitude: 35.34, accuracy: 8, heading: null, speed: null });
    if (result !== "accepted") throw new Error(`Fixture sample rejected: ${result}`);
  }
}
export async function resetOrderActionLimits(User) {
  await offerLocationFixtures();
  const accounts = await User.find({}).select("_id").lean();
  const keys = accounts.flatMap(({ _id }) => ["create", "accept"].map(action => `driver:action-limit:${action}:${_id}`));
  if (keys.length) await client.del(keys);
}
export async function closeOfferLocations() {
  if (!client) return;
  for (const id of ids) {
    await client.del(Object.values(store.keys(id)));
    await client.zRem(store.geoKey, id);
  }
  ids.clear(); client.destroy(); client = undefined; store = undefined;
}
