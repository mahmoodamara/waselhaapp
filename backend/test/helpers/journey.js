// Route/ETA tests advance a service clock while Redis uses real TIME. Backdate
// only their previous fixture to allow a realistic journey at 20 m/s. Production
// plausibility checks and the independent rejection tests remain enabled.
export async function ageJourneyFixture(redis, store, id, latitude, longitude) {
  const { distanceMeters } = await import('../../src/services/nearbyOffers.js');
  if (!new URL(process.env.MONGODB_URI).pathname.endsWith('_test')) throw Error('Test database required');
  const keys = store.keys(id), value = await redis.get(keys.plausibility);
  if (!value) return;
  const previous = JSON.parse(value), distance = distanceMeters({ lat: previous.latitude, lng: previous.longitude }, { latitude, longitude });
  if (distance <= 250) return;
  previous.measuredAt = Date.now() - Math.ceil(distance / 20) * 1000;
  await redis.set(keys.plausibility, JSON.stringify(previous), { KEEPTTL: true });
  await redis.hSet(keys.session, 'lastMeasuredAt', String(previous.measuredAt));
  for (const key of [keys.location, keys.lastKnown]) {
    const text = await redis.get(key);
    if (text) await redis.set(key, JSON.stringify({ ...JSON.parse(text), measuredAt: previous.measuredAt }), { KEEPTTL: true });
  }
}
