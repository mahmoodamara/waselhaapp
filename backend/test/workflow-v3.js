import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { models, sessions, request as baseRequest, tokenOf, destination, router, restart } from "./helpers/security.js";
const request = (path, token, method, body, expected) => baseRequest(path, token, method, body, expected, { "x-waselha-workflow": "3" });

const store = () => sessions.store1.token;
const driver = () => sessions.driver1.token;
const raw = o => models.Order.findById(o._id).lean();
const cv = async o => (await request(`/customer/${tokenOf(o)}`)).data;
const sv = async o => (await request(`/orders/${o._id}`, store())).data;
const make = async extra => (await request("/orders", store(), "POST", {
  workflowVersion: 3, storeAuthorization: true, customerPhone: "0501234567",
  vehicleType: "motorcycle", parcelSize: "medium", parcelReady: true,
  goodsAmountAgorot: 8000, goodsPaymentStatus: "unpaid", deliveryFeePaidBy: "customer", ...extra,
}, 201)).data;
async function confirm(o, available = true) {
  await request(`/customer/${tokenOf(o)}/location`, null, "POST", destination);
  return (await request(`/customer/${tokenOf(o)}/confirm`, null, "POST", {
    recipientName: "Customer", customerPhone: "0501234567", available,
    observed: (await cv(o)).confirmationSnapshot,
  })).data;
}
const accept = async (o, version, expected = 200) => {
  await request("/driver/orders/available", driver());
  return request(`/orders/${o._id}/accept`, driver(), "POST", { dispatchVersion: version, supportedWorkflowVersion: 3 }, expected);
};
beforeEach(async () => {
  router.reset();
  await request("/store/pickup-service-area", store(), "PUT", { pickupServiceArea: "kafr-kanna" });
  await models.User.updateOne({ _id: sessions.driver1.user._id }, { $set: { supportedWorkflowVersion: 3 } });
});

test("v3 waits for both parties and readiness does not void customer consent", async () => {
  const o = await make({ parcelReady: false });
  const customer = await confirm(o);
  assert.equal(customer.dispatchState, "waiting_store");
  assert.equal((await raw(o)).driverSearchStatus, "waiting");
  const view = await sv(o);
  const ready = (await request(`/orders/${o._id}`, store(), "PATCH", {
    parcelReady: true, observed: view.confirmationSnapshot,
  })).data;
  assert.equal(ready.customerConfirmed, true);
  assert.equal(ready.driverSearchStatus, "searching");
  assert.equal(ready.customerConfirmedRevision, ready.detailsRevision);
});

test("v3 old offers are rejected after pause/resume and old clients cannot accept", async () => {
  const o = await make();
  const first = await confirm(o);
  const version = (await raw(o)).dispatchVersion;
  await request(`/customer/${tokenOf(o)}/availability`, null, "POST", { available: false });
  await request(`/customer/${tokenOf(o)}/availability`, null, "POST", { available: true });
  assert.ok((await raw(o)).dispatchVersion > version);
  assert.equal((await accept(o, version, 409)).data.code, "offer_expired");
  assert.equal((await request(`/orders/${o._id}/accept`, driver(), "POST", {}, 409)).data.code, "app_update_required");
  assert.equal(first.customerConfirmed, true);
});

test("v3 direct pickup and delivery are idempotent and never invent arrival timestamps", async () => {
  const o = await make();
  await confirm(o);
  const before = await raw(o);
  await accept(o, before.dispatchVersion);
  let view = await sv(o);
  assert.equal(view.pickupCode, undefined);
  assert.ok(view.driverAgreement.acceptedAt);
  const pickup = { requestId: "v3-pickup", supportedWorkflowVersion: 3 };
  await request(`/orders/${o._id}/pickup`, driver(), "POST", pickup);
  await request(`/orders/${o._id}/pickup`, driver(), "POST", pickup);
  let saved = await raw(o);
  assert.equal(saved.status, "collected");
  assert.equal(saved.arrivedStoreAt, undefined);
  assert.match((await cv(o)).deliveryCode, /^[1-9]\d{3}$/);
  assert.equal((await request(`/orders/${o._id}`, driver())).data.deliveryCodeLength, 4);
  const body = { requestId: "v3-deliver", code: saved.deliveryCode,
    actualCashCollectedAgorot: saved.expectedCustomerCashAgorot, observedExpectedAgorot: saved.expectedCustomerCashAgorot };
  await request(`/orders/${o._id}/deliver`, driver(), "POST", body);
  await request(`/orders/${o._id}/deliver`, driver(), "POST", body);
  saved = await raw(o);
  assert.equal(saved.status, "delivered");
  assert.equal(saved.arrivedCustomerAt, undefined);
  assert.equal(saved.events.filter(e => e.type === "cash_collected").length, 1);
  assert.equal((await cv(o)).deliveryCode, undefined);
  assert.equal((await request(`/orders/${o._id}/deliver`, driver(), "POST", { ...body, actualCashCollectedAgorot: 0 }, 409)).data.code, "operation_conflict");
});

test("v3 prepaid goods are excluded from cash and merchant settlement", async () => {
  const { financeDue } = await import("../src/services/orderFinance.js");
  for (const prepaid of [false, true]) for (const payer of ["customer", "store"]) {
    const o = await make({ goodsPaymentStatus: prepaid ? "prepaid" : "unpaid", deliveryFeePaidBy: payer });
    await confirm(o, false);
    const saved = await raw(o);
    assert.equal(saved.expectedCustomerCashAgorot, (prepaid ? 0 : 8000) + (payer === "customer" ? saved.deliveryFeeAgorot : 0));
  }
  assert.equal(financeDue({ status: "delivered", actualCashCollectedAgorot: 0,
    financialSnapshot: { goodsAmountAgorot: 8000, goodsPaymentStatus: "prepaid", storeDeliveryFeeLiabilityAgorot: 4000,
      driverEarningsAgorot: 3600 } }).storeSettlementDirection, "collect_from_store");
});

test("v3 accepted financial terms cannot be edited under the driver", async () => {
  const o = await make(); await confirm(o); await accept(o, (await raw(o)).dispatchVersion);
  const view = await sv(o);
  assert.equal((await request(`/orders/${o._id}`, store(), "PATCH", {
    goodsAmountAgorot: 9000, observed: view.confirmationSnapshot,
  }, 409)).data.code, "editing_blocked");
});

test("v3 coverage follows the town polygon and never saves an outside address", async () => {
  const { deliveryAreaFor } = await import("../src/services/coverage.js");
  assert.equal(deliveryAreaFor({ lat: 32.7459862, lng: 35.3398025 }), "kafr-kanna");
  assert.equal(deliveryAreaFor({ lat: 32.70, lng: 35.30 }), null);
  // Inside the bounding box but outside the actual polygon.
  assert.equal(deliveryAreaFor({ lat: 32.733, lng: 35.328 }), null);
  const o = await make();
  assert.equal((await request(`/customer/${tokenOf(o)}/location`, null, "POST", {
    ...destination, lat: 32.70, lng: 35.30,
  }, 422)).data.code, "outside_delivery_area");
  assert.equal((await raw(o)).destinationLocation, undefined);
  assert.equal((await raw(o)).driverSearchStatus, "waiting");
});

test("v3 readiness and availability races start one search and old clients see no new offers", async () => {
  const o = await make({ parcelReady: false });
  await confirm(o, false);
  const view = await sv(o);
  await Promise.all([
    request(`/orders/${o._id}/readiness`, store(), "POST", { ready: true, observed: view.confirmationSnapshot }),
    request(`/customer/${tokenOf(o)}/availability`, null, "POST", { available: true }, null),
  ]);
  const { startReadyDispatches } = await import("../src/services/orders.js");
  await Promise.all([startReadyDispatches(), startReadyDispatches()]);
  const saved = await raw(o);
  assert.equal(saved.driverSearchStatus, "searching");
  assert.equal(saved.events.filter(e => e.type === "driver_search_started").length, 1);
  assert.equal(saved.customerConfirmedRevision, saved.detailsRevision);
  const old = await baseRequest("/driver/orders/available", driver());
  assert.deepEqual(old.data, []);
  const modern = await request("/driver/orders/available", driver());
  assert.ok(modern.data.some(offer => offer._id === o._id && offer.dispatchVersion === saved.dispatchVersion));
});

test("v3 changes invalidate the consent revision atomically; readiness alone preserves it", async () => {
  const o = await make(); await confirm(o);
  let view = await sv(o);
  const revision = view.detailsRevision;
  await request(`/orders/${o._id}/readiness`, store(), "POST", { ready: false, observed: view.confirmationSnapshot });
  let saved = await raw(o);
  assert.equal(saved.driverSearchStatus, "waiting");
  assert.equal(saved.customerConfirmedRevision, revision);
  view = await sv(o);
  await request(`/orders/${o._id}`, store(), "PATCH", { goodsPaymentStatus: "prepaid", observed: view.confirmationSnapshot });
  saved = await raw(o);
  assert.equal(saved.customerConfirmed, false);
  assert.ok(saved.detailsRevision > revision);
  assert.equal(saved.customerConfirmedRevision, null);
  assert.equal(saved.customerAgreement, null);
  assert.equal(saved.driverSearchStatus, "waiting");
});

test("v3 two drivers race for one order and one driver races for two orders", async () => {
  await models.User.updateOne({ _id: sessions.driver2.user._id }, { $set: { supportedWorkflowVersion: 3 } });
  const first = await make(); await confirm(first);
  await request("/driver/orders/available", driver());
  const version = (await raw(first)).dispatchVersion;
  const results = await Promise.all([sessions.driver1.token, sessions.driver2.token].map(token =>
    request(`/orders/${first._id}/accept`, token, "POST", { supportedWorkflowVersion: 3, dispatchVersion: version }, null)));
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal((await raw(first)).events.filter(e => e.type === "driver_assigned").length, 1);
  // Free the winner before the second race.
  await models.Order.deleteMany({});
  const a = await make(), b = await make(); await confirm(a); await confirm(b);
  await request("/driver/orders/available", driver());
  const accepts = await Promise.all([a, b].map(async o => request(`/orders/${o._id}/accept`, driver(), "POST", {
    supportedWorkflowVersion: 3, dispatchVersion: (await raw(o)).dispatchVersion,
  }, null)));
  assert.equal(accepts.filter(r => r.status === 200).length, 1);
  assert.equal(await models.Order.countDocuments({ driverId: sessions.driver1.user._id, activeAssignment: true }), 1);
});

test("v3 concurrent pickup/delivery replay once and preserve explicit arrivals", async () => {
  const o = await make(); await confirm(o); await accept(o, (await raw(o)).dispatchVersion);
  await request(`/orders/${o._id}/arrive-store`, driver(), "POST", { requestId: "arrive-store" });
  const arrival = (await raw(o)).arrivedStoreAt;
  const pickups = await Promise.all(Array.from({ length: 5 }, () => request(`/orders/${o._id}/pickup`, driver(), "POST", { requestId: "pickup-race" }, null)));
  assert.ok(pickups.every(r => r.status === 200), JSON.stringify(pickups.map(r => r.data.code)));
  let saved = await raw(o);
  assert.equal(saved.arrivedStoreAt.getTime(), arrival.getTime());
  await request(`/orders/${o._id}/arrive-customer`, driver(), "POST", { requestId: "arrive-customer" });
  const body = { requestId: "deliver-race", code: saved.deliveryCode,
    actualCashCollectedAgorot: saved.expectedCustomerCashAgorot - 100, observedExpectedAgorot: saved.expectedCustomerCashAgorot,
    confirmDifference: true, differenceReason: "Customer paid less" };
  const deliveries = await Promise.all(Array.from({ length: 5 }, () => request(`/orders/${o._id}/deliver`, driver(), "POST", body, null)));
  assert.ok(deliveries.every(r => r.status === 200), JSON.stringify(deliveries.map(r => r.data.code)));
  saved = await raw(o);
  assert.equal(saved.events.filter(e => e.type === "cash_collected").length, 1);
  assert.equal(saved.collectionAdjustment.status, "open");
  assert.equal(saved.collectionDifferenceReason, "Customer paid less");
  assert.ok(saved.arrivedCustomerAt);
});

test("v3 prepaid settlement, zero cash delivery and financial freeze survive routing retries", async () => {
  const o = await make({ goodsPaymentStatus: "prepaid", deliveryFeePaidBy: "store" });
  await confirm(o);
  const agreed = await raw(o);
  router.distance = 4000;
  await request(`/orders/${o._id}/recalculate-price`, store(), "POST", {});
  assert.equal((await raw(o)).deliveryFeeAgorot, agreed.deliveryFeeAgorot);
  await accept(o, agreed.dispatchVersion);
  assert.equal((await baseRequest("/driver/orders/current", driver(), "GET", undefined, 409)).data.code, "app_update_required");
  await request(`/orders/${o._id}/pickup`, driver(), "POST", { requestId: "zero-pickup" });
  const saved = await raw(o);
  assert.equal(saved.expectedCustomerCashAgorot, 0);
  await request(`/orders/${o._id}/deliver`, driver(), "POST", {
    requestId: "zero-delivery", code: saved.deliveryCode, observedExpectedAgorot: 0, actualCashCollectedAgorot: 0,
  });
  const delivered = await raw(o);
  const { financeDue } = await import("../src/services/orderFinance.js");
  const due = financeDue(delivered);
  assert.equal(due.storeSettlementDirection, "collect_from_store");
  assert.equal(due.storeSettlementAgorot, saved.deliveryFeeAgorot);
  for (const [action, amount] of [["cash-handover", 0], ["driver-payout", null], ["store-settlement", due.storeSettlementAgorot]]) {
    await request(`/admin/orders/${o._id}/finance/${action}`, sessions.admin.token, "POST", {
      requestId: `zero-${action}`, ...(amount === null ? {} : { amountAgorot: amount }),
    });
  }
  const { financeComplete } = await import("../src/services/orderFinance.js");
  assert.equal(financeComplete(await raw(o)), true);
});

test("v3 assignment timeout advances the dispatch generation", async () => {
  const o = await make(); await confirm(o);
  const original = (await raw(o)).dispatchVersion;
  await accept(o, original);
  await models.Order.updateOne({ _id: o._id }, { $set: { storeArrivalDeadlineAt: new Date(Date.now() - 1000) } });
  const { processExpiredAssignments } = await import("../src/services/orderTimeouts.js");
  await processExpiredAssignments(new Date());
  const saved = await raw(o);
  assert.ok(saved.dispatchVersion > original);
  assert.equal(saved.driverAgreement, undefined);
});

test("v3 the same customer-confirmation command is replayed without applying an old answer again", async () => {
  const o = await make();
  await request(`/customer/${tokenOf(o)}/location`, null, "POST", destination);
  const body = { requestId: "customer-one-confirmation", recipientName: "Customer", customerPhone: "0501234567",
    available: false, observed: (await cv(o)).confirmationSnapshot };
  await request(`/customer/${tokenOf(o)}/confirm`, null, "POST", body);
  const noop = { ...body, requestId: "customer-noop-confirmation", observed: (await cv(o)).confirmationSnapshot };
  await request(`/customer/${tokenOf(o)}/confirm`, null, "POST", noop);
  const repeats = await Promise.all(Array.from({ length: 4 }, () => request(`/customer/${tokenOf(o)}/confirm`, null, "POST", body, null)));
  assert.ok(repeats.every(r => r.status === 200));
  await request(`/customer/${tokenOf(o)}/availability`, null, "POST", { available: true });
  await request(`/customer/${tokenOf(o)}/confirm`, null, "POST", body);
  await request(`/customer/${tokenOf(o)}/confirm`, null, "POST", noop);
  assert.equal((await raw(o)).customerAvailable, true);
  assert.equal((await raw(o)).events.filter(e => e.type === "driver_search_started").length, 1);
  assert.equal((await request(`/customer/${tokenOf(o)}/confirm`, null, "POST", { ...body, available: true }, 409)).data.code, "operation_conflict");
});

test("v3 rollout switch stops new creation without blocking existing orders", async () => {
  const o = await make();
  try {
    process.env.UNIFIED_DELIVERY_ENABLED = "false"; await restart();
    const result = await request("/orders", store(), "POST", { workflowVersion: 3 }, 409);
    assert.equal(result.data.code, "unified_delivery_disabled");
    const confirmed = await confirm(o, false);
    assert.equal(confirmed.customerConfirmed, true);
  } finally { delete process.env.UNIFIED_DELIVERY_ENABLED; await restart(); }
});

test("v3 admin recovery and return preserve custody without needing a driver command ID", async () => {
  const o = await make(); await confirm(o); await accept(o, (await raw(o)).dispatchVersion);
  await request(`/orders/${o._id}/pickup`, driver(), "POST", { requestId: "support-pickup" });
  await request(`/admin/orders/${o._id}/recover`, sessions.admin.token, "POST", {
    reason: "Driver phone unavailable", custodyConfirmed: true, actualCashCollectedAgorot: 0,
  });
  let saved = await raw(o);
  assert.equal(saved.status, "delivery_failed"); assert.equal(saved.activeAssignment, true);
  await request(`/admin/orders/${o._id}/authorize-return`, sessions.admin.token, "POST", {});
  await request(`/orders/${o._id}/confirm-return`, store(), "POST", {});
  saved = await raw(o);
  assert.equal(saved.status, "returned"); assert.equal(saved.activeAssignment, false);
});

test("v3 legacy route endpoint cannot reveal an assignment to an old client", async () => {
  const o = await make(); await confirm(o); await accept(o, (await raw(o)).dispatchVersion);
  const old = await baseRequest("/driver/orders/current/route", driver(), "GET", undefined, null);
  assert.equal(old.status, 409); assert.equal(old.data.code, "app_update_required");
});

// Audit additions: real HTTP/MongoDB behavior missing from the existing v3 cases.
test("audit S10: concurrent no-op confirmations retain both replay IDs and never restore an old Later choice", async t => {
  const o = await make(); await confirm(o, false);
  const view = await cv(o);
  const bodies = ['noop-device-a', 'noop-device-b'].map(requestId => ({
    requestId, recipientName: view.recipientName, customerPhone: view.customerPhone,
    available: false, observed: view.confirmationSnapshot,
  }));
  const results = await Promise.all(bodies.map(body => request(`/customer/${tokenOf(o)}/confirm`, null, 'POST', body, null)));
  assert.ok(results.every(r => r.status === 200));
  t.diagnostic(JSON.stringify({ stage: 'concurrent-acks', statuses: results.map(r => r.status),
    rememberedIds: (await raw(o)).operations.map(op => op.requestId) }));
  await request(`/customer/${tokenOf(o)}/availability`, null, 'POST', { available: true });
  for (const body of bodies) await request(`/customer/${tokenOf(o)}/confirm`, null, 'POST', body);
  const saved = await raw(o);
  t.diagnostic(JSON.stringify({ stage: 'after-ready-and-replays', customerAvailable: saved.customerAvailable,
    driverSearchStatus: saved.driverSearchStatus }));
  assert.equal(saved.customerAvailable, true, 'an acknowledged concurrent confirmation replay must not restore Later');
  assert.ok(bodies.every(body => saved.operations.some(op => op.requestId === body.requestId)));
});

test("v3 concurrent confirmation replays append one identity and reject conflicting payloads or actors", async () => {
  const { confirmCustomer } = await import('../src/services/orders.js');
  const o = await make(); await confirm(o, false);
  const before = await raw(o), view = await cv(o);
  const body = { requestId: 'concurrent-same-command', recipientName: view.recipientName,
    customerPhone: view.customerPhone, available: false, observed: view.confirmationSnapshot };
  // Both commands hold the same pre-write document, as concurrent HTTP reads can.
  await Promise.all([confirmCustomer(before, body), confirmCustomer(before, body)]);
  let saved = await raw(o);
  assert.equal(saved.operations.filter(op => op.requestId === body.requestId).length, 1);
  await request(`/customer/${tokenOf(o)}/availability`, null, 'POST', { available: true });
  const replay = await confirmCustomer(before, body);
  assert.equal(replay.customerAvailable, true, 'a stale in-flight replay returns current state');
  await assert.rejects(confirmCustomer(before, { ...body, available: true }), { code: 'operation_conflict' });
  saved = await raw(o);
  assert.equal(saved.customerAvailable, true);
  const actorBody = { ...body, requestId: 'existing-driver-command' };
  await models.Order.updateOne({ _id: o._id }, { $push: { operations: {
    requestId: actorBody.requestId, action: 'pickup', actorId: sessions.driver1.user._id, digest: 'driver-digest', at: new Date(),
  } } });
  await assert.rejects(confirmCustomer(saved, actorBody), { code: 'operation_conflict' });
});

test("audit S4: two customer devices cannot overwrite a newer confirmation with a stale screen", async () => {
  const o = await make();
  await request(`/customer/${tokenOf(o)}/location`, null, "POST", destination);
  const [a, b] = await Promise.all([cv(o), cv(o)]);
  const results = await Promise.all([a, b].map((view, index) => request(`/customer/${tokenOf(o)}/confirm`, null, "POST", {
    requestId: `device-${index}`, recipientName: `Device ${index}`, customerPhone: "0501234567",
    available: false, observed: view.confirmationSnapshot,
  }, null)));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const winner = results.find(r => r.status === 200).data.recipientName;
  assert.equal((await raw(o)).recipientName, winner);
  const stale = await request(`/customer/${tokenOf(o)}/details`, null, "POST", {
    recipientName: "Stale device", customerPhone: "0501234567", observed: a.confirmationSnapshot,
  }, 409);
  assert.equal(stale.data.code, "stale_details");
  assert.equal((await raw(o)).recipientName, winner);
});

test("audit S12: polygon edge is accepted and a point immediately west of the town is rejected", async () => {
  const { default: boundary } = await import('../../shared/kafr-kanna-boundary.json', { with: { type: 'json' } });
  const rings = boundary.geometry.type === 'Polygon' ? [boundary.geometry.coordinates] : boundary.geometry.coordinates;
  const west = rings.flatMap(p => p[0]).reduce((a, b) => b[0] < a[0] ? b : a);
  const o = await make();
  await request(`/customer/${tokenOf(o)}/location`, null, "POST", { ...destination, lng: west[0], lat: west[1] });
  const saved = await raw(o);
  const outside = await request(`/customer/${tokenOf(o)}/location`, null, "POST", {
    ...destination, lng: west[0] - 0.00001, lat: west[1],
  }, 422);
  assert.equal(outside.data.code, "outside_delivery_area");
  assert.deepEqual((await raw(o)).destinationLocation, saved.destinationLocation);
});

test("audit S20/22/23: v3 deadline expires before sweep, no-driver is explicit, retry invalidates the old round", async () => {
  const o = await make(); await confirm(o);
  const version = (await raw(o)).dispatchVersion;
  await models.Order.updateOne({ _id: o._id }, { $set: { searchDeadlineAt: new Date(Date.now() - 1000) } });
  await accept(o, version, 409);
  assert.equal((await raw(o)).activeAssignment, false);
  const { processExpiredSearches } = await import('../src/services/orderTimeouts.js');
  await processExpiredSearches();
  const timedOut = await cv(o);
  assert.equal(timedOut.dispatchState, 'no_driver');
  assert.equal((await raw(o)).status, 'searching_driver');
  await request(`/orders/${o._id}/retry-search`, store(), 'POST', { requestId: 'audit-retry' });
  assert.ok((await raw(o)).dispatchVersion > version);
  assert.equal((await accept(o, version, 409)).data.code, 'offer_expired');
});

test("audit S27/28/46/47: v3 merchant cancellation is limited to unassigned search substates", async () => {
  for (const substate of ['waiting', 'searching', 'no_driver']) {
    const o = await make();
    if (substate !== 'waiting') await confirm(o);
    if (substate === 'no_driver') {
      await models.Order.updateOne({ _id: o._id }, { $set: { searchDeadlineAt: new Date(0) } });
      const { processExpiredSearches } = await import('../src/services/orderTimeouts.js');
      await processExpiredSearches();
    }
    await request(`/orders/${o._id}/cancel`, store(), 'POST', {});
    const saved = await raw(o);
    assert.equal(saved.status, 'cancelled'); assert.equal(saved.activeAssignment, false);
    assert.equal(saved.financialSnapshot, undefined); assert.equal(saved.actualCashCollectedAgorot, null);
    assert.equal(saved.events.filter(e => e.type === 'store_cancelled').length, 1);
    assert.equal((await cv(o)).deliveryCode, undefined);
    assert.equal((await request(`/customer/${tokenOf(o)}/confirm`, null, 'POST', {}, 409)).data.code, 'editing_blocked');
  }
  const o = await make(); await confirm(o); await accept(o, (await raw(o)).dispatchVersion);
  await request(`/orders/${o._id}/cancel`, store(), 'POST', {}, 409);
  await request(`/orders/${o._id}/cancel`, driver(), 'POST', {}, 403);
  await request(`/admin/orders/${o._id}/cancel`, store(), 'POST', {}, 403);
  assert.equal((await raw(o)).status, 'driver_assigned');
});

test("audit S46/47: v3 admin cancellation releases custody before pickup and is refused at every later stage", async () => {
  for (const stage of ['driver_assigned','driver_at_store','collected','driver_at_destination','delivery_failed','returning','returned','delivered']) {
    await models.Order.deleteMany({});
    const o = await make(); await confirm(o); await accept(o, (await raw(o)).dispatchVersion);
    if (stage === 'driver_at_store') await request(`/orders/${o._id}/arrive-store`, driver(), 'POST', { requestId: 'audit-arrive' });
    if (!['driver_assigned','driver_at_store'].includes(stage)) {
      await request(`/orders/${o._id}/pickup`, driver(), 'POST', { requestId: 'audit-pickup' });
      if (stage === 'driver_at_destination') await request(`/orders/${o._id}/arrive-customer`, driver(), 'POST', { requestId: 'audit-arrive' });
      if (['delivery_failed','returning','returned'].includes(stage)) {
        await request(`/orders/${o._id}/fail`, driver(), 'POST', { requestId: 'audit-fail', reason: 'Customer unreachable', actualCashCollectedAgorot: 0 });
        if (stage !== 'delivery_failed') await request(`/admin/orders/${o._id}/authorize-return`, sessions.admin.token, 'POST', {});
        if (stage === 'returned') await request(`/orders/${o._id}/confirm-return`, store(), 'POST', {});
      }
      if (stage === 'delivered') {
        const saved = await raw(o);
        await request(`/orders/${o._id}/deliver`, driver(), 'POST', { requestId: 'audit-deliver', code: saved.deliveryCode,
          actualCashCollectedAgorot: saved.expectedCustomerCashAgorot, observedExpectedAgorot: saved.expectedCustomerCashAgorot });
      }
    }
    const before = await raw(o);
    assert.equal(before.status, stage);
    const allowed = ['driver_assigned','driver_at_store'].includes(stage);
    await request(`/admin/orders/${o._id}/cancel`, sessions.admin.token, 'POST', { reason: 'Audit cancellation' }, allowed ? 200 : 409);
    const after = await raw(o);
    assert.equal(after.status, allowed ? 'cancelled' : stage);
    assert.equal(after.activeAssignment, allowed ? false : before.activeAssignment);
    assert.deepEqual(after.financialSnapshot, before.financialSnapshot);
    assert.equal(after.actualCashCollectedAgorot, before.actualCashCollectedAgorot);
  }
});

test("audit S38/39/40: v3 four-digit delivery code is stage-gated, fifth failure locks, admin unlock recovers", async () => {
  const o = await make(); await confirm(o); await accept(o, (await raw(o)).dispatchVersion);
  let saved = await raw(o);
  const body = { requestId: 'audit-code', code: saved.deliveryCode,
    actualCashCollectedAgorot: saved.expectedCustomerCashAgorot, observedExpectedAgorot: saved.expectedCustomerCashAgorot };
  await request(`/orders/${o._id}/deliver`, driver(), 'POST', body, 409);
  assert.equal(await models.CodeAttempt.countDocuments({ orderId: o._id }), 0);
  await request(`/orders/${o._id}/pickup`, driver(), 'POST', { requestId: 'audit-code-pickup' });
  const wrong = saved.deliveryCode === '1111' ? '2222' : '1111';
  for (let i = 1; i <= 5; i++) {
    const result = await request(`/orders/${o._id}/deliver`, driver(), 'POST', { ...body, requestId: `wrong-${i}`, code: wrong }, i < 5 ? 422 : 429);
    assert.equal(result.data.code, i < 5 ? 'incorrect_delivery_code' : 'too_many_attempts');
    if (i === 5) assert.ok(result.data.retryAfterSeconds > 0);
  }
  await request(`/orders/${o._id}/deliver`, driver(), 'POST', body, 429);
  assert.equal((await raw(o)).status, 'collected');
  assert.equal(await models.CodeAttempt.countDocuments({ orderId: o._id }), 5);
  await request(`/admin/orders/${o._id}/unlock-code`, sessions.admin.token, 'POST', { verificationType: 'delivery', actorId: sessions.driver1.user._id, note: 'Audit recovery' });
  await request(`/orders/${o._id}/deliver`, driver(), 'POST', body);
  await request(`/orders/${o._id}/deliver`, driver(), 'POST', { ...body, requestId: 'used-code-again' }, 404);
  saved = await raw(o);
  assert.equal(saved.events.filter(e => e.type === 'cash_collected').length, 1);
});

test("audit S50: a database error before delivery commit preserves money and permits a safe retry", async t => {
  const o = await make(); await confirm(o); await accept(o, (await raw(o)).dispatchVersion);
  await request(`/orders/${o._id}/pickup`, driver(), 'POST', { requestId: 'fault-pickup' });
  const before = await raw(o);
  const { transition } = await import('../src/services/orders.js');
  const actor = await models.User.findById(sessions.driver1.user._id).lean();
  const body = { requestId: 'fault-delivery', code: before.deliveryCode,
    actualCashCollectedAgorot: before.expectedCustomerCashAgorot, observedExpectedAgorot: before.expectedCustomerCashAgorot };
  const original = models.Order.findOneAndUpdate;
  const mock = t.mock.method(models.Order, 'findOneAndUpdate', function(filter, update, ...args) {
    if (update.$set?.status === 'delivered') throw new Error('audit-injected-database-failure');
    return original.call(this, filter, update, ...args);
  });
  try { await assert.rejects(transition(before, 'deliver', body, { actor }), /audit-injected-database-failure/); }
  finally { mock.mock.restore(); }
  const unchanged = await raw(o);
  assert.equal(unchanged.status, 'collected'); assert.equal(unchanged.actualCashCollectedAgorot, null);
  assert.equal(unchanged.events.filter(e => e.type === 'cash_collected').length, 0);
  assert.equal(unchanged.cashHandover, undefined);
  await request(`/orders/${o._id}/deliver`, driver(), 'POST', body);
  assert.equal((await raw(o)).events.filter(e => e.type === 'cash_collected').length, 1);
});

test("audit S50: crash between customer consent and dispatch is repaired by the readiness sweep", async t => {
  const o = await make();
  await request(`/customer/${tokenOf(o)}/location`, null, 'POST', destination);
  const before = await raw(o);
  const { confirmCustomer, startReadyDispatches } = await import('../src/services/orders.js');
  const original = models.Order.findOneAndUpdate;
  const mock = t.mock.method(models.Order, 'findOneAndUpdate', function(filter, update, ...args) {
    if (update.$set?.driverSearchStatus === 'searching') throw new Error('audit-dispatch-crash');
    return original.call(this, filter, update, ...args);
  });
  try {
    await assert.rejects(confirmCustomer(before, { requestId: 'crash-consent', recipientName: 'Customer', customerPhone: '0501234567',
      available: true, observed: (await cv(o)).confirmationSnapshot }), /audit-dispatch-crash/);
  } finally { mock.mock.restore(); }
  let saved = await raw(o);
  assert.equal(saved.customerConfirmed, true); assert.equal(saved.driverSearchStatus, 'waiting');
  await startReadyDispatches(); await startReadyDispatches();
  saved = await raw(o);
  assert.equal(saved.driverSearchStatus, 'searching');
  assert.equal(saved.events.filter(e => e.type === 'driver_search_started').length, 1);
});
