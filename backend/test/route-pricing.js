import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { models, sessions, router, request, create, tokenOf, confirmLocation, confirm, pickedUp, destination } from "./helpers/security.js";

const store = () => sessions.store1.token;
const driver = () => sessions.driver1.token;
const admin = () => sessions.admin.token;
const raw = (o) => models.Order.findById(o._id).lean();
const view = async (o, actor = store()) => (await request(`/orders/${o._id}`, actor)).data;
const retry = (o, actor = store(), expected = 200) => request(`/orders/${o._id}/recalculate-price`, actor, "POST", {}, expected);
const locate = (o, point = destination) => confirmLocation(tokenOf(o), point);
const final = async (distance = 1634) => {
  router.distance = distance;
  const o = await create();
  const { data } = await locate(o);
  assert.equal(data.priceStatus, "final", "location must trigger route pricing");
  return o;
};
beforeEach(() => router.reset());

test("zero-meter route can complete all confirmations and pickup, paying only the server minimum", async () => {
  router.distance = 0;
  const o = await create();
  await pickedUp(o);
  const saved = await raw(o);
  assert.equal(saved.status, "collected");
  assert.equal(saved.routeDistanceMeters, 0);
  assert.equal(saved.deliveryFeeAgorot, 1500); // the real distance is kept; the minimum is the fee
  assert.equal(saved.financialSnapshot.expectedCustomerCashAgorot, 11500);
});

test("store can correct this order's pickup; reprice and require fresh confirmations", async () => {
  const o = await final();
  await confirm(tokenOf(o));
  const old = await view(o);
  const storeLocation = (await models.User.findById(o.storeId).lean()).pickupLocation;
  router.distance = 2000;
  const body = { ...destination, address: "Correct store entrance", lng: 35.34, observed: old.confirmationSnapshot };
  const { data } = await request(`/orders/${o._id}/pickup-location`, store(), "POST", body);
  assert.equal(data.pickupLocation.lng, 35.34);
  assert.equal(data.pickupAddress, body.address);
  assert.equal(data.deliveryFeeAgorot, 4000);
  assert.equal(data.customerConfirmed, false);
  assert.equal(data.storeConfirmed, false);
  assert.equal(data.driverConfirmed, false);
  assert.deepEqual((await models.User.findById(o.storeId).lean()).pickupLocation, storeLocation);
  await request(`/orders/${o._id}/confirm`, store(), "POST", { observed: old.confirmationSnapshot }, 409);
  await pickedUp(o);
  const current = await view(o);
  await request(`/orders/${o._id}/pickup-location`, store(), "POST", { ...body, observed: current.confirmationSnapshot }, 409);
});

test("pickup correction is restricted to the owning store and requires an observed snapshot", async () => {
  const o = await final();
  await request(`/orders/${o._id}/pickup-location`, driver(), "POST", destination, 403);
  await request(`/orders/${o._id}/pickup-location`, admin(), "POST", destination, 403);
  await request(`/orders/${o._id}/pickup-location`, store(), "POST", destination, 409);
  await request("/admin/accounts", admin(), "POST", {
    login: "pickup-other-store", password: "OtherStore123!", role: "store", name: "Other", storeName: "Other", pickupAddress: "Other pickup",
  }, 201);
  const other = (await request("/auth/login", null, "POST", { login: "pickup-other-store", password: "OtherStore123!" })).data;
  await request(`/orders/${o._id}/pickup-location`, other.token, "POST", { ...destination, observed: (await view(o)).confirmationSnapshot }, 404);
});

test("a delayed route from an earlier pickup revision cannot overwrite its correction", async () => {
  const o = await final();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  router.handler = async (_req, res) => { await held; res.end(JSON.stringify({ code: "Ok", routes: [{ distance: 9999 }] })); };
  const calls = router.calls.length;
  const pending = locate(o, { ...destination, lng: 35.36 });
  await router.waitForCalls(calls + 1);
  try {
    router.handler = null;
    router.distance = 2000;
    const current = await view(o);
    await request(`/orders/${o._id}/pickup-location`, store(), "POST", {
      ...destination, lng: 35.34, address: "Corrected pickup", observed: current.confirmationSnapshot,
    });
  } finally { release(); await pending; }
  assert.equal((await raw(o)).routeDistanceMeters, 2000);
  assert.equal((await raw(o)).deliveryFeeAgorot, 4000);
});

test("RP-1/4: new order starts pending; location triggers 1634m server fee", async () => {
  router.distance = 1634;
  const o = await create();
  assert.equal(o.priceStatus, "pending");
  assert.equal(o.deliveryFeeAgorot, null);
  assert.equal(router.calls.length, 0);
  const { data } = await locate(o);
  assert.equal(data.priceStatus, "final");
  const stored = await raw(o);
  assert.equal(stored.routeDistanceMeters, 1634);
  assert.equal(stored.deliveryFeeAgorot, 3268);
  assert.equal(stored.platformCommissionAgorot, 327);
  assert.equal(stored.driverEarningsAgorot, 2941);
  assert.equal(stored.expectedCustomerCashAgorot, 13268);
  assert.ok(stored.routeCalculatedAt instanceof Date);
  assert.equal(stored.routeProvider, "osrm");
});
test("RP-2/20: a short route pays the 15 NIS minimum and the split stays exact", async () => {
  const o = await final(3);
  const p = await raw(o);
  assert.equal(p.routeDistanceMeters, 3);
  assert.equal(p.deliveryFeeAgorot, 1500);
  assert.equal(p.platformCommissionAgorot, 150);
  assert.equal(p.driverEarningsAgorot, 1350);
  assert.equal(p.platformCommissionAgorot + p.driverEarningsAgorot, p.deliveryFeeAgorot);
});
test("RP-3: fractional provider meters round once", async () => {
  for (const [distance, meters] of [[1634.4, 1634], [1634.5, 1635]]) {
    const o = await final(distance);
    assert.equal((await raw(o)).routeDistanceMeters, meters);
    assert.equal((await raw(o)).deliveryFeeAgorot, meters * 2);
  }
});
test("RP-5/13/16: failure preserves confirmed destination, clears money, blocks pickup, hides details", async () => {
  router.mode = "fail";
  const o = await create();
  const { data } = await locate(o);
  assert.ok(data.destinationLocation.confirmedAt);
  assert.equal(data.priceStatus, "pending");
  assert.equal(data.routeError, "routing_unavailable");
  const v = await view(o);
  assert.ok(v.missingRequirements.includes("route_price_required"));
  assert.equal(v.deliveryFeeAgorot, null);
  assert.ok(!JSON.stringify(data).includes("private-provider-error"));
  await request(`/orders/${o._id}/accept`, driver(), "POST", {});
  await request(`/orders/${o._id}/arrive-store`, driver(), "POST", {});
  const blocked = await request(`/orders/${o._id}/pickup`, driver(), "POST", { code: o.pickupCode }, 422);
  assert.ok(blocked.data.missingRequirements.includes("route_price_required"));
});
test("RP-6: authorized retry finalizes price without reconfirming location", async () => {
  router.mode = "fail";
  const o = await create();
  await locate(o);
  const point = (await raw(o)).destinationLocation;
  router.mode = "ok"; router.distance = 1634;
  const { data } = await retry(o);
  assert.equal(data.priceStatus, "final");
  assert.equal(data.deliveryFeeAgorot, 3268);
  assert.deepEqual((await raw(o)).destinationLocation, point);
});
test("RP-7: destination change invalidates old route immediately, including during HTTP", async () => {
  const o = await final();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  router.handler = async (_req, res) => { await held; res.end(JSON.stringify({ code: "Ok", routes: [{ distance: 2000 }] })); };
  const n = router.calls.length;
  const requestB = locate(o, { ...destination, lng: 35.36 });
  await router.waitForCalls(n + 1);
  try {
    const pending = await view(o);
    assert.equal(pending.priceStatus, "pending");
    for (const field of ["routeDistanceMeters", "routeCalculatedAt", "routeProvider", "deliveryFeeAgorot", "driverEarningsAgorot", "platformCommissionAgorot", "expectedCustomerCashAgorot"])
      assert.equal(pending[field], null, field);
  } finally { release(); await requestB; }
});
test("RP-8: B calculates its own route price", async () => {
  const o = await final(1000);
  router.distance = 2000;
  await locate(o, { ...destination, lng: 35.36 });
  const b = await raw(o);
  assert.equal(b.routeDistanceMeters, 2000);
  assert.equal(b.deliveryFeeAgorot, 4000);
});
test("RP-9: response A arriving after B cannot overwrite B", async () => {
  const o = await final();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let first = true;
  router.handler = async (_req, res) => {
    if (first) { first = false; await held; res.end(JSON.stringify({ code: "Ok", routes: [{ distance: 1000 }] })); }
    else res.end(JSON.stringify({ code: "Ok", routes: [{ distance: 2000 }] }));
  };
  const n = router.calls.length;
  const a = locate(o, { ...destination, lng: 35.355 });
  await router.waitForCalls(n + 1);
  try { await locate(o, { ...destination, lng: 35.36 }); }
  finally { release(); await a; }
  const b = await raw(o);
  assert.equal(b.destinationLocation.lng, 35.36);
  assert.equal(b.routeDistanceMeters, 2000);
  assert.equal(b.deliveryFeeAgorot, 4000);
});
test("RP-10: route uses immutable order pickup after store moves", async () => {
  const o = await create();
  const pickup = o.pickupLocation;
  await request("/store/pickup-location", store(), "PUT", { ...destination, lat: 32.7 });
  await locate(o);
  assert.equal(router.calls.length, 1);
  assert.ok(router.calls[0].includes(`${pickup.lng},${pickup.lat};${destination.lng},${destination.lat}`));
});
test("RP-11: legacy manual fee survives location change; no provider or backfill", async () => {
  const o = await create();
  await models.Order.collection.updateOne({ _id: new models.Order.base.Types.ObjectId(o._id) }, {
    $unset: { pickupLocation: "", priceSource: "", priceStatus: "" },
    $set: { deliveryFeeAgorot: 2000, platformCommissionAgorot: 200, driverEarningsAgorot: 1800, storeDeliveryFeeLiabilityAgorot: 0, expectedCustomerCashAgorot: 12000 },
  });
  await locate(o);
  const historical = await raw(o);
  assert.equal(router.calls.length, 0);
  assert.equal(historical.pickupLocation, undefined);
  assert.equal(historical.deliveryFeeAgorot, 2000);
  const v = await view(o);
  assert.equal(v.priceSource, "manual");
  assert.equal(v.priceStatus, "final");
  assert.equal((await retry(o, store(), 422)).data.code, "route_inputs_required");
});
test("RP-12: malicious client price/distance/source never overrides new order", async () => {
  const o = await final();
  const v = await view(o);
  await request(`/orders/${o._id}`, store(), "PATCH", {
    observed: v.confirmationSnapshot, deliveryFeeAgorot: 1, routeDistanceMeters: 1,
    driverEarningsAgorot: 1, platformCommissionAgorot: 0, priceSource: "manual", priceStatus: "final",
  });
  const p = await raw(o);
  assert.equal(p.deliveryFeeAgorot, 3268);
  assert.equal(p.routeDistanceMeters, 1634);
  assert.equal(p.priceSource, "route");
});
test("RP-14/19: final-price pickup and unchanged actual/difference delivery flow", async () => {
  const o = await final();
  await pickedUp(o);
  assert.equal((await raw(o)).status, "collected");
  await request(`/orders/${o._id}/arrive-customer`, driver(), "POST", {});
  const customer = (await request(`/customer/${tokenOf(o)}`)).data;
  await request(`/orders/${o._id}/deliver`, driver(), "POST", {
    code: customer.deliveryCode, actualCashCollectedAgorot: 13200, observedExpectedAgorot: 13268,
  }, 422);
  await request(`/orders/${o._id}/deliver`, driver(), "POST", {
    code: customer.deliveryCode, actualCashCollectedAgorot: 13200, observedExpectedAgorot: 13268, confirmDifference: true,
  });
  const p = await raw(o);
  assert.equal(p.status, "delivered");
  assert.equal(p.cashDifferenceAgorot, -68);
  assert.equal(p.driverEarningsAgorot, 2941);
});
test("RP-15: malformed provider distances never become final", async () => {
  for (const distance of [null, -1, "garbage", "1634", Infinity, NaN, Number.MAX_SAFE_INTEGER]) {
    router.distance = distance;
    const o = await create();
    const { data } = await locate(o);
    assert.equal(data.priceStatus, "pending");
    assert.equal(data.deliveryFeeAgorot, null);
    assert.equal(data.routeError, "routing_unavailable");
  }
});
test("RP-17/18: available driver keeps privacy; assigned driver sees current earning", async () => {
  const o = await final();
  const offers = (await request("/driver/orders/available", driver())).data;
  const offer = offers.find((x) => x._id === o._id);
  assert.equal(offer.priceStatus, "final");
  assert.equal(offer.driverEarningsAgorot, 2941);
  for (const key of ["destinationLocation", "pickupLocation", "customerToken", "pickupCode", "deliveryCode", "confirmationSnapshot"])
    assert.equal(offer[key], undefined);
  await request(`/orders/${o._id}/accept`, driver(), "POST", {});
  const assigned = await view(o, driver());
  assert.equal(assigned.driverEarningsAgorot, 2941);
  assert.equal(assigned.expectedCustomerCashAgorot, 13268);
});
test("retry is owner/admin only and blocked after pickup", async () => {
  const o = await final();
  await retry(o, driver(), 403);
  await retry(o, null, 401);
  await request("/admin/accounts", admin(), "POST", {
    login: "route-other-store", role: "store", name: "Other store", storeName: "Other store",
    pickupAddress: "Other pickup", password: "RouteTest123!",
  }, 201);
  const second = (await request("/auth/login", null, "POST", { login: "route-other-store", password: "RouteTest123!" })).data;
  await retry(o, second.token, 404);
  await retry(o, admin());
  await pickedUp(o);
  await retry(o, store(), 409);
});
test("destination/price changes invalidate all stale financial confirmations", async () => {
  const o = await final();
  await confirm(tokenOf(o));
  await request(`/orders/${o._id}/accept`, driver(), "POST", {});
  const old = await view(o);
  for (const actor of [store(), driver()]) {
    const current = await view(o, actor);
    await request(`/orders/${o._id}/confirm`, actor, "POST", { observed: current.confirmationSnapshot });
  }
  router.distance = 2000;
  await locate(o, { ...destination, lng: 35.36 });
  const p = await raw(o);
  assert.equal(p.customerConfirmed, false);
  assert.equal(p.storeConfirmed, false);
  assert.equal(p.driverConfirmed, false);
  await request(`/orders/${o._id}/confirm`, store(), "POST", { observed: old.confirmationSnapshot }, 409);
  await confirm(tokenOf(o));
  for (const actor of [store(), driver()]) {
    const current = await view(o, actor);
    await request(`/orders/${o._id}/confirm`, actor, "POST", { observed: current.confirmationSnapshot });
  }
  assert.ok((await raw(o)).storeConfirmed && (await raw(o)).driverConfirmed);
});
test("repeated final retry is idempotent and creates no finance records", async () => {
  const o = await final();
  await confirm(tokenOf(o));
  const before = await raw(o);
  const calls = router.calls.length;
  await retry(o); await retry(o);
  const after = await raw(o);
  for (const key of ["deliveryFeeAgorot", "driverEarningsAgorot", "platformCommissionAgorot", "customerConfirmed"])
    assert.equal(after[key], before[key]);
  assert.equal(router.calls.length, calls);
  assert.equal(await models.DriverCashRecord.countDocuments({}), 0);
});
test("missing pickup on a route-marked order stays pending and cannot turn into manual", async () => {
  const o = await create();
  await models.Order.collection.updateOne({ _id: new models.Order.base.Types.ObjectId(o._id) }, { $unset: { pickupLocation: "" } });
  const { data } = await locate(o);
  assert.equal(data.priceStatus, "pending");
  assert.equal(router.calls.length, 0);
  assert.ok((await view(o)).missingRequirements.includes("pickup_location_required"));
});
test("provider timeout is bounded and location remains persisted", async () => {
  router.mode = "timeout";
  const o = await create();
  const start = Date.now();
  const { data } = await locate(o);
  assert.equal(data.routeError, "routing_unavailable");
  assert.ok(data.destinationLocation.confirmedAt);
  assert.ok(Date.now() - start < 2000);
});
test("retry without destination never calls provider", async () => {
  const o = await create();
  assert.equal((await retry(o, store(), 422)).data.code, "route_inputs_required");
  assert.equal(router.calls.length, 0);
});
test("historical manual orders with pickup snapshots are also preserved", async () => {
  const o = await create();
  await models.Order.collection.updateOne({ _id: new models.Order.base.Types.ObjectId(o._id) }, {
    $unset: { priceSource: "", priceStatus: "" },
    $set: { deliveryFeeAgorot: 3000, platformCommissionAgorot: 300, driverEarningsAgorot: 2700, expectedCustomerCashAgorot: 13000 },
  });
  await locate(o);
  await confirm(tokenOf(o));
  await locate(o, { ...destination, lng: 35.36 });
  assert.equal((await raw(o)).customerConfirmed, true);
  assert.equal((await raw(o)).deliveryFeeAgorot, 3000);
  assert.equal(router.calls.length, 0);
  const current = await view(o);
  await request(`/orders/${o._id}`, store(), "PATCH", { observed: current.confirmationSnapshot, deliveryFeeAgorot: 3100 });
  assert.equal((await raw(o)).deliveryFeeAgorot, 3100);
  assert.equal((await raw(o)).customerConfirmed, false);
});
test("legacy manual order without pickup retains the STEP 4 pickup path", async () => {
  const o = await create();
  await models.Order.collection.updateOne({ _id: new models.Order.base.Types.ObjectId(o._id) }, {
    $unset: { priceSource: "", priceStatus: "", pickupLocation: "" },
    $set: { deliveryFeeAgorot: 2000, platformCommissionAgorot: 200, driverEarningsAgorot: 1800, storeDeliveryFeeLiabilityAgorot: 0, expectedCustomerCashAgorot: 12000 },
  });
  await pickedUp(o);
  assert.equal((await raw(o)).status, "collected");
  assert.equal((await raw(o)).pickupLocation, undefined);
  assert.equal(router.calls.length, 0);
});
test("an in-flight route uses current goods for expected cash", async () => {
  const o = await final();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  router.handler = async (_req, res) => { await held; res.end(JSON.stringify({ code: "Ok", routes: [{ distance: 2000 }] })); };
  const n = router.calls.length;
  const b = locate(o, { ...destination, lng: 35.36 });
  await router.waitForCalls(n + 1);
  try {
    const v = await view(o);
    await request(`/orders/${o._id}`, store(), "PATCH", { observed: v.confirmationSnapshot, goodsAmountAgorot: 11000 });
  } finally { release(); await b; }
  assert.equal((await raw(o)).expectedCustomerCashAgorot, 15000);
});
test("cancellation during routing cannot acquire a new final price", async () => {
  const o = await final();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  router.handler = async (_req, res) => { await held; res.end(JSON.stringify({ code: "Ok", routes: [{ distance: 2000 }] })); };
  const n = router.calls.length;
  const b = locate(o, { ...destination, lng: 35.36 });
  await router.waitForCalls(n + 1);
  try { await request(`/admin/orders/${o._id}/cancel`, admin(), "POST", { reason: "Cancelled while routing" }); }
  finally { release(); await b; }
  assert.equal((await raw(o)).priceStatus, "pending");
  assert.equal((await raw(o)).deliveryFeeAgorot, null);
  assert.equal((await raw(o)).status, "cancelled");
});
test("reissued customer link cannot receive a fresh view after waiting for routing", async () => {
  const o = await final();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  router.handler = async (_req, res) => { await held; res.end(JSON.stringify({ code: "Ok", routes: [{ distance: 2000 }] })); };
  const n = router.calls.length;
  const b = confirmLocation(tokenOf(o), { ...destination, lng: 35.36 }, 404);
  await router.waitForCalls(n + 1);
  try { await request(`/orders/${o._id}/customer-link/reissue`, store(), "POST", {}); }
  finally { release(); await b; }
  assert.equal((await raw(o)).deliveryFeeAgorot, 4000);
});
test("same-destination delayed failure cannot regress a successful retry", async () => {
  router.mode = "fail";
  const o = await create();
  await locate(o);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let first = true;
  router.handler = async (_req, res) => {
    if (first) { first = false; await held; res.statusCode = 503; res.end("private-error"); }
    else res.end(JSON.stringify({ code: "Ok", routes: [{ distance: 1634 }] }));
  };
  const n = router.calls.length;
  const a = retry(o);
  await router.waitForCalls(n + 1);
  try { await retry(o, admin()); }
  finally { release(); await a; }
  assert.equal((await raw(o)).priceStatus, "final");
  assert.equal((await raw(o)).routeError, null);
  assert.equal((await raw(o)).deliveryFeeAgorot, 3268);
});
test("final status alone cannot bypass route integrity or existing pickup requirements", async () => {
  const o = await final();
  const v = await view(o);
  assert.ok(v.missingRequirements.includes("customer_confirmation_required"));
  assert.ok(v.missingRequirements.includes("driver_required"));
  await models.Order.collection.updateOne({ _id: new models.Order.base.Types.ObjectId(o._id) }, { $set: { deliveryFeeAgorot: 1 } });
  assert.ok((await view(o)).missingRequirements.includes("route_price_required"));
});

// ---- A price that failed while the routing service was down is calculated again by the sweep.
const { retryPendingRoutePrices } = await import("../src/services/orders.js");
const { routingHealth } = await import("../src/services/routing.js");
const later = (seconds) => new Date(Date.now() + seconds * 1000);
const unpriced = async () => {
  router.mode = "fail";
  const o = await create();
  const { data } = await locate(o);
  assert.equal(data.priceStatus, "pending");
  assert.equal(data.routeError, "routing_unavailable");
  return o;
};
test("RP-S1: once the router is back the sweep prices the order, so confirmation and pickup unlock", async () => {
  const o = await unpriced();
  router.mode = "ok"; router.distance = 1634;
  assert.equal(await retryPendingRoutePrices(), 0, "an order just attempted is left alone for a moment");
  assert.equal((await raw(o)).priceStatus, "pending");
  assert.equal(await retryPendingRoutePrices({ now: later(60) }), 1);
  const saved = await raw(o);
  assert.equal(saved.priceStatus, "final"); assert.equal(saved.routeError, null);
  assert.equal(saved.routeDistanceMeters, 1634); assert.equal(saved.deliveryFeeAgorot, 3268);
  assert.equal((await request(`/customer/${tokenOf(o)}`)).data.priceStatus, "final");
  await pickedUp(o); // the customer can now confirm and the pickup code works
  assert.equal((await raw(o)).status, "collected");
});
test("RP-S2: while the router is still down the sweep prices nothing and asks it only once", async () => {
  const a = await unpriced(); const b = await unpriced();
  const before = router.calls.length;
  assert.equal(await retryPendingRoutePrices({ now: later(60) }), 0);
  assert.equal(router.calls.length - before, 1, "the batch stops at the first failure");
  for (const o of [a, b]) { const saved = await raw(o); assert.equal(saved.priceStatus, "pending"); assert.equal(saved.routeError, "routing_unavailable"); }
});
test("RP-S3: the sweep never touches orders without a confirmed destination, past pickup, or manual-priced", async () => {
  const waiting = await create(); // the customer has not chosen a location
  const done = await final(); await pickedUp(done);
  const before = router.calls.length;
  assert.equal(await retryPendingRoutePrices({ now: later(60) }), 0);
  assert.equal(router.calls.length, before);
  assert.equal((await raw(waiting)).priceStatus, "pending");
});
test("RP-S4: an order unpriced for five minutes is listed for the administrator", async () => {
  const o = await unpriced();
  assert.ok(!(await request("/admin/ops/stuck", admin())).data.some((x) => x._id === o._id), "not yet: the sweep is still trying");
  await models.Order.updateOne({ _id: o._id }, { $set: { "destinationLocation.confirmedAt": new Date(Date.now() - 10 * 60000) } });
  const found = (await request("/admin/ops/stuck", admin())).data.find((x) => x._id === o._id);
  assert.equal(found.reason, "route_unavailable");
});
test("RP-S5: readiness reports the routing service without failing the app", async () => {
  const start = Date.now() + 10 * 3600 * 1000; // a clock of its own: the answer is cached for 30 seconds
  router.mode = "ok";
  assert.equal(await routingHealth(start), "ok");
  router.mode = "fail";
  assert.equal(await routingHealth(start + 1000), "ok", "cached");
  assert.equal(await routingHealth(start + 31000), "unreachable");
  router.mode = "ok";
  assert.equal(await routingHealth(start + 62000), "ok");
  const ready = await request("/ready", null, "GET", undefined, null);
  assert.equal(ready.status, 200); assert.ok(["ok", "unreachable"].includes(ready.data.routing));
});
