import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { models, sessions, router, request, tokenOf, destination, restart } from "./helpers/security.js";

const store = () => sessions.store1.token;
const driver = () => sessions.driver1.token;
const view = async o => (await request(`/orders/${o._id}`, driver())).data;
const storeView = async o => (await request(`/orders/${o._id}`, store())).data;
const customer = async o => (await request(`/customer/${tokenOf(o)}`)).data;
const quick = async extra => (await request("/orders", store(), "POST", {
  workflowVersion: 2, storeAuthorization: true, serviceArea: "kafr-kanna",
  vehicleType: "motorcycle", parcelSize: "medium", goodsAmountAgorot: 15000, ...extra,
}, 201)).data;
// A v2 order created before goods became mandatory: the invoice is unknown.
const withoutGoods = o => models.Order.updateOne({ _id: o._id },
  { $unset: { goodsAmountRecordedAt: "" }, $set: { goodsAmountAgorot: 0 } });
const save = async o => request(`/customer/${tokenOf(o)}/details`, null, "POST", {
  recipientName: "Customer", customerPhone: "٠٥٠١٢٣٤٥٦٧", deliveryInstructions: "Door",
  observed: (await customer(o)).confirmationSnapshot,
});
const confirm = async (o, observed) => request(`/customer/${tokenOf(o)}/confirm`, null, "POST", {
  recipientName: "Customer", customerPhone: "0501234567", deliveryInstructions: "Door", available: true,
  observed: observed ?? (await customer(o)).confirmationSnapshot,
});
// Place, details and the one confirmation ("ready now"): the search starts.
const readyQuick = async extra => {
  const o = await quick(extra);
  await request(`/customer/${tokenOf(o)}/location`, null, "POST", destination);
  await save(o);
  await confirm(o);
  return o;
};
// What an open quick order created by the previous release looks like: searching
// from creation, with no availability gate.
const legacy = o => models.Order.updateOne({ _id: o._id }, { $unset: { customerAvailable: "" },
  $set: { driverSearchStatus: "searching", searchStartedAt: new Date(), searchDeadlineAt: new Date(Date.now() + 600000) } });
beforeEach(async () => {
  router.reset();
  await request("/store/pickup-service-area", store(), "PUT", { pickupServiceArea: "kafr-kanna" });
});

test("quick request: vehicle, size and goods come from the store; nothing about the customer", async () => {
  const base = { workflowVersion: 2, storeAuthorization: true, serviceArea: "kafr-kanna",
    vehicleType: "car", parcelSize: "medium", goodsAmountAgorot: 15000 };
  const without = key => { const b = { ...base }; delete b[key]; return b; };
  const code = async body => (await request("/orders", store(), "POST", body, 422)).data.code;
  assert.equal(await code(without("vehicleType")), "vehicle_type_required");
  assert.equal(await code(without("parcelSize")), "parcel_size_required");
  assert.equal(await code(without("goodsAmountAgorot")), "goods_amount_required");
  assert.equal((await request("/orders", store(), "POST", { ...base, vehicleType: "truck" }, 400)).data.code, "invalid_input");
  assert.equal((await request("/orders", store(), "POST", { ...base, goodsAmountAgorot: -1 }, 400)).data.code, "invalid_amount");
  assert.equal(await code({ ...base, vehicleType: "motorcycle", parcelSize: "large" }), "vehicle_size_mismatch");
  const o = (await request("/orders", store(), "POST", base, 201)).data;
  assert.equal(o.vehicleType, "car");
  assert.equal(o.parcelSize, "medium");
  assert.equal(o.goodsAmountKnown, true);
  assert.equal(o.goodsAmountAgorot, 15000); // goods only, never including delivery
  assert.equal(o.deliveryFeeAgorot, null);
  assert.equal(o.customerPhone, "");
  // Zero is a valid invoice (prepaid goods): only the delivery is collected.
  assert.equal((await quick({ goodsAmountAgorot: 0 })).goodsAmountKnown, true);
});

test("a new quick order waits for its customer; estimate never becomes collectible cash", async () => {
  const o = await quick();
  assert.equal(o.status, "searching_driver");
  assert.equal(o.dispatchState, "waiting_customer");
  assert.equal(o.customerPhone, "");
  assert.equal(o.estimatedDeliveryFeeAgorot, 1500);
  assert.equal(o.deliveryFeeAgorot, null);
  assert.equal(o.expectedCustomerCashAgorot, null);
  assert.equal(o.storeConfirmed, false);
  assert.ok(o.storeAuthorizedAt);
  assert.equal(router.calls.length, 0);
  assert.deepEqual((await request("/driver/orders/available", driver())).data, []);
});

test("a pre-existing quick order without goods stays blocked until the store records them", async () => {
  const o = await quick();
  await withoutGoods(o);
  await legacy(o);
  await request(`/orders/${o._id}/accept`, driver(), "POST", {});
  await request(`/customer/${tokenOf(o)}/location`, null, "POST", destination);
  await save(o);
  const c = await customer(o);
  assert.equal(c.customerPhone, "0501234567");
  assert.equal(c.goodsAmountKnown, false);
  assert.equal(c.customerConfirmed, false);
  assert.equal(c.expectedCustomerCashAgorot, null);
  await request(`/customer/${tokenOf(o)}/confirm`, null, "POST", { ...c, observed: c.confirmationSnapshot }, 422);
  const d = await view(o);
  const blocked = await request(`/orders/${o._id}/pickup`, driver(), "POST", {
    code: o.pickupCode, acceptDetails: true, observed: d.confirmationSnapshot,
  }, 422);
  assert.ok(blocked.data.missingRequirements.includes("goods_amount_required"));
  // The store (only) records it; the customer then sees the total and confirms.
  const s = await storeView(o);
  await request(`/orders/${o._id}`, store(), "PATCH", { goodsAmountAgorot: 4000, observed: s.confirmationSnapshot });
  const after = await customer(o);
  assert.equal(after.goodsAmountKnown, true);
  assert.equal(after.expectedCustomerCashAgorot, 4000 + after.deliveryFeeAgorot);
});

test("zero goods is known; driver combines review and code pickup, then code and exact collection", async () => {
  router.distance = 100; // 2 NIS by distance: the server minimum (15 NIS) applies.
  const o = await quick({ goodsAmountAgorot: 0 });
  await request(`/customer/${tokenOf(o)}/location`, null, "POST", destination);
  await save(o);
  const c = await confirm(o);
  await request(`/orders/${o._id}/accept`, driver(), "POST", {});
  assert.equal(c.data.goodsAmountKnown, true);
  assert.equal(c.data.deliveryFeeAgorot, 1500);
  assert.equal(c.data.expectedCustomerCashAgorot, 1500);
  const ready = await view(o);
  assert.deepEqual(ready.missingRequirements, []);
  assert.equal(ready.storeConfirmed, false);
  await request(`/orders/${o._id}/pickup`, driver(), "POST", {
    code: o.pickupCode, acceptDetails: true, observed: ready.confirmationSnapshot,
  });
  assert.ok((await customer(o)).deliveryCode);
  const raw = await models.Order.findById(o._id).lean();
  assert.equal(raw.driverConfirmed, true);
  assert.equal(raw.financialSnapshot.expectedCustomerCashAgorot, 1500);
  await request(`/orders/${o._id}/deliver`, driver(), "POST", {
    code: raw.deliveryCode, actualCashCollectedAgorot: 1500, observedExpectedAgorot: 1500,
  });
  assert.equal((await models.Order.findById(o._id).lean()).status, "delivered");
});

test("only the store sets goods; a later change voids the customer's confirmation", async () => {
  const o = await quick();
  await request(`/customer/${tokenOf(o)}/location`, null, "POST", destination);
  await save(o);
  const old = await confirm(o);
  await request(`/orders/${o._id}/accept`, driver(), "POST", {});
  // The driver has no way to set or change goods (or any money).
  await request(`/orders/${o._id}/parcel-details`, driver(), "POST", { goodsAmountAgorot: 100 }, 404);
  await request(`/orders/${o._id}`, driver(), "PATCH", { goodsAmountAgorot: 100 }, 403);
  const s = await storeView(o);
  assert.equal(s.customerConfirmed, true);
  assert.equal(s.goodsAmountAgorot, 15000);
  // New goods -> new total, confirmation voided, pickup blocked until re-confirmed.
  const changed = (await request(`/orders/${o._id}`, store(), "PATCH",
    { goodsAmountAgorot: 16000, observed: s.confirmationSnapshot })).data;
  assert.equal(changed.customerConfirmed, false);
  assert.equal(changed.expectedCustomerCashAgorot, 16000 + changed.deliveryFeeAgorot);
  assert.ok(changed.missingRequirements.includes("customer_confirmation_required"));
  assert.equal((await customer(o)).expectedCustomerCashAgorot, 16000 + changed.deliveryFeeAgorot);
  const d = await view(o);
  const blocked = await request(`/orders/${o._id}/pickup`, driver(), "POST",
    { code: o.pickupCode, acceptDetails: true, observed: d.confirmationSnapshot }, 422);
  assert.ok(blocked.data.missingRequirements.includes("customer_confirmation_required"));
  // A stale store screen cannot overwrite the newer value.
  await request(`/orders/${o._id}`, store(), "PATCH", { goodsAmountAgorot: 17000, observed: s.confirmationSnapshot }, 409);
  // The customer's stale screen cannot confirm the old total either.
  await request(`/customer/${tokenOf(o)}/confirm`, null, "POST", {
    recipientName: "Customer", customerPhone: "0501234567", observed: old.data.confirmationSnapshot,
  }, 409);
  await confirm(o);
  // A driver accepted this trip: the customer can no longer move the place.
  const moved = await request(`/customer/${tokenOf(o)}/location`, null, "POST", { ...destination, lng: 35.36 }, 409);
  assert.equal(moved.data.code, "editing_blocked");
});

test("a large parcel cannot be edited onto a motorcycle order", async () => {
  const o = await quick({ vehicleType: "motorcycle", parcelSize: "small" });
  const s = await storeView(o);
  const r = await request(`/orders/${o._id}`, store(), "PATCH", { parcelSize: "large", observed: s.confirmationSnapshot }, 422);
  assert.equal(r.data.code, "vehicle_size_mismatch");
});

test("routing outage retains location and estimate while retry supplies only a real route price", async () => {
  router.mode = "fail";
  const o = await quick({ goodsAmountAgorot: 1000 });
  await request(`/customer/${tokenOf(o)}/location`, null, "POST", destination);
  await save(o);
  const waiting = await customer(o);
  assert.equal(waiting.deliveryFeeAgorot, null);
  assert.equal(waiting.expectedCustomerCashAgorot, null);
  assert.equal(waiting.estimatedDeliveryFeeAgorot, 1500);
  router.mode = "ok"; router.distance = 0;
  await request(`/customer/${tokenOf(o)}/location`, null, "POST", destination);
  assert.equal((await customer(o)).deliveryFeeAgorot, 1500); // 0 m still pays the minimum
  await confirm(o);
});

test("contact can be saved before location; pickup still requires review, current terms and arrival deadline", async () => {
  const o = await quick({ goodsAmountAgorot: 0 });
  await save(o);
  const early = await customer(o);
  assert.equal(early.customerPhone, "0501234567");
  assert.equal(early.priceStatus, "pending");
  assert.equal(early.customerConfirmed, false);
  await request(`/customer/${tokenOf(o)}/location`, null, "POST", destination);
  await confirm(o);
  await request(`/orders/${o._id}/accept`, driver(), "POST", {});
  const d = await view(o);
  await request(`/orders/${o._id}/pickup`, driver(), "POST", {
    code: o.pickupCode, observed: d.confirmationSnapshot,
  }, 422);
  await models.Order.updateOne({ _id: o._id }, { $set: { storeArrivalDeadlineAt: new Date(Date.now() - 1000) } });
  const expired = await request(`/orders/${o._id}/pickup`, driver(), "POST", {
    code: o.pickupCode, acceptDetails: true, observed: d.confirmationSnapshot,
  }, 409);
  assert.equal(expired.data.code, "assignment_expired");
  assert.ok(!(await models.Order.findById(o._id).lean()).financialSnapshot);
});

test("disabling quick creation leaves existing quick orders able to finish", async () => {
  const o = await quick({ goodsAmountAgorot: 0 });
  const previous = process.env.QUICK_DELIVERY_ENABLED;
  try {
    process.env.QUICK_DELIVERY_ENABLED = "false";
    await restart();
    await request("/orders", store(), "POST", {
      workflowVersion: 2, storeAuthorization: true, serviceArea: "kafr-kanna",
    }, 409);
    assert.equal((await request("/store/permissions", store())).data.quickDeliveryEnabled, false);
    await save(o);
    await request(`/customer/${tokenOf(o)}/location`, null, "POST", destination);
    await confirm(o);
    await request(`/orders/${o._id}/accept`, driver(), "POST", {});
    await request(`/orders/${o._id}/pickup`, driver(), "POST", {
      code: o.pickupCode, acceptDetails: true, observed: (await view(o)).confirmationSnapshot,
    });
    const c = await customer(o);
    await request(`/orders/${o._id}/deliver`, driver(), "POST", {
      code: c.deliveryCode, observedExpectedAgorot: c.expectedCustomerCashAgorot,
      actualCashCollectedAgorot: c.expectedCustomerCashAgorot,
    });
  } finally {
    if (previous === undefined) delete process.env.QUICK_DELIVERY_ENABLED;
    else process.env.QUICK_DELIVERY_ENABLED = previous;
    await restart();
  }
});

test("estimate is never the final fee; short trips pay the server minimum", async () => {
  router.distance = 300;
  const o = await quick({ goodsAmountAgorot: 15000 });
  assert.equal(o.estimatedDeliveryFeeAgorot, 1500);
  assert.equal(o.estimatedDriverEarningsAgorot, 1350);
  assert.equal(o.deliveryFeeAgorot, null); // the estimate is never written as the fee
  router.mode = "fail";
  await request(`/customer/${tokenOf(o)}/location`, null, "POST", destination);
  const pending = await customer(o);
  assert.equal(pending.deliveryFeeAgorot, null); // routing down: still no fee
  assert.equal(pending.expectedCustomerCashAgorot, null);
  router.mode = "ok";
  await request(`/customer/${tokenOf(o)}/location`, null, "POST", destination); // retry the same point
  const final = await customer(o);
  assert.equal(final.priceStatus, "final");
  assert.equal(final.deliveryFeeAgorot, 1500); // max(600, 1500)
  assert.equal(final.expectedCustomerCashAgorot, 15000 + 1500);
  assert.equal(final.estimatedDeliveryFeeAgorot, null); // the final price replaces the estimate
  assert.equal(final.estimatedDriverEarningsAgorot, undefined); // customer DTO omits driver earnings
});

test("store permissions expose only display estimates for the store's pickup area", async () => {
  const p = (await request("/store/permissions", store())).data;
  assert.deepEqual(p.deliveryEstimatesAgorot, { "kafr-kanna": 1500 });
});

test("a motorcycle driver neither sees nor can accept a car order; a car driver covers motorcycle orders", async () => {
  const carOrder = await readyQuick({ vehicleType: "car", parcelSize: "large" });
  const offersFor = async login => (await request("/driver/orders/available", sessions[login].token)).data;
  const ids = async login => (await offersFor(login)).map(x => x._id);
  assert.ok(!(await ids("driver2")).includes(carOrder._id)); // driver2 = motorcycle
  assert.equal((await request(`/orders/${carOrder._id}/accept`, sessions.driver2.token, "POST", {}, 409)).data.code, "order_unavailable");
  assert.equal((await request(`/admin/orders/${carOrder._id}/assign`, sessions.admin.token, "POST", { driverId: sessions.driver2.user._id }, 409)).data.code, "order_unavailable");
  assert.equal((await models.Order.findById(carOrder._id).lean()).status, "searching_driver");
  const bikeOrder = await readyQuick(); // motorcycle
  assert.ok((await ids("driver2")).includes(bikeOrder._id));
  assert.ok((await ids("driver1")).includes(bikeOrder._id)); // a car covers a motorcycle order
  const offer = (await offersFor("driver1")).find(x => x._id === carOrder._id);
  assert.equal(offer.pickupServiceArea, "kafr-kanna");
  assert.equal(offer.serviceArea, "kafr-kanna");
  assert.equal(offer.vehicleType, "car");
  assert.equal(offer.parcelSize, "large");
  // Offered only once ready, so the fare is final (1.5 km = 30 NIS) and no estimate is shown.
  assert.equal(offer.priceStatus, "final");
  assert.equal(offer.estimatedDeliveryFeeAgorot, null);
  assert.equal(offer.estimatedDriverEarningsAgorot, null);
  assert.equal(offer.driverEarningsAgorot, 2700);
  for (const key of ["customerPhone", "recipientName", "finalAddress", "customerLink", "pickupCode"])
    assert.equal(offer[key], undefined, key);
  assert.equal((await request(`/orders/${carOrder._id}/accept`, driver(), "POST", {})).data.status, "driver_assigned");
});

// A quick order where everything is final and the driver has arrived at the store.
async function readyOrder() {
  const o = await readyQuick();
  await request(`/orders/${o._id}/accept`, driver(), "POST", {});
  await request(`/orders/${o._id}/arrive-store`, driver(), "POST", {});
  return o;
}
const pickup = async (o, code = o.pickupCode, expected = 200) => {
  const d = await view(o);
  return request(`/orders/${o._id}/pickup`, driver(), "POST",
    { code, acceptDetails: true, observed: d.confirmationSnapshot }, expected);
};

test("pickup is impossible while any final requirement is missing", async () => {
  const cases = [
    ["destination_location_required", { $unset: { destinationLocation: "" } }],
    ["route_price_required", { $set: { priceStatus: "pending", routeCalculatedAt: null } }],
    ["fee_required", { $set: { deliveryFeeAgorot: null, expectedCustomerCashAgorot: null } }],
    ["customer_details_required", { $set: { customerPhone: "" } }],
    ["goods_amount_required", { $unset: { goodsAmountRecordedAt: "" } }],
    ["customer_confirmation_required", { $set: { customerConfirmed: false } }],
  ];
  for (const [missing, update] of cases) {
    const o = await readyOrder();
    await models.Order.updateOne({ _id: o._id }, update);
    const blocked = await pickup(o, o.pickupCode, 422);
    assert.ok(blocked.data.missingRequirements.includes(missing), `${missing}: ${blocked.data.missingRequirements}`);
    assert.ok(!(await models.Order.findById(o._id).lean()).financialSnapshot, `${missing}: money must not be captured`);
    await request(`/orders/${o._id}/withdraw`, driver(), "POST", { reason: "cannot_complete" });
  }
  const o = await readyOrder();
  assert.equal((await pickup(o, "000000", 422)).data.code, "incorrect_pickup_code");
  const done = (await pickup(o)).data;
  assert.equal(done.status, "collected");
  assert.equal((await models.Order.findById(o._id).lean()).financialSnapshot.deliveryFeeAgorot, done.deliveryFeeAgorot);
});

test("moving the location after the final price voids price and confirmation", async () => {
  const o = await readyQuick();
  assert.equal((await customer(o)).customerConfirmed, true);
  router.mode = "fail";
  await request(`/customer/${tokenOf(o)}/location`, null, "POST", { ...destination, lat: destination.lat + 0.01 });
  const c = await customer(o);
  assert.equal(c.priceStatus, "pending");
  assert.equal(c.customerConfirmed, false);
  assert.equal(c.expectedCustomerCashAgorot, null);
  assert.equal(c.dispatchState, "waiting_customer");
  assert.equal((await request(`/orders/${o._id}/accept`, driver(), "POST", {}, 409)).data.code, "order_unavailable");
  router.mode = "ok";
  await request(`/customer/${tokenOf(o)}/location`, null, "POST", { ...destination, lat: destination.lat + 0.01 });
  assert.equal((await customer(o)).customerConfirmed, false, "a new price needs a new confirmation");
  await request(`/orders/${o._id}/accept`, driver(), "POST", {}, 409);
  // On an old open order the pickup gate still catches an unconfirmed new price.
  const old = await quick();
  await legacy(old);
  await request(`/orders/${old._id}/accept`, driver(), "POST", {});
  await request(`/customer/${tokenOf(old)}/location`, null, "POST", destination);
  assert.ok((await pickup(old, old.pickupCode, 422)).data.missingRequirements.includes("customer_confirmation_required"));
});

test("an old driver app picking up straight from driver_assigned still works", async () => {
  const o = await readyQuick();
  await request(`/orders/${o._id}/accept`, driver(), "POST", {});
  const done = (await pickup(o)).data; // no arrive-store call
  assert.equal(done.status, "collected");
  assert.ok(done.arrivedStoreAt, "arrival is still recorded");
});

test("a network retry or double tap cannot pick up or deliver twice", async () => {
  router.distance = 1500;
  const o = await readyQuick();
  await request(`/orders/${o._id}/accept`, driver(), "POST", {});
  const d = await view(o);
  const pick = () => request(`/orders/${o._id}/pickup`, driver(), "POST",
    { code: o.pickupCode, acceptDetails: true, observed: d.confirmationSnapshot }, null);
  const picks = await Promise.all(Array.from({ length: 10 }, pick));
  assert.equal(picks.filter(r => r.status === 200).length, 1, "exactly one pickup wins");
  let raw = await models.Order.findById(o._id).lean();
  assert.equal(raw.status, "collected");
  assert.equal(raw.events.filter(e => e.type === "financial_terms_captured").length, 1);
  assert.equal((await pick()).status, 409, "a late retry is refused, not applied again");
  const deliver = () => request(`/orders/${o._id}/deliver`, driver(), "POST", {
    code: raw.deliveryCode, actualCashCollectedAgorot: 18000, observedExpectedAgorot: 18000,
  }, null);
  const drops = await Promise.all(Array.from({ length: 10 }, deliver));
  assert.equal(drops.filter(r => r.status === 200).length, 1, "exactly one delivery wins");
  raw = await models.Order.findById(o._id).lean();
  assert.equal(raw.status, "delivered");
  assert.equal(raw.events.filter(e => e.type === "cash_collected").length, 1);
  assert.equal(raw.actualCashCollectedAgorot, 18000);
});
