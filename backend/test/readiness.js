import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { createClient } from 'redis';
import { writeFile, mkdir } from 'node:fs/promises';
const evidence = new URL(`../../${process.env.READINESS_EVIDENCE_DIR || '.verification/store-readiness-2026-10-22/'}`, import.meta.url);
const uri = process.env.OFFERS_TEST_URI;
if (!uri || !new URL(uri).pathname.endsWith('_test') || !process.env.REDIS_TEST_URL) throw Error('Isolated test MongoDB/Redis required');
process.env.MONGODB_URI = uri; process.env.JWT_SECRET = 'readiness-integration-test';
const { User, Order, PushDevice, DriverCashRecord, connectDatabase } = await import('../src/models/index.js');
const { DataRequest } = await import('../src/models/dataRequest.js');
const { createApp } = await import('../src/app.js');
const { createLocationStore } = await import('../src/services/locationStore.js');
const { driverSummary } = await import('../src/services/finance.js');
const { driverCashHistory } = await import('../src/services/driverSummary.js');
const { availableNearbyOffers } = await import('../src/services/nearbyOffers.js');
const { sweepCustomerRetention } = await import('../src/services/privacyRetention.js');
const { config } = await import('../src/config.js');
const { BACKGROUND } = await import('../../shared/realtimeContract.js');
const redis = createClient({ url: process.env.REDIS_TEST_URL }); redis.on('error', () => {});
const prefix = `readiness:${randomUUID()}:`, store = createLocationStore(redis, config, prefix);
let server, base;
const account = extra => User.create({ login: randomUUID(), name: 'Fixture', role: 'driver', active: true,
  passwordHash: 'fixture-not-a-password', availableForOrders: true, vehicleType: 'car', serviceAreas: ['kafr-kanna'], ...extra });
const sign = user => jwt.sign({ ver: user.authVersion ?? 0 }, config.jwtSecret, { subject: String(user._id), expiresIn: '1d' });
async function request(path, user, body, method = 'POST') {
  const response = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type':'application/json', ...(user ? { Authorization:`Bearer ${typeof user === 'string' ? user : sign(user)}` } : {}) }, ...(body === undefined ? {} : { body:JSON.stringify(body) }) });
  return { status:response.status, data:await response.json() };
}
const sample = sessionId => ({ sessionId, sequence:1, measuredAt:Date.now(), latitude:32.75, longitude:35.34, accuracy:8, heading:null, speed:null });
before(async () => { await connectDatabase(); await DataRequest.init(); await redis.connect(); server=createServer(createApp({locationStore:store,redis})); server.listen(0,'127.0.0.1'); await once(server,'listening'); base=`http://127.0.0.1:${server.address().port}`; });
beforeEach(async () => { await Promise.all([User,Order,PushDevice,DriverCashRecord,DataRequest].map(m=>m.deleteMany({}))); });
after(async () => { server?.close(); for await (const keys of redis.scanIterator({MATCH:`${prefix}*`,COUNT:100})) if(keys.length) await redis.del(keys); await redis.quit(); await mongoose.disconnect(); });

test('GEO expires independently of searches; a newer sample survives stale cleanup', async () => {
  const driver=await account(), id=String(driver._id), sessionId=randomUUID();
  await store.activateSession(id,sessionId); await store.saveLocation(id,sample(sessionId));
  await redis.zAdd(store.geoExpiryKey,{score:Date.now()-1,value:id});
  assert.equal(await store.sweepExpiredGeo(),1); assert.equal(await redis.zScore(store.geoKey,id),null);
  const point=sample(sessionId); point.sequence=2; point.measuredAt+=1;
  await store.saveLocation(id,point); await store.sweepExpiredGeo();
  assert.notEqual(await redis.zScore(store.geoKey,id),null);
  await store.invalidateDriver(id); assert.equal(await redis.zScore(store.geoKey,id),null);
});
test('renewal remains scoped, bounded, owner-controlled and revocable', async () => {
  const driver=await account(), id=String(driver._id), fg=randomUUID(); await store.activateSession(id,fg);
  const bg=(await request(BACKGROUND.session,driver,{sessionId:fg})).data;
  const renewal=await request(BACKGROUND.renew,bg.credential,{}); assert.equal(renewal.status,200);
  assert.equal(renewal.data.sessionId,bg.sessionId);
  assert.equal(jwt.decode(renewal.data.credential).renewalUntil,jwt.decode(bg.credential).renewalUntil);
  assert.equal((await request('/auth/me',renewal.data.credential,undefined,'GET')).status,401);
  await User.updateOne({_id:driver._id},{$set:{availableForOrders:false}});
  assert.equal((await request(BACKGROUND.renew,bg.credential,{})).data.code,'tracking_disabled');
  await User.updateOne({_id:driver._id},{$set:{availableForOrders:true}});
  await store.activateSession(id,randomUUID());
  assert.equal((await request(BACKGROUND.renew,bg.credential,{})).data.code,'stale_session');
  await User.updateOne({_id:driver._id},{$inc:{authVersion:1}});
  assert.equal((await request(BACKGROUND.renew,bg.credential,{})).status,401);
});
test('5000-trip summary is bounded, totals stay exact and indexed history pages do not overlap', async () => {
  const driver=await account(), now=new Date();
  for(let batch=0;batch<25;batch++) await Order.collection.insertMany(Array.from({length:200},(_,i)=>({
    driverId:driver._id, status:'delivered', activeAssignment:false, customerToken:randomUUID(),
    deliveredAt:new Date(now.getTime()-(batch*200+i)*1000), driverEarningsAgorot:123, actualCashCollectedAgorot:200,
  })));
  const first=await driverSummary(driver._id), second=await driverSummary(driver._id,{cursor:first.nextCursor});
  assert.equal(first.deliveredCount,5000); assert.equal(first.earningsAgorot,615000); assert.equal(first.cashHeldAgorot,1000000);
  assert.equal(first.deliveries.length,20); assert.equal(second.deliveries.length,20);
  assert.equal(new Set([...first.deliveries,...second.deliveries].map(x=>String(x.orderId))).size,40);
  const bytes=Buffer.byteLength(JSON.stringify(first)); assert(bytes<20000);
  const plan=await Order.find({driverId:driver._id,status:'delivered'}).sort({deliveredAt:-1,_id:-1}).limit(21).explain('executionStats');
  assert(!JSON.stringify(plan.queryPlanner.winningPlan).includes('COLLSCAN'));
  await mkdir(evidence,{recursive:true});
  await writeFile(new URL('summary-performance.json',evidence),JSON.stringify({trips:5000,returned:first.deliveries.length,bytes,keysExamined:plan.executionStats.totalKeysExamined,docsExamined:plan.executionStats.totalDocsExamined,plan:plan.queryPlanner.winningPlan},null,2));
});
test('100 drivers and five offers require a bounded batch of Mongo queries', async () => {
  const drivers=[]; for(let i=0;i<100;i++) drivers.push(await account());
  const driver=drivers[0], id=String(driver._id), sessionId=randomUUID();
  await store.activateSession(id,sessionId); await store.saveLocation(id,sample(sessionId));
  await Order.collection.insertMany(Array.from({length:5},()=>({ customerToken:randomUUID(), status:'searching_driver',activeAssignment:false,collectedAt:null,
    driverSearchStatus:'searching',searchDeadlineAt:new Date(Date.now()+600000),pickupLocation:{lat:32.75,lng:35.34},serviceArea:'kafr-kanna',storeName:'Public',createdAt:new Date(),updatedAt:new Date() })));
  let queries=0; mongoose.set('debug',()=>queries++);
  let result; try { result=await availableNearbyOffers(driver,store); } finally { mongoose.set('debug',false); }
  assert.equal(result.length,5); assert(queries<25,`queries=${queries}`);
  await writeFile(new URL('offers-performance.json',evidence),JSON.stringify({drivers:100,orders:5,queries},null,2));
});
test('cash record pages preserve full totals, private notes and account isolation', async () => {
  const driver=await account(), other=await account(), at=new Date();
  await DriverCashRecord.collection.insertMany(Array.from({length:60},(_,i)=>({driverId:driver._id,type:'cash_handover',amountAgorot:10,createdAt:at,requestId:randomUUID(),note:'private-note',recordedByAdminId:other._id})));
  const summary=await driverSummary(driver._id), second=await driverCashHistory(driver._id,{cursor:summary.nextRecordsCursor});
  assert.equal(summary.cashHandedOverAgorot,600); assert.equal(summary.records.length,20); assert.equal(second.items.length,20);
  assert.equal(new Set([...summary.records,...second.items].map(r=>String(r._id))).size,40);
  assert(!JSON.stringify(summary.records).includes('private-note'));
  assert.equal((await driverCashHistory(other._id)).items.length,0);
  const admin = await account({role:'admin'});
  assert.equal((await request(`/admin/accounts/${driver._id}/cash-records`,driver,undefined,'GET')).status,403);
  assert.equal((await request(`/admin/accounts/${driver._id}/cash-records`,admin,undefined,'GET')).data.items[0].note,'private-note');
  assert.equal((await request('/driver/summary?cursor[]=bad',driver,undefined,'GET')).status,400);
});
test('public requests avoid enumeration, require verified admin processing and deletion revokes credentials', async () => {
  const user=await account(), admin=await account({role:'admin'});
  const submitted=await request('/data-requests',null,{type:'deletion',identifier:user.login,contact:'fixture@example.invalid'});
  assert.equal(submitted.status,202); assert(submitted.data.reference);
  const ticket=await DataRequest.findOne({reference:submitted.data.reference});
  assert.equal((await request('/admin/data-requests',user,undefined,'GET')).status,403);
  assert.equal((await request(`/admin/data-requests/${ticket._id}/resolve`,admin,{action:'completed',identityVerified:false,userId:String(user._id)})).status,400);
  await PushDevice.create({userId:user._id,token:'ExponentPushToken[abcdefghijklmnop]',platform:'android'});
  assert.equal((await request(`/admin/data-requests/${ticket._id}/resolve`,admin,{action:'completed',identityVerified:true,userId:String(user._id)})).status,200);
  const deleted=await User.findById(user._id).lean(); assert.equal(deleted.active,false); assert.equal(deleted.phone,'');
  assert.equal(await PushDevice.countDocuments({userId:user._id}),0);
  assert.equal((await request('/auth/me',user,undefined,'GET')).status,401);
  assert.equal((await request(`/admin/accounts/${user._id}`,admin,{active:true},'PATCH')).status,404);
});
test('retention removes customer details once, preserves financials, skips active work', async () => {
  const old=new Date(Date.now()-91*86400000), driver=await account();
  const rows=await Order.collection.insertMany([false,true].map(activeAssignment=>({driverId:driver._id,customerToken:randomUUID(),status:'delivered',activeAssignment,updatedAt:old,
    customerPhone:'private',recipientName:'private',finalAddress:'private',destinationLocation:{lat:32.75,lng:35.34},driverEarningsAgorot:123})));
  assert.equal(await sweepCustomerRetention(),1); assert.equal(await sweepCustomerRetention(),0);
  const clean=await Order.findById(rows.insertedIds[0]).lean(); assert.equal(clean.customerPhone,''); assert.equal(clean.destinationLocation,undefined); assert.equal(clean.driverEarningsAgorot,123);
  assert.equal((await Order.findById(rows.insertedIds[1]).lean()).customerPhone,'private');
});
test('diagnostic endpoint accepts only scrubbed version metadata', async () => {
  assert.equal((await request('/diagnostics',null,{kind:'render',platform:'android',releaseId:'build-123',fingerprint:'1234abcd'})).status,202);
  assert.equal((await request('/diagnostics',null,{kind:'render',platform:'android',releaseId:'build-123',fingerprint:'1234abcd',token:'private'})).status,400);
});
