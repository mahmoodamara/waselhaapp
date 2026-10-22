// Fresh, real MongoDB/Redis evidence. External providers and push transports are never used.
import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { createClient } from 'redis';

const uri = process.env.READINESS_TEST_URI;
if (!uri || !new URL(uri).pathname.endsWith('_test') || !process.env.REDIS_TEST_URL) throw Error('Isolated test MongoDB/Redis required');
process.env.MONGODB_URI = uri;
process.env.JWT_SECRET = 'extended-readiness-test-only';
const { User, Order, PushDevice, connectDatabase } = await import('../src/models/index.js');
const { createApp } = await import('../src/app.js');
const { createLocationStore } = await import('../src/services/locationStore.js');
const { availableNearbyOffers } = await import('../src/services/nearbyOffers.js');
const { createPushNotifier } = await import('../src/services/push.js');
const { config } = await import('../src/config.js');
const { BACKGROUND } = await import('../../shared/realtimeContract.js');
const redis = createClient({ url:process.env.REDIS_TEST_URL }); redis.on('error', () => {});
const prefix = `reaudit:${randomUUID()}:`, store = createLocationStore(redis, config, prefix);
const evidence = new URL(`../../${process.env.READINESS_EVIDENCE_DIR || '.verification/store-readiness-2026-10-22/'}`, import.meta.url);
const measurements = [];
let server, base;
const account = extra => User.create({ login:randomUUID(), name:'Isolated driver', role:'driver', active:true,
  passwordHash:'not-a-login-fixture', availableForOrders:true, vehicleType:'car', serviceAreas:['kafr-kanna'], ...extra });
const sign = user => jwt.sign({ ver:user.authVersion ?? 0 }, config.jwtSecret, { subject:String(user._id), expiresIn:'1d' });
const point = (sessionId, sequence = 1) => ({ sessionId, sequence, measuredAt:Date.now(), latitude:32.75, longitude:35.34, accuracy:8, heading:null, speed:null });
async function request(path, token, body = {}, method = 'POST') {
  const response = await fetch(`${base}/api${path}`, { method, headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${typeof token === 'string' ? token : sign(token)}` }, ...(method === 'GET' ? {} : { body:JSON.stringify(body) }) });
  return { status:response.status, data:await response.json() };
}
async function locate(driver, target = store) {
  const id = String(driver._id), sessionId = randomUUID();
  await target.activateSession(id, sessionId);
  assert.equal(await target.saveLocation(id, point(sessionId)), 'accepted');
  return sessionId;
}
before(async () => {
  await connectDatabase(); await Promise.all([User.init(), Order.init(), PushDevice.init()]); await redis.connect();
  await mkdir(evidence, { recursive:true });
  server = createServer(createApp({ locationStore:store, redis })).listen(0, '127.0.0.1');
  await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
  await Promise.all([User, Order, PushDevice].map(model => model.deleteMany({})));
  for await (const keys of redis.scanIterator({ MATCH:`${prefix}*`, COUNT:200 })) if (keys.length) await redis.del(keys);
});
after(async () => {
  await new Promise(resolve => server.close(resolve));
  for await (const keys of redis.scanIterator({ MATCH:`${prefix}*`, COUNT:200 })) if (keys.length) await redis.del(keys);
  await redis.quit(); await mongoose.disconnect();
});

for (const [driverCount, orderCount] of [[30,1], [30,5], [100,5]]) test(`offer query evidence ${driverCount} drivers / ${orderCount} orders`, async () => {
  const drivers = [];
  for (let i = 0; i < driverCount; i++) { const driver = await account(); drivers.push(driver); await locate(driver); }
  const orders = await Order.collection.insertMany(Array.from({ length:orderCount }, () => ({ customerToken:randomUUID(), status:'searching_driver', activeAssignment:false,
    collectedAt:null, driverSearchStatus:'searching', searchDeadlineAt:new Date(Date.now() + 600000), pickupLocation:{ lat:32.75, lng:35.34 },
    serviceArea:'kafr-kanna', storeName:'Public store', createdAt:new Date(), updatedAt:new Date() })));
  let queries = 0, offers;
  mongoose.set('debug', () => queries++);
  const started = performance.now();
  try { offers = await availableNearbyOffers(drivers[0], store); } finally { mongoose.set('debug', false); }
  const durationMs = +(performance.now() - started).toFixed(2);
  assert.equal(offers.length, orderCount);
  assert.deepEqual(new Set(offers.map(offer => String(offer.orderId))), new Set(Object.values(orders.insertedIds).map(String)));
  assert(queries <= 6 + orderCount * 2, `unexpected query growth: ${queries}`);
  measurements.push({ drivers:driverCount, orders:orderCount, mongoQueries:queries, returned:offers.length, durationMs });
  await writeFile(new URL('offer-scenarios.json', evidence), JSON.stringify(measurements, null, 2));
  // The cached selection cannot authorize a driver after eligibility changes.
  await User.updateOne({ _id:drivers[0]._id }, { $set:{ availableForOrders:false } });
  assert.equal((await request(`/orders/${orders.insertedIds[0]}/accept`, drivers[0])).status, 409);
  assert.equal(await Order.countDocuments({ activeAssignment:true }), 0);
});

test('GEO expires after real TTL without GEOSEARCH and stays safe across client reconnect and stale cleanup', async () => {
  const short = createLocationStore(redis, { ...config, locationTtlSeconds:1, presenceTtlSeconds:1, pushLocationMaxAgeSeconds:1 }, `${prefix}short:`);
  const driver = await account(), id = String(driver._id), session = await locate(driver, short), keys = short.keys(id);
  assert((await redis.ttl(keys.plausibility)) > 0);
  await new Promise(resolve => setTimeout(resolve, 1150)); // Intentionally cross Redis's real TTL, not a UI readiness wait.
  assert.equal(await redis.get(keys.location), null); assert.equal(await redis.get(keys.lastKnown), null);
  await redis.quit(); await redis.connect();
  assert.equal(await short.sweepExpiredGeo(), 1);
  assert.equal(await redis.zScore(short.geoKey, id), null); assert.equal(await redis.zScore(short.geoExpiryKey, id), null);
  const nextSession = randomUUID(); await store.activateSession(id, nextSession);
  assert.equal(await store.saveLocation(id, point(nextSession)), 'accepted');
  assert.equal(await store.removeStaleGeoMember(id), 0);
  await store.sweepExpiredGeo(); assert.notEqual(await redis.zScore(store.geoKey, id), null);
  await store.invalidateDriver(id); assert.equal(await redis.get(store.keys(id).location), null);
  assert.equal(await redis.zScore(store.geoKey, id), null);
});

test('background renewals never extend the 12-hour maximum even with repeated valid renewals', async t => {
  t.mock.timers.enable({ apis:['Date'], now:Date.now() });
  const driver = await account(), sessionId = await locate(driver);
  let response = await request(BACKGROUND.session, driver, { sessionId });
  assert.equal(response.status, 200);
  const until = jwt.decode(response.data.credential).renewalUntil;
  assert.equal(until - Math.floor(Date.now() / 1000), BACKGROUND.maxShiftSeconds);
  for (let renewal = 0; renewal < 13; renewal++) {
    t.mock.timers.tick(55 * 60000);
    response = await request(BACKGROUND.renew, response.data.credential);
    assert.equal(response.status, 200);
    assert.equal(jwt.decode(response.data.credential).renewalUntil, until);
    assert(response.data.expiresAt <= until * 1000);
  }
  t.mock.timers.tick(5 * 60000 + 1000);
  assert.equal((await request(BACKGROUND.renew, response.data.credential)).status, 401);
});

test('the same phone moves from logged-out A to B without receiving A notifications', async () => {
  const a = await account(), b = await account(), token = 'ExponentPushToken[isolatedsamephone123]';
  assert.equal((await request('/driver/push-token', a, { token, platform:'android' }, 'PUT')).status, 200);
  assert.equal((await request('/auth/logout', a)).status, 200); // No unregister call is sent by the client.
  assert.equal(await PushDevice.countDocuments({ userId:a._id }), 0);
  assert.equal((await request('/driver/push-token', b, { token, platform:'android' }, 'PUT')).status, 200);
  const sent = [], notifier = createPushNotifier({ ...config, pushEnabled:true }, async messages => { sent.push(...messages); return messages.map(() => ({ status:'ok' })); });
  assert.equal(await notifier.offer(a._id, { orderId:'a' }), 0);
  assert.equal(await notifier.offer(b._id, { orderId:'b' }), 1);
  assert.equal(sent.length, 1); assert.equal(sent[0].data.orderId, 'b');
  assert.equal(String((await PushDevice.findOne({ token })).userId), String(b._id));
});
