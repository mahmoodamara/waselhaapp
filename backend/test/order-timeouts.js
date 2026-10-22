import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { models, sessions, request, create, tokenOf, confirm, pickedUp, restart, relogin } from "./helpers/security.js";
import { resetOrderActionLimits } from './helpers/offerLocations.js';
const { Order, User } = models;
const { processExpiredSearches: searches, processExpiredAssignments: assignments,
  runTimeoutSweep, initializeLegacyDeadlines } = await import("../src/services/orderTimeouts.js");
const { assignOrder, transition } = await import("../src/services/orders.js");
const { config } = await import("../src/config.js");
const store = () => sessions.store1.token, d1 = () => sessions.driver1.token, d2 = () => sessions.driver2.token;
const get = (o) => Order.findById(o._id).lean();
const post = (o, action, token = d1(), body = {}, expected = 200) => request(`/orders/${o._id}/${action}`, token, "POST", body, expected);
const events = (o, type) => o.events.filter((e) => e.type === type);
const offers = async (token = d1()) => (await request("/driver/orders/available", token)).data;
async function expireSearch(o) {
  await Order.updateOne({ _id: o._id }, { $set: { searchDeadlineAt: new Date(Date.now() - 1000) } });
  return get(o);
}
async function accepted() { const o = await create(); await post(o, "accept"); return get(o); }
async function expiredAssignment() {
  const o = await accepted();
  await Order.updateOne({ _id: o._id }, { $set: { storeArrivalDeadlineAt: new Date(Date.now() - 1000) } });
  return get(o);
}
async function noDriver() { const o = await expireSearch(await create()); await searches(); return get(o); }
const preservedKeys = ["_id", "customerToken", "customerTokenExpiresAt", "pickupCode", "deliveryCode",
  "destinationLocation", "pickupLocation", "routeDistanceMeters", "routeCalculatedAt", "routeProvider", "priceStatus",
  "goodsAmountAgorot", "deliveryFeeAgorot", "expectedCustomerCashAgorot", "platformCommissionAgorot", "driverEarningsAgorot"];
function preserved(a, b) { for (const key of preservedKeys) assert.deepEqual(b[key], a[key], key); }
function assertReleased(o, type) {
  assert.equal(o.activeAssignment, false); assert.equal(o.status, "searching_driver");
  assert.equal(o.driverSearchStatus, "searching"); assert.ok(o.searchDeadlineAt > o.searchStartedAt);
  assert.equal(events(o, type).length, 1); assert.equal(o.excludedDriverIds.length, 1);
}

test("T6-1 new searches persist server-controlled UTC deadlines", async () => {
  const o = await create({ searchStartedAt: "1990-01-01", searchDeadlineAt: "2099-01-01", driverSearchStatus: "no_driver" });
  const db = await get(o); assert.equal(db.driverSearchStatus, "searching");
  assert.equal(db.searchDeadlineAt - db.searchStartedAt, config.driverSearchTimeoutMs);
  assert.equal(events(db, "driver_search_started").length, 1);
  assert.ok(db.searchStartedAt.getFullYear() > 1990);
});
test("T6-2 driver accepts before deadline", async () => {
  const o = await accepted(); assert.equal(o.activeAssignment, true); assert.equal(o.driverSearchStatus, null);
});
test("T6-3 accept rejects expiry before sweeper runs", async () => {
  const o = await expireSearch(await create()); await post(o, "accept", d1(), {}, 409);
  assert.equal((await get(o)).driverSearchStatus, "searching");
});
test("T6-4 expiry explicitly records no_driver without cancelling", async () => {
  const o = await noDriver(); assert.equal(o.driverSearchStatus, "no_driver");
  assert.equal(o.status, "searching_driver"); assert.equal(events(o, "driver_search_timed_out").length, 1);
});
test("T6-5 expired offers disappear before sweeper", async () => {
  const o = await expireSearch(await create()); assert.ok(!(await offers()).some((a) => a._id === String(o._id)));
});
test("T6-6 twenty concurrent search processors emit one event; repeated sweep is inert", async () => {
  const o = await expireSearch(await create());
  const counts = await Promise.all(Array.from({ length: 20 }, () => searches()));
  assert.equal(counts.reduce((a,b) => a+b), 1); assert.equal(await searches(), 0);
  assert.equal(events(await get(o), "driver_search_timed_out").length, 1);
});
test("T6-7 own-store retry reuses order, admin may retry, unauthorized stores cannot", async () => {
  const o = await noDriver(); const old = o.searchDeadlineAt;
  const other = await User.create({ login: "other-store", name: "Other", role: "store", passwordHash: "unused" });
  const jwt = (await import("jsonwebtoken")).default;
  const token = jwt.sign({ sub: String(other._id) }, config.jwtSecret, { expiresIn: "1h" });
  await post(o, "retry-search", token, {}, 404); await post(o, "cancel", token, {}, 404);
  const retried = (await post(o, "retry-search", store())).data;
  assert.equal(retried._id, String(o._id)); assert.ok(new Date(retried.searchDeadlineAt) > old);
  assert.equal(await Order.countDocuments(), 1);
  await expireSearch(o); await searches(); await post(o, "retry-search", sessions.admin.token);
});
test("T6-8 store cancels no_driver or unassigned search; assigned cancel rejected", async () => {
  const o = await noDriver(); await post(o, "cancel", store());
  assert.equal((await get(o)).status, "cancelled"); await post(o, "retry-search", store(), {}, 409);
  await post(await create(), "cancel", store());
  await post(await accepted(), "cancel", store(), {}, 409);
});
test("T6-9 accept records server acceptedAt and arrival deadline", async () => {
  const o = await accepted(); assert.ok(o.acceptedAt instanceof Date);
  assert.equal(o.storeArrivalDeadlineAt - o.acceptedAt, config.driverArrivalTimeoutMs);
});
test("T6-10 arrive-store records server timestamp and event", async () => {
  const o = await accepted(); const before = Date.now();
  await post(o, "arrive-store", d1(), { arrivedStoreAt: "1990-01-01" });
  const db = await get(o); assert.ok(db.arrivedStoreAt.getTime() >= before);
  assert.equal(events(db, "driver_arrived_store").length, 1);
});
test("T6-11 arrival protects assignment when deadline later expires", async () => {
  const o = await accepted(); await post(o, "arrive-store");
  assert.equal(await assignments(new Date(o.storeArrivalDeadlineAt.getTime()+1)), 0);
  assert.equal((await get(o)).activeAssignment, true);
});
test("T6-12 arrival timeout releases assignment, preserves driver identity and frees current", async () => {
  const o = await expiredAssignment(); await assignments(); const db = await get(o);
  assertReleased(db, "driver_assignment_timed_out"); assert.deepEqual(db.driverId, o.driverId);
  assert.equal((await request("/driver/orders/current", d1())).data, null);
});
test("T6-13 timeout returns same order to search", async () => {
  const o = await expiredAssignment(); await assignments();
  assert.equal(await Order.countDocuments(), 1); assertReleased(await get(o), "driver_assignment_timed_out");
});
test("T6-14 timeout creates a fresh server search window", async () => {
  const o = await expiredAssignment(); const now = new Date(); await assignments(now); const db = await get(o);
  assert.deepEqual(db.searchStartedAt, now); assert.equal(db.searchDeadlineAt-now, config.driverSearchTimeoutMs);
});
test("T6-15 twenty concurrent assignment processors release once", async () => {
  const o = await expiredAssignment(); const now = new Date();
  const counts = await Promise.all(Array.from({ length: 20 }, () => assignments(now)));
  assert.equal(counts.reduce((a,b) => a+b), 1); assert.equal(await assignments(now), 0);
  assertReleased(await get(o), "driver_assignment_timed_out");
});
test("T6-16 repeated arrival vs timeout races never mix arrival and expired release", async () => {
  for (let i=0;i<20;i++) {
    await resetOrderActionLimits(User);
    const o = await expiredAssignment();
    const arrive = () => post(o, "arrive-store", d1(), {}, null);
    const [a] = i%2 ? await Promise.all([arrive(), assignments()]) : (await Promise.all([assignments(), arrive()])).reverse();
    assert.ok([200,404,409].includes(a.status)); const db = await get(o);
    if (db.arrivedStoreAt) { assert.equal(db.activeAssignment,true); assert.equal(events(db,"driver_assignment_timed_out").length,0); }
    else { assertReleased(db,"driver_assignment_timed_out"); await post(o,"arrive-store",d1(),{},404); }
    await Order.deleteMany({});
  }
});
test("T6-17 repeated accept vs search-timeout races yield assigned or no_driver exclusively", async () => {
  for (let i=0;i<20;i++) {
    await resetOrderActionLimits(User);
    const o = await get(await create()); const boundary = new Date(o.searchDeadlineAt);
    const accept = () => assignOrder(o,sessions.driver1.user._id,true,new Date(boundary.getTime()-(i%2)));
    await Promise.allSettled(i%2 ? [accept(),searches(boundary)] : [searches(boundary),accept()]);
    const db = await get(o);
    if (db.activeAssignment) { assert.equal(db.status,"driver_assigned"); assert.equal(db.driverSearchStatus,null); }
    else { assert.equal(db.driverSearchStatus,"no_driver"); assert.equal(events(db,"driver_assigned").length,0); }
    await Order.deleteMany({});
  }
});
test("T6-18 a fresh Node process processes persisted deadlines without process memory", async () => {
  const o = await expiredAssignment();
  const modulePath = new URL("../src/services/orderTimeouts.js",import.meta.url).href;
  const modelsPath = new URL("../src/models/index.js",import.meta.url).href;
  const child = spawn(process.execPath,["--input-type=module","-e",`const m=await import(${JSON.stringify(modelsPath)}); await m.connectDatabase(); const s=await import(${JSON.stringify(modulePath)}); await s.runTimeoutSweep(); await m.Order.db.close();`],{env:process.env,stdio:["ignore","pipe","pipe"]});
  let stderr=""; child.stderr.on("data",b=>{stderr+=b;});
  const [code]=await once(child,"exit"); assert.equal(code,0,stderr);
  assertReleased(await get(o),"driver_assignment_timed_out");
});
test("T6-19 withdrawal before pickup from assigned or arrived works", async () => {
  for (const arrived of [false,true]) {
    const o = await accepted(); if(arrived) await post(o,"arrive-store");
    await post(o,"withdraw",d1(),{reason:"details_changed"}); const db=await get(o);
    assertReleased(db,"driver_withdrawn"); const e=events(db,"driver_withdrawn")[0];
    assert.equal(e.reason,"details_changed"); assert.equal(String(e.actorId),sessions.driver1.user._id);
  }
});
test("T6-20 withdrawal validates enum, bounded optional other note, no operator injection", async () => {
  const o=await accepted();
  for(const body of [{},{reason:"invalid"},{reason:{$ne:null}},{reason:"other",note:"x".repeat(301)},{reason:"cannot_complete",note:"text"}])
    await post(o,"withdraw",d1(),body,400);
  await post(o,"withdraw",d1(),{reason:"other",note:"short note"});
  assert.equal(events(await get(o),"driver_withdrawn")[0].note,"short note");
});
test("T6-20b a driver reports the store is not ready: the store sees it, the driver keeps the order, repeats are no-ops", async () => {
  const o = await accepted();
  for (const body of [{}, { reason: "other" }, { reason: { $ne: null } }, { reason: "store_not_ready", note: "x" }])
    await post(o, "report-issue", d1(), body, 400);
  await post(o, "report-issue", d2(), { reason: "store_not_ready" }, 404);
  await request(`/orders/${o._id}/report-issue`, null, "POST", { reason: "store_not_ready" }, 401);
  for (let i = 0; i < 3; i++) await post(o, "report-issue", d1(), { reason: "store_not_ready" });
  const db = await get(o);
  assert.equal(events(db, "driver_issue_reported").length, 1);
  assert.equal(events(db, "driver_issue_reported")[0].reason, "store_not_ready");
  assert.equal(String(events(db, "driver_issue_reported")[0].actorId), sessions.driver1.user._id);
  assert.equal(db.activeAssignment, true); assert.equal(db.status, "driver_assigned");
  await post(o, "arrive-store"); await post(o, "report-issue", d1(), { reason: "store_not_ready" });
  assert.equal(events(await get(o), "driver_issue_reported").length, 1, "same assignment, same reason: still one event");
});
test("T6-20c the issue report is only for an active assignment before pickup", async () => {
  const done = await create(); await pickedUp(done);
  await post(done, "report-issue", d1(), { reason: "store_not_ready" }, 409);
  const o = await create();
  await post(o, "report-issue", d1(), { reason: "store_not_ready" }, 404);
});
test("T6-21 another driver cannot withdraw someone else's assignment", async () => {
  const o=await accepted(); await post(o,"withdraw",d2(),{reason:"cannot_complete"},404);
  await request(`/orders/${o._id}/withdraw`,null,"POST",{reason:"other"},401);
});
test("T6-22 withdrawal after pickup cannot bypass delivery-failure/return", async () => {
  const o=await create(); await pickedUp(o); await post(o,"withdraw",d1(),{reason:"cannot_complete"},409);
  assert.equal((await get(o)).status,"collected"); await post(o,"retry-search",store(),{},409);
});
test("T6-23 withdrawn driver cannot see the same offer", async () => {
  const o=await accepted(); await post(o,"withdraw",d1(),{reason:"order_incomplete"});
  assert.ok(!(await offers()).some(a=>a._id===String(o._id)));
});
test("T6-24 withdrawn driver cannot directly reaccept", async () => {
  const o=await accepted(); await post(o,"withdraw",d1(),{reason:"other"}); await post(o,"accept",d1(),{},409);
});
test("T6-25 timed-out driver cannot see or retake the order", async () => {
  const o=await expiredAssignment(); await assignments(); await post(o,"accept",d1(),{},409);
  assert.ok(!(await offers()).some(a=>a._id===String(o._id)));
});
test("T6-26 different driver accepts after withdrawal and timeout with clean arrival evidence", async () => {
  for(const timeout of [true,false]) {
    const o=timeout?await expiredAssignment():await accepted();
    if(timeout) await assignments(); else { await post(o,"arrive-store"); await post(o,"withdraw",d1(),{reason:"details_changed"}); }
    assert.ok((await offers(d2())).some(a=>a._id===String(o._id)));
    await post(o,"accept",d2()); const db=await get(o); assert.equal(String(db.driverId),sessions.driver2.user._id);
    assert.equal(db.arrivedStoreAt,undefined); await Order.deleteMany({});
  }
});
test("T6-27 arrive-customer saves server time and event", async () => {
  const o=await create(); await pickedUp(o); const before=Date.now();
  await post(o,"arrive-customer",d1(),{arrivedCustomerAt:"1990-01-01"});
  const db=await get(o); assert.ok(db.arrivedCustomerAt.getTime()>=before);
  assert.equal(events(db,"driver_arrived_customer").length,1);
});
test("T6-28 previous driver immediately loses PII on timeout or withdrawal and reassignment", async () => {
  for(const timeout of [true,false]) {
    const o=timeout?await expiredAssignment():await accepted();
    if(timeout) await assignments(); else {
      const result=await post(o,"withdraw",d1(),{reason:"other"});
      for(const field of ["customerPhone","recipientName","destinationLocation","events","customerToken","confirmationSnapshot"])
        assert.equal(result.data[field],undefined,field);
    }
    await request(`/orders/${o._id}`,d1(),"GET",undefined,404);
    await post(o,"confirm",d1(),{},404); await post(o,"accept",d2());
    await request(`/orders/${o._id}`,d1(),"GET",undefined,404); await Order.deleteMany({});
  }
});
test("T6-29 retry and timeout never extend expiry or restore revoked customer links", async () => {
  const o=await noDriver(); const token=o.customerToken;
  await Order.updateOne({_id:o._id},{$set:{customerTokenExpiresAt:new Date(Date.now()-1000)}});
  await post(o,"retry-search",store()); await request(`/customer/${token}`,null,"GET",undefined,404);
  const reissued=(await post(o,"customer-link/reissue",store())).data.customerLink.split("/").at(-1);
  await post(o,"accept"); await Order.updateOne({_id:o._id},{$set:{storeArrivalDeadlineAt:new Date(0)}});
  await assignments(); await request(`/customer/${token}`,null,"GET",undefined,404);
  await request(`/customer/${reissued}`); await post(o,"cancel",store());
  const closed=(await request(`/customer/${reissued}`)).data;
  assert.equal(closed.canEdit,false); assert.equal(closed.recipientName,undefined);
  await request(`/customer/${reissued}/confirm`,null,"POST",{},409);
});
test("T6-30 retry retains final valid route, location, price, codes and link", async () => {
  const o=await create(); await confirm(tokenOf(o)); const before=await get(o);
  await expireSearch(o); await searches(); await post(o,"retry-search",store()); preserved(before,await get(o));
});
test("T6-31 withdrawal retains valid route/location/pricing and link", async () => {
  const o=await create(); await confirm(tokenOf(o)); await post(o,"accept"); const before=await get(o);
  await post(o,"withdraw",d1(),{reason:"details_changed"}); preserved(before,await get(o));
});
test("T6-32 normal accept/arrival/pickup/customer-arrival/delivery remains intact", async () => {
  const o=await create(); await pickedUp(o); const collected=await get(o);
  await runTimeoutSweep(new Date(collected.storeArrivalDeadlineAt.getTime()+1));
  assert.equal((await get(o)).activeAssignment,true); await post(o,"arrive-customer"); const db=await get(o);
  await post(o,"deliver",d1(),{code:db.deliveryCode,actualCashCollectedAgorot:db.expectedCustomerCashAgorot,observedExpectedAgorot:db.expectedCustomerCashAgorot});
  assert.equal((await get(o)).status,"delivered"); await post(o,"retry-search",store(),{},409);
});
test("T6-33 repeated withdraw vs timeout races release once and create one search window", async () => {
  for(let i=0;i<20;i++) {
    await resetOrderActionLimits(User);
    const o=await expiredAssignment(); const now=new Date();
    await Promise.all([post(o,"withdraw",d1(),{reason:"other"},null),assignments(now)]);
    const db=await get(o); assert.equal(db.activeAssignment,false); assert.equal(db.driverSearchStatus,"searching");
    assert.equal(events(db,"driver_withdrawn").length+events(db,"driver_assignment_timed_out").length,1);
    assert.equal(db.searchDeadlineAt-db.searchStartedAt,config.driverSearchTimeoutMs); await Order.deleteMany({});
  }
});
test("T6-34 repeated retry vs cancel races leave searchable or cancelled exclusively", async () => {
  for(let i=0;i<20;i++) {
    await resetOrderActionLimits(User);
    const o=await noDriver(); await Promise.all([post(o,"retry-search",store(),{},null),post(o,"cancel",store(),{},null)]);
    const db=await get(o); const visible=(await offers()).some(a=>a._id===String(o._id));
    if(db.status==="cancelled") { assert.equal(visible,false); assert.equal(db.driverSearchStatus,null); }
    else { assert.equal(db.driverSearchStatus,"searching"); assert.equal(visible,true); }
    assert.ok(events(db,"driver_search_retried").length<=1); assert.ok(events(db,"store_cancelled").length<=1);
  }
});
test("T6-35 released driver is free to accept another order", async () => {
  const o=await expiredAssignment(); await assignments(); const next=await create(); await post(next,"accept");
  assert.equal((await request("/driver/orders/current",d1())).data._id,next._id);
});
test("legacy deadline migration is resumable, derives old evidence and worker startup recovers", async () => {
  const o=await accepted(); const old=new Date(Date.now()-config.driverArrivalTimeoutMs-1000);
  await Order.collection.updateOne({_id:o._id},{$unset:{storeArrivalDeadlineAt:"",acceptedAt:""},$set:{updatedAt:old}});
  assert.equal(await initializeLegacyDeadlines(),1); assert.equal(await initializeLegacyDeadlines(),0);
  assert.deepEqual((await get(o)).acceptedAt,old); await restart();
  for(let i=0;i<100&&(await get(o)).activeAssignment;i++) await new Promise(r=>setTimeout(r,20));
  assertReleased(await get(o),"driver_assignment_timed_out");
});
test("deadline queries have targeted indexes, original unique assignment index remains", async () => {
  const indexes=await Order.collection.indexes();
  for(const name of ["driver_search_deadline","driver_arrival_deadline","one_active_order_per_driver"])
    assert.ok(indexes.some(i=>i.name===name));
  const plan=await Order.find({status:"searching_driver",activeAssignment:false,driverSearchStatus:"searching",searchDeadlineAt:{$lte:new Date()}}).hint("driver_search_deadline").explain();
  assert.ok(JSON.stringify(plan.queryPlanner.winningPlan).includes("IXSCAN"));
});
test("legacy searches use original createdAt, migrate once and expire; terminal orders stay closed", async () => {
  const o=await create(); const old=new Date(Date.now()-config.driverSearchTimeoutMs-1000);
  await Order.collection.updateOne({_id:(await get(o))._id},{$unset:{searchDeadlineAt:"",searchStartedAt:"",driverSearchStatus:""},$set:{createdAt:old}});
  assert.equal(await initializeLegacyDeadlines(),1); assert.equal(await initializeLegacyDeadlines(),0);
  assert.deepEqual((await get(o)).searchStartedAt,old); await searches();
  assert.equal((await get(o)).driverSearchStatus,"no_driver"); await post(o,"cancel",store());
  await Order.collection.updateOne({_id:(await get(o))._id},{$unset:{searchDeadlineAt:""}});
  assert.equal(await initializeLegacyDeadlines(),0); await post(o,"retry-search",store(),{},409);
});
test("retained historical driverId does not block deactivating a released driver", async () => {
  const o=await expiredAssignment(); await assignments(); const driverId=sessions.driver1.user._id;
  await request(`/admin/accounts/${driverId}`,sessions.admin.token,"PATCH",{active:false});
  await request(`/admin/accounts/${driverId}`,sessions.admin.token,"PATCH",{active:true});
  await relogin("driver1");
});
