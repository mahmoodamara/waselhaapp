// STEP 4 location tests. Real HTTP server and isolated MongoDB (shared helper,
// SECURITY_TEST_URI) plus a local fake geocoder, so no test touches a live maps
// provider. Run with: npm --prefix backend run test:location
import assert from "node:assert/strict";
import { test, beforeEach, after } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  models, sessions, router, request, apiUrl, create, tokenOf, confirm, pickedUp, restart,
  destination, confirmLocation,
} from "./helpers/security.js";

// ---- fake geocoder (Nominatim-compatible subset) -------------------------
const providerCalls = [];
let providerMode = "ok";
const provider = createServer((req, res) => {
  const url = new URL(req.url, "http://provider.test");
  providerCalls.push({
    path: url.pathname,
    params: Object.fromEntries(url.searchParams),
    userAgent: req.headers["user-agent"],
  });
  if (providerMode === "fail") { res.statusCode = 500; return res.end("boom"); }
  res.setHeader("content-type", "application/json");
  if (providerMode === "garbage") return res.end("<html>not json</html>");
  if (url.pathname === "/search")
    return res.end(JSON.stringify([
      { display_name: "Main Street, Kafr Kanna", lat: "32.7459862", lon: "35.3398025" },
      { display_name: "Impossible latitude", lat: "999", lon: "35" },
      { display_name: "", lat: "32", lon: "35" },
      { display_name: "Second result", lat: "32.75", lon: "35.35" },
    ]));
  if (url.pathname === "/reverse")
    return res.end(JSON.stringify({ display_name: "Reverse label" }));
  res.statusCode = 404;
  res.end("{}");
});
provider.listen(0, "127.0.0.1");
await once(provider, "listening");
// Inherited by the server process the shared helper spawns.
process.env.MAPS_GEOCODER_URL = `http://127.0.0.1:${provider.address().port}`;
process.env.MAPS_MIN_INTERVAL_MS = "0";
process.env.MAPS_CONTACT = "location-tests@example.invalid";
after(() => { provider.closeAllConnections?.(); provider.close(); });

// ---- fixtures -------------------------------------------------------------
const A = { lat: 32.7459, lng: 35.3398, address: "Pickup A", source: "search" };
const B = { lat: 32.7001, lng: 35.3001, address: "Pickup B", source: "pin" };
const D1 = destination; // the shared helper's default, so its pickup flow keeps this one
const D2 = { lat: 32.7551, lng: 35.3602, address: "Other street 9", source: "pin" };
const store = () => sessions.store1.token;
const admin = () => sessions.admin.token;
const d1 = () => sessions.driver1.token;
const d2 = () => sessions.driver2.token;
const pick = (loc) => ({ lat: loc.lat, lng: loc.lng, address: loc.address, source: loc.source });
const setPickup = (loc, token = store(), expected = 200) =>
  request("/store/pickup-location", token, "PUT", loc, expected);
const oid = (id) => new models.Order.base.Types.ObjectId(id);
const rawOrder = (id) => models.Order.collection.findOne({ _id: oid(id) });
const rawStore = () => models.User.collection.findOne({ login: "store1" });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Same bad inputs for the store and the customer endpoints.
const badLocations = [
  ["latitude too high", { ...A, lat: 100 }],
  ["latitude too low", { ...A, lat: -90.0001 }],
  ["longitude too high", { ...A, lng: 200 }],
  ["longitude too low", { ...A, lng: -180.5 }],
  ["latitude null", { ...A, lat: null }],
  ["longitude null", { ...A, lng: null }],
  ["missing latitude", { lng: A.lng, address: A.address, source: A.source }],
  ["missing longitude", { lat: A.lat, address: A.address, source: A.source }],
  ["missing coordinate pair", { address: A.address, source: A.source }],
  ["latitude not numeric", { ...A, lat: "abc" }],
  ["latitude NaN string", { ...A, lat: "NaN" }],
  ["longitude Infinity string", { ...A, lng: "Infinity" }],
  ["latitude boolean", { ...A, lat: true }],
  ["latitude array", { ...A, lat: [32] }],
  ["latitude object", { ...A, lat: { v: 32 } }],
  ["unknown source", { ...A, source: "teleport" }],
  ["missing source", { lat: A.lat, lng: A.lng, address: A.address }],
  ["address not a string", { ...A, address: 12 }],
  ["address too long", { ...A, address: "x".repeat(301) }],
  ["confirmed flag without coordinates", { confirmed: true, source: "pin" }],
];
async function rawJson(path, token, method, text) {
  const response = await fetch(apiUrl(path), {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: text,
  });
  return { status: response.status, data: await response.json() };
}
// 1e999 is valid JSON that parses to Infinity.
const infinityBody = `{"lat":1e999,"lng":35.3,"address":"x","source":"pin"}`;
// Reaches the delivery state without relying on the shared helper's flow.
async function deliveredOrder() {
  const order = await create();
  await confirmLocation(tokenOf(order));
  await pickedUp(order);
  await request(`/orders/${order._id}/arrive-customer`, d1(), "POST", {});
  const customer = (await request(`/customer/${tokenOf(order)}`)).data;
  await request(`/orders/${order._id}/deliver`, d1(), "POST", {
    code: customer.deliveryCode, actualCashCollectedAgorot: 13000, observedExpectedAgorot: 13000,
  });
  return order;
}

beforeEach(async () => {
  router.reset();
  providerMode = "ok";
  providerCalls.length = 0;
  // Raw write: the baseline is independent of the schema under test.
  await models.User.collection.updateOne(
    { login: "store1" },
    { $set: { pickupLocation: { ...A, confirmedAt: new Date() } } },
  );
});

// ---- store pickup location -------------------------------------------------
test("LOC-1: store saves a valid pickup location and it persists", async () => {
  const { data } = await setPickup(A);
  assert.equal(data.pickupLocation.lat, A.lat);
  assert.equal(data.pickupLocation.lng, A.lng);
  assert.equal(data.pickupLocation.address, A.address);
  assert.equal(data.pickupLocation.source, A.source);
  assert.ok(!Number.isNaN(Date.parse(data.pickupLocation.confirmedAt)));
  assert.equal(data.passwordHash, undefined);
  await setPickup(B);
  const stored = (await rawStore()).pickupLocation;
  assert.deepEqual([stored.lat, stored.lng, stored.address, stored.source], [B.lat, B.lng, B.address, B.source]);
  assert.ok(stored.confirmedAt instanceof Date);
  assert.deepEqual((await request("/auth/me", store())).data.pickupLocation.lat, B.lat);
});
test("LOC-2: invalid store pickup locations are rejected server-side and nothing changes", async () => {
  for (const [name, body] of badLocations) {
    const { status } = await request("/store/pickup-location", store(), "PUT", body, null);
    assert.equal(status, 400, `store pickup accepted: ${name}`);
  }
  const infinity = await rawJson("/store/pickup-location", store(), "PUT", infinityBody);
  assert.equal(infinity.status, 400, "Infinity from 1e999 accepted");
  assert.equal((await rawStore()).pickupLocation.address, A.address, "valid location was replaced");
  // The boundaries themselves are valid.
  const edge = (await setPickup({ lat: 90, lng: -180, address: "", source: "pin" })).data.pickupLocation;
  assert.deepEqual([edge.lat, edge.lng], [90, -180]);
});
test("LOC-3: a new order snapshots the pickup location; later store changes do not move it", async () => {
  await setPickup(A);
  const order = await create();
  const placed = (await request(`/orders/${order._id}`, store())).data;
  for (const key of ["lat", "lng", "address", "source"]) assert.equal(placed.pickupLocation[key], A[key]);
  assert.ok(placed.pickupLocation.confirmedAt);
  await setPickup(B);
  const after = (await request(`/orders/${order._id}`, store())).data;
  assert.deepEqual(after.pickupLocation, placed.pickupLocation, "old order moved with the store");
  const stored = (await rawOrder(order._id)).pickupLocation;
  assert.deepEqual([stored.lat, stored.lng], [A.lat, A.lng]);
  const next = (await create()).pickupLocation;
  assert.deepEqual([next.lat, next.lng], [B.lat, B.lng], "new orders use the current store location");
});
test("LOC-14: an admin account update cannot move an existing order's pickup snapshot", async () => {
  const order = await create();
  const storeId = (await rawStore())._id.toString();
  const { data: updated } = await request(`/admin/accounts/${storeId}`, admin(), "PATCH", { pickupLocation: B });
  assert.equal(updated.pickupLocation.lat, B.lat);
  const stored = (await rawOrder(order._id)).pickupLocation;
  assert.deepEqual([stored.lat, stored.lng, stored.address], [A.lat, A.lng, A.address]);
  await request(`/admin/accounts/${storeId}`, admin(), "PATCH", { pickupLocation: { ...B, lat: 120 } }, 400);
  assert.equal((await rawStore()).pickupLocation.lat, B.lat);
});
test("LOC-15: a store without a saved pickup location cannot create orders; existing orders keep working", async () => {
  const kept = await create();
  await models.User.collection.updateOne({ login: "store1" }, { $unset: { pickupLocation: "" } });
  const blocked = (await request("/orders", store(), "POST", { area: "Central area", serviceArea: "kafr-kanna", deliveryFeePaidBy: "customer" }, 422)).data;
  assert.equal(blocked.code, "pickup_location_required");
  assert.equal(await models.Order.countDocuments({}), 1, "a rejected order must not be stored");
  // Orders that already exist are not touched by the store's missing setting.
  assert.equal((await request(`/orders/${kept._id}`, store())).data._id, kept._id);
  await setPickup(B);
  assert.equal((await request("/orders", store(), "POST", { area: "Central area", serviceArea: "kafr-kanna", deliveryFeePaidBy: "customer" }, 201)).status, 201);
  // Invalid input is still reported as invalid input, before the location rule.
  await models.User.collection.updateOne({ login: "store1" }, { $unset: { pickupLocation: "" } });
  await request("/orders", store(), "POST", { serviceArea: "kafr-kanna", deliveryFeePaidBy: "customer" }, 400);
});
test("LOC-17: only the owning store (or an admin through account update) can set pickup locations", async () => {
  await setPickup(B, d1(), 403);
  await setPickup(B, admin(), 403);
  await setPickup(B, null, 401);
  const driverId = sessions.driver1.user._id;
  await request(`/admin/accounts/${driverId}`, admin(), "PATCH", { phone: "", pickupLocation: B });
  assert.equal((await models.User.collection.findOne({ login: "driver1" })).pickupLocation, undefined, "drivers have no pickup location");
  assert.equal((await rawStore()).pickupLocation.address, A.address);
});

// ---- customer destination --------------------------------------------------
test("LOC-4: the customer confirms an exact destination before any delivery fee exists", async () => {
  const order = await create({ deliveryFeeAgorot: undefined });
  assert.equal(order.deliveryFeeAgorot, null, "fixture must have no fee");
  const view = (await request(`/customer/${tokenOf(order)}`)).data;
  assert.equal(view.deliveryFeeAgorot, null);
  const { data } = await confirmLocation(tokenOf(order), D1);
  assert.equal(data.destinationLocation.lat, D1.lat);
  assert.equal(data.destinationLocation.lng, D1.lng);
  assert.equal(data.destinationLocation.source, D1.source);
  assert.ok(data.destinationLocation.confirmedAt);
  assert.equal(data.priceStatus, "final", "STEP 5 prices only after the independent location confirmation");
});
test("LOC-4b: the money/details confirmation is unchanged and still needs a fee", async () => {
  const order = await create({ deliveryFeeAgorot: undefined });
  const view = (await request(`/customer/${tokenOf(order)}`)).data;
  const refused = await request(`/customer/${tokenOf(order)}/confirm`, null, "POST", {
    observed: view.confirmationSnapshot, recipientName: "Customer name", finalAddress: "Final address",
  }, 422);
  assert.equal(refused.data.code, "fee_required");
});
test("LOC-5: the confirmed destination persists in MongoDB and survives a server restart", async () => {
  const order = await create();
  const { data } = await confirmLocation(tokenOf(order), D1);
  const stored = (await rawOrder(order._id)).destinationLocation;
  assert.deepEqual([stored.lat, stored.lng, stored.address, stored.source], [D1.lat, D1.lng, D1.address, D1.source]);
  assert.ok(stored.confirmedAt instanceof Date);
  assert.equal(stored.confirmedAt.toISOString(), data.destinationLocation.confirmedAt);
  await restart();
  const reloaded = (await request(`/customer/${tokenOf(order)}`)).data.destinationLocation;
  assert.deepEqual(reloaded, data.destinationLocation);
  const storeView = (await request(`/orders/${order._id}`, store())).data.destinationLocation;
  assert.deepEqual(storeView, data.destinationLocation);
});
test("LOC-6: invalid customer coordinates never become a confirmed destination", async () => {
  const order = await create();
  const token = tokenOf(order);
  for (const [name, body] of badLocations) {
    const { status } = await request(`/customer/${token}/location`, null, "POST", body, null);
    assert.equal(status, 400, `customer location accepted: ${name}`);
  }
  assert.equal((await rawJson(`/customer/${token}/location`, null, "POST", infinityBody)).status, 400);
  assert.equal((await rawOrder(order._id)).destinationLocation, undefined, "an invalid request created a destination");
  assert.equal((await request(`/customer/${token}`)).data.destinationLocation ?? null, null);
  // The client can never choose the confirmation time.
  const before = Date.now();
  const { data } = await confirmLocation(token, { ...D1, confirmedAt: "2000-01-01T00:00:00.000Z" });
  assert.ok(Date.parse(data.destinationLocation.confirmedAt) >= before - 1000, "client supplied confirmedAt was trusted");
});
test("LOC-7: the customer can correct the destination before pickup", async () => {
  const order = await create();
  const token = tokenOf(order);
  const first = (await confirmLocation(token, D1)).data.destinationLocation;
  await sleep(25);
  const second = (await confirmLocation(token, D2)).data.destinationLocation;
  assert.deepEqual([second.lat, second.lng, second.address, second.source], [D2.lat, D2.lng, D2.address, D2.source]);
  assert.ok(Date.parse(second.confirmedAt) > Date.parse(first.confirmedAt), "confirmedAt was not refreshed");
  assert.deepEqual((await rawOrder(order._id)).destinationLocation.lat, D2.lat);
  // Re-sending the identical destination is an idempotent no-op.
  const again = (await confirmLocation(token, D2)).data.destinationLocation;
  assert.equal(again.confirmedAt, second.confirmedAt);
});
test("LOC-8: the destination cannot change after pickup or after the order closes", async () => {
  const order = await create();
  const token = tokenOf(order);
  await confirmLocation(token, D1);
  await pickedUp(order);
  const refused = await confirmLocation(token, D2, 409);
  assert.equal(refused.data.code, "editing_blocked");
  assert.equal((await rawOrder(order._id)).destinationLocation.lat, D1.lat);
  await request(`/orders/${order._id}/arrive-customer`, d1(), "POST", {});
  await confirmLocation(token, D2, 409);
  const customer = (await request(`/customer/${token}`)).data;
  await request(`/orders/${order._id}/deliver`, d1(), "POST", {
    code: customer.deliveryCode, actualCashCollectedAgorot: 13000, observedExpectedAgorot: 13000,
  });
  await confirmLocation(token, D2, 409);
  assert.equal((await rawOrder(order._id)).destinationLocation.lat, D1.lat);
  const final = (await request(`/customer/${token}`)).data;
  assert.deepEqual(Object.keys(final).sort(), ["canEdit", "publicReference", "status", "storeName"], "terminal view stays minimal");
});
test("LOC-9: expired and replaced links cannot read or change a location", async () => {
  const order = await create();
  const oldToken = tokenOf(order);
  await confirmLocation(oldToken, D1);
  const { confirmDestination } = await import("../src/services/orders.js");
  assert.equal(typeof confirmDestination, "function", "confirmDestination must exist");
  const staleRead = await models.Order.findById(order._id).lean();
  const replacement = (await request(`/orders/${order._id}/customer-link/reissue`, store(), "POST", {})).data;
  const fresh = tokenOf(replacement);
  assert.deepEqual((await confirmLocation(oldToken, D2, 404)).data, { code: "not_found" });
  await request(`/customer/${oldToken}/maps/search?q=main+street`, null, "GET", undefined, 404);
  await assert.rejects(confirmDestination(staleRead, D2), (e) => e.status === 409, "an in-flight request on the old token must not write");
  assert.equal((await rawOrder(order._id)).destinationLocation.lat, D1.lat);
  await models.Order.collection.updateOne({ customerToken: fresh }, { $set: { customerTokenExpiresAt: new Date(Date.now() - 1000) } });
  assert.deepEqual((await confirmLocation(fresh, D2, 404)).data, { code: "not_found" });
  assert.equal((await rawOrder(order._id)).destinationLocation.lat, D1.lat, "expired link changed the location");
});
test("LOC-16: legacy orders without any location data stay usable and are only gated at pickup", async () => {
  const order = await create();
  await models.Order.collection.updateOne({ _id: oid(order._id) }, {
    $unset: { pickupLocation: "", destinationLocation: "", priceSource: "", priceStatus: "" },
    $set: { deliveryFeeAgorot: 2000, platformCommissionAgorot: 200, driverEarningsAgorot: 1800, storeDeliveryFeeLiabilityAgorot: 0, expectedCustomerCashAgorot: 12000 },
  });
  const view = (await request(`/customer/${tokenOf(order)}`)).data;
  assert.equal(view.destinationLocation ?? null, null);
  assert.equal((await confirm(tokenOf(order))).customerConfirmed, true, "details confirmation must still work");
  const storeView = (await request(`/orders/${order._id}`, store())).data;
  assert.ok(storeView.missingRequirements.includes("destination_location_required"));
  assert.equal(storeView.pickupLocation ?? null, null, "no pickup snapshot is invented for old orders");
  assert.equal((await rawOrder(order._id)).pickupLocation, undefined, "reading must not backfill coordinates");
  await confirmLocation(tokenOf(order), D1);
  const unblocked = (await request(`/orders/${order._id}`, store())).data;
  assert.ok(!unblocked.missingRequirements.includes("destination_location_required"));
});
test("LOC-19: STEP 5 location triggers pricing without settlement or order-state side effects", async () => {
  const order = await create();
  const before = await rawOrder(order._id);
  await confirmLocation(tokenOf(order), D1);
  await confirmLocation(tokenOf(order), D2);
  const after = await rawOrder(order._id);
  for (const key of ["goodsAmountAgorot", "status", "actualCashCollectedAgorot", "cashDifferenceAgorot"])
    assert.equal(after[key], before[key], `${key} changed`);
  assert.equal(after.priceStatus, "final");
  assert.equal(after.deliveryFeeAgorot, 3000);
  assert.equal(after.estimatedPrice, undefined);
  assert.equal(await models.DriverCashRecord.countDocuments({}), 0);
});
test("LOC-20: a changed destination resets store/driver confirmation and rejects stale views", async () => {
  const order = await create();
  const token = tokenOf(order);
  await confirmLocation(token, D1);
  await confirm(token);
  await request(`/orders/${order._id}/accept`, d1(), "POST", {});
  const views = {};
  for (const [name, actor] of [["store", store()], ["driver", d1()]]) {
    views[name] = (await request(`/orders/${order._id}`, actor)).data;
    await request(`/orders/${order._id}/confirm`, actor, "POST", { observed: views[name].confirmationSnapshot });
  }
  const confirmed = await rawOrder(order._id);
  assert.ok(confirmed.storeConfirmed && confirmed.driverConfirmed && confirmed.customerConfirmed);
  await confirmLocation(token, D2);
  const changed = await rawOrder(order._id);
  assert.equal(changed.storeConfirmed, false);
  assert.equal(changed.driverConfirmed, false);
  assert.equal(changed.customerConfirmed, false, "STEP 5 invalidates the old financial confirmation with the old route price");
  const stale = await request(`/orders/${order._id}/confirm`, store(), "POST", { observed: views.store.confirmationSnapshot }, 409);
  assert.equal(stale.data.code, "stale_details");
  await confirm(token);
  const fresh = (await request(`/orders/${order._id}`, store())).data;
  await request(`/orders/${order._id}/confirm`, store(), "POST", { observed: fresh.confirmationSnapshot });
});

// ---- pickup gate ------------------------------------------------------------
test("LOC-13: pickup and store/driver confirmation are blocked until the destination is confirmed", async () => {
  const order = await create();
  // Isolate the existing destination gate using a genuine pre-STEP-5 manual
  // order; route-priced order gates are additionally covered by RP-5/13/14.
  await models.Order.collection.updateOne({ _id: oid(order._id) }, {
    $unset: { priceSource: "", priceStatus: "" },
    $set: { deliveryFeeAgorot: 2000, platformCommissionAgorot: 200, driverEarningsAgorot: 1800, storeDeliveryFeeLiabilityAgorot: 0, expectedCustomerCashAgorot: 12000 },
  });
  const token = tokenOf(order);
  await confirm(token);
  await request(`/orders/${order._id}/accept`, d1(), "POST", {});
  const view = (await request(`/orders/${order._id}`, store())).data;
  const early = (await request(`/orders/${order._id}/confirm`, store(), "POST", { observed: view.confirmationSnapshot }, 422)).data;
  assert.equal(early.code, "pickup_blocked");
  assert.ok(early.missingRequirements.includes("destination_location_required"));
  await request(`/orders/${order._id}/arrive-store`, d1(), "POST", {});
  // Every other requirement satisfied: only the destination is missing.
  await models.Order.collection.updateOne({ _id: oid(order._id) }, { $set: { storeConfirmed: true, driverConfirmed: true } });
  const blocked = (await request(`/orders/${order._id}/pickup`, d1(), "POST", { code: order.pickupCode }, 422)).data;
  assert.equal(blocked.code, "pickup_blocked");
  assert.deepEqual(blocked.missingRequirements, ["destination_location_required"]);
  assert.equal((await rawOrder(order._id)).status, "driver_at_store");
  await confirmLocation(token, D1);
  for (const actor of [store(), d1()]) {
    const fresh = (await request(`/orders/${order._id}`, actor)).data;
    await request(`/orders/${order._id}/confirm`, actor, "POST", { observed: fresh.confirmationSnapshot });
  }
  const done = (await request(`/orders/${order._id}/pickup`, d1(), "POST", { code: order.pickupCode })).data;
  assert.equal(done.status, "collected");
  assert.equal(done.destinationLocation.lat, D1.lat);
});

// ---- privacy (STEP 2 regression for the new fields) --------------------------
const offerFields = [
  "dispatchVersion",
  "orderId", "offerVersion", "approximateDistanceMeters", "expiresAt", "offerExpiresAt",
  "_id", "storeId", "storeName", "pickupAddress", "area", "parcelDescription", "parcelReady",
  "goodsAmountAgorot", "deliveryFeeAgorot", "platformCommissionAgorot", "driverEarningsAgorot",
  "expectedCustomerCashAgorot", "customerConfirmed", "storeConfirmed", "status", "createdAt", "missingRequirements",
  "priceSource", "priceStatus", "serviceArea",
  "workflowVersion", "goodsAmountKnown", "estimatedDeliveryFeeAgorot", "estimatedDriverEarningsAgorot",
  // Enough to decide on an offer (STEP: vehicle-based dispatch); never customer data.
  "pickupServiceArea", "vehicleType", "parcelSize",
].sort();
test("LOC-10: an unassigned driver never receives destination or exact location data", async () => {
  const order = await create();
  // Written straight to MongoDB so this guards the response view itself.
  await models.Order.collection.updateOne({ _id: oid(order._id) }, {
    $set: { destinationLocation: { ...D1, confirmedAt: new Date() } },
  });
  const offers = (await request("/driver/orders/available", d1())).data;
  assert.equal(offers.length, 1);
  assert.deepEqual(Object.keys(offers[0]).sort(), offerFields, "offer must stay an explicit allowlist");
  const text = JSON.stringify(offers);
  for (const secret of [D1.address, String(D1.lat), String(D1.lng), "destinationLocation", "pickupLocation", "latitude", "lat\"", "lng\""])
    assert.ok(!text.includes(secret), `offer leaked: ${secret}`);
  await request(`/orders/${order._id}`, d1(), "GET", undefined, 404);
});
test("LOC-11: the active assigned driver receives the confirmed destination", async () => {
  const order = await create();
  await confirmLocation(tokenOf(order), D1);
  const accepted = (await request(`/orders/${order._id}/accept`, d1(), "POST", {})).data;
  for (const view of [accepted, (await request("/driver/orders/current", d1())).data, (await request(`/orders/${order._id}`, d1())).data]) {
    assert.deepEqual([view.destinationLocation.lat, view.destinationLocation.lng, view.destinationLocation.address], [D1.lat, D1.lng, D1.address]);
    assert.equal(view.pickupLocation.lat, A.lat);
    for (const key of ["customerToken", "customerLink", "pickupCode", "deliveryCode"])
      assert.ok(!Object.hasOwn(view, key), `assigned driver must not see ${key}`);
  }
  await request(`/orders/${order._id}`, d2(), "GET", undefined, 404);
  assert.deepEqual((await request("/driver/orders/available", d2())).data, []);
});
test("LOC-12: a previous driver loses access to the destination after reassignment, cancellation and delivery", async () => {
  const reassigned = await create();
  await confirmLocation(tokenOf(reassigned), D1);
  await request(`/orders/${reassigned._id}/accept`, d1(), "POST", {});
  const driver2 = (await models.User.collection.findOne({ login: "driver2" }))._id.toString();
  await request(`/admin/orders/${reassigned._id}/assign`, admin(), "POST", { driverId: driver2 });
  assert.equal((await request("/driver/orders/current", d1())).data, null);
  assert.deepEqual((await request(`/orders/${reassigned._id}`, d1(), "GET", undefined, 404)).data, { code: "not_found" });
  assert.equal((await request(`/orders/${reassigned._id}`, d2())).data.destinationLocation.lat, D1.lat);
  await request(`/admin/orders/${reassigned._id}/cancel`, admin(), "POST", { reason: "Location privacy test" });
  assert.deepEqual((await request(`/orders/${reassigned._id}`, d2(), "GET", undefined, 404)).data, { code: "not_found" });
  assert.equal((await request("/driver/orders/current", d2())).data, null);
  const delivered = await deliveredOrder();
  assert.deepEqual((await request(`/orders/${delivered._id}`, d1(), "GET", undefined, 404)).data, { code: "not_found" });
  assert.equal((await request("/driver/orders/current", d1())).data, null);
  const history = (await request(`/orders/${delivered._id}`, store())).data;
  assert.equal(history.destinationLocation.lat, D1.lat, "the store keeps its own order history");
});

// ---- provider boundary ------------------------------------------------------
test("LOC-18: address search and reverse geocoding go through the backend with bounded, normalised data", async () => {
  const order = await create();
  const token = tokenOf(order);
  const search = (await request("/maps/search?q=main%20street&lang=he", store())).data;
  assert.deepEqual(search.map((r) => r.label), ["Main Street, Kafr Kanna", "Second result"], "invalid provider entries must be dropped");
  assert.deepEqual(Object.keys(search[0]).sort(), ["label", "lat", "lng"]);
  assert.equal(search[0].lat, 32.7459862);
  const call = providerCalls.at(-1);
  assert.equal(call.params.q, "main street");
  assert.match(call.userAgent, /^Waselha/);
  assert.match(call.params["accept-language"], /^he/);
  assert.equal((await request(`/maps/reverse?lat=${D1.lat}&lng=${D1.lng}`, admin())).data.label, "Reverse label");
  assert.equal((await request(`/customer/${token}/maps/search?q=main%20street`)).data.length, 2);
  assert.equal((await request(`/customer/${token}/maps/reverse?lat=${D1.lat}&lng=${D1.lng}`)).data.label, "Reverse label");
  // Access, size and coordinate limits.
  await request("/maps/search?q=main", null, "GET", undefined, 401);
  await request("/maps/search?q=main", d1(), "GET", undefined, 403);
  for (const q of ["", "ab", "x".repeat(201)])
    await request(`/maps/search?q=${q}`, store(), "GET", undefined, 400);
  await request("/maps/search", store(), "GET", undefined, 400);
  await request("/maps/reverse?lat=100&lng=35", store(), "GET", undefined, 400);
  await request("/maps/reverse?lat=abc&lng=35", store(), "GET", undefined, 400);
  await request(`/customer/${token}/maps/search?q=ab`, null, "GET", undefined, 400);
  const callsBefore = providerCalls.length;
  await request("/maps/search?q=ab", store(), "GET", undefined, 400);
  assert.equal(providerCalls.length, callsBefore, "rejected queries must not reach the provider");
  // The customer link only proxies while the order can still change.
  await confirmLocation(token, D1);
  await pickedUp(order);
  await request(`/customer/${token}/maps/search?q=main%20street`, null, "GET", undefined, 409);
});
test("LOC-18b: a provider failure is a clean retryable error and never confirms anything", async () => {
  const order = await create();
  const token = tokenOf(order);
  for (const mode of ["fail", "garbage"]) {
    providerMode = mode;
    const failure = await request(`/customer/${token}/maps/search?q=main%20street`, null, "GET", undefined, 503);
    assert.deepEqual(failure.data, { code: "maps_unavailable" }, `provider mode ${mode}`);
    assert.deepEqual((await request(`/maps/reverse?lat=${D1.lat}&lng=${D1.lng}`, store(), "GET", undefined, 503)).data, { code: "maps_unavailable" });
  }
  assert.equal((await rawOrder(order._id)).destinationLocation, undefined, "a provider error created a destination");
  providerMode = "ok";
  assert.equal((await request(`/customer/${token}/maps/search?q=main%20street`)).data.length, 2, "recovers after the provider returns");
  // Confirming a location does not depend on the provider at all.
  providerMode = "fail";
  await confirmLocation(token, D1);
});
