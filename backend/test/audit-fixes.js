import { resetOrderActionLimits } from "./helpers/offerLocations.js";
// Regression tests for the 2026-10-09 controlled-pilot audit (docs/audit-2026-10-09-fixes.md).
import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { randomUUID } from "node:crypto";
import express from "express";
import jwt from "jsonwebtoken";
import { create, request, sessions, models, pickedUp, tokenOf, router, confirmLocation, relogin, loginStates } from "./helpers/security.js";
import { runTimeoutSweep } from "../src/services/orderTimeouts.js";
import { rateLimit } from "../src/services/rateLimit.js";
import { productionConfigProblems, demoAccountsPresent } from "../src/services/startupChecks.js";
import { createAdmin } from "../src/scripts/create-admin.js";
import { seed } from "../src/scripts/seed.js";

const store = () => sessions.store1.token, admin = () => sessions.admin.token, driver = () => sessions.driver1.token;
const db = (o) => models.Order.findById(o._id).lean();
const action = (o, name, body = {}, actor = driver(), status = 200) => request(`/orders/${o._id}/${name}`, actor, "POST", body, status);
const reconcile = (o, name, body, actor = admin(), status = 200) => request(`/admin/orders/${o._id}/finance/${name}`, actor, "POST", body, status);
const rid = () => randomUUID();
const final = async (payer = "customer", goods = 15000) => {
  const o = await create({ deliveryFeePaidBy: payer, goodsAmountAgorot: goods });
  await confirmLocation(tokenOf(o)); return o;
};
const arrived = async (payer, goods) => { const o = await final(payer, goods); await pickedUp(o); await action(o, "arrive-customer"); return o; };
const collect = async (o, actual, status = 200) => {
  const raw = await db(o);
  return action(o, "deliver", { code: raw.deliveryCode, actualCashCollectedAgorot: actual,
    observedExpectedAgorot: raw.expectedCustomerCashAgorot, confirmDifference: true }, driver(), status);
};
const delivered = async (actual, payer, goods) => { const o = await arrived(payer, goods); await collect(o, actual); return o; };
const complete = async (o) => (await request(`/orders/${o._id}`, admin())).data.financeComplete;
const pay = (o, name, amountAgorot, status = 200) =>
  reconcile(o, name, { requestId: rid(), ...(name === "driver-payout" ? {} : { amountAgorot }) }, admin(), status);
const decide = (o, resolutionType, amountAgorot = 500, status = 200, extra = {}) => reconcile(o, "resolve-adjustment",
  { requestId: rid(), resolutionNote: "Reviewed", resolutionType, reference: "REF-9", amountAgorot, ...extra }, admin(), status);
beforeEach(() => { router.reset(); router.distance = 1500; }); // fee 3000, driver 2700, platform 300

test("rejected account updates never deactivate the account or change its audit/session version", async () => {
  const before = await models.User.findOne({ login: "driver2" }).select("+accountEvents").lean();
  try {
    await request(`/admin/accounts/${before._id}`, admin(), "PATCH", { active: false, password: "x" }, 400);
    const after = await models.User.findById(before._id).select("+accountEvents").lean();
    assert.equal(after.active, before.active);
    assert.equal(after.authVersion, before.authVersion);
    assert.deepEqual(after.accountEvents, before.accountEvents);
  } finally { await models.User.updateOne({ _id: before._id }, { $set: { active: true } }); }
});

test("a delayed payment replay cannot re-complete a reversed record", async () => {
  const o = await delivered(18000), requestId = rid();
  const body = { requestId, amountAgorot: 18000 };
  await reconcile(o, "cash-handover", body);
  await reconcile(o, "reverse-record", { requestId: rid(), record: "cash-handover", reason: "Wrong receipt" });
  await reconcile(o, "cash-handover", body, admin(), 409);
  const current = await db(o);
  assert.equal(current.cashHandover.status, "pending");
  assert.equal(current.events.filter(e => e.type === "cash_handover_completed").length, 1);
});

test("a stale pending payment cannot cross a completed-and-reversed payment cycle", async () => {
  const { reconcileOrder } = await import("../src/services/orderFinance.js");
  const o = await delivered(18000), stale = await db(o);
  await pay(o, "cash-handover", 18000);
  await reconcile(o, "reverse-record", { requestId: rid(), record: "cash-handover", reason: "Wrong receipt" });
  await assert.rejects(reconcileOrder(stale, { role: "admin", _id: sessions.admin.user._id }, "cash-handover",
    { requestId: rid(), amountAgorot: 18000 }), e => e.status === 409);
  assert.equal((await db(o)).cashHandover.status, "pending");
});

test("driver-funded shortage handover clears customer cash custody without a negative balance", async () => {
  const o = await delivered(17500);
  await decide(o, "driver_pays");
  await pay(o, "cash-handover", 18000);
  const summary = (await request("/driver/summary", driver())).data;
  assert.equal(summary.cashCollectedAgorot, 17500);
  assert.equal(summary.cashHandedOverAgorot, 18000);
  assert.equal(summary.cashHeldAgorot, 0);
  assert.equal(summary.driverShortagePaidAgorot, 500);
  assert.equal((await request("/admin/finance", admin())).data.driverShortagePaidAgorot, 500);
  await reconcile(o, "reverse-record", { requestId: rid(), record: "cash-handover", reason: "Wrong receipt" });
  const reversed = (await request("/driver/summary", driver())).data;
  assert.equal(reversed.driverShortagePaidAgorot, 0);
  assert.equal(reversed.cashHeldAgorot, 17500);
});

test("account audit records personal fields by name without retaining their values", async () => {
  const id = sessions.driver2.user._id;
  const before = await models.User.findById(id).select("+accountEvents").lean();
  try {
    await request(`/admin/accounts/${id}`, admin(), "PATCH", { phone: "0509876543", name: "Private Driver Name" });
    const events = (await request(`/admin/accounts/${id}/audit`, admin())).data;
    const event = events.at(-1);
    assert.deepEqual(event.changes.find(c => c.field === "phone"), { field: "phone" });
    assert.deepEqual(event.changes.find(c => c.field === "name"), { field: "name" });
    assert.equal(JSON.stringify(event).includes("0509876543"), false);
  } finally {
    await models.User.updateOne({ _id: id }, { $set: { phone: before.phone, name: before.name,
      ...(before.accountEvents ? { accountEvents: before.accountEvents } : {}) },
      ...(!before.accountEvents ? { $unset: { accountEvents: "" } } : {}) });
  }
});

test("a concurrent disable based on a temporary inactive state cannot disable a driver with live work", async () => {
  const { createApp } = await import("../src/app.js");
  const o = await final();
  const userId = sessions.driver2.user._id;
  await request(`/admin/orders/${o._id}/assign`, admin(), "POST", { driverId: userId });
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/admin/accounts/${userId}`;
  const disable = async () => fetch(url, { method: "PATCH", headers: {
    Authorization: `Bearer ${admin()}`, "Content-Type": "application/json",
  }, body: JSON.stringify({ active: false }) });
  const exists = models.Order.exists, findOne = models.User.findOne;
  let reachedCheck, resumeCheck, reachedRead, resumeRead;
  const atCheck = new Promise(r => { reachedCheck = r; });
  const checkGate = new Promise(r => { resumeCheck = r; });
  const atRead = new Promise(r => { reachedRead = r; });
  const readGate = new Promise(r => { resumeRead = r; });
  try {
    // Barriers select a valid interleaving; all reads/writes still hit MongoDB.
    models.Order.exists = async function(filter) {
      reachedCheck(); await checkGate;
      return exists.call(this, filter);
    };
    const first = disable();
    await atCheck;
    models.User.findOne = function(...args) {
      const query = findOne.apply(this, args);
      if (String(args[0]?._id) === userId && args[0]?.role?.$in) {
        const lean = query.lean.bind(query);
        query.lean = async () => { const value = await lean(); reachedRead(); await readGate; return value; };
      }
      return query;
    };
    const second = disable();
    await atRead;
    resumeCheck();
    assert.equal((await first).status, 409);
    resumeRead();
    assert.equal((await second).status, 409);
    assert.equal((await models.User.findById(userId).lean()).active, true);
    assert.equal((await db(o)).activeAssignment, true);
  } finally {
    resumeCheck(); resumeRead();
    models.Order.exists = exists; models.User.findOne = findOne;
    server.closeAllConnections(); await new Promise(r => server.close(r));
    await models.User.updateOne({ _id: userId }, { $set: { active: true } });
  }
});

test("a delayed link command remains idempotent after more than fifty subsequent commands", async () => {
  const o = await create(), first = rid();
  await request(`/orders/${o._id}/customer-link/reissue`, store(), "POST", { requestId: first });
  for (let i = 0; i < 51; i++)
    await request(`/orders/${o._id}/customer-link/reissue`, store(), "POST", { requestId: rid() });
  const before = await db(o);
  await request(`/orders/${o._id}/customer-link/reissue`, store(), "POST", { requestId: first });
  const after = await db(o);
  assert.equal(after.customerToken, before.customerToken);
  assert.equal(after.events.length, before.events.length);
});

// ---- P0-01: nothing completes until every obligation equals what the order owes
test("P0-01 handover must equal the cash the driver holds; zero and overpayment are rejected", async () => {
  const o = await delivered(18000);
  let r = await pay(o, "cash-handover", 0, 422); assert.equal(r.data.code, "amount_mismatch"); assert.equal(r.data.expectedAgorot, 18000);
  await pay(o, "cash-handover", 18001, 422);
  await pay(o, "store-settlement", 0, 422);
  await pay(o, "driver-payout", undefined);
  assert.equal(await complete(o), false);
  assert.equal((await request("/driver/summary", driver())).data.cashHeldAgorot, 18000);
  await pay(o, "cash-handover", 18000);
  assert.equal((await request("/driver/summary", driver())).data.cashHeldAgorot, 0);
  assert.equal(await complete(o), false);
  const settled = (await pay(o, "store-settlement", 15000)).data;
  assert.equal(settled.storeSettlement.direction, "pay_store");
  assert.equal(await complete(o), true);
});
test("P0-01 store-paid fee larger than the goods is collected from the store, never paid out", async () => {
  const o = await delivered(1000, "store", 1000); // fee 3000: store owes 2000 net
  await pay(o, "cash-handover", 1000);
  await pay(o, "store-settlement", 0, 422);
  const r = await pay(o, "store-settlement", 2000);
  assert.equal(r.data.storeSettlement.direction, "collect_from_store"); assert.equal(r.data.storeSettlement.amountAgorot, 2000);
  await pay(o, "driver-payout");
  assert.equal(await complete(o), true);
  assert.equal((await view(o)).financeDue.storeSettlementDirection, "collect_from_store");
});
const view = async (o) => (await request(`/orders/${o._id}`, admin())).data;
test("P0-01 a wrongly recorded payment is reopened with its history, then recorded again", async () => {
  const o = await delivered(18000); await pay(o, "cash-handover", 18000);
  const requestId = rid();
  await reconcile(o, "reverse-record", { requestId, record: "cash-handover" }, admin(), 400);
  const reversed = (await reconcile(o, "reverse-record", { requestId, record: "cash-handover", reason: "Receipt not found" })).data;
  assert.equal(reversed.cashHandover.status, "pending"); assert.equal(reversed.cashHandover.amountAgorot, undefined);
  const again = (await reconcile(o, "reverse-record", { requestId, record: "cash-handover", reason: "Receipt not found" })).data;
  assert.equal(again.events.filter((e) => e.type === "finance_record_reversed").length, 1);
  const event = (await db(o)).events.find((e) => e.type === "finance_record_reversed");
  assert.equal(event.amountAgorot, 18000); assert.equal(event.note, "Receipt not found"); assert.equal(String(event.actorId), sessions.admin.user._id);
  assert.equal((await db(o)).events.filter((e) => e.type === "cash_handover_completed").length, 1); // history is not erased
  await reconcile(o, "reverse-record", { requestId: rid(), record: "cash-handover", reason: "x" }, admin(), 409); // already pending
  await reconcile(o, "reverse-record", { requestId: rid(), record: "cash-handover", reason: "x" }, driver(), 403);
  await pay(o, "cash-handover", 18000);
  assert.equal((await db(o)).events.filter((e) => e.type === "cash_handover_completed").length, 2);
});

// ---- P0-02: a collection difference needs an explicit, complete, referenced decision
test("P0-02 resolution needs a valid type for the difference, the full amount and a reference", async () => {
  const o = await delivered(17500); // shortage 500
  assert.equal((await decide(o, "platform_absorbs", 500, 400, { reference: "  " })).data.code, "required_fields");
  assert.equal((await decide(o, "credit_store", 500, 422)).data.code, "invalid_resolution"); // overage type
  assert.equal((await decide(o, "platform_absorbs", 200, 422)).data.code, "amount_mismatch"); // partial
  assert.equal((await decide(o, undefined, 500, 422)).data.code, "invalid_resolution");
  assert.equal((await db(o)).collectionAdjustment.status, "open");
  const a = (await decide(o, "store_absorbs")).data.collectionAdjustment;
  assert.equal(a.resolutionType, "store_absorbs"); assert.equal(a.resolutionParty, "store"); assert.equal(a.resolutionReference, "REF-9");
  assert.equal((await db(o)).actualCashCollectedAgorot, 17500); assert.equal((await db(o)).financialSnapshot.expectedCustomerCashAgorot, 18000);
});
for (const [type, cash, storeAmount, direction] of [["platform_absorbs", 17500, 15000, "pay_store"], ["driver_pays", 18000, 15000, "pay_store"],
  ["store_absorbs", 17500, 14500, "pay_store"]])
  test(`P0-02 shortage ${type} fixes the exact amounts the records must carry`, async () => {
    const o = await delivered(17500); await decide(o, type);
    await pay(o, "cash-handover", cash === 18000 ? 17500 : 18000, 422);
    await pay(o, "cash-handover", cash); await pay(o, "driver-payout");
    await pay(o, "store-settlement", storeAmount + 500, 422);
    assert.equal((await pay(o, "store-settlement", storeAmount)).data.storeSettlement.direction, direction);
    assert.equal(await complete(o), true);
  });
for (const [type, cash, storeAmount] of [["credit_store", 18500, 15500], ["platform_revenue", 18500, 15000], ["refund_customer", 18500, 15000]])
  test(`P0-02 overage ${type} fixes the exact amounts the records must carry`, async () => {
    const o = await delivered(18500); await decide(o, type);
    await pay(o, "cash-handover", cash); await pay(o, "driver-payout"); await pay(o, "store-settlement", storeAmount);
    assert.equal(await complete(o), true);
  });
test("P0-02 financeComplete is derived: tampered amounts or a missing decision never read as complete", async () => {
  const o = await delivered(17500); await decide(o, "platform_absorbs");
  await pay(o, "cash-handover", 17500); await pay(o, "driver-payout"); await pay(o, "store-settlement", 15000);
  assert.equal(await complete(o), true);
  await models.Order.updateOne({ _id: o._id }, { $set: { "cashHandover.amountAgorot": 1 } });
  assert.equal(await complete(o), false);
  await models.Order.updateOne({ _id: o._id }, { $set: { "cashHandover.amountAgorot": 17500 }, $unset: { "collectionAdjustment.resolutionType": "" } });
  assert.equal(await complete(o), false);
});
test("P0-02 concurrent resolutions with different decisions leave exactly one", async () => {
  const o = await delivered(17500);
  const results = await Promise.all(["platform_absorbs", "store_absorbs", "driver_pays"].flatMap((t) => [decide(o, t, 500, null), decide(o, t, 500, null)]));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal((await db(o)).events.filter((e) => e.type === "collection_adjustment_resolved").length, 1);
});

// ---- P1-02: cash kept after a failed delivery is handed back like any other cash
test("P1-02 failed delivery with collected cash gets a handover record that closes the driver's custody", async () => {
  const o = await arrived("customer", 15000);
  const failed = (await action(o, "fail", { reason: "Customer absent", actualCashCollectedAgorot: 1000 })).data;
  assert.equal(failed.cashHandover.status, "pending");
  assert.equal(await complete(o), false);
  assert.equal((await request("/driver/summary", driver())).data.cashHeldAgorot, 1000);
  await action(o, "pickup", {}, driver(), 409);
  await pay(o, "driver-payout", undefined, 409); // no payout is invented for a failed attempt
  await pay(o, "cash-handover", 900, 422);
  await request(`/admin/orders/${o._id}/authorize-return`, admin(), "POST", {});
  await pay(o, "cash-handover", 1000);
  await request(`/orders/${o._id}/confirm-return`, store(), "POST", {});
  assert.equal((await db(o)).status, "returned");
  assert.equal((await request("/driver/summary", driver())).data.cashHeldAgorot, 0);
  assert.equal(await complete(o), true);
});
test("P1-02 a failed delivery with no cash needs no record", async () => {
  const o = await arrived("customer", 15000);
  const failed = (await action(o, "fail", { reason: "Customer absent" })).data;
  assert.equal(failed.cashHandover, null); assert.equal(await complete(o), true);
  await pay(o, "cash-handover", 0, 409);
});

// ---- P1-03: admin recovery after pickup
test("P1-03 admin can record a failed delivery for an unreachable driver without releasing custody", async () => {
  const o = await final(); await pickedUp(o);
  assert.equal((await db(o)).status, "collected");
  const body = { reason: "Driver phone dead, parcel confirmed with driver by phone", actualCashCollectedAgorot: 0 };
  assert.equal((await request(`/admin/orders/${o._id}/recover`, admin(), "POST", body, 422)).data.code, "custody_confirmation_required");
  await request(`/admin/orders/${o._id}/recover`, driver(), "POST", { ...body, custodyConfirmed: true }, 403);
  await request(`/admin/orders/${o._id}/recover`, store(), "POST", { ...body, custodyConfirmed: true }, 403);
  await request(`/admin/orders/${o._id}/cancel`, admin(), "POST", { reason: "x" }, 409); // cancel stays blocked after pickup
  const recovered = (await request(`/admin/orders/${o._id}/recover`, admin(), "POST", { ...body, custodyConfirmed: true })).data;
  assert.equal(recovered.status, "delivery_failed"); assert.equal(recovered.activeAssignment, true);
  const event = (await db(o)).events.find((e) => e.type === "delivery_failed");
  assert.equal(event.actorType, "admin"); assert.equal(String(event.actorId), sessions.admin.user._id);
  assert.deepEqual([event.fromStatus, event.toStatus], ["collected", "delivery_failed"]);
  await request(`/admin/orders/${o._id}/recover`, admin(), "POST", { ...body, custodyConfirmed: true }, 409);
  await request(`/admin/orders/${o._id}/authorize-return`, admin(), "POST", {});
  await request(`/orders/${o._id}/confirm-return`, store(), "POST", {});
  assert.equal((await db(o)).activeAssignment, false);
});
test("P1-03 recovery cannot run before pickup or after delivery", async () => {
  const early = await final();
  await request(`/admin/orders/${early._id}/recover`, admin(), "POST", { reason: "x", custodyConfirmed: true }, 409);
  const done = await delivered(18000);
  await request(`/admin/orders/${done._id}/recover`, admin(), "POST", { reason: "x", custodyConfirmed: true }, 409);
});

// ---- P1-04: every sensitive action leaves an attributed event
test("P1-04 admin assignment, cancellation, link reissue and edits are attributed with before/after values", async () => {
  const a = await final();
  await request(`/admin/orders/${a._id}/assign`, admin(), "POST", { driverId: sessions.driver2.user._id });
  const assigned = (await db(a)).events.filter((e) => e.type === "driver_assigned").at(-1);
  assert.equal(assigned.actorType, "admin"); assert.equal(String(assigned.actorId), sessions.admin.user._id);
  await request(`/admin/orders/${a._id}/cancel`, admin(), "POST", { reason: "Store closed" });
  const cancelled = (await db(a)).events.find((e) => e.type === "order_cancelled");
  assert.equal(cancelled.actorType, "admin"); assert.equal(cancelled.note, "Store closed");
  assert.deepEqual([cancelled.fromStatus, cancelled.toStatus], ["driver_assigned", "cancelled"]);

  const b = await final(); const before = await db(b);
  const link = (await request(`/orders/${b._id}/customer-link/reissue`, store(), "POST", { requestId: rid() })).data.customerLink;
  const reissued = (await db(b)).events.find((e) => e.type === "customer_link_reissued");
  assert.equal(reissued.actorType, "store"); assert.equal(String(reissued.actorId), sessions.store1.user._id);
  const stored = JSON.stringify((await db(b)).events);
  assert.equal(stored.includes(before.customerToken), false); assert.equal(stored.includes(tokenOf({ customerLink: link })), false);

  const c = await final(); const snapshot = (await request(`/orders/${c._id}`, store())).data.confirmationSnapshot;
  await request(`/orders/${c._id}`, store(), "PATCH", { observed: snapshot, goodsAmountAgorot: 12345, customerPhone: "0509999999" });
  const edit = (await db(c)).events.find((e) => e.type === "order_details_edited");
  assert.equal(edit.actorType, "store");
  assert.deepEqual(edit.changes.find((x) => x.field === "goodsAmountAgorot"), { field: "goodsAmountAgorot", from: 15000, to: 12345 });
  assert.deepEqual(edit.changes.find((x) => x.field === "customerPhone"), { field: "customerPhone" }); // PII by name only
  assert.equal(JSON.stringify(edit).includes("0509999999"), false);
  await request(`/admin/orders/${c._id}/finance-terms`, admin(), "PATCH",
    { observed: (await request(`/orders/${c._id}`, admin())).data.confirmationSnapshot, deliveryFeePaidBy: "store" });
  const terms = (await db(c)).events.filter((e) => e.type === "order_details_edited").at(-1);
  assert.equal(terms.actorType, "admin");
  assert.deepEqual(terms.changes.find((x) => x.field === "deliveryFeePaidBy"), { field: "deliveryFeePaidBy", from: "customer", to: "store" });
});
test("P1-04 return authorization and confirmation are attributed", async () => {
  const o = await arrived("customer", 15000); await action(o, "fail", { reason: "Customer absent" });
  await request(`/admin/orders/${o._id}/authorize-return`, admin(), "POST", {});
  await request(`/orders/${o._id}/confirm-return`, store(), "POST", {});
  const events = (await db(o)).events;
  assert.equal(events.find((e) => e.type === "return_authorized").actorType, "admin");
  assert.equal(events.find((e) => e.type === "return_confirmed").actorType, "store");
  assert.equal(events.find((e) => e.type === "delivery_failed").actorType, "driver");
});
test("P1-04 account changes and code unlocks are stored with the change itself", async () => {
  const id = sessions.driver2.user._id;
  await request(`/admin/accounts/${id}`, admin(), "PATCH", { phone: "0501111111", password: "another-pass-1" });
  const audit = (await request(`/admin/accounts/${id}/audit`, admin())).data;
  assert.equal(audit.length, 1); assert.equal(audit[0].adminId, sessions.admin.user._id);
  assert.deepEqual(audit[0].changes.find((c) => c.field === "password"), { field: "password" });
  assert.deepEqual(audit[0].changes.find((c) => c.field === "phone"), { field: "phone" });
  assert.equal(JSON.stringify(audit).includes("another-pass-1"), false); assert.equal(JSON.stringify(audit).includes("$2"), false);
  await request(`/admin/accounts/${id}/audit`, driver(), "GET", undefined, 403);
  assert.equal("accountEvents" in (await request(`/admin/accounts`, admin())).data.find((u) => u._id === id), false);
  await request(`/admin/accounts/${id}`, admin(), "PATCH", { password: "WaselhaDemo123!" });
  await relogin("driver2");

  const o = await final(); await pickedUp(o); await action(o, "arrive-customer");
  for (let i = 0; i < 5; i++) await action(o, "deliver", { code: "000000", actualCashCollectedAgorot: 18000, observedExpectedAgorot: 18000 }, driver(), null);
  await request(`/admin/orders/${o._id}/unlock-code`, admin(), "POST", { actorId: sessions.driver1.user._id, verificationType: "delivery", note: "Verified by phone" });
  const state = await models.CodeAttemptState.findOne({ orderId: o._id }).lean();
  assert.equal(state.unlocks.length, 1); assert.equal(String(state.unlocks[0].adminId), sessions.admin.user._id);
});

// ---- P1-05: session revocation
test("P1-05 password reset and deactivation revoke earlier tokens; new sign-in works", async () => {
  const old = sessions.driver2.token;
  await request("/auth/me", old, "GET");
  await request(`/admin/accounts/${sessions.driver2.user._id}`, admin(), "PATCH", { password: "reset-password-1" });
  await request("/auth/me", old, "GET", undefined, 401);
  const fresh = (await request("/auth/login", null, "POST", { login: "driver2", password: "reset-password-1" })).data;
  await request("/auth/me", fresh.token, "GET");
  await request(`/admin/accounts/${sessions.driver2.user._id}`, admin(), "PATCH", { active: false });
  await request(`/admin/accounts/${sessions.driver2.user._id}`, admin(), "PATCH", { active: true, password: "WaselhaDemo123!" });
  await request("/auth/me", fresh.token, "GET", undefined, 401);
  await relogin("driver2");
  await request("/auth/me", sessions.driver2.token, "GET");
});
test("P1-05 tokens issued before the version field existed keep working until the account changes", async () => {
  const legacy = jwt.sign({}, process.env.JWT_SECRET, { subject: sessions.store1.user._id, expiresIn: "1h" });
  await request("/auth/me", legacy, "GET");
  await models.User.updateOne({ login: "store1" }, { $inc: { authVersion: 1 } });
  await request("/auth/me", legacy, "GET", undefined, 401);
  await models.User.updateOne({ login: "store1" }, { $set: { authVersion: 0 } });
});

// ---- P1-01: account state and assignment cannot disagree
test("P1-01 accepting while the driver is being disabled never leaves an inactive driver with an order", async () => {
  let accepted = 0, disabled = 0;
  for (let i = 0; i < 25; i++) {
    await resetOrderActionLimits(models.User);
    await models.Order.deleteMany({}); await models.User.updateOne({ login: "driver1" }, { $set: { active: true } });
    await relogin("driver1");
    const o = await create();
    const [a, d] = await Promise.all([action(o, "accept", {}, driver(), null),
      request(`/admin/accounts/${sessions.driver1.user._id}`, admin(), "PATCH", { active: false }, null)]);
    const user = await models.User.findOne({ login: "driver1" }).lean(), order = await db(o);
    assert.ok(!(user.active === false && order.activeAssignment === true), `iteration ${i}: ${a.status}/${d.status} left an inactive driver assigned`);
    if (a.status === 200) accepted++;
    if (d.status === 200) disabled++;
    assert.ok(a.status === 200 || d.status === 200 || (a.status === 409 && d.status === 409) || a.status === 401, `${a.status}/${d.status}`);
  }
  assert.ok(accepted + disabled > 0);
  await models.User.updateOne({ login: "driver1" }, { $set: { active: true } }); await relogin("driver1");
});
test("P1-01 creating an order while the store is being disabled never leaves an inactive store with a live order", async () => {
  const body = { serviceArea: "kafr-kanna", deliveryFeePaidBy: "customer", area: "Central area", customerPhone: "0501234567" };
  for (let i = 0; i < 25; i++) {
    await resetOrderActionLimits(models.User);
    await models.Order.deleteMany({}); await models.User.updateOne({ login: "store1" }, { $set: { active: true } }); await relogin("store1");
    const [c, d] = await Promise.all([request("/orders", store(), "POST", body, null),
      request(`/admin/accounts/${sessions.store1.user._id}`, admin(), "PATCH", { active: false }, null)]);
    const user = await models.User.findOne({ login: "store1" }).lean();
    const live = await models.Order.countDocuments({ status: { $nin: ["cancelled", "delivered", "returned"] } });
    assert.ok(!(user.active === false && live > 0), `iteration ${i}: ${c.status}/${d.status}`);
  }
  await models.User.updateOne({ login: "store1" }, { $set: { active: true } }); await relogin("store1");
});

// ---- P2-01: replayed commands are answered, not executed again
test("P2-01 a delayed retry-search replay after a later search cycle does not open another window", async () => {
  const o = await create(); const retry = rid();
  const expire = async () => { await models.Order.updateOne({ _id: o._id }, { $set: { searchDeadlineAt: new Date(0) } }); await runTimeoutSweep(); };
  await request(`/orders/${o._id}/retry-search`, store(), "POST", { requestId: 5 }, 400); // the ID is required and must be text
  await expire(); await request(`/orders/${o._id}/retry-search`, store(), "POST", { requestId: retry });
  await expire(); assert.equal((await db(o)).driverSearchStatus, "no_driver");
  const eventsBefore = (await db(o)).events.length;
  const replay = (await request(`/orders/${o._id}/retry-search`, store(), "POST", { requestId: retry })).data;
  assert.equal(replay.driverSearchStatus, "no_driver"); assert.equal((await db(o)).events.length, eventsBefore);
  await request(`/orders/${o._id}/retry-search`, store(), "POST", { requestId: rid() });
  assert.equal((await db(o)).driverSearchStatus, "searching");
});
test("P2-01 link reissue replay returns the issued link without rotating again; identical racing requests rotate once", async () => {
  const o = await create(); await request(`/orders/${o._id}/customer-link/reissue`, store(), "POST", {}, 200); // helper adds an ID
  const first = rid();
  const a = (await request(`/orders/${o._id}/customer-link/reissue`, store(), "POST", { requestId: first })).data;
  const second = (await request(`/orders/${o._id}/customer-link/reissue`, store(), "POST", { requestId: rid() })).data;
  const replay = (await request(`/orders/${o._id}/customer-link/reissue`, store(), "POST", { requestId: first })).data;
  assert.equal(replay.customerLink, second.customerLink); assert.notEqual(replay.customerLink, a.customerLink);
  const racing = rid(), before = (await db(o)).events.length;
  const results = await Promise.all(Array.from({ length: 10 }, () => request(`/orders/${o._id}/customer-link/reissue`, store(), "POST", { requestId: racing }, null)));
  assert.ok(results.every((r) => r.status === 200)); assert.equal(new Set(results.map((r) => r.data.customerLink)).size, 1);
  assert.equal((await db(o)).events.length, before + 1);
  await request(`/orders/${o._id}/customer-link/reissue`, store(), "POST", { requestId: 5 }, 400);
});

// ---- P1-06: pilot configuration and provisioning
test("P1-06 production refuses example secrets, plain HTTP and demo accounts", async () => {
  const good = { jwtSecret: "k3Jd9fQ2xL0pVb7TzW1mNc8RhY4uGa6E", publicBaseUrl: "https://waselha.app" };
  assert.deepEqual(productionConfigProblems(good), []);
  for (const jwtSecret of [undefined, "short", "change-this-local-demo-secret-padding-padding", "access-security-test-secret-0000000"])
    assert.equal(productionConfigProblems({ ...good, jwtSecret }).length, 1, String(jwtSecret));
  assert.equal(productionConfigProblems({ ...good, publicBaseUrl: "http://waselha.example" }).length, 1);
  assert.deepEqual((await demoAccountsPresent()).sort(), ["admin", "driver1", "driver2", "store1"]);
});
test("P1-06 seed is disabled in production and create-admin sets or resets a real administrator", async () => {
  process.env.NODE_ENV = "production";
  try { await assert.rejects(seed(), /disabled in production/); } finally { delete process.env.NODE_ENV; }
  await assert.rejects(createAdmin({ login: "owner", password: "WaselhaDemo123!" }), /ADMIN_PASSWORD/);
  await assert.rejects(createAdmin({ login: "owner", password: "short" }), /ADMIN_PASSWORD/);
  await assert.rejects(createAdmin({ login: "store1", password: "a-long-enough-password" }), /non-admin/);
  assert.equal(await createAdmin({ login: "Owner", password: "a-long-enough-password" }), "created");
  const token = (await request("/auth/login", null, "POST", { login: "owner", password: "a-long-enough-password" })).data.token;
  assert.equal(await createAdmin({ login: "owner", password: "another-long-password" }), "updated");
  await request("/auth/me", token, "GET", undefined, 401);
  await request("/auth/login", null, "POST", { login: "owner", password: "another-long-password" });
  await models.User.deleteOne({ login: "owner" });
});

// ---- P2-03 / P2-05 / P2-06: operations, abuse limits, link hygiene
test("P2-03 readiness checks the database and index; stuck-order list is admin only", async () => {
  const ready = await request("/ready", null, "GET", undefined, null);
  assert.equal(ready.status, 200); assert.equal(ready.data.database, true); assert.equal(ready.data.activeDriverIndex, true);
  await request("/admin/ops/stuck", null, "GET", undefined, 401);
  await request("/admin/ops/stuck", store(), "GET", undefined, 403);
  const o = await final(); await pickedUp(o);
  assert.deepEqual((await request("/admin/ops/stuck", admin())).data, []);
  await models.Order.collection.updateOne({ _id: (await db(o))._id }, { $set: { updatedAt: new Date(Date.now() - 5 * 3600 * 1000) } });
  const stuck = (await request("/admin/ops/stuck", admin())).data;
  assert.equal(stuck.length, 1); assert.equal(stuck[0].status, "collected"); assert.equal(stuck[0].reason, "no_progress");
});
test("P2-05 the per-IP limiter answers 429 with Retry-After and is bounded", async () => {
  const app = express(); app.use(rateLimit(3)); app.get("/", (req, res) => res.json({ ok: true }));
  app.use((error, req, res, next) => res.status(error.status).set("Retry-After", String(error.retryAfterSeconds)).json({ code: error.code }));
  const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    for (let i = 0; i < 3; i++) assert.equal((await fetch(url)).status, 200);
    const blocked = await fetch(url);
    assert.equal(blocked.status, 429); assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
  } finally { server.close(); }
});
test("P2-05 unknown-login attempt states expire by TTL", async () => {
  await request("/auth/login", null, "POST", { login: "nobody-here", password: "x" }, 401);
  const state = await loginStates().findOne({ _id: "nobody-here" });
  assert.ok(state.expiresAt > new Date());
  assert.ok((await loginStates().indexes()).some((i) => i.key.expiresAt === 1 && i.expireAfterSeconds === 0));
});
test("P2-06 API and customer responses are not cacheable and never send referrers", async () => {
  const o = await final();
  const response = await fetch(`${new URL(o.customerLink).origin}/api/customer/${tokenOf(o)}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.ok(response.headers.get("x-request-id"));
});
test("P1-01 an order inserted by a request that authenticated before the store was disabled is cancelled at once", async () => {
  const { createOrder } = await import("../src/services/orders.js");
  const authenticated = await models.User.findOne({ login: "store1" }).lean();
  await models.User.updateOne({ login: "store1" }, { $set: { active: false } });
  try {
    await assert.rejects(createOrder(authenticated, { serviceArea: "kafr-kanna", deliveryFeePaidBy: "customer", area: "A", customerPhone: "0501234567" }), /unauthorized/);
  } finally { await models.User.updateOne({ login: "store1" }, { $set: { active: true } }); }
  const orders = await models.Order.find().lean();
  assert.equal(orders.length, 1); assert.equal(orders[0].status, "cancelled"); assert.equal(orders[0].cancellationReason, "store_inactive");
  assert.equal(orders[0].events.at(-1).type, "order_cancelled");
});
