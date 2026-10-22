// Real HTTP and MongoDB regression tests; only an explicitly selected *_test
// database is reset. Run separately from the workflow suite.
import assert from "node:assert/strict";
import { before, after, beforeEach, test } from "node:test";
import { once } from "node:events";
import mongoose from "mongoose";
import { startFakeRouting } from "./helpers/routing.js";
import { offerLocationFixtures, refreshOfferLocations, closeOfferLocations, resetOrderActionLimits } from "./helpers/offerLocations.js";

const uri = process.env.PRIVACY_TEST_URI;
if (!uri || !new URL(uri).pathname.endsWith("_test"))
  throw new Error("Set PRIVACY_TEST_URI to a dedicated MongoDB database ending in _test. That test database will be reset.");
process.env.MONGODB_URI = uri;
process.env.JWT_SECRET = "privacy-test-secret";
process.env.RATE_LIMIT_LOGIN_PER_MIN = process.env.RATE_LIMIT_CUSTOMER_PER_MIN = "1000000"; // suites log in/call constantly
const router = await startFakeRouting();
const { connectDatabase, User, Order, DriverCashRecord, CodeAttemptState, CodeAttempt } =
  await import("../src/models/index.js");
const { createApp } = await import("../src/app.js");
const { seed } = await import("../src/scripts/seed.js");
let server, base, admin, store, d1, d2, driver1Id, driver2Id;

async function request(path, token, method = "GET", body, expected = 200) {
  if (path === "/driver/orders/available") await refreshOfferLocations(User);
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  // Avoid printing customer details if an unauthorized read unexpectedly succeeds.
  assert.equal(response.status, expected, `${method} ${path}: expected ${expected}, received ${response.status}`);
  return data;
}
before(async () => {
  await connectDatabase();
  await mongoose.connection.dropDatabase();
  await Promise.all([User, Order, DriverCashRecord, CodeAttemptState, CodeAttempt].map((m) => m.syncIndexes()));
  await seed();
  server = createApp({ locationStore: await offerLocationFixtures() }).listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}/api`;
  const sessions = {};
  for (const login of ["admin", "store1", "driver1", "driver2"])
    sessions[login] = await request("/auth/login", null, "POST", { login, password: "WaselhaDemo123!" });
  admin = sessions.admin.token;
  store = sessions.store1.token;
  d1 = sessions.driver1.token;
  d2 = sessions.driver2.token;
  driver1Id = sessions.driver1.user._id;
  driver2Id = sessions.driver2.user._id;
});
beforeEach(async () => {
  await resetOrderActionLimits(User);
  await User.updateMany({ role: "driver" }, { $set: { availableForOrders: true, serviceAreas: ["kafr-kanna"] } });
  await Promise.all([Order, DriverCashRecord, CodeAttemptState, CodeAttempt].map((m) => m.deleteMany({})));
});
after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await mongoose.disconnect();
  await closeOfferLocations();
  await router.close();
});

const pii = {
  recipientName: "Privacy recipient",
  customerPhone: "0501234567",
  preliminaryAddress: "Private preliminary address 123",
  finalAddress: "Private destination 456",
  deliveryInstructions: "Private door instructions",
};
// STEP 4: exact destination data is as private as the address text.
const destination = { lat: 32.7512, lng: 35.3487, address: "Private pin address 789", source: "pin" };
const confirmDestination = (order) =>
  request(`/customer/${order.customerLink.split("/").at(-1)}/location`, null, "POST", destination);
const offerFields = [
  "dispatchVersion",
  "orderId", "offerVersion", "approximateDistanceMeters", "expiresAt", "offerExpiresAt",
  "_id", "storeId", "storeName", "pickupAddress", "area", "parcelDescription",
  "parcelReady", "goodsAmountAgorot", "deliveryFeeAgorot", "platformCommissionAgorot",
  "driverEarningsAgorot", "expectedCustomerCashAgorot", "customerConfirmed",
  "storeConfirmed", "status", "createdAt", "missingRequirements",
  "priceSource", "priceStatus", "serviceArea",
  // Presentation/flow metadata only; customer data and coordinates stay forbidden.
  "workflowVersion", "goodsAmountKnown", "estimatedDeliveryFeeAgorot", "estimatedDriverEarningsAgorot",
  // Enough to decide on an offer (STEP: vehicle-based dispatch); never customer data.
  "pickupServiceArea", "vehicleType", "parcelSize",
];
function assertNoCustomerData(value) {
  const forbidden = [...Object.keys(pii), "customerToken", "customerLink", "pickupCode", "deliveryCode", "destinationLocation", "lat", "lng"];
  function visit(object) {
    if (!object || typeof object !== "object") return;
    for (const [key, nested] of Object.entries(object)) {
      assert.ok(!forbidden.includes(key), `customer field leaked: ${key}`);
      visit(nested);
    }
  }
  visit(value);
  for (const secret of [...Object.values(pii), destination.address, String(destination.lat), String(destination.lng)])
    assert.ok(!JSON.stringify(value).includes(secret), "customer value leaked");
}
const create = (extra = {}) => request("/orders", store, "POST", {
  serviceArea: "kafr-kanna",
  deliveryFeePaidBy: "customer",
  ...pii,
  area: "Central area",
  parcelDescription: "Sealed box",
  parcelReady: true,
  goodsAmountAgorot: 10000,
  deliveryFeeAgorot: 2000,
  ...extra,
}, 201);
async function assigned() {
  const order = await create();
  const token = order.customerLink.split("/").at(-1);
  await confirmDestination(order);
  const customer = await request(`/customer/${token}`);
  await request(`/customer/${token}/confirm`, null, "POST", {
    observed: customer.confirmationSnapshot,
    recipientName: pii.recipientName,
    finalAddress: pii.finalAddress,
    deliveryInstructions: pii.deliveryInstructions,
  });
  await request(`/orders/${order._id}/accept`, d1, "POST", {});
  return order;
}
async function pickedUp() {
  const order = await assigned();
  for (const actor of [store, d1]) {
    const view = await request(`/orders/${order._id}`, actor);
    await request(`/orders/${order._id}/confirm`, actor, "POST", { observed: view.confirmationSnapshot });
  }
  await request(`/orders/${order._id}/arrive-store`, d1, "POST", {});
  await request(`/orders/${order._id}/pickup`, d1, "POST", { code: order.pickupCode });
  return order;
}
async function assertReleased(order, status) {
  for (const actor of [store, admin]) {
    const view = await request(`/orders/${order._id}`, actor);
    assert.equal(view.status, status);
    assert.equal(view.driverId, driver1Id, "historical driver must remain");
    assert.equal(view.activeAssignment, false);
    assert.equal(view.customerPhone, pii.customerPhone);
  }
  assert.equal(await request("/driver/orders/current", d1), null);
  assert.deepEqual(await request(`/orders/${order._id}`, d1, "GET", undefined, 404), { code: "not_found" });
  for (const action of ["confirm", "arrive-store", "pickup", "arrive-customer", "deliver", "fail"])
    assert.deepEqual(await request(`/orders/${order._id}/${action}`, d1, "POST", {}, 404), { code: "not_found" });
}

test("A: unassigned driver sees only operational offer data, including no nested PII", async () => {
  const placed = await create();
  // The customer has confirmed an exact destination, which must stay hidden.
  await confirmDestination(placed);
  const order = await request(`/orders/${placed._id}`, store);
  assert.equal(order.destinationLocation.lat, destination.lat, "fixture: destination is stored");
  const offers = await request("/driver/orders/available", d1);
  assert.equal(offers.length, 1);
  const offer = offers[0];
  assert.equal(offer._id, order._id);
  for (const key of offerFields.filter((k) => !["missingRequirements", "orderId", "offerVersion", "approximateDistanceMeters", "expiresAt", "offerExpiresAt"].includes(k)))
    // Historical orders have no pickup area / vehicle / size: the offer says null, the stored order says nothing.
    assert.deepEqual(offer[key] ?? null, order[key] ?? null, `offer field preserved: ${key}`);
  assert.deepEqual(offer.missingRequirements, order.missingRequirements);
  assertNoCustomerData(offers);
  assert.deepEqual(Object.keys(offer).sort(), [...offerFields].sort(), "offer has an explicit allowlist");
  await request(`/orders/${order._id}`, d1, "GET", undefined, 404);
});
test("B: active assigned driver retains delivery details on accept, current and detail APIs", async () => {
  const created = await create();
  await confirmDestination(created);
  const order = await request(`/orders/${created._id}`, store);
  const accepted = await request(`/orders/${order._id}/accept`, d1, "POST", {});
  for (const view of [accepted, await request("/driver/orders/current", d1), await request(`/orders/${order._id}`, d1)]) {
    assert.equal(view._id, order._id);
    assert.equal(view.driverId, driver1Id);
    assert.equal(view.activeAssignment, true);
    for (const [key, value] of Object.entries(pii)) assert.equal(view[key], value);
    assert.equal(view.expectedCustomerCashAgorot, 13000);
    assert.equal(view.driverEarningsAgorot, 2700);
    assert.equal(view.pickupAddress, order.pickupAddress);
    assert.deepEqual(view.confirmationSnapshot, { ...order.confirmationSnapshot, driverId: driver1Id });
    for (const key of ["customerToken", "customerLink", "pickupCode", "deliveryCode"])
      assert.ok(!Object.hasOwn(view, key), `assigned driver must not see ${key}`);
  }
  assert.deepEqual(await request("/driver/orders/available", d2), []);
  await request(`/orders/${order._id}`, d2, "GET", undefined, 404);
});
test("C: delivery ends driver read/write access and preserves historical driver", async () => {
  const order = await pickedUp();
  await request(`/orders/${order._id}/arrive-customer`, d1, "POST", {});
  const customer = await request(`/customer/${order.customerLink.split("/").at(-1)}`);
  const result = await request(`/orders/${order._id}/deliver`, d1, "POST", {
    code: customer.deliveryCode,
    actualCashCollectedAgorot: 13000,
    observedExpectedAgorot: 13000,
  });
  assert.equal(result.status, "delivered");
  await assertReleased(order, "delivered");
  assertNoCustomerData(result);
});
test("D: reassignment denies previous driver and allows current driver", async () => {
  const order = await assigned();
  await request(`/orders/${order._id}/arrive-store`, d1, "POST", {});
  await request(`/admin/orders/${order._id}/assign`, admin, "POST", { driverId: driver2Id });
  assert.equal(await request("/driver/orders/current", d1), null);
  await request(`/orders/${order._id}`, d1, "GET", undefined, 404);
  for (const action of ["confirm", "arrive-store", "pickup", "arrive-customer", "deliver", "fail"])
    await request(`/orders/${order._id}/${action}`, d1, "POST", {}, 404);
  for (const view of [await request(`/orders/${order._id}`, d2), await request("/driver/orders/current", d2)]) {
    assert.equal(view.driverId, driver2Id);
    assert.equal(view.activeAssignment, true);
    assert.equal(view.customerPhone, pii.customerPhone);
    assert.equal(view.finalAddress, pii.finalAddress);
  }
  await request(`/orders/${order._id}/arrive-store`, d2, "POST", {});
});
test("E: cancellation ends driver read/write access without clearing historical driver", async () => {
  const order = await assigned();
  await request(`/admin/orders/${order._id}/cancel`, admin, "POST", { reason: "Privacy cancellation test" });
  await assertReleased(order, "cancelled");
  assert.deepEqual(await request("/driver/orders/available", d2), []);
});
test("F: driver retains access while failed/returning and loses it after store confirms return", async () => {
  const order = await pickedUp();
  await request(`/orders/${order._id}/fail`, d1, "POST", { reason: "Cannot deliver", actualCashCollectedAgorot: 500 });
  let view = await request(`/orders/${order._id}`, d1);
  assert.equal(view.status, "delivery_failed");
  assert.equal(view.activeAssignment, true);
  assert.equal(view.customerPhone, pii.customerPhone);
  await request(`/admin/orders/${order._id}/authorize-return`, admin, "POST", {});
  view = await request("/driver/orders/current", d1);
  assert.equal(view.status, "returning");
  assert.equal(view.customerPhone, pii.customerPhone);
  await request(`/orders/${order._id}/confirm-return`, store, "POST", {});
  await assertReleased(order, "returned");
  const summary = await request("/driver/summary", d1);
  assert.equal(summary.cashHeldAgorot, 500);
  assert.equal(summary.earningsAgorot, 0);
});
