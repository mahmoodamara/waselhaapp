import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { createClient } from 'redis';
const uri=process.env.REALTIME_TEST_URI;
if(!uri||new URL(uri).hostname!=='127.0.0.1'||new URL(uri).port!=='27118'||!new URL(uri).pathname.endsWith('_test'))throw new Error('Isolated local audit database required');
process.env.MONGODB_URI=uri;process.env.JWT_SECRET='security-socket-local-test-secret';
const {User,Order,connectDatabase}=await import('../../src/models/index.js');
const {createApp}=await import('../../src/app.js');
const {attachRealtime}=await import('../../src/realtime/index.js');
const {createLocationStore}=await import('../../src/services/locationStore.js');
const {config}=await import('../../src/config.js');
const {REALTIME,TRACKING}=await import('../../../shared/realtimeContract.js');
const {issueCustomerToken}=await import('../../src/services/customerLinks.js');
const {issueTrackingCredential}=await import('../../src/services/customerTracking.js');
const {publicOrderReference}=await import('../../src/services/publicOrderReference.js');
const {io}=createRequire(new URL('../../../driver-app/package.json',import.meta.url))('socket.io-client');
const redis=createClient({url:process.env.REDIS_TEST_URL,disableOfflineQueue:true});redis.on('error',()=>{});
const store=createLocationStore(redis,{...config,presenceTtlSeconds:3},`security-audit:${randomUUID()}:`);
const sockets=[],ids=[],orders=[],observations=[];let rt,http,base;
const sign=u=>jwt.sign({ver:0},config.jwtSecret,{subject:String(u._id),expiresIn:'5m'});
async function user(role='driver'){const u=await User.create({login:randomUUID(),name:'Synthetic audit',passwordHash:'not-for-login',role,active:true,availableForOrders:true});ids.push(u._id);return u;}
function event(s,name,ms=3000){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{s.off(name,done);reject(new Error(`Timeout ${name}`));},ms);const done=x=>{clearTimeout(timer);resolve(x);};s.once(name,done);});}
async function client(token,namespace='',auth){const s=io(base+namespace,{auth:auth??{token},autoConnect:false,reconnection:false,forceNew:true,transports:['websocket']});sockets.push(s);const ready=event(s,namespace?TRACKING.snapshot:REALTIME.session);s.connect();return {socket:s,...await ready};}
const point=(sessionId,sequence=1,extra={})=>({latitude:32.75,longitude:35.34,accuracy:8,heading:0,speed:0,measuredAt:Date.now(),sequence,sessionId,...extra});
const publish=(s,p)=>s.timeout(3000).emitWithAck(REALTIME.location,p);
const barrier=s=>new Promise(resolve=>s.timeout(150).emit('__audit_unhandled_barrier',{},()=>resolve()));
before(async()=>{await connectDatabase();await redis.connect();http=createServer(createApp({locationStore:store,textMe:{enabled:false}}));rt=attachRealtime(http,store,{...config,presenceTtlSeconds:3,offerReconcileIntervalMs:60000});http.listen(0,'127.0.0.1');await once(http,'listening');base=`http://127.0.0.1:${http.address().port}`;});
after(async()=>{sockets.forEach(s=>s.disconnect());await rt?.close();if(redis.isReady){await redis.del([...ids.flatMap(id=>Object.values(store.keys(String(id)))),store.geoKey]);await redis.quit();}await Order.deleteMany({_id:{$in:orders}});await User.deleteMany({_id:{$in:ids}});await mongoose.disconnect();await writeFile(new URL('../../../.verification/security-audit-2026-10-18/socket-observations.json',import.meta.url),JSON.stringify(observations,null,2));});
test('S23/S25 driver room guessing and client emission of server/admin events grant no rooms or authority',async()=>{
 const a=await user(),b=await user(),x=await client(sign(a)),y=await client(sign(b));let received=0;y.socket.on(REALTIME.offerCreated,()=>received++);
 const o=await Order.collection.insertOne({storeId:new mongoose.Types.ObjectId(),status:'collected',driverId:b._id,activeAssignment:true});orders.push(o.insertedId);
 for(const e of ['join','join-room','subscribe','admin:assign','driver:offer-created','driver:order-changed'])x.socket.emit(e,{room:`driver:${b._id}`,orderId:String(o.insertedId),driverId:String(a._id)});
 await barrier(x.socket);const rooms=[...rt.io.of('/').sockets.get(x.socket.id).rooms];assert.ok(!rooms.includes(`driver:${b._id}`));assert.equal(received,0);assert.equal(String((await Order.findById(o.insertedId).lean()).driverId),String(b._id));x.socket.disconnect();y.socket.disconnect();
});
test('S24 customer room guessing/resync cannot read second order',async()=>{
 const a=await user(),b=await user();const make=async driver=>{const o={_id:new mongoose.Types.ObjectId(),...issueCustomerToken(),storeId:new mongoose.Types.ObjectId(),driverId:driver._id,status:'collected',activeAssignment:true,createdAt:new Date(),updatedAt:new Date()};await Order.collection.insertOne(o);orders.push(o._id);return o;};
 const ox=await make(a),oy=await make(b),x=await client(null,TRACKING.namespace,{credential:issueTrackingCredential(ox).credential});
 x.socket.emit('join',{room:`tracking:order:${oy._id}`});x.socket.emit(TRACKING.resync,{orderId:String(oy._id)});await barrier(x.socket);
 const rooms=[...rt.io.of(TRACKING.namespace).sockets.get(x.socket.id).rooms];assert.ok(!rooms.includes(`tracking:order:${oy._id}`));assert.equal(x.orderId,publicOrderReference(ox));x.socket.disconnect();
});
test('S36 impossible jump must be rejected despite valid sample fields and monotonic time',async()=>{
 const a=await user(),x=await client(sign(a)),t=Date.now()-1000;
 assert.equal((await publish(x.socket,point(x.sessionId,1,{measuredAt:t}))).ok,true);
 const result=await publish(x.socket,point(x.sessionId,2,{measuredAt:t+1,latitude:0,longitude:0,speed:0}));
 observations.push({scenario:36,firstAccepted:true,jumpAccepted:result.ok,jumpDistance:'thousands of km in 1 ms, speed reported as zero'});
 x.socket.disconnect();assert.equal(result.ok,false,'Server accepted impossible GPS teleport with monotonic sequence/time');
});
