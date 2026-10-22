import { resetOrderActionLimits } from "./helpers/offerLocations.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { models, sessions, request, create as baseCreate, tokenOf, confirm, pickedUp, restart, relogin, destination } from "./helpers/security.js";
const { Order, User } = models;
const create = (extra={}) => baseCreate({serviceArea:"kafr-kanna",...extra});
const store=()=>sessions.store1.token, admin=()=>sessions.admin.token, d1=()=>sessions.driver1.token, d2=()=>sessions.driver2.token;
const driverId=(n=1)=>sessions[`driver${n}`].user._id;
const db=(o)=>Order.findById(o._id).lean();
const offers=async(token=d1())=>(await request("/driver/orders/available",token)).data;
const post=(o,action,token=d1(),body={},status=200)=>request(`/orders/${o._id}/${action}`,token,"POST",body,status);
const available=(value,token=d1(),status=200)=>request("/driver/availability",token,"PATCH",{available:value},status);
const areas=(values,n=1,token=admin(),status=200)=>request(`/admin/accounts/${driverId(n)}`,token,"PATCH",{serviceAreas:values},status);
// A quick order reaches drivers once its customer placed it, confirmed the total and is ready now.
async function quickReady(body) {
  const o=(await request("/orders",store(),"POST",{workflowVersion:2,storeAuthorization:true,serviceArea:"kafr-kanna",...body},201)).data;
  const token=tokenOf(o); await request(`/customer/${token}/location`,null,"POST",destination);
  const c=(await request(`/customer/${token}`)).data;
  await request(`/customer/${token}/confirm`,null,"POST",{recipientName:"Customer",customerPhone:"0501234567",available:true,observed:c.confirmationSnapshot});
  return o;
}
async function ready(n=1) { await areas(["kafr-kanna"],n); await available(true,sessions[`driver${n}`].token); }
async function assigned() { await ready(); const o=await create(); await post(o,"accept"); return o; }
async function complete(o) {
  await post(o,"arrive-customer"); const value=await db(o);
  await post(o,"deliver",d1(),{code:value.deliveryCode,actualCashCollectedAgorot:value.expectedCustomerCashAgorot,observedExpectedAgorot:value.expectedCustomerCashAgorot});
}

test("T7-1 new driver defaults unavailable with no granted areas",async()=>{
  const result=await request("/admin/accounts",admin(),"POST",{role:"driver",name:"New driver",login:"new-driver",password:"NewDriver123!"},201);
  assert.equal(result.data.availableForOrders,false); assert.deepEqual(result.data.serviceAreas,[]);
});
test("T7-2 driver sets own availability true and it persists across restart",async()=>{
  const result=await available(true); assert.equal(result.data.availableForOrders,true);
  await restart(); assert.equal((await request("/auth/me",d1())).data.availableForOrders,true);
});
test("T7-3 driver sets availability false",async()=>{
  await available(true); assert.equal((await available(false)).data.availableForOrders,false);
});
test("T7-4 availability endpoint requires authenticated driver",async()=>{
  for(const token of [admin(),store()]) await available(true,token,403);
  await available(true,null,401);
});
test("T7-5 availability endpoint cannot target another driver or edit areas",async()=>{
  await available(false,d2());
  for(const extra of [{driverId:driverId(2)},{serviceAreas:["kafr-kanna"]},{active:true},{availableForOrders:true}])
    await request("/driver/availability",d1(),"PATCH",{available:true,...extra},400);
  await request(`/driver/${driverId(2)}/availability`,d1(),"PATCH",{available:true},404);
  assert.equal((await User.findById(driverId(2)).lean()).availableForOrders,false);
});
test("T7-6 unavailable driver receives zero offers",async()=>{
  await ready(); await create(); await available(false); assert.deepEqual(await offers(),[]);
});
test("T7-7 unavailable driver cannot directly accept",async()=>{
  await ready(); const o=await create(); await available(false); await post(o,"accept",d1(),{},409);
});
test("T7-8 available correct-area driver sees eligible offer",async()=>{
  await ready(); const o=await create(); assert.ok((await offers()).some(a=>a._id===o._id));
});
test("T7-9 availability OFF never releases active assignment",async()=>{
  const o=await assigned(); await available(false); assert.equal((await db(o)).activeAssignment,true);
});
test("T7-10 unavailable driver retains current/detail access",async()=>{
  const o=await assigned(); await available(false);
  assert.equal((await request("/driver/orders/current",d1())).data._id,o._id);
  assert.equal((await request(`/orders/${o._id}`,d1())).data._id,o._id);
});
test("T7-11 availability ON while busy still yields zero offers and no second accept",async()=>{
  const o=await assigned(); const next=await create(); await available(true);
  assert.deepEqual(await offers(),[]); await post(next,"accept",d1(),{},409); assert.equal((await db(o)).activeAssignment,true);
});
test("T7-12 completion preserves ON preference and restores next offers",async()=>{
  await ready(); const o=await create(); await pickedUp(o); const next=await create(); await complete(o);
  assert.equal((await request("/auth/me",d1())).data.availableForOrders,true);
  assert.ok((await offers()).some(a=>a._id===next._id));
});
test("T7-13 admin assigns supported canonical areas",async()=>{
  assert.deepEqual((await areas(["kafr-kanna"])).data.serviceAreas,["kafr-kanna"]);
});
test("T7-14 driver cannot self-assign areas",async()=>{
  await areas([],1); await areas(["kafr-kanna"],1,d1(),403);
  await request("/driver/availability",d1(),"PATCH",{available:true,serviceAreas:["kafr-kanna"]},400);
  assert.deepEqual((await User.findById(driverId()).lean()).serviceAreas,[]);
});
test("T7-15 unknown/noncanonical/nested/unbounded service areas are rejected",async()=>{
  for(const value of [["unknown-area"],[""],["كفركنا"],["כפר כנא"],["Kafr Kanna"],"kafr-kanna",[{}],null,Array(100).fill("kafr-kanna")])
    await areas(value,1,admin(),400);
});
test("T7-16 duplicate areas are rejected",async()=>{
  await areas(["kafr-kanna","kafr-kanna"],1,admin(),400);
});
test("T7-17 empty serviceAreas means zero offers",async()=>{
  await ready(); await areas([]); await create(); assert.deepEqual(await offers(),[]);
});
test("T7-18 Kafr Kanna driver sees Kafr Kanna order",async()=>{
  await ready(); const o=await create(); assert.equal((await offers())[0]._id,o._id);
});
test("T7-19 wrong-area driver does not see offer",async()=>{
  await ready(); await areas([]); await create(); assert.deepEqual(await offers(),[]);
});
test("T7-20 wrong-area direct accept rejected",async()=>{
  await ready(); const o=await create(); await areas([]); await post(o,"accept",d1(),{},409);
});
test("T7-21 admin removal affects future offers immediately without restart",async()=>{
  await ready(); await create(); assert.equal((await offers()).length,1);
  await areas([]); assert.deepEqual(await offers(),[]); await ready(); assert.equal((await offers()).length,1);
});
test("T7-22 area removal during assignment preserves current access",async()=>{
  const o=await assigned(); await areas([]);
  assert.equal((await request("/driver/orders/current",d1())).data._id,o._id);
  await post(o,"arrive-store"); assert.equal((await db(o)).activeAssignment,true);
});
test("T7-23 new searchable orders store canonical serviceArea",async()=>{
  const o=await create(); assert.equal((await db(o)).serviceArea,"kafr-kanna"); assert.equal(o.status,"searching_driver");
});
test("T7-24 unsupported order service area rejected",async()=>{
  for(const value of ["unknown-area","כפר כנא","كفركنا",{$ne:null}])
    await request("/orders",store(),"POST",{area:"Kafr Kanna",serviceArea:value,deliveryFeePaidBy:"customer"},400);
});
test("T7-25 missing order serviceArea fails validation; legacy missing area never broadcasts",async()=>{
  await request("/orders",store(),"POST",{area:"Kafr Kanna"},422);
  await ready(); const o=await create(); await Order.collection.updateOne({_id:(await db(o))._id},{$unset:{serviceArea:""}});
  assert.deepEqual(await offers(),[]); await post(o,"accept",d1(),{},409);
});
test("T7-26 canonical serviceArea remains independent from human-readable address",async()=>{
  const o=await create({area:"Human district / 123",finalAddress:"Other address"});
  assert.equal(o.serviceArea,"kafr-kanna"); assert.equal(o.area,"Human district / 123"); assert.equal(o.finalAddress,"Other address");
});
test("T7-27 no canonical area is inferred from address substrings or coordinates",async()=>{
  for(const text of ["Kafr Kanna center","كفركنا شارع السوق","כפר כנא"])
    await request("/orders",store(),"POST",{area:text,finalAddress:text},422);
});
test("T7-28 active available area-matched free driver is eligible",async()=>{
  await ready(); const o=await create(); await post(o,"accept"); assert.equal((await db(o)).activeAssignment,true);
});
test("T7-29 inactive account cannot get offers or accept",async()=>{
  await ready(); const o=await create(); await request(`/admin/accounts/${driverId()}`,admin(),"PATCH",{active:false});
  await request("/driver/orders/available",d1(),"GET",undefined,401); await post(o,"accept",d1(),{},401);
  await request(`/admin/accounts/${driverId()}`,admin(),"PATCH",{active:true});
  await request("/auth/me",d1(),"GET",undefined,401); // reactivation does not revive a revoked session
  await relogin("driver1");
});
test("T7-30 missing/invalid availability fails closed",async()=>{
  await ready(); const o=await create(); await User.collection.updateOne({_id:(await User.findById(driverId()))._id},{$unset:{availableForOrders:""}});
  assert.deepEqual(await offers(),[]); await post(o,"accept",d1(),{},409);
});
test("T7-31 persisted invalid area data fails closed",async()=>{
  await ready(); const o=await create(); await User.collection.updateOne({_id:(await User.findById(driverId()))._id},{$set:{serviceAreas:["unknown-area","kafr-kanna"]}});
  assert.deepEqual(await offers(),[]); await post(o,"accept",d1(),{},409);
});
test("T7-32 busy driver cannot receive another offer",async()=>{
  await assigned(); await create(); assert.deepEqual(await offers(),[]);
});
test("T7-33 STEP 6 exclusion still prevents offers and accept",async()=>{
  const o=await assigned(); await post(o,"withdraw",d1(),{reason:"other"});
  assert.deepEqual(await offers(),[]); await post(o,"accept",d1(),{},409);
});
test("T7-34 expired searches remain hidden and unacceptable",async()=>{
  await ready(); const o=await create(); await Order.updateOne({_id:o._id},{$set:{searchDeadlineAt:new Date(0)}});
  assert.deepEqual(await offers(),[]); await post(o,"accept",d1(),{},409);
});
test("T7-35 no_driver is ineligible until retry",async()=>{
  await ready(); const o=await create(); await Order.updateOne({_id:o._id},{$set:{driverSearchStatus:"no_driver"}});
  assert.deepEqual(await offers(),[]); await post(o,"accept",d1(),{},409);
  await post(o,"retry-search",store()); assert.equal((await offers())[0]._id,o._id);
});
test("T7-36 already assigned order is hidden and cannot be taken",async()=>{
  const o=await assigned(); await ready(2); assert.deepEqual(await offers(d2()),[]); await post(o,"accept",d2(),{},409);
});
test("T7-37 offer remains PII-free with nested data checked",async()=>{
  await ready(); const o=await create(); await confirm(tokenOf(o)); const value=(await offers())[0];
  const forbidden=["customerPhone","recipientName","finalAddress","preliminaryAddress","destinationLocation","customerToken","customerLink","deliveryCode","pickupCode","confirmationSnapshot","events","lat","lng"];
  function check(v) { if(!v||typeof v!=="object")return; for(const [key,item]of Object.entries(v)){assert.ok(!forbidden.includes(key),key);check(item);} }
  check(value); assert.equal(value.serviceArea,"kafr-kanna");
});
test("T7-38 wrong-area driver cannot retrieve hidden customer data",async()=>{
  await ready(); const o=await create(); await areas([]); await request(`/orders/${o._id}`,d1(),"GET",undefined,404);
});
test("T7-39 direct accept re-reads fresh availability rather than old login data",async()=>{
  await ready(); const o=await create(); assert.equal((await offers()).length,1); await available(false); await post(o,"accept",d1(),{},409);
});
test("T7-40 admin service-area management requires existing admin auth",async()=>{
  await areas(["kafr-kanna"],1,null,401); await areas(["kafr-kanna"],1,d2(),403);
});
test("T7-41 store cannot edit driver eligibility",async()=>{
  await areas(["kafr-kanna"],1,store(),403); await available(true,store(),403);
});
test("T7-42 customer link security/confirmation survives eligibility changes",async()=>{
  const o=await assigned(); await available(false); await areas([]); await confirm(tokenOf(o));
  assert.equal((await request(`/customer/${tokenOf(o)}`)).data.customerConfirmed,true);
  const replacement=(await post(o,"customer-link/reissue",store())).data;
  await request(`/customer/${tokenOf(o)}`,null,"GET",undefined,404);
  assert.ok(replacement.customerLink);
});
test("T7-43 twenty eligible drivers concurrently accept one order",async()=>{
  const jwt=(await import("jsonwebtoken")).default; const {config}=await import("../src/config.js");
  const tokens=[];
  for(let i=0;i<20;i++) {
    await resetOrderActionLimits(User);
    const u=await User.create({role:"driver",active:true,availableForOrders:true,serviceAreas:["kafr-kanna"],name:`Race ${i}`,login:`race-${i}`,passwordHash:"unused"});
    tokens.push(jwt.sign({},config.jwtSecret,{subject:String(u._id),expiresIn:"1h"}));
  }
  const o=await create(); const results=await Promise.all(tokens.map(token=>post(o,"accept",token,{},null)));
  assert.equal(results.filter(r=>r.status===200).length,1); assert.equal(await Order.countDocuments({activeAssignment:true}),1);
  assert.equal((await db(o)).events.filter(e=>e.type==="driver_assigned").length,1);
});
test("T7-44 repeated availability-OFF vs accept races retain one valid assignment outcome",async()=>{
  for(let i=0;i<20;i++) {
    await resetOrderActionLimits(User);
    await ready(); const o=await create(); const [accepted]=await Promise.all([post(o,"accept",d1(),{},null),available(false)]);
    const value=await db(o); assert.equal(value.activeAssignment,accepted.status===200);
    assert.ok([200,409].includes(accepted.status)); assert.equal(await Order.countDocuments({driverId:driverId(),activeAssignment:true}),accepted.status===200?1:0);
    if(value.activeAssignment) assert.equal((await request("/driver/orders/current",d1())).data._id,o._id);
    await Order.deleteMany({});
  }
});
test("T7-45 repeated admin-area-removal vs accept races retain valid current assignment",async()=>{
  for(let i=0;i<20;i++) {
    await resetOrderActionLimits(User);
    await ready(); const o=await create(); const [accepted]=await Promise.all([post(o,"accept",d1(),{},null),areas([])]);
    const value=await db(o); assert.equal(value.activeAssignment,accepted.status===200);
    assert.ok([200,409].includes(accepted.status)); assert.deepEqual(await offers(),[]);
    if(value.activeAssignment) await request(`/orders/${o._id}`,d1());
    await Order.deleteMany({});
  }
});
test("T7-46 STEP 6 timeout and retry permit another eligible driver",async()=>{
  const o=await assigned(); await ready(2); const {runTimeoutSweep}=await import("../src/services/orderTimeouts.js");
  await Order.updateOne({_id:o._id},{$set:{storeArrivalDeadlineAt:new Date(0)}}); await runTimeoutSweep();
  await Order.updateOne({_id:o._id},{$set:{searchDeadlineAt:new Date(0)}}); await runTimeoutSweep(); await post(o,"retry-search",store());
  await post(o,"accept",d2()); assert.equal(String((await db(o)).driverId),driverId(2));
});
test("T7-47 excluded previous driver remains excluded after another search retry",async()=>{
  const o=await assigned(); await post(o,"withdraw",d1(),{reason:"other"});
  await Order.updateOne({_id:o._id},{$set:{driverSearchStatus:"no_driver"}}); await post(o,"retry-search",store());
  assert.deepEqual(await offers(),[]); await post(o,"accept",d1(),{},409);
});
test("T7-48 unavailable driver finishes all current-order actions normally",async()=>{
  await ready(); const o=await create(); await confirm(tokenOf(o)); await post(o,"accept");
  for(const actor of [store(),d1()]) { const value=(await request(`/orders/${o._id}`,actor)).data; await post(o,"confirm",actor,{observed:value.confirmationSnapshot}); }
  await available(false); await request(`/orders/${o._id}`,d1()); await post(o,"arrive-store");
  await post(o,"pickup",d1(),{code:o.pickupCode}); await complete(o);
  assert.equal((await db(o)).status,"delivered"); assert.equal((await request("/auth/me",d1())).data.availableForOrders,false);
});
test("T7-49 area removal preserves current pickup/delivery and STEP 6 withdrawal/return",async()=>{
  await ready(); const o=await create(); await pickedUp(o); await areas([]); await available(false);
  await post(o,"fail",d1(),{reason:"isolated failed delivery"}); await request(`/admin/orders/${o._id}/authorize-return`,admin(),"POST",{}); await post(o,"confirm-return",store());
  assert.equal((await db(o)).status,"returned");
  const next=await assigned(); await areas([]); await available(false); await post(next,"withdraw",d1(),{reason:"cannot_complete"});
  assert.equal((await db(next)).activeAssignment,false);
});
test("T7-50 next-order eligibility uses current preference/areas after release",async()=>{
  const o=await assigned(); const next=await create(); await available(false); await areas([]);
  await post(o,"withdraw",d1(),{reason:"other"}); assert.deepEqual(await offers(),[]);
  await available(true); assert.deepEqual(await offers(),[]); await areas(["kafr-kanna"]);
  assert.ok((await offers()).some(a=>a._id===next._id)); await post(next,"accept");
});
test("strict availability boolean input and persisted UTC timestamp",async()=>{
  for(const value of ["true",1,null,{},[],"false"]) await available(value,d1(),400);
  const before=Date.now(); const result=await available(true);
  assert.ok(new Date(result.data.availabilityUpdatedAt).getTime()>=before);
});
test("legacy order classification is explicit, ownership checked, and preserves pricing/location",async()=>{
  await ready(); const o=await create(); await confirm(tokenOf(o));
  await Order.collection.updateOne({_id:(await db(o))._id},{$unset:{serviceArea:""}});
  const before=await db(o), view=(await request(`/orders/${o._id}`,store())).data;
  const edited=(await request(`/orders/${o._id}`,store(),"PATCH",{observed:view.confirmationSnapshot,serviceArea:"kafr-kanna"})).data;
  assert.equal(edited.serviceArea,"kafr-kanna"); const after=await db(o);
  for(const key of ["routeDistanceMeters","deliveryFeeAgorot","destinationLocation","pickupLocation","customerToken","searchDeadlineAt","customerConfirmed"]) assert.deepEqual(after[key],before[key],key);
  assert.equal((await offers())[0]._id,o._id);
});
test("legacy order correction cannot change active assignment or bypass area validation",async()=>{
  const o=await assigned(); await Order.collection.updateOne({_id:(await db(o))._id},{$unset:{serviceArea:""}});
  const view=(await request(`/orders/${o._id}`,store())).data;
  await request(`/orders/${o._id}`,store(),"PATCH",{observed:view.confirmationSnapshot,serviceArea:"kafr-kanna"},409);
  await request(`/orders/${o._id}`,store(),"PATCH",{observed:view.confirmationSnapshot,serviceArea:"other"},400);
});

test("retry requires a valid canonical area and never renews an unclassified search", async () => {
  for (const serviceArea of [undefined, "unknown-area"]) {
    const o = await create();
    const old = await db(o);
    await Order.collection.updateOne({ _id: old._id }, {
      $set: { driverSearchStatus: "no_driver", ...(serviceArea ? { serviceArea } : {}) },
      ...(!serviceArea ? { $unset: { serviceArea: "" } } : {}),
    });
    const result = await post(o, "retry-search", store(), {}, serviceArea ? 400 : 422);
    assert.equal(result.data.code, serviceArea ? "invalid_service_area" : "service_area_required");
    const after = await db(o);
    assert.equal(after.driverSearchStatus, "no_driver");
    assert.deepEqual(after.searchDeadlineAt, old.searchDeadlineAt);
    assert.equal(after.events.filter(e => e.type === "driver_search_retried").length, 0);
  }
});

test("admin cannot assign an expired or stopped unassigned search before retry", async () => {
  await ready();
  for (const changes of [{ searchDeadlineAt: new Date(0) }, { driverSearchStatus: "no_driver" }]) {
    const o = await create();
    await Order.updateOne({ _id: o._id }, { $set: changes });
    await request(`/admin/orders/${o._id}/assign`, admin(), "POST", { driverId: driverId() }, 409);
    assert.equal((await db(o)).activeAssignment, false);
  }
});

test("admin assignment also checks availability and service-area grants", async () => {
  await ready();
  const o = await create();
  await available(false);
  await request(`/admin/orders/${o._id}/assign`, admin(), "POST", { driverId: driverId() }, 409);
  await available(true); await areas([]);
  await request(`/admin/orders/${o._id}/assign`, admin(), "POST", { driverId: driverId() }, 409);
  assert.equal((await db(o)).activeAssignment, false);
});

test("twenty concurrent orders for one eligible driver preserve the unique active-assignment index", async () => {
  await ready();
  const orders = [];
  // Set up fixtures separately from the concurrent accept/uniqueness assertion.
  for (let i = 0; i < 20; i++) { await resetOrderActionLimits(User); orders.push(await create()); }
  const accepted = await Promise.all(orders.map(o => post(o, "accept", d1(), {}, null)));
  assert.equal(accepted.filter(r => r.status === 200).length, 1);
  assert.ok(accepted.every(r => [200, 409, 429].includes(r.status)));
  assert.equal(accepted.filter(r => r.status === 429).length, 10);
  assert.equal(await Order.countDocuments({ driverId: driverId(), activeAssignment: true }), 1);
});

test("area removal before pickup preserves the entire assigned delivery workflow", async () => {
  await ready();
  const o = await create(); await confirm(tokenOf(o)); await post(o, "accept");
  await areas([]); await available(false);
  assert.equal((await request("/driver/orders/current", d1())).data._id, o._id);
  for (const actor of [store(), d1()]) {
    const view = (await request(`/orders/${o._id}`, actor)).data;
    await post(o, "confirm", actor, { observed: view.confirmationSnapshot });
  }
  await post(o, "arrive-store"); await post(o, "pickup", d1(), { code: o.pickupCode });
  await complete(o);
  const next = await create();
  assert.equal((await db(o)).status, "delivered");
  assert.deepEqual(await offers(), []);
  await available(true); assert.deepEqual(await offers(), []);
  await areas(["kafr-kanna"]); assert.equal((await offers())[0]._id, next._id);
});

test("only the owning store may classify a legacy order through the existing store edit route", async () => {
  const o = await create();
  const other = await request("/admin/accounts", admin(), "POST", {
    role: "store", login: "classification-other-store", name: "Other store",
    storeName: "Other store", pickupAddress: "Other pickup", password: "OtherStore123!",
  }, 201);
  const session = await request("/auth/login", null, "POST", {
    login: other.data.login, password: "OtherStore123!",
  });
  const before = await db(o);
  await Order.collection.updateOne({ _id: before._id }, { $unset: { serviceArea: "" } });
  const view = (await request(`/orders/${o._id}`, store())).data;
  const body = { observed: view.confirmationSnapshot, serviceArea: "kafr-kanna" };
  await request(`/orders/${o._id}`, session.data.token, "PATCH", body, 404);
  await request(`/orders/${o._id}`, d1(), "PATCH", body, 403);
  await request(`/orders/${o._id}`, admin(), "PATCH", body, 403);
  await request(`/orders/${o._id}`, store(), "PATCH", body);
  assert.equal((await db(o)).serviceArea, "kafr-kanna");
});

test("invalid persisted order areas fail closed, including arrays containing a supported ID", async () => {
  await ready();
  for (const serviceArea of [["kafr-kanna"], ["unknown-area", "kafr-kanna"], { code: "kafr-kanna" }, null, "unknown-area"]) {
    const o = await create();
    await Order.collection.updateOne({ _id: (await db(o))._id }, { $set: { serviceArea } });
    assert.deepEqual(await offers(), []);
    await post(o, "accept", d1(), {}, 409);
    assert.equal((await db(o)).activeAssignment, false);
  }
});

test("T7-V1 vehicle type is admin-set, validated, audited, and drivers only",async()=>{
  const patch=(body,id=driverId(2),status=200)=>request(`/admin/accounts/${id}`,admin(),"PATCH",body,status);
  assert.equal((await patch({vehicleType:"car"})).data.vehicleType,"car");
  await patch({vehicleType:"truck"},driverId(2),400);
  await patch({vehicleType:"motorcycle"},sessions.store1.user._id,400);
  const audit=(await request(`/admin/accounts/${driverId(2)}/audit`,admin())).data;
  assert.deepEqual(audit.at(-1).changes,[{field:"vehicleType",from:"motorcycle",to:"car"}]);
  await patch({vehicleType:"motorcycle"});
});
test("T7-V2 a driver without a vehicle sees historical orders but no vehicle orders",async()=>{
  await ready(); await User.updateOne({login:"driver1"},{$unset:{vehicleType:""}});
  const legacy=await create();
  await request("/store/pickup-service-area",store(),"PUT",{pickupServiceArea:"kafr-kanna"});
  const quick=await quickReady({vehicleType:"motorcycle",parcelSize:"small",goodsAmountAgorot:0});
  const ids=(await offers()).map(o=>o._id);
  assert.ok(ids.includes(legacy._id)); assert.ok(!ids.includes(quick._id));
  await post(quick,"accept",d1(),{},409);
});
test("T7-V3 admin can explicitly clear a vehicle; omission preserves it and null is audited", async () => {
  const path = `/admin/accounts/${driverId()}`;
  await ready();
  assert.equal((await request(path, admin(), "PATCH", { phone: "0501234567" })).data.vehicleType, "car");
  const legacy = await create();
  await request("/store/pickup-service-area", store(), "PUT", { pickupServiceArea: "kafr-kanna" });
  const quick = await quickReady({ vehicleType: "car", parcelSize: "large", goodsAmountAgorot: 0 });
  assert.ok((await offers()).some(o => o._id === quick._id));
  assert.equal((await request(path, admin(), "PATCH", { vehicleType: null })).data.vehicleType, null);
  assert.equal((await request("/auth/me", d1())).data.vehicleType, null);
  const ids = (await offers()).map(o => o._id);
  assert.ok(ids.includes(legacy._id));
  assert.ok(!ids.includes(quick._id));
  await post(quick, "accept", d1(), {}, 409);
  const audit = (await request(`${path}/audit`, admin())).data;
  assert.deepEqual(audit.at(-1).changes, [{ field: "vehicleType", from: "car", to: null }]);
  for (const value of ["", "truck", false, { $ne: "car" }])
    await request(path, admin(), "PATCH", { vehicleType: value }, 400);
  await request(`/admin/accounts/${sessions.store1.user._id}`, admin(), "PATCH", { vehicleType: null }, 400);
  await request(path, d1(), "PATCH", { vehicleType: "car" }, 403);
  assert.equal((await request(path, admin(), "PATCH", { vehicleType: "motorcycle" })).data.vehicleType, "motorcycle");
});

// A driver created by the script is ready at once: it sees (and can accept) new
// car and motorcycle orders; a repair keeps what is already set.
const { createDriver } = await import("../src/scripts/create-driver.js");
const { offerProblems } = await import("../src/services/driverEligibility.js");
test("T7-S1 offerProblems names what keeps a driver from receiving orders", () => {
  assert.deepEqual(offerProblems({ role: "driver", active: true, availableForOrders: true, serviceAreas: ["kafr-kanna"], vehicleType: "car" }), []);
  assert.deepEqual(offerProblems({ role: "driver", active: true, availableForOrders: false, serviceAreas: [], vehicleType: undefined }),
    ["not_available", "no_service_area", "no_vehicle"]);
  assert.deepEqual(offerProblems({ role: "driver", active: false, availableForOrders: true, serviceAreas: ["kafr-kanna"], vehicleType: "motorcycle" }), ["inactive"]);
  assert.deepEqual(offerProblems({ role: "store" }), ["not_a_driver"]);
});
test("T7-S2 a driver made by create-driver logs in and receives a new car order", async () => {
  assert.equal(await createDriver({ login: "Script-Driver", password: "ScriptDriver-2026", name: "Script driver", phone: "0501112222", vehicleType: "car" }), "created");
  const login = (await request("/auth/login", null, "POST", { login: "script-driver", password: "ScriptDriver-2026" })).data;
  assert.equal(login.user.role, "driver");
  assert.equal(login.user.vehicleType, "car"); assert.deepEqual(login.user.serviceAreas, ["kafr-kanna"]); assert.equal(login.user.availableForOrders, true);
  await request("/store/pickup-service-area", store(), "PUT", { pickupServiceArea: "kafr-kanna" });
  const quick = await quickReady({ vehicleType: "car", parcelSize: "large", goodsAmountAgorot: 0 });
  assert.ok((await offers(login.token)).some(o => o._id === quick._id));
  await post(quick, "accept", login.token);
});
test("T7-S3 repairing a driver keeps the password, the availability and the areas already set", async () => {
  await createDriver({ login: "repair-driver", password: "RepairDriver-2026", name: "Repair driver", vehicleType: "motorcycle", available: false });
  assert.equal(await createDriver({ login: "repair-driver", vehicleType: "car" }), "updated");
  const driver = await User.findOne({ login: "repair-driver" }).select("+passwordHash +accountEvents").lean();
  assert.equal(driver.vehicleType, "car"); assert.equal(driver.availableForOrders, false, "a repair never switches a driver on");
  assert.deepEqual(driver.serviceAreas, ["kafr-kanna"]);
  assert.deepEqual(driver.accountEvents.at(-1).changes, [{ field: "vehicleType", from: "motorcycle", to: "car" }]);
  await request("/auth/login", null, "POST", { login: "repair-driver", password: "RepairDriver-2026" });
  assert.equal(await createDriver({ login: "repair-driver", vehicleType: "car" }), "unchanged");
  assert.equal(driver.authVersion ?? 0, 0, "no password change, so sessions stay valid");
});
test("T7-S4 create-driver refuses bad input and accounts that are not drivers", async () => {
  const good = { login: "bad-input", password: "BadInput-2026-ok", name: "Bad input", vehicleType: "car" };
  await assert.rejects(createDriver({ ...good, vehicleType: "truck" }), /car or motorcycle/);
  await assert.rejects(createDriver({ ...good, vehicleType: undefined }), /car or motorcycle/);
  await assert.rejects(createDriver({ ...good, serviceAreas: ["nowhere"] }), /supported areas/);
  await assert.rejects(createDriver({ ...good, password: "short" }), /12 characters/);
  await assert.rejects(createDriver({ ...good, password: "WaselhaDemo123!", production: true }), /demo password/);
  await assert.rejects(createDriver({ ...good, password: undefined }), /DRIVER_PASSWORD is required/);
  await assert.rejects(createDriver({ login: "store1", vehicleType: "car" }), /non-driver/);
  assert.equal(await User.exists({ login: "bad-input" }), null);
  await User.updateOne({ login: "script-driver" }, { $set: { active: false } });
  await assert.rejects(createDriver({ login: "script-driver", vehicleType: "car" }), /deactivated/);
});
