import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { create, request, sessions, models, pickedUp, tokenOf, router, confirmLocation, confirm } from "./helpers/security.js";
import { runTimeoutSweep } from "../src/services/orderTimeouts.js";
const store = () => sessions.store1.token, admin = () => sessions.admin.token, driver = () => sessions.driver1.token;
const db = o => models.Order.findById(o._id).lean();
const view = async (o, actor = store()) => (await request(`/orders/${o._id}`, actor)).data;
const edit = async (o, changes, actor = store(), status = 200) => request(`/orders/${o._id}`, actor, "PATCH",
  { observed: (await view(o)).confirmationSnapshot, ...changes }, status);
const action = (o, name, body = {}, actor = driver(), status = 200) => request(`/orders/${o._id}/${name}`, actor, "POST", body, status);
const reconcile = (o, name, body, actor = admin(), status = 200) => request(`/admin/orders/${o._id}/finance/${name}`, actor, "POST", body, status);
// A 500-agorot difference must name who covers it and carry a reference.
const decision = (extra = {}) => ({ resolutionNote: "Verified", resolutionType: "platform_absorbs", reference: "REF-1", amountAgorot: 500, ...extra });
const final = async (payer = "customer", goods = 15000) => {
  const o = await create({ deliveryFeePaidBy: payer, goodsAmountAgorot: goods });
  await confirmLocation(tokenOf(o)); return o;
};
const arrived = async (payer = "customer", goods = 15000) => {
  const o = await final(payer, goods); await pickedUp(o); await action(o, "arrive-customer"); return o;
};
const collect = async (o, actual = 18000, status = 200) => {
  const raw = await db(o);
  return action(o, "deliver", { code: raw.deliveryCode, actualCashCollectedAgorot: actual,
    observedExpectedAgorot: raw.expectedCustomerCashAgorot, confirmDifference: true }, driver(), status);
};
const delivered = async (actual = 18000) => { const o = await arrived(); await collect(o, actual); return o; };
const otherStore = async () => {
  let user = await models.User.findOne({ login: "finance-other-store" }).lean();
  if (!user) {
    const saved = await request("/admin/accounts", admin(), "POST", { login: "finance-other-store", password: "WaselhaDemo123!",
      role: "store", name: "Other store", storeName: "Other", pickupAddress: "Other pickup" }, 201);
    user = saved.data;
  }
  return (await request("/auth/login", null, "POST", { login: user.login, password: "WaselhaDemo123!" })).data.token;
};
beforeEach(() => { router.reset(); router.distance = 1500; });

test("T8-1 new customer-payer order persists explicit canonical payer", async () => {
  const order = await create({ deliveryFeePaidBy: "customer" });
  assert.equal(order.deliveryFeePaidBy, "customer");
});
test("T8-2 new store-payer order persists explicit canonical payer", async () => {
  const order = await create({ deliveryFeePaidBy: "store" });
  assert.equal(order.deliveryFeePaidBy, "store");
});
test("T8-3 invalid/missing payer is rejected without creating an order", async () => {
  for (const deliveryFeePaidBy of [undefined, null, "", "Customer", "الزبون", {}, ["store"]]) {
    const result = await request("/orders", sessions.store1.token, "POST", {
      serviceArea: "kafr-kanna", area: "Pilot", deliveryFeePaidBy,
    }, null);
    assert.ok([400, 422].includes(result.status));
  }
  assert.equal(await models.Order.countDocuments(), 0);
});
test("T8-14 pickup atomically captures terms and fulfillment driver", async () => {
  const order = await create({ deliveryFeePaidBy: "customer" });
  await pickedUp(order);
  const saved = await models.Order.findById(order._id).lean();
  assert.ok(saved.financialSnapshot?.capturedAt);
  assert.equal(String(saved.financialSnapshot.driverId), sessions.driver1.user._id);
  assert.equal(saved.events.filter(e => e.type === "financial_terms_captured").length, 1);
});

test("T8-4 driver cannot edit fee payer", async () => {
  const o = await final(); await action(o, "accept"); await edit(o, { deliveryFeePaidBy: "store" }, driver(), 403);
  assert.equal((await db(o)).deliveryFeePaidBy, "customer");
});
test("T8-5 customer cannot change financial terms or actual cash", async () => {
  const o = await final(); const token = tokenOf(o), customer = (await request(`/customer/${token}`)).data;
  await request(`/customer/${token}/confirm`, null, "POST", { observed: customer.confirmationSnapshot,
    recipientName: "Customer name", finalAddress: "Final address", deliveryFeePaidBy: "store",
    expectedCustomerCashAgorot: 1, actualCashCollectedAgorot: 1 });
  const saved = await db(o); assert.equal(saved.deliveryFeePaidBy, "customer");
  assert.equal(saved.expectedCustomerCashAgorot, 18000); assert.equal(saved.actualCashCollectedAgorot, null);
});
test("T8-6 another store cannot edit payer", async () => {
  const o = await final(); await edit(o, { deliveryFeePaidBy: "store" }, await otherStore(), 404);
});
test("T8-7 owning store can change payer before pickup and confirmations invalidate", async () => {
  const o = await final(); await confirm(tokenOf(o)); await edit(o, { deliveryFeePaidBy: "store" });
  const saved = await db(o); assert.equal(saved.deliveryFeePaidBy, "store"); assert.equal(saved.customerConfirmed, false);
  assert.equal(saved.financialSnapshot, undefined);
});
test("T8-8 payer and goods are locked after pickup for store/admin", async () => {
  const o = await final(); await pickedUp(o); const before = await db(o);
  await edit(o, { deliveryFeePaidBy: "store", goodsAmountAgorot: 1 }, store(), 409);
  await request(`/admin/orders/${o._id}/finance-terms`, admin(), "PATCH", {
    observed: (await view(o, admin())).confirmationSnapshot, deliveryFeePaidBy: "store" }, 409);
  assert.deepEqual((await db(o)).financialSnapshot, before.financialSnapshot);
});
test("T8-9 customer-pays expected 18000; store liability zero; split 2700/300", async () => {
  const s = await db(await final()); assert.equal(s.expectedCustomerCashAgorot, 18000);
  assert.equal(s.storeDeliveryFeeLiabilityAgorot, 0);
  assert.deepEqual([s.driverEarningsAgorot, s.platformCommissionAgorot], [2700, 300]);
});
test("T8-10 store-pays expected 15000; store liability 3000; split unchanged", async () => {
  const o = await arrived("store"); const s = await db(o);
  assert.equal(s.expectedCustomerCashAgorot, 15000); assert.equal(s.storeDeliveryFeeLiabilityAgorot, 3000);
  assert.deepEqual([s.driverEarningsAgorot, s.platformCommissionAgorot], [2700, 300]); await collect(o, 15000);
  assert.equal((await db(o)).cashDifferenceAgorot, 0);
});
test("T8-11 zero goods and zero actual collection work", async () => {
  let o = await final("customer", 0); assert.equal((await db(o)).expectedCustomerCashAgorot, 3000);
  o = await arrived("store", 0); await collect(o, 0); const s = await db(o);
  assert.equal(s.expectedCustomerCashAgorot, 0); assert.equal(s.actualCashCollectedAgorot, 0);
});
test("T8-12 frontend cannot override expected total", async () => {
  const o = await final(); await edit(o, { expectedCustomerCashAgorot: 1 });
  assert.equal((await db(o)).expectedCustomerCashAgorot, 18000);
});
test("T8-13 frontend cannot override fees/split or supply snapshot", async () => {
  const o = await final(); await edit(o, { deliveryFeeAgorot: 2, driverEarningsAgorot: 1,
    platformCommissionAgorot: 1, financialSnapshot: { capturedAt: new Date() } });
  const s = await db(o); assert.equal(s.deliveryFeeAgorot, 3000); assert.equal(s.driverEarningsAgorot, 2700);
  assert.equal(s.financialSnapshot, undefined);
});
test("T8-15 snapshot includes exact authoritative components and route", async () => {
  const o = await final("store"); await pickedUp(o); const s = (await db(o)).financialSnapshot;
  assert.deepEqual([s.goodsAmountAgorot,s.deliveryFeeAgorot,s.deliveryFeePaidBy,s.expectedCustomerCashAgorot,
    s.driverEarningsAgorot,s.platformCommissionAgorot,s.storeDeliveryFeeLiabilityAgorot,s.routeDistanceMeters],
    [15000,3000,"store",15000,2700,300,3000,1500]);
});
test("T8-16 missing payer blocks pickup with valid code", async () => {
  const o = await final(); await pickedUp(o); // Restore the immediately-before-pickup fixture only.
  await models.Order.updateOne({ _id:o._id }, { $set:{status:"driver_at_store"}, $unset:{financialSnapshot:"",deliveryFeePaidBy:"",collectedAt:""} });
  const r = await action(o,"pickup",{code:o.pickupCode},driver(),422);
  assert.ok(r.data.missingRequirements.includes("fee_payer_required")); assert.equal((await db(o)).financialSnapshot,undefined);
});
test("T8-17 pending price blocks pickup without snapshot", async () => {
  const o = await final(); await pickedUp(o);
  await models.Order.updateOne({_id:o._id},{$set:{status:"driver_at_store",priceStatus:"pending"},$unset:{financialSnapshot:"",collectedAt:""}});
  await action(o,"pickup",{code:o.pickupCode},driver(),422); assert.equal((await db(o)).financialSnapshot,undefined);
});
test("T8-18 post-pickup edits/repricing cannot mutate snapshot", async () => {
  const o = await final(); await pickedUp(o); const s = (await db(o)).financialSnapshot;
  await edit(o,{financialSnapshot:{goodsAmountAgorot:1}},store(),409);
  await action(o,"recalculate-price",{},admin(),409);
  await confirmLocation(tokenOf(o),{lat:32.76,lng:35.36,source:"pin",address:"Changed"},409);
  assert.deepEqual((await db(o)).financialSnapshot,s);
});
test("T8-19 route repricing updates expected before snapshot", async () => {
  const o = await final(); router.distance=2000;
  await confirmLocation(tokenOf(o),{lat:32.76,lng:35.36,source:"pin",address:"Changed"});
  const s=await db(o); assert.equal(s.expectedCustomerCashAgorot,19000); assert.equal(s.financialSnapshot,undefined);
});
test("T8-20 payer and goods changes update expected before snapshot", async () => {
  const o=await final(); await edit(o,{deliveryFeePaidBy:"store",goodsAmountAgorot:12345});
  assert.equal((await db(o)).expectedCustomerCashAgorot,12345);
});
for (const [id,actual,difference,type] of [[21,18000,0,null],[22,17500,-500,"shortage"],[23,18500,500,"overage"]])
  test(`T8-${id} ${type??"exact"} collection persists reality and pending independent finance`,async()=>{
    const o=await delivered(actual),s=await db(o); assert.equal(s.status,"delivered"); assert.equal(s.actualCashCollectedAgorot,actual);
    assert.equal(s.cashDifferenceAgorot,difference); assert.equal(s.expectedCustomerCashAgorot,18000);
    assert.equal(s.collectionAdjustment?.type,type??undefined); if(type){assert.equal(s.collectionAdjustment.amountAgorot,500);assert.equal(s.collectionAdjustment.status,"open");}
    assert.equal(s.driverPayout.status,"pending"); assert.equal(s.driverPayout.amountAgorot,2700);
    assert.equal(s.platformCommissionAgorot,300); assert.equal(s.goodsAmountAgorot,15000);
  });
test("T8-24 difference is computed by server ignoring client difference",async()=>{
  const o=await arrived(); const s=await db(o);
  await action(o,"deliver",{code:s.deliveryCode,actualCashCollectedAgorot:17500,observedExpectedAgorot:18000,confirmDifference:true,cashDifferenceAgorot:0});
  assert.equal((await db(o)).cashDifferenceAgorot,-500);
});
test("T8-25 invalid actual money rejected, including unsafe integer and fractions",async()=>{
  const o=await arrived();const s=await db(o);
  for(const value of [-1,0.5,"18000",null,Number.MAX_SAFE_INTEGER+1])
    await action(o,"deliver",{code:s.deliveryCode,actualCashCollectedAgorot:value,observedExpectedAgorot:18000},driver(),400);
  assert.equal((await db(o)).status,"driver_at_destination");
});
for(const [id,actual] of [[26,17500],[27,18500]])test(`T8-${id} confirmed discrepancy allows successful delivery`,async()=>{
  const o=await delivered(actual); assert.equal((await db(o)).status,"delivered");
  assert.equal((await view(o,admin())).financeComplete,false);
});
test("T8-28 repeated delivery cannot rewrite actual history",async()=>{
  const o=await delivered(17500);await collect(o,1,404);assert.equal((await db(o)).actualCashCollectedAgorot,17500);
});
test("T8-29 admin resolves an open adjustment",async()=>{
  const o=await delivered(17500);await reconcile(o,"resolve-adjustment",{requestId:"resolve-A",...decision({resolutionNote:"Cash independently reconciled"})});
  const a=(await db(o)).collectionAdjustment;assert.equal(a.status,"resolved");assert.equal(String(a.resolvedBy),sessions.admin.user._id);assert.ok(a.resolvedAt);
});
test("T8-30 adjustment resolution requires a short note",async()=>{
  const o=await delivered(17500);for(const note of [undefined,"","  ","x".repeat(301)]){
    const r=await reconcile(o,"resolve-adjustment",{requestId:"A",resolutionNote:note},admin(),null);assert.equal(r.status,400);
  }assert.equal((await db(o)).collectionAdjustment.status,"open");
});
test("T8-31 store/driver/anonymous cannot resolve adjustment",async()=>{
  const o=await delivered(17500);for(const actor of [store(),driver(),null])
    await reconcile(o,"resolve-adjustment",{requestId:"A",resolutionNote:"Resolved"},actor,actor?403:401);
});
test("T8-32 resolution preserves expected/actual/split and snapshot",async()=>{
  const o=await delivered(17500),before=await db(o);await reconcile(o,"resolve-adjustment",{requestId:"A",...decision()});const after=await db(o);
  for(const key of ["expectedCustomerCashAgorot","actualCashCollectedAgorot","cashDifferenceAgorot","financialSnapshot","driverEarningsAgorot","platformCommissionAgorot"])
    assert.deepEqual(after[key],before[key]);
});
test("T8-33 same resolution requestId replays once and payload conflicts reject",async()=>{
  const o=await delivered(17500),body={requestId:"A",...decision()};await reconcile(o,"resolve-adjustment",body);await reconcile(o,"resolve-adjustment",body);
  await reconcile(o,"resolve-adjustment",{...body,resolutionNote:"Different"},admin(),409);
  assert.equal((await db(o)).events.filter(e=>e.type==="collection_adjustment_resolved").length,1);
});
test("T8-34 another resolution request after completion rejected",async()=>{
  const o=await delivered(18500),overage=decision({resolutionType:"platform_revenue"});
  await reconcile(o,"resolve-adjustment",{requestId:"A",...overage});
  await reconcile(o,"resolve-adjustment",{requestId:"B",...overage},admin(),409);
});
test("T8-35 payout amount comes from financial snapshot",async()=>{
  const o=await delivered();await reconcile(o,"driver-payout",{requestId:"A"});assert.equal((await db(o)).driverPayout.amountAgorot,2700);
});
test("T8-36 client cannot choose payout amount or driver earning",async()=>{
  const o=await delivered();for(const key of ["amountAgorot","driverEarningsAgorot","driverId"])
    await reconcile(o,"driver-payout",{requestId:"A",[key]:1},admin(),400);
  await request("/admin/driver-cash-records",admin(),"POST",{orderId:o._id,type:"driver_payment",requestId:"A",amountAgorot:1},400);
  await request("/admin/driver-cash-records",admin(),"POST",{driverId:sessions.driver1.user._id,type:"driver_payment",requestId:"A",amountAgorot:1},409);
});
test("T8-37 only admin can complete driver payout",async()=>{
  const o=await delivered();await reconcile(o,"driver-payout",{requestId:"A"});const s=await db(o);
  assert.equal(s.driverPayout.status,"completed");assert.equal(String(s.driverPayout.completedBy),sessions.admin.user._id);
});
test("T8-38 same payout request is idempotent; other ID rejected",async()=>{
  const o=await delivered();await reconcile(o,"driver-payout",{requestId:"A"});await reconcile(o,"driver-payout",{requestId:"A"});
  await reconcile(o,"driver-payout",{requestId:"B"},admin(),409);assert.equal((await db(o)).events.filter(e=>e.type==="driver_payout_completed").length,1);
});
for(const [id,name,event,amount] of [[39,"driver-payout","driver_payout_completed",null],[41,"cash-handover","cash_handover_completed",17500],[43,"store-settlement","store_settlement_completed",15000], [63,"resolve-adjustment","collection_adjustment_resolved",null]])
  test(`T8-${id} twenty concurrent ${name} requests create one logical completion`,async()=>{
    const o=await delivered(17500),body={...(name==="resolve-adjustment"?decision():amount===null?{}:{amountAgorot:amount,note:"Recorded actual"})};
    if(name==="cash-handover"||name==="store-settlement")await reconcile(o,"resolve-adjustment",{requestId:"decision",...decision()});
    const results=await Promise.all(Array.from({length:20},(_,i)=>reconcile(o,name,{...body,requestId:`race-${i}`},admin(),null)));
    assert.equal(results.filter(r=>r.status===200).length,1);assert.equal(results.filter(r=>r.status===409).length,19);
    const s=await db(o);assert.equal(s.events.filter(e=>e.type===event).length,1);
    const winner=results.find(r=>r.status===200).data;const field={"driver-payout":"driverPayout","cash-handover":"cashHandover","store-settlement":"storeSettlement","resolve-adjustment":"collectionAdjustment"}[name];
    const replay=await reconcile(o,name,{...body,requestId:winner[field].requestId});assert.deepEqual(replay.data[field],winner[field]);
  });
for(const [id,name,field,amount] of [[40,"cash-handover","cashHandover",18000],[42,"store-settlement","storeSettlement",15000]])
  test(`T8-${id} ${name} records actual amount once without automatic netting`,async()=>{
    const o=await delivered(),body={requestId:"A",amountAgorot:amount,note:"Manual reconciliation"};
    await reconcile(o,name,body);await reconcile(o,name,body);await reconcile(o,name,{...body,requestId:"B"},admin(),409);
    await reconcile(o,name,{...body,amountAgorot:1},admin(),409);assert.equal((await db(o))[field].amountAgorot,amount);
  });
test("T8-44 customer cannot see driver payout",async()=>{
  const o=await arrived();const v=(await request(`/customer/${tokenOf(o)}`)).data;
  for(const key of ["financialSnapshot","driverPayout","storeSettlement","cashHandover","events","driverEarningsAgorot"])assert.equal(key in v,false);
});
test("T8-45 customer platform/internal reconciliation privacy",async()=>{
  const o=await arrived();const v=(await request(`/customer/${tokenOf(o)}`)).data;
  for(const key of ["platformCommissionAgorot","collectionAdjustment","storeDeliveryFeeLiabilityAgorot"])assert.equal(key in v,false);
  assert.equal(v.expectedCustomerCashAgorot,18000);assert.equal(v.deliveryFeePaidBy,"customer");
});
test("T8-46 driver cannot see another driver's financial receipt",async()=>{
  const o=await delivered();const own=(await request("/driver/summary",driver())).data;
  assert.equal(own.orderFinances[0].orderId,o._id);const other=(await request("/driver/summary",sessions.driver2.token)).data;
  assert.deepEqual(other.orderFinances,[]);await request(`/orders/${o._id}`,sessions.driver2.token,"GET",undefined,404);
});
test("T8-47 driver cannot settle own payout",async()=>{const o=await delivered();await reconcile(o,"driver-payout",{requestId:"A"},driver(),403);});
test("T8-48 another store cannot see or settle an order",async()=>{
  const o=await delivered(),other=await otherStore();await request(`/orders/${o._id}`,other,"GET",undefined,404);
  await reconcile(o,"store-settlement",{requestId:"A",amountAgorot:15000},other,403);
});
test("T8-49 all finance endpoints require admin authentication",async()=>{
  const o=await delivered(17500);for(const name of ["resolve-adjustment","cash-handover","driver-payout","store-settlement"])
    for(const actor of [null,store(),driver()])await reconcile(o,name,{requestId:"A"},actor,actor?403:401);
});
test("T8-50 historical receipt contains no PII/internal notes and does not restore access",async()=>{
  const o=await delivered(17500);await reconcile(o,"resolve-adjustment",{requestId:"A",...decision({resolutionNote:"Private finance note",reference:"Private reference"})});
  await request(`/orders/${o._id}`,driver(),"GET",undefined,404);const s=(await request("/driver/summary",driver())).data;
  const serialized=JSON.stringify(s);for(const text of ["0501234567","Customer name","Private finance note","Final address","resolutionNote","storeSettlement","customerToken"])
    assert.equal(serialized.includes(text),false,text);
});
test("T8-51 customer-link expiry and revocation remain enforced",async()=>{
  const o=await final(),old=tokenOf(o);await action(o,"customer-link/reissue",{},store());await request(`/customer/${old}`,null,"GET",undefined,404);
  const current=await db(o);await models.Order.updateOne({_id:o._id},{$set:{customerTokenExpiresAt:new Date(0)}});
  await request(`/customer/${current.customerToken}`,null,"GET",undefined,404);
});
test("T8-52 withdrawal before pickup creates no payout or snapshot",async()=>{
  const o=await final();await action(o,"accept");await action(o,"withdraw",{reason:"cannot_complete"});const s=await db(o);
  assert.equal(s.financialSnapshot,undefined);assert.equal(s.driverPayout,undefined);
});
test("T8-53 assignment timeout before pickup creates no payout",async()=>{
  const o=await final();await action(o,"accept");await models.Order.updateOne({_id:o._id},{$set:{storeArrivalDeadlineAt:new Date(0)}});await runTimeoutSweep();
  const s=await db(o);assert.equal(s.activeAssignment,false);assert.equal(s.financialSnapshot,undefined);assert.equal(s.driverPayout,undefined);
});
test("T8-54 no-driver timeout creates no financial transaction",async()=>{
  const o=await final();await models.Order.updateOne({_id:o._id},{$set:{searchDeadlineAt:new Date(0)}});await runTimeoutSweep();const s=await db(o);
  assert.equal(s.driverSearchStatus,"no_driver");assert.equal(s.driverPayout,undefined);assert.equal(s.cashHandover,undefined);assert.equal(s.storeSettlement,undefined);
});
test("T8-55 search retry preserves pre-pickup financial inputs",async()=>{
  const o=await final("store");const before=await db(o);await models.Order.updateOne({_id:o._id},{$set:{searchDeadlineAt:new Date(0)}});await runTimeoutSweep();
  await action(o,"retry-search",{},store());const s=await db(o);for(const k of ["deliveryFeePaidBy","goodsAmountAgorot","deliveryFeeAgorot","expectedCustomerCashAgorot","storeDeliveryFeeLiabilityAgorot"])
    assert.equal(s[k],before[k]);
});
test("T8-56 excluded previous driver cannot claim eventual payout",async()=>{
  const o=await final();await action(o,"accept",{},sessions.driver2.token);await action(o,"withdraw",{reason:"cannot_complete"},sessions.driver2.token);
  await pickedUp(o);await action(o,"arrive-customer");await collect(o);assert.deepEqual((await request("/driver/summary",sessions.driver2.token)).data.orderFinances,[]);
});
test("T8-57 earning record names only fulfillment driver",async()=>{
  const o=await delivered();const s=await db(o);assert.equal(String(s.financialSnapshot.driverId),sessions.driver1.user._id);
  assert.equal((await request("/driver/summary",driver())).data.earningsAgorot,2700);
});
test("T8-58 availability/area changes do not change finance or block current fulfillment",async()=>{
  const o=await final();await pickedUp(o);const before=(await db(o)).financialSnapshot;
  await request("/driver/availability",driver(),"PATCH",{available:false});await request(`/admin/accounts/${sessions.driver1.user._id}`,admin(),"PATCH",{serviceAreas:[]});
  await action(o,"arrive-customer");await collect(o);assert.deepEqual((await db(o)).financialSnapshot,before);
});
for(const [id,key] of [[59,"deliveryFeePaidBy"],[60,"driverPayout"],[62,"actualCashCollectedAgorot"]])
  test(`T8-${id} historical ${key} is never guessed/backfilled by reads`,async()=>{
    const o=await delivered();await models.Order.collection.updateOne({_id:(await db(o))._id},{$unset:{financialSnapshot:"",deliveryFeePaidBy:"",actualCashCollectedAgorot:"",cashHandover:"",driverPayout:"",storeSettlement:""}});
    await view(o,admin());await view(o);await request("/admin/finance",admin());const s=await db(o);assert.equal(s[key],undefined);
    await reconcile(o,"driver-payout",{requestId:"A"},admin(),409);
  });
test("T8-61 open legacy order can be explicitly prepared without fabricating history",async()=>{
  const o=await final();await models.Order.collection.updateOne({_id:(await db(o))._id},{$unset:{deliveryFeePaidBy:"",storeDeliveryFeeLiabilityAgorot:""}});
  await edit(o,{deliveryFeePaidBy:"store"});await pickedUp(o);const s=await db(o);assert.equal(s.financialSnapshot.deliveryFeePaidBy,"store");
});
test("T8-64 twenty concurrent delivery finalizations write one cash/adjustment event",async()=>{
  const o=await arrived();const results=await Promise.all(Array.from({length:20},()=>collect(o,17500,null)));
  assert.equal(results.filter(r=>r.status===200).length,1);assert.ok(results.every(r=>[200,404,409,429].includes(r.status)), JSON.stringify(results.map(r=>({status:r.status,code:r.data.code}))));
  const s=await db(o);assert.equal(s.events.filter(e=>e.type==="cash_collected").length,1);
  assert.equal(s.events.filter(e=>e.type==="collection_adjustment_opened").length,1);assert.equal(s.actualCashCollectedAgorot,17500);
});
test("T8-65 finance completes only after every manual record and adjustment resolution",async()=>{
  const o=await delivered(17500);
  await reconcile(o,"cash-handover",{requestId:"early",amountAgorot:17500},admin(),409); // decision first
  await reconcile(o,"resolve-adjustment",{requestId:"resolve",...decision({resolutionNote:"Platform covers the shortage"})});
  for(const name of ["cash-handover","driver-payout","store-settlement"]){
    assert.equal((await view(o,admin())).financeComplete,false);
    await reconcile(o,name,{requestId:name,...(name==="driver-payout"?{}:{amountAgorot:name==="cash-handover"?17500:15000})});
  }
  assert.equal((await view(o,admin())).financeComplete,true);assert.equal((await db(o)).status,"delivered");
});
test("T8-66 admin may set payer before pickup but cannot inject snapshot/split",async()=>{
  const o=await final(),body={observed:(await view(o,admin())).confirmationSnapshot,deliveryFeePaidBy:"store"};
  await request(`/admin/orders/${o._id}/finance-terms`,admin(),"PATCH",{...body,financialSnapshot:{}},400);
  await request(`/admin/orders/${o._id}/finance-terms`,admin(),"PATCH",body);assert.equal((await db(o)).expectedCustomerCashAgorot,15000);
});
test("T8-67 financial internals never enter available-order projection",async()=>{
  await final();const offers=(await request("/driver/orders/available",driver())).data;assert.equal(offers.length,1);
  for(const key of ["financialSnapshot","collectionAdjustment","cashHandover","driverPayout","storeSettlement","events","deliveryFeePaidBy","storeDeliveryFeeLiabilityAgorot"])
    assert.equal(key in offers[0],false,key);
});
test("T8-68 negative/unsafe settlement amounts and missing requestId rejected",async()=>{
  const o=await delivered();for(const name of ["cash-handover","store-settlement"])
    for(const amountAgorot of [-1,0.1,null,"100",Number.MAX_SAFE_INTEGER+1])await reconcile(o,name,{requestId:"A",amountAgorot},admin(),400);
  await reconcile(o,"driver-payout",{},admin(),400);
});
test("T8-69 settlement before delivery rejected; no records created",async()=>{
  const o=await final();await pickedUp(o);await reconcile(o,"driver-payout",{requestId:"A"},admin(),409);
  assert.equal((await db(o)).driverPayout,undefined);
});
test("T8-70 twenty identical payout retries return one stable recorded result",async()=>{
  const o=await delivered();const results=await Promise.all(Array.from({length:20},()=>reconcile(o,"driver-payout",{requestId:"same"})));
  assert.ok(results.every(r=>r.status===200));const r=results[0].data.driverPayout;
  for(const result of results)assert.deepEqual(result.data.driverPayout,r);
  assert.equal((await db(o)).events.filter(e=>e.type==="driver_payout_completed").length,1);
});
test("T8-71 historical cash records remain readable; admin notes stay private to admin",async()=>{
  const o=await delivered();
  await models.DriverCashRecord.create({driverId:sessions.driver1.user._id,type:"cash_handover",amountAgorot:123,
    recordedByAdminId:sessions.admin.user._id,requestId:"historical-record",note:"Private historical audit note"});
  const own=(await request("/driver/summary",driver())).data;assert.equal(own.records.length,1);assert.equal(own.records[0].note,undefined);
  const full=(await request("/admin/finance",admin())).data;assert.equal(full.drivers.find(d=>d.driverId===sessions.driver1.user._id).records[0].note,"Private historical audit note");
  await reconcile(o,"cash-handover",{requestId:"per-order",amountAgorot:18000});
  assert.equal((await request("/driver/summary",driver())).data.cashHandedOverAgorot,18123);
  assert.equal(await models.DriverCashRecord.countDocuments(),1);
});
test("T8-72 payer changes during in-flight routing use current payer without overwriting terms",async()=>{
  const o=await create({goodsAmountAgorot:15000});let release;const paused=new Promise(r=>{release=r;});let entered;
  const started=new Promise(r=>{entered=r;});router.handler=async(req,res)=>{entered();await paused;
    res.setHeader("Content-Type","application/json");res.end(JSON.stringify({code:"Ok",routes:[{distance:1500}]}));};
  const location=confirmLocation(tokenOf(o));await started;await edit(o,{deliveryFeePaidBy:"store"});release();await location;
  const s=await db(o);assert.equal(s.deliveryFeePaidBy,"store");assert.equal(s.expectedCustomerCashAgorot,15000);assert.equal(s.storeDeliveryFeeLiabilityAgorot,3000);
});
test("T8-73 pickup and payer edit race never captures mixed terms",async()=>{
  const o=await final();await pickedUp(o);
  await models.Order.updateOne({_id:o._id},{$set:{status:"driver_at_store"},$unset:{financialSnapshot:"",collectedAt:""}});
  const observed=(await view(o)).confirmationSnapshot;
  const results=await Promise.all([action(o,"pickup",{code:o.pickupCode},driver(),null),
    request(`/orders/${o._id}`,store(),"PATCH",{observed,deliveryFeePaidBy:"store"},null)]);
  assert.equal(results.filter(r=>r.status===200).length,1);assert.ok(results.every(r=>[200,409,422].includes(r.status)));
  const s=await db(o);if(s.financialSnapshot){assert.equal(s.deliveryFeePaidBy,"customer");assert.equal(s.financialSnapshot.expectedCustomerCashAgorot,18000);}
  else{assert.equal(s.deliveryFeePaidBy,"store");assert.equal(s.expectedCustomerCashAgorot,15000);}
});
test("T8-74 invalid split cannot be captured at pickup",async()=>{
  const o=await final();await pickedUp(o);
  await models.Order.updateOne({_id:o._id},{$set:{status:"driver_at_store",driverEarningsAgorot:1},$unset:{financialSnapshot:"",collectedAt:""}});
  await action(o,"pickup",{code:o.pickupCode},driver(),422);assert.equal((await db(o)).financialSnapshot,undefined);
});
test("T8-75 zero manual fee has zero payout and zero reconciliation remains explicit",async()=>{
  const o=await final("store",0);await models.Order.collection.updateOne({_id:(await db(o))._id},{$unset:{priceSource:"",priceStatus:""}});
  await edit(o,{deliveryFeeAgorot:0});await pickedUp(o);await action(o,"arrive-customer");await collect(o,0);
  await reconcile(o,"driver-payout",{requestId:"zero-payout"});
  for(const name of ["cash-handover","store-settlement"])await reconcile(o,name,{requestId:name,amountAgorot:0});
  const s=await view(o,admin());assert.equal(s.driverPayout.amountAgorot,0);assert.equal(s.financeComplete,true);
});
