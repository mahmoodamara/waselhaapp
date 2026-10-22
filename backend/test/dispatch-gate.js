import { resetOrderActionLimits } from "./helpers/offerLocations.js";
// The driver search for a quick order starts only once the customer has placed the
// destination, seen the final total, confirmed it and said they can receive it now.
import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { models, sessions, router, request, tokenOf, destination, create } from "./helpers/security.js";

const { processExpiredAssignments, processExpiredSearches, initializeLegacyDeadlines, runTimeoutSweep } =
  await import("../src/services/orderTimeouts.js");
const { startReadyDispatches } = await import("../src/services/orders.js");

const store = () => sessions.store1.token;
const driver = (login = "driver1") => sessions[login].token;
const raw = o => models.Order.findById(o._id).lean();
const customer = async o => (await request(`/customer/${tokenOf(o)}`)).data;
const storeView = async o => (await request(`/orders/${o._id}`, store())).data;
const offerIds = async (login = "driver1") => (await request("/driver/orders/available", driver(login))).data.map(x => x._id);
const quick = async extra => (await request("/orders", store(), "POST", {
  workflowVersion: 2, storeAuthorization: true, serviceArea: "kafr-kanna",
  vehicleType: "motorcycle", parcelSize: "medium", goodsAmountAgorot: 15000, ...extra,
}, 201)).data;
const place = (o, at = destination, expected = 200) => request(`/customer/${tokenOf(o)}/location`, null, "POST", at, expected);
const confirm = async (o, available, expected = 200) => request(`/customer/${tokenOf(o)}/confirm`, null, "POST", {
  recipientName: "Customer", customerPhone: "0501234567", deliveryInstructions: "Door",
  ...(available === undefined ? {} : { available }), observed: (await customer(o)).confirmationSnapshot,
}, expected);
const availability = (o, available, expected = 200) =>
  request(`/customer/${tokenOf(o)}/availability`, null, "POST", { available }, expected);
// Location, final price, details and one confirmation with "ready now".
async function ready(extra) {
  const o = await quick(extra);
  await place(o);
  await confirm(o, true);
  return o;
}
const searchEvents = order => order.events.filter(e => e.type === "driver_search_started").length;
const accept = (o, login = "driver1", expected = 200) => request(`/orders/${o._id}/accept`, driver(login), "POST", {}, expected);

beforeEach(async () => {
  router.reset();
  await request("/store/pickup-service-area", store(), "PUT", { pickupServiceArea: "kafr-kanna" });
});

test("creating a quick order does not start the driver search", async () => {
  const o = await quick();
  assert.equal(o.status, "searching_driver"); // unchanged for older clients
  assert.equal(o.dispatchState, "waiting_customer");
  const saved = await raw(o);
  assert.equal(saved.driverSearchStatus, "waiting");
  assert.equal(saved.customerAvailable, false);
  assert.equal(saved.searchStartedAt, null);
  assert.equal(saved.searchDeadlineAt, null);
  assert.equal(searchEvents(saved), 0);
  assert.deepEqual(await offerIds(), []);
  assert.equal((await accept(o, "driver1", 409)).data.code, "order_unavailable");
  // D2: an administrator cannot bypass the gate either.
  assert.equal((await request(`/admin/orders/${o._id}/assign`, sessions.admin.token, "POST",
    { driverId: sessions.driver1.user._id }, 409)).data.code, "order_unavailable");
  assert.equal((await customer(o)).availabilityRequired, true);
});

test("an incomplete or not-yet-available customer never reaches a driver", async () => {
  const o = await quick();
  await place(o);
  assert.equal((await raw(o)).driverSearchStatus, "waiting");
  await request(`/customer/${tokenOf(o)}/details`, null, "POST", { recipientName: "Customer", customerPhone: "0501234567",
    observed: (await customer(o)).confirmationSnapshot });
  assert.equal((await raw(o)).driverSearchStatus, "waiting");
  const later = (await confirm(o, false)).data;
  assert.equal(later.customerConfirmed, true);
  assert.equal(later.customerAvailable, false);
  assert.equal(later.dispatchState, "customer_later");
  assert.equal((await storeView(o)).dispatchState, "customer_later");
  assert.equal((await raw(o)).driverSearchStatus, "waiting");
  assert.deepEqual(await offerIds(), []);
  // A confirmation without the availability choice (an older page) keeps the order waiting.
  const other = await quick();
  await place(other);
  await confirm(other);
  assert.equal((await raw(other)).driverSearchStatus, "waiting");
  // Routing down: no final price, so neither confirmation nor search.
  router.mode = "fail";
  const unpriced = await quick();
  await place(unpriced);
  assert.equal((await confirm(unpriced, true, 422)).data.code, "fee_required");
  assert.equal((await raw(unpriced)).driverSearchStatus, "waiting");
  assert.deepEqual(await offerIds(), []);
});

test("confirming with 'ready now' starts the search exactly once, with a fresh window", async () => {
  const before = Date.now();
  const o = await ready();
  const saved = await raw(o);
  assert.equal(saved.driverSearchStatus, "searching");
  assert.ok(saved.searchStartedAt.getTime() >= before);
  assert.equal(saved.searchDeadlineAt.getTime() - saved.searchStartedAt.getTime(), 10 * 60 * 1000);
  assert.equal(searchEvents(saved), 1);
  assert.equal(saved.customerAvailable, true);
  assert.deepEqual(await offerIds(), [o._id]);
  assert.equal((await customer(o)).dispatchState, "searching");
  assert.equal((await storeView(o)).dispatchState, "searching");
  // Confirming the same details again is a no-op: no second search.
  await confirm(o, true);
  assert.equal(searchEvents(await raw(o)), 1);
});

test("'later' then 'I am ready now' starts the search without confirming the total again", async () => {
  const o = await quick();
  await place(o);
  await confirm(o, false);
  const now = (await availability(o, true)).data;
  assert.equal(now.dispatchState, "searching");
  const saved = await raw(o);
  assert.equal(saved.customerConfirmed, true);
  assert.equal(saved.driverSearchStatus, "searching");
  assert.equal(saved.events.filter(e => e.type === "customer_availability_changed").length, 2);
  assert.equal(searchEvents(saved), 1);
});

test("duplicate ready signals start one search", async () => {
  const o = await quick();
  await place(o);
  await confirm(o, false);
  // Ten taps on "ready now" at once, plus background sweeps running alongside.
  const taps = await Promise.all(Array.from({ length: 10 }, () => availability(o, true, null)));
  assert.ok(taps.every(r => r.status === 200), JSON.stringify(taps.map(r => r.data.code)));
  await Promise.all([runTimeoutSweep(), startReadyDispatches(), startReadyDispatches()]);
  assert.equal(searchEvents(await raw(o)), 1);
  // A ready order whose signal was lost is picked up by the sweep, once.
  const lost = await quick();
  await place(lost);
  await confirm(lost, false);
  await models.Order.updateOne({ _id: lost._id }, { $set: { customerAvailable: true } });
  await Promise.all([startReadyDispatches(), startReadyDispatches(), runTimeoutSweep()]);
  const picked = await raw(lost);
  assert.equal(picked.driverSearchStatus, "searching");
  assert.equal(searchEvents(picked), 1);
});

test("moving the location during the search pulls the order back until it is confirmed again", async () => {
  const o = await ready();
  assert.deepEqual(await offerIds(), [o._id]);
  await place(o, { ...destination, lat: destination.lat + 0.01 });
  const paused = await raw(o);
  assert.equal(paused.driverSearchStatus, "waiting");
  assert.equal(paused.customerConfirmed, false);
  assert.equal(paused.searchDeadlineAt, null);
  assert.equal(paused.events.filter(e => e.type === "driver_search_paused").length, 1);
  assert.deepEqual(await offerIds(), []);
  // An offer a driver still had on screen cannot be accepted any more.
  assert.equal((await accept(o, "driver1", 409)).data.code, "order_unavailable");
  await confirm(o, true);
  const resumed = await raw(o);
  assert.equal(resumed.driverSearchStatus, "searching");
  assert.equal(searchEvents(resumed), 2);
});

test("a store change to the goods, or new contact details, pulls a searching order back", async () => {
  const o = await ready();
  const s = await storeView(o);
  await request(`/orders/${o._id}`, store(), "PATCH", { goodsAmountAgorot: 16000, observed: s.confirmationSnapshot });
  let saved = await raw(o);
  assert.equal(saved.driverSearchStatus, "waiting");
  assert.equal(saved.customerConfirmed, false);
  assert.deepEqual(await offerIds(), []);
  await confirm(o, true);
  assert.equal((await raw(o)).driverSearchStatus, "searching");
  await request(`/customer/${tokenOf(o)}/details`, null, "POST", { recipientName: "Someone else", customerPhone: "0501234567",
    observed: (await customer(o)).confirmationSnapshot });
  saved = await raw(o);
  assert.equal(saved.driverSearchStatus, "waiting");
  assert.equal(saved.customerConfirmed, false);
  // A store change that does not touch money or the customer keeps the search going.
  await confirm(o, true);
  const again = await storeView(o);
  await request(`/orders/${o._id}`, store(), "PATCH", { parcelSize: "small", observed: again.confirmationSnapshot });
  assert.equal((await raw(o)).driverSearchStatus, "searching");
});

test("a customer who becomes unavailable during the search pulls the order back", async () => {
  const o = await ready();
  const later = (await availability(o, false)).data;
  assert.equal(later.dispatchState, "customer_later");
  const saved = await raw(o);
  assert.equal(saved.driverSearchStatus, "waiting");
  assert.equal(saved.customerConfirmed, true);
  assert.equal(saved.events.filter(e => e.type === "driver_search_paused").length, 1);
  assert.deepEqual(await offerIds(), []);
  // Also from "no driver found".
  await availability(o, true);
  await models.Order.updateOne({ _id: o._id }, { $set: { searchDeadlineAt: new Date(0) } });
  await processExpiredSearches();
  assert.equal((await raw(o)).driverSearchStatus, "no_driver");
  await availability(o, false);
  assert.equal((await raw(o)).driverSearchStatus, "waiting");
});

test("accept racing the customer's 'not now' ends assigned or waiting, never both", async () => {
  for (let i = 0; i < 12; i++) {
    await resetOrderActionLimits(models.User);
    const o = await ready();
    const [won, off] = await Promise.all([accept(o, "driver1", null), availability(o, false, null)]);
    const saved = await raw(o);
    if (saved.status === "driver_assigned") {
      assert.equal(won.status, 200);
      assert.equal(off.status, 409);
      assert.equal(saved.customerAvailable, true);
      await request(`/orders/${o._id}/withdraw`, driver(), "POST", { reason: "other" });
      await models.Order.updateOne({ _id: o._id }, { $set: { excludedDriverIds: [] } });
      await models.Order.updateOne({ _id: o._id }, { $set: { status: "cancelled", activeAssignment: false, driverSearchStatus: null } });
    } else {
      assert.equal(won.status, 409);
      assert.equal(off.status, 200);
      assert.equal(saved.driverSearchStatus, "waiting");
      assert.equal(saved.activeAssignment, false);
      assert.equal(saved.customerAvailable, false);
    }
  }
});

test("two drivers accepting a ready order: exactly one wins", async () => {
  const o = await ready(); // motorcycle: both the car and the motorcycle driver may take it
  assert.deepEqual(await offerIds("driver2"), [o._id]);
  const results = await Promise.all([accept(o, "driver1", null), accept(o, "driver2", null)]);
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal((await raw(o)).status, "driver_assigned");
});

test("after assignment the customer can no longer move the location or change availability", async () => {
  const o = await ready();
  await accept(o);
  assert.equal((await place(o, { ...destination, lat: destination.lat + 0.02 }, 409)).data.code, "editing_blocked");
  assert.equal((await availability(o, false, 409)).data.code, "editing_blocked");
  assert.equal((await confirm(o, false, 409)).data.code, "editing_blocked");
  const view = await customer(o);
  assert.equal(view.canChangeLocation, false);
  assert.equal(view.canEdit, true);
  // A store correction of the goods still needs (and accepts) a new confirmation of the total.
  const s = await storeView(o);
  await request(`/orders/${o._id}`, store(), "PATCH", { goodsAmountAgorot: 16000, observed: s.confirmationSnapshot });
  const reconfirmed = (await confirm(o, true)).data;
  assert.equal(reconfirmed.customerConfirmed, true);
  assert.equal((await raw(o)).status, "driver_assigned");
});

test("a released assignment returns to the search only while the order is still ready", async () => {
  const o = await ready();
  await accept(o);
  await request(`/orders/${o._id}/withdraw`, driver(), "POST", { reason: "other" });
  let saved = await raw(o);
  assert.equal(saved.driverSearchStatus, "searching");
  assert.equal(saved.activeAssignment, false);
  assert.ok(!(await offerIds("driver1")).includes(o._id), "the withdrawn driver is excluded");
  assert.ok((await offerIds("driver2")).includes(o._id));
  // Driver 2 takes it, the store changes the goods, then the arrival deadline passes.
  await accept(o, "driver2");
  const s = await storeView(o);
  await request(`/orders/${o._id}`, store(), "PATCH", { goodsAmountAgorot: 17000, observed: s.confirmationSnapshot });
  await models.Order.updateOne({ _id: o._id }, { $set: { storeArrivalDeadlineAt: new Date(0) } });
  assert.equal(await processExpiredAssignments(), 1);
  saved = await raw(o);
  assert.equal(saved.activeAssignment, false);
  assert.equal(saved.driverSearchStatus, "waiting", "unconfirmed total: no new search");
  assert.equal(saved.searchDeadlineAt, null);
  assert.deepEqual(await offerIds("driver2"), []);
  // The customer confirms the new total and the search starts again.
  await confirm(o, true);
  assert.equal((await raw(o)).driverSearchStatus, "searching");
});

test("an arrival timeout returns a ready order to the search", async () => {
  const o = await ready();
  await accept(o);
  await models.Order.updateOne({ _id: o._id }, { $set: { storeArrivalDeadlineAt: new Date(0) } });
  assert.equal(await processExpiredAssignments(), 1);
  const saved = await raw(o);
  assert.equal(saved.driverSearchStatus, "searching");
  assert.ok(saved.searchDeadlineAt > new Date());
});

test("startup deadline migration and search expiry never start a waiting order", async () => {
  const o = await quick();
  await place(o);
  await confirm(o, false);
  const unset = await quick();
  await models.Order.updateOne({ _id: unset._id }, { $unset: { searchDeadlineAt: "", searchStartedAt: "" } });
  await initializeLegacyDeadlines();
  await processExpiredSearches(new Date(Date.now() + 3600000));
  for (const order of [o, unset]) {
    const saved = await raw(order);
    assert.equal(saved.driverSearchStatus, "waiting");
    assert.equal(searchEvents(saved), 0);
  }
  assert.deepEqual(await offerIds(), []);
});

test("retry needs a ready order; a waiting order can be cancelled by the store", async () => {
  const o = await ready();
  await models.Order.updateOne({ _id: o._id }, { $set: { searchDeadlineAt: new Date(0) } });
  await processExpiredSearches();
  await request(`/orders/${o._id}/retry-search`, store(), "POST");
  assert.equal((await raw(o)).driverSearchStatus, "searching");
  await availability(o, false);
  await request(`/orders/${o._id}/retry-search`, store(), "POST", undefined, 409);
  const cancelled = (await request(`/orders/${o._id}/cancel`, store(), "POST", {})).data;
  assert.equal(cancelled.status, "cancelled");
  const fresh = await quick();
  assert.equal((await request(`/orders/${fresh._id}/cancel`, store(), "POST", {})).data.status, "cancelled");
});

test("a ready offer carries the final fare and cash, never an estimate", async () => {
  router.distance = 2000; // 40 NIS
  const o = await ready();
  const offer = (await request("/driver/orders/available", driver())).data.find(x => x._id === o._id);
  assert.equal(offer.priceStatus, "final");
  assert.equal(offer.estimatedDriverEarningsAgorot, null);
  assert.equal(offer.driverEarningsAgorot, 3600);
  assert.equal(offer.expectedCustomerCashAgorot, 15000 + 4000);
  for (const key of ["customerPhone", "recipientName", "destinationLocation", "customerLink", "pickupCode"])
    assert.equal(offer[key], undefined, key);
});

test("open quick orders from before the gate keep the old rules", async () => {
  const o = await quick();
  const now = new Date();
  // What an order created by the previous release looks like.
  await models.Order.updateOne({ _id: o._id }, {
    $unset: { customerAvailable: "" },
    $set: { driverSearchStatus: "searching", searchStartedAt: now, searchDeadlineAt: new Date(now.getTime() + 600000) },
    $push: { events: { type: "driver_search_started", at: now, actorType: "store" } },
  });
  assert.deepEqual(await offerIds(), [o._id]);
  const c = await customer(o);
  assert.equal(c.availabilityRequired, false);
  assert.equal(c.dispatchState, null);
  await accept(o);
  await place(o, destination); // the old flow still lets the customer place it after assignment
  await request(`/orders/${o._id}/withdraw`, driver(), "POST", { reason: "other" });
  assert.equal((await raw(o)).driverSearchStatus, "searching");
  // Orders of the first workflow start searching at creation, as before.
  const legacy = await create();
  assert.equal((await raw(legacy)).driverSearchStatus, "searching");
  assert.ok((await offerIds("driver2")).includes(legacy._id));
});

test("a quick order left waiting for its customer shows in the admin stuck list, never cancelled", async () => {
  const o = await quick();
  await models.Order.collection.updateOne({ _id: models.Order.castObject({ _id: o._id })._id },
    { $set: { updatedAt: new Date(Date.now() - 4 * 3600 * 1000) } });
  await runTimeoutSweep();
  const stuck = (await request("/admin/ops/stuck", sessions.admin.token)).data.find(x => x._id === o._id);
  assert.equal(stuck?.reason, "waiting_customer");
  assert.equal((await raw(o)).status, "searching_driver");
});
