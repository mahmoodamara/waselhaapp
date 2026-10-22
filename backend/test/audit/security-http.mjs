// Real HTTP/server/MongoDB security regressions; existing isolated fixture reused.
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { models, request, sessions, create, tokenOf, confirm, confirmLocation, pickedUp, apiUrl, relogin, auditServerLogs } from '../helpers/security.js';
const inventory=JSON.parse(await readFile(new URL('../../../.verification/security-audit-2026-10-18/authorization-map.json',import.meta.url),'utf8'));
const evidence=[];
const record=(name,value)=>{evidence.push({name,value});};
const logFindings=[];let sanitizedServerLog='';
afterEach(async()=>{
 const logs=auditServerLogs();let safe=logs;
 const values=[];
 const collect=value=>{if(value&&typeof value==='object')Object.values(value).forEach(collect);else values.push(value);};
 for(const line of logs.split(/\r?\n/)){try{collect(JSON.parse(line));}catch{values.push(line);}}
 const samples=await models.Order.find({}).select('customerPhone customerToken deliveryCode pickupCode destinationLocation').lean();
 const candidates=samples.flatMap(o=>[['customerPhone',o.customerPhone],['customerToken',o.customerToken],['deliveryCode',o.deliveryCode],['pickupCode',o.pickupCode],['latitude',o.destinationLocation?.lat],['longitude',o.destinationLocation?.lng]]).filter(([,v])=>v!==undefined&&v!==null&&v!=='');
 for(const [field,value]of candidates){const needle=String(value),found=values.some(v=>['latitude','longitude'].includes(field)?typeof v==='number'&&v===value:field.endsWith('Code')?String(v)===needle:typeof v==='string'&&v.includes(needle));if(found&&!logFindings.some(x=>x.field===field))logFindings.push({field,source:'captured real HTTP server stdout/stderr',qualification:'structured log value match; timestamp and identifier substrings are not coordinates/codes'});safe=safe.replaceAll(needle,`[REDACTED_${field}]`);}
 safe=safe.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[REDACTED_JWT]').replace(/\b[a-f0-9]{48}\b/gi,'[REDACTED_LINK]');sanitizedServerLog=safe;
});
const fakeId='000000000000000000000001';
const routePath=r=>r.path.replace('/api','').replaceAll(':id',fakeId).replaceAll(':token','0'.repeat(48));
let otherToken,otherId;
async function ensureOther(){
 if(otherToken)return;
 const saved=await request('/admin/accounts',sessions.admin.token,'POST',{login:'security-other-store',password:'OtherStore123!',role:'store',name:'Other',storeName:'Other',pickupAddress:'Other pickup'},201);
 otherId=saved.data._id; otherToken=(await request('/auth/login',null,'POST',{login:'security-other-store',password:'OtherStore123!'})).data.token;
}
async function raw(path,token,method='GET',body,headers={}) {
 const r=await fetch(apiUrl(path),{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`} :{}),...headers},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
 const text=await r.text(); return {status:r.status,text,headers:r.headers};
}
const db=o=>models.Order.findById(o._id).lean();
const edit=async(o,changes)=>request(`/orders/${o._id}`,sessions.store1.token,'PATCH',{observed:(await request(`/orders/${o._id}`,sessions.store1.token)).data.confirmationSnapshot,...changes},null);

test('S01 every JWT-protected route rejects absent/expired/malformed/wrong-signature credentials',async()=>{
 const tokens=[null,jwt.sign({},process.env.JWT_SECRET,{subject:sessions.store1.user._id,expiresIn:-1}),'malformed',jwt.sign({},'wrong-local-only-signing-key',{subject:sessions.store1.user._id,expiresIn:'5m'})];
 let checked=0;
 for(const r of inventory.routes.filter(r=>r.protected&&r.file!=='backend/src/routes/backgroundLocation.js'||r.path.endsWith('/background/session'))) {
  for(const token of tokens) {const result=await request(routePath(r),token,r.method,['GET','DELETE'].includes(r.method)?undefined:{},null);assert.equal(result.status,401,`${r.method} ${r.path}`);assert.deepEqual(result.data,{code:'unauthorized'});checked++;}
 }
 record('S01',{requests:checked});
});
test('S02 inactive/deleted tokens rejected and admin password reset revokes session',async()=>{
 const id=sessions.driver2.user._id;
 try {
  await models.User.updateOne({_id:id},{$set:{active:false}}); await request('/auth/me',sessions.driver2.token,'GET',undefined,401);
  await models.User.updateOne({_id:id},{$set:{active:true}});
  const missing=jwt.sign({},process.env.JWT_SECRET,{subject:new mongoose.Types.ObjectId().toString(),expiresIn:'5m'});await request('/auth/me',missing,'GET',undefined,401);
  await request(`/admin/accounts/${id}`,sessions.admin.token,'PATCH',{password:'WaselhaDemo123!'});await request('/auth/me',sessions.driver2.token,'GET',undefined,401);
 } finally {await models.User.updateOne({_id:id},{$set:{active:true}});await relogin('driver2');}
});
test('S03 role injection into login/driver profile cannot escalate; registration/reset routes unavailable',async()=>{
 const result=await request('/auth/login',null,'POST',{login:'driver1',password:'WaselhaDemo123!',role:'admin'});assert.equal(result.data.user.role,'driver');
 await request('/driver/availability',sessions.driver1.token,'PATCH',{availableForOrders:true,role:'admin'},null);
 assert.equal((await models.User.findById(sessions.driver1.user._id).lean()).role,'driver');
 for(const role of ['admin','driver','store']) await request('/admin/accounts',sessions.store1.token,'POST',{role},403);
 for(const path of ['/auth/register','/auth/forgot-password','/auth/reset-password']) await request(path,null,'POST',{login:'nobody'},404);
});
test('S05 logout revokes token across HTTP',async()=>{await request('/auth/logout',sessions.driver2.token,'POST',{});await request('/auth/me',sessions.driver2.token,'GET',undefined,401);await relogin('driver2');});
test('S06 merchant cannot read/edit/cancel/ready another merchants order',async()=>{
 await ensureOther();
 const o=await create();
 for(const [method,suffix,body] of [['GET','',undefined],['PATCH','',{}],['POST','/cancel',{requestId:randomUUID()}],['POST','/readiness',{ready:true}]]) await request(`/orders/${o._id}${suffix}`,otherToken,method,body,404);
 assert.equal((await db(o)).status,o.status);
});
test('S07 merchant lists/filter/search/pagination cannot expose other store',async()=>{
 await ensureOther();
 const a=await create(), b=await create({recipientName:'Other owner sentinel'});await models.Order.updateOne({_id:b._id},{$set:{storeId:otherId}});
 for(const query of ['', '?status=searching_driver','?search=Other&storeId='+otherId,'?page=1&limit=100&skip=0']) {const list=(await request('/orders'+query,sessions.store1.token)).data;assert.ok(list.some(o=>o._id===a._id));assert.ok(list.every(o=>o.storeId===a.storeId));}
});
test('S08 driver cannot read or mutate another drivers assignment',async()=>{
 const o=await create();await pickedUp(o);
 await request(`/orders/${o._id}`,sessions.driver2.token,'GET',undefined,404);
 for(const action of ['accept','arrive-store','pickup','arrive-customer','deliver','fail','verify-delivery-code','withdraw','report-issue']) {const r=await request(`/orders/${o._id}/${action}`,sessions.driver2.token,'POST',{code:'0000',requestId:randomUUID()},null);assert.ok([404,409].includes(r.status),action);}
 assert.equal(String((await db(o)).driverId),sessions.driver1.user._id);
});
test('S09-S10 driver never offered order cannot read customer data or codes',async()=>{
 const o=await create();await request(`/orders/${o._id}`,sessions.driver2.token,'GET',undefined,404);
 await pickedUp(o);const view=(await request(`/orders/${o._id}`,sessions.driver1.token)).data;assert.equal(view.deliveryCode,undefined);assert.equal(view.customerToken,undefined);assert.equal(view.pickupCode,undefined);
 const cv=(await request(`/customer/${tokenOf(o)}`)).data;assert.equal(cv.deliveryCode,undefined);
});
test('S11 customer X cannot select or mutate Y using extra order identifiers',async()=>{
 const x=await create(), y=await create(), before=await db(y);
 const result=await request(`/customer/${tokenOf(x)}/details`,null,'POST',{orderId:y._id,_id:y._id,recipientName:'Own token update',customerPhone:'0501234567'},null);assert.ok([200,400,409].includes(result.status));
 assert.deepEqual((await db(y)).recipientName,before.recipientName);
 await request(`/orders/${y._id}`,tokenOf(x),'GET',undefined,401);
});
test('S12 wrong owner and nonexistent identifiers must have indistinguishable responses',async()=>{
 await ensureOther();
 const o=await create();const existing=await request(`/orders/${o._id}`,otherToken,'GET',undefined,null),missing=await request(`/orders/${fakeId}`,otherToken,'GET',undefined,null);
 const next=await create();record('S12',{existingStatus:existing.status,missingStatus:missing.status,consecutiveSuffix:BigInt('0x'+next._id)-BigInt('0x'+o._id)===1n});
 assert.equal(existing.status,404); assert.deepEqual(existing,missing,'Foreign and missing orders must both return the same 404 body');
});

test('S12 creation idempotency identifiers cannot probe another merchants order existence',async()=>{
 await ensureOther();
 await models.User.updateOne({_id:otherId},{$set:{pickupServiceArea:'kafr-kanna',pickupLocation:{lat:32.75,lng:35.34,address:'Synthetic pickup',source:'gps',confirmedAt:new Date()}}});
 const victim=await create(), before=await db(victim);
 const body={serviceArea:'kafr-kanna',area:'Synthetic area',deliveryFeePaidBy:'customer',goodsAmountAgorot:10000,customerPhone:'0501234567'};
 const existing=await request('/orders',otherToken,'POST',{...body,operationId:victim._id},null);
 const missing=await request('/orders',otherToken,'POST',{...body,operationId:new mongoose.Types.ObjectId().toString()},null);
 assert.equal(existing.status,201);assert.equal(missing.status,201);
 assert.notEqual(existing.data._id,victim._id);
 assert.deepEqual(await db(victim),before);
 const replay=await request('/orders',otherToken,'POST',{...body,operationId:victim._id});
 assert.equal(replay.data._id,existing.data._id);
});
test('S13 every admin route rejects merchant and driver',async()=>{
 let n=0;for(const r of inventory.routes.filter(r=>r.path.startsWith('/api/admin/'))) for(const token of [sessions.store1.token,sessions.driver1.token]) {await request(routePath(r),token,r.method,['GET','DELETE'].includes(r.method)?undefined:{},403);n++;}record('S13',{requests:n});
});
test('S14 cross-role driver/store routes rejected',async()=>{
 for(const r of inventory.routes.filter(r=>r.path.startsWith('/api/store/')||r.path.startsWith('/api/driver/')&&r.path!=='/api/driver/location/background')) {const token=r.path.startsWith('/api/store/')?sessions.driver1.token:sessions.store1.token;await request(routePath(r),token,r.method,['GET','DELETE'].includes(r.method)?undefined:{},403);}
 for(const r of inventory.routes.filter(r=>r.file.endsWith('/orders.js')&&['store','driver'].includes(r.roles.trim()))) await request(routePath(r),r.roles.trim()==='store'?sessions.driver1.token:sessions.store1.token,r.method,r.method==='GET'?undefined:{},403);
});
test('S15 mass assignment cannot set server controlled order fields',async()=>{
 const injected={status:'delivered',assignedDriver:sessions.driver2.user._id,driverId:sessions.driver2.user._id,dispatchVersion:999,customerAgreement:{accepted:true},platformCommissionAgorot:1,driverEarningsAgorot:1,priceStatus:'final',deliveryFeeAgorot:1,actualCashCollectedAgorot:1};
 const o=await create(injected);let saved=await db(o);assert.equal(saved.status,'searching_driver');assert.equal(saved.driverId,null);assert.notEqual(saved.deliveryFeeAgorot,1);assert.notEqual(saved.platformCommissionAgorot,1);assert.notEqual(saved.driverEarningsAgorot,1);assert.notEqual(saved.dispatchVersion,999);assert.notEqual(saved.actualCashCollectedAgorot,1);
 const result=await edit(o,injected);assert.ok([200,400,409].includes(result.status));saved=await db(o);assert.equal(saved.status,'searching_driver');assert.notEqual(saved.dispatchVersion,999);assert.notEqual(saved.actualCashCollectedAgorot,1);
});
test('S16 customer financial injection and terminal writes rejected or ignored',async()=>{
 const o=await create();await confirmLocation(tokenOf(o));const view=(await request(`/customer/${tokenOf(o)}`)).data;
 await request(`/customer/${tokenOf(o)}/confirm`,null,'POST',{observed:view.confirmationSnapshot,recipientName:'Customer name',finalAddress:'Final address',goodsAmountAgorot:1,deliveryFeeAgorot:1,driverId:sessions.driver2.user._id,status:'delivered',actualCashCollectedAgorot:1});
 let saved=await db(o);assert.equal(saved.goodsAmountAgorot,10000);assert.notEqual(saved.deliveryFeeAgorot,1);assert.notEqual(saved.actualCashCollectedAgorot,1);
 await models.Order.updateOne({_id:o._id},{$set:{status:'cancelled'}});
 for(const suffix of ['confirm','details','availability','location']) {const r=await request(`/customer/${tokenOf(o)}/${suffix}`,null,'POST',{available:true,recipientName:'Terminal tamper',lat:32.75,lng:35.35,source:'gps'},null);assert.ok([400,409].includes(r.status),suffix);}
});
test('S17 finance cash/payout/settlement/reversal attributes actual authenticated admin',async()=>{
 const o=await create();await pickedUp(o);await request(`/orders/${o._id}/arrive-customer`,sessions.driver1.token,'POST',{});const before=await db(o);
 await request(`/orders/${o._id}/deliver`,sessions.driver1.token,'POST',{code:before.deliveryCode,actualCashCollectedAgorot:before.expectedCustomerCashAgorot,observedExpectedAgorot:before.expectedCustomerCashAgorot});
 const amounts=[['cash-handover','cashHandover',before.expectedCustomerCashAgorot],['driver-payout','driverPayout',undefined],['store-settlement','storeSettlement',before.goodsAmountAgorot]];
 for(const [action,field,amount]of amounts){const body={requestId:randomUUID(),...(amount===undefined?{}:{amountAgorot:amount})};await request(`/admin/orders/${o._id}/finance/${action}`,sessions.admin.token,'POST',{...body,completedBy:sessions.driver1.user._id},400);await request(`/admin/orders/${o._id}/finance/${action}`,sessions.admin.token,'POST',body);assert.equal(String((await db(o))[field].completedBy),sessions.admin.user._id);}
 await request(`/admin/orders/${o._id}/finance/reverse-record`,sessions.admin.token,'POST',{requestId:randomUUID(),record:'driver-payout',reason:'Synthetic audit reversal'});
 const event=(await db(o)).events.find(e=>e.type==='finance_record_reversed');assert.equal(String(event.actorId),sessions.admin.user._id);
});
test('S18 link format uniqueness and small guessing probe rejects all guesses',async()=>{
 const tokens=new Set();for(let i=0;i<8;i++){const token=tokenOf(await create());assert.match(token,/^[a-f0-9]{48}$/);tokens.add(token);}assert.equal(tokens.size,8);
 for(let i=0;i<8;i++)await request('/customer/'+i.toString(16).padStart(48,'0'),null,'GET',undefined,404);
 record('S18',{sampleSize:8,unique:8,entropySource:'randomBytes(24), code review: 192 random bits'});
});
test('S21 customer DTO must not disclose internal identifiers or earning splits',async()=>{
 await request('/store/pickup-service-area',sessions.store1.token,'PUT',{pickupServiceArea:'kafr-kanna'});
 const o=await create({workflowVersion:3,storeAuthorization:true,vehicleType:'car',parcelSize:'medium'});const cv=(await request(`/customer/${tokenOf(o)}`)).data;
 const forbidden=['_id','storeId','driverId','assignedDriver','platformCommissionAgorot','driverEarningsAgorot','estimatedDriverEarningsAgorot','passwordHash','customerToken'];
 const exposed=forbidden.filter(k=>Object.hasOwn(cv,k));record('S21',{exposedFields:exposed});assert.deepEqual(exposed,[],'Customer response contains internal ID/estimated earning split');
});
test('S28 NoSQL operator objects cannot bypass auth/order/status/customer validation',async()=>{
 for(const body of [{login:{$ne:null},password:'x'},{login:'driver1',password:{$gt:''}}])await request('/auth/login',null,'POST',body,400);
 for(const path of ['/orders/%7B%22%24ne%22:null%7D','/orders?status[$ne]=cancelled']){const r=await request(path,sessions.store1.token,'GET',undefined,null);assert.ok([200,400,404].includes(r.status));if(r.status===200)assert.ok(Array.isArray(r.data));}
 for(const token of ['%7B%22%24ne%22:null%7D','$gt','null'])await request(`/customer/${token}`,null,'GET',undefined,404);
});
test('S29 invalid amount and coordinate types do not persist corrupt money',async()=>{
 const o=await create(),before=await db(o);
 for(const goodsAmountAgorot of [-1,1.2,'12',null,Number.MAX_SAFE_INTEGER+1,{$gt:0}]) {const r=await edit(o,{goodsAmountAgorot});assert.ok([400,409].includes(r.status));}
 for(const lat of [-91,91,'NaN',null,{$ne:null}]){const r=await request(`/customer/${tokenOf(o)}/location`,null,'POST',{lat,lng:35.35,source:'gps'},null);assert.ok([400,422].includes(r.status));}
 await request(`/customer/${tokenOf(o)}/location`,null,'POST',{lat:'32.75',lng:'35.35',source:'gps'});assert.equal(typeof (await db(o)).destinationLocation.lat,'number');
 const saved=await db(o);assert.equal(saved.goodsAmountAgorot,before.goodsAmountAgorot);assert.equal(saved.actualCashCollectedAgorot,before.actualCashCollectedAgorot);
 const zero=await edit(o,{goodsAmountAgorot:0});assert.equal(zero.status,200);
});
test('S30 oversized/malformed/nested/unexpected content type bodies bounded',async()=>{
 const huge=await raw('/orders',sessions.store1.token,'POST',{notes:'x'.repeat(110000)});assert.equal(huge.status,413);assert.doesNotMatch(huge.text,/stack|node_modules|[A-Z]:\\/);
 assert.equal((await raw('/orders',sessions.store1.token,'POST','{')).status,400);
 const nested=await request('/auth/login',null,'POST',{login:{a:{b:{c:{$ne:null}}}},password:'x'},null);assert.equal(nested.status,400);
 const wrongType=await raw('/auth/login',null,'POST','login=driver1&password=x',{'Content-Type':'text/plain'});assert.equal(wrongType.status,400);
 const long=await edit(await create(),{recipientName:'x'.repeat(5000)});assert.equal(long.status,400);
});
test('S33 headers/errors/foreign HTTP Origin cannot disclose protected data',async()=>{
 const health=await raw('/health',null);assert.equal(health.headers.get('x-content-type-options'),'nosniff');assert.equal(health.headers.get('referrer-policy'),'no-referrer');assert.equal(health.headers.get('access-control-allow-origin'),null);
 const error=await raw('/orders',null,'POST',{} ,{Origin:'https://attacker.invalid'});assert.equal(error.status,401);assert.equal(error.text,'{"code":"unauthorized"}');assert.equal(error.headers.get('access-control-allow-origin'),null);
});
test('S34 merchant creation must apply an abuse limit (bounded 12-order probe)',async()=>{
 const statuses=[];for(let i=0;i<12;i++)statuses.push((await raw('/orders',sessions.store1.token,'POST',{serviceArea:'kafr-kanna',deliveryFeePaidBy:'customer',goodsAmountAgorot:10000,recipientName:'Synthetic',customerPhone:'0501234567'})).status);
 record('S34',{requests:12,statuses});assert.ok(statuses.includes(429),'12 creations all accepted; code review confirms no limiter with SMS disabled');
});
test('S35/S39 real customer limiter shares all token paths and ignores spoofed XFF when trust proxy false',async()=>{
 const {config}=await import('../../src/config.js');const {createApp}=await import('../../src/app.js');const previous=config.rateLimitCustomerPerMin;config.rateLimitCustomerPerMin=8;
 const local=createServer(createApp({textMe:{enabled:false}}));config.rateLimitCustomerPerMin=previous;
 local.listen(0,'127.0.0.1');await once(local,'listening');
 try {const statuses=[];for(let i=0;i<12;i++){const r=await fetch(`http://127.0.0.1:${local.address().port}/api/customer/${'0'.repeat(48)}/${i%2?'confirm':'availability'}`,{method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-For':`198.51.100.${i+1}`},body:'{}'});statuses.push(r.status);await r.text();}assert.deepEqual(statuses,[...Array(8).fill(404),...Array(4).fill(429)]);record('S35/S39',{testConfiguredLimit:8,defaultLimit:120,statuses,trustProxy:false});}
 finally{local.closeAllConnections();await new Promise(r=>local.close(r));}
});
test('S39 simulated trusted proxy hop demonstrates need to reject direct clients upstream',async()=>{
 const {config}=await import('../../src/config.js');const {createApp}=await import('../../src/app.js');const previous={max:config.rateLimitCustomerPerMin,proxy:config.trustProxy};config.rateLimitCustomerPerMin=8;config.trustProxy=1;
 const local=createServer(createApp({textMe:{enabled:false}}));config.rateLimitCustomerPerMin=previous.max;config.trustProxy=previous.proxy;
 local.listen(0,'127.0.0.1');await once(local,'listening');
 try{const statuses=[];for(let i=0;i<12;i++){const r=await fetch(`http://127.0.0.1:${local.address().port}/api/customer/${'0'.repeat(48)}`,{headers:{'X-Forwarded-For':`198.51.100.${i+1}`}});statuses.push(r.status);await r.text();}assert.deepEqual(statuses,Array(12).fill(404));record('S39-trusted-hop',{trustProxy:1,directLoopbackClient:true,spoofedAddresses:12,rateLimited:0,realReverseProxy:'Not verified'});}
 finally{local.closeAllConnections();await new Promise(r=>local.close(r));}
});
test('S37 parallel delivery code guesses retain shared lock across IDs/header/IP/format',async()=>{
 const o=await create();await pickedUp(o);await request(`/orders/${o._id}/arrive-customer`,sessions.driver1.token,'POST',{});
 await request(`/orders/${o._id}/verify-delivery-code`,sessions.driver1.token,'POST',{code:' ٠٠٠٠ '},400);
 const results=await Promise.all(Array.from({length:12},(_,i)=>request(`/orders/${o._id}/verify-delivery-code`,sessions.driver1.token,'POST',{code:i%2?'٠٠٠٠':'0000',requestId:randomUUID()},null,{'X-Request-Id':randomUUID(),'X-Forwarded-For':`198.51.100.${i+1}`})));
 const state=await models.CodeAttemptState.findOne({orderId:o._id,type:'delivery'}).lean();record('S37',{statuses:results.map(r=>r.status),failures:state?.failures});assert.equal(state.failures,5);assert.equal(results.filter(r=>r.status===422).length,4);assert.equal(results.filter(r=>r.status===429).length,8);
 await request(`/orders/${o._id}/verify-delivery-code`,sessions.driver1.token,'POST',{code:(await db(o)).deliveryCode,requestId:randomUUID()},429);
 const tiers=[];
 // Simulate elapsed cooldown only in this audit DB; all guessing remains HTTP.
 for(let failures=6;failures<=15;failures++){
  await models.CodeAttemptState.updateOne({_id:state._id},{$set:{lockedUntil:new Date(Date.now()-1000)}});
  const result=await request(`/orders/${o._id}/verify-delivery-code`,sessions.driver1.token,'POST',{code:failures%2?'۰۰۰۰':'0000',requestId:randomUUID()},429,{'X-Request-Id':randomUUID(),'X-Forwarded-For':`198.51.100.${failures+1}`});
  const current=await models.CodeAttemptState.findById(state._id).lean();assert.equal(current.failures,failures);
  if(failures===10){assert.ok(result.data.retryAfterSeconds>590);tiers.push({failures:10,lock:'ten minutes'});}
  if(failures===15){assert.equal(result.data.requiresAdmin,true);tiers.push({failures:15,lock:'manual'});}
 }
 const locked=await request(`/orders/${o._id}/verify-delivery-code`,sessions.driver1.token,'POST',{code:(await db(o)).deliveryCode,requestId:randomUUID()},429);assert.equal(locked.data.requiresAdmin,true);record('S37-tiers',{cooldownElapsedByTestDbUpdate:true,tiers});
});
test('S37 accept endpoint must apply an abuse limit (bounded 12 invalid-ID probes)',async()=>{
 const statuses=[];for(let i=0;i<12;i++)statuses.push((await request(`/orders/${fakeId}/accept`,sessions.driver1.token,'POST',{},null)).status);
 record('S37-accept',{requests:12,statuses});assert.ok(statuses.includes(429),'No accept limiter in router; all twelve requests reach order lookup');
});
test('S40 all-role user/order responses omit hashes/JWT/link secrets except intentional merchant link',async()=>{
 const o=await create();await pickedUp(o);
 for(const actor of [sessions.store1.token,sessions.driver1.token,sessions.admin.token]){for(const path of ['/auth/me',`/orders/${o._id}`]){const data=(await request(path,actor)).data;const keys=[];const walk=v=>{if(v&&typeof v==='object')for(const [k,x]of Object.entries(v)){keys.push(k);walk(x);}};walk(data);assert.ok(!keys.some(k=>['passwordHash','authVersion','customerToken','jwtSecret','expoPushAccessToken'].includes(k)));}}
});
test('S42 database check documents intentionally recoverable codes and link, no accidental report disclosure',async()=>{
 const o=await create(),saved=await db(o);assert.equal(saved.customerToken,tokenOf(o));assert.match(saved.deliveryCode,/^\d{4}$/);const user=await models.User.findById(sessions.store1.user._id).select('+passwordHash').lean();assert.match(user.passwordHash,/^\$2/);record('S42',{customerTokenPlaintext:true,deliveryCodePlaintext:true,passwordBcrypt:true,intended:'merchant re-share and customer code display use recoverable fields'});
});
test('S43 terminal customer view redacts retained customer data; merchant retains its own history',async()=>{
 const o=await create();await confirmLocation(tokenOf(o));await models.Order.updateOne({_id:o._id},{$set:{status:'cancelled'}});const saved=await db(o),customer=(await request(`/customer/${tokenOf(o)}`)).data,merchant=(await request(`/orders/${o._id}`,sessions.store1.token)).data;
 assert.ok(saved.customerPhone);assert.ok(saved.destinationLocation);for(const k of ['customerPhone','recipientName','destinationLocation','deliveryCode','driverId'])assert.equal(customer[k],undefined);assert.ok(merchant.customerPhone);await request(`/orders/${o._id}`,sessions.driver1.token,'GET',undefined,404);record('S43',{dbPhoneRetained:true,dbLocationRetained:true,customerRedacted:true,merchantOwnHistoryVisible:true});
});
test('S41 successful HTTP server logs contain no tested sensitive fixture values',async()=>{
 record('S41',{findings:logFindings,capturedBytes:Buffer.byteLength(auditServerLogs()),scope:'actual server startup and requests; fixture seed stdout separately redacted by runner'});
 await writeFile(new URL('../../../.verification/security-audit-2026-10-18/http-server-redacted.log',import.meta.url),sanitizedServerLog);
 assert.deepEqual(logFindings,[],'Sensitive fixture value candidate in real server logs (values suppressed)');
});
test('public route inventory denies malformed scoped credentials and probes anonymous status endpoints',async()=>{
 for(const path of ['/health','/ready']){const r=await request(path,null,'GET',undefined,null);assert.ok([200,503].includes(r.status));}
 for(const r of inventory.routes.filter(r=>r.file.endsWith('/customer.js'))) {const x=await request(routePath(r),null,r.method,r.method==='GET'?undefined:{},null);assert.equal(x.status,404);}
 await request('/tracking/snapshot',null,'GET',undefined,401);await request('/tracking/snapshot','bad','GET',undefined,401);
 await request('/driver/location/background',null,'POST',{},401);await request('/driver/location/background','bad','POST',{},401);
 await writeFile(new URL('../../../.verification/security-audit-2026-10-18/http-observations.json',import.meta.url),JSON.stringify(evidence,null,2));
});
