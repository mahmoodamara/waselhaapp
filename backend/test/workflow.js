// Focused end-to-end check. It resets ONLY the explicitly selected *_test database.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { startFakeRouting } from "./helpers/routing.js";
import { refreshOfferLocations, closeOfferLocations, resetOrderActionLimits } from "./helpers/offerLocations.js";
const uri = process.env.WORKFLOW_TEST_URI;
if (!uri || !new URL(uri).pathname.endsWith("_test"))
  throw new Error(
    "Set WORKFLOW_TEST_URI to a dedicated MongoDB database ending in _test. That test database will be reset.",
  );
process.env.MONGODB_URI = uri;
process.env.JWT_SECRET = "workflow-test-secret";
process.env.RATE_LIMIT_LOGIN_PER_MIN = process.env.RATE_LIMIT_CUSTOMER_PER_MIN = "1000000"; // suites log in/call constantly
const router = await startFakeRouting();
const {
  connectDatabase,
  User,
  Order,
  DriverCashRecord,
  CodeAttemptState,
  CodeAttempt,
} = await import("../src/models/index.js");
const { seed } = await import("../src/scripts/seed.js");
const { verifyCode } = await import("../src/services/codeGuard.js");
const { price } = await import("../src/services/money.js");
const probe = createServer();
await new Promise((r) => probe.listen(0, "127.0.0.1", r));
const port = probe.address().port;
await new Promise((r) => probe.close(r));
const base = `http://127.0.0.1:${port}/api`;
let server;
const checkpoints = [];
function passed(name) {
  checkpoints.push(name);
  console.log(`PASS ${name}`);
}
async function start() {
  server = spawn(
    process.execPath,
    [fileURLToPath(new URL("../src/server.js", import.meta.url))],
    {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        GOOGLE_ROUTES_ENABLED: "false", // tests never reach Google
        MONGODB_URI: uri,
        JWT_SECRET: "workflow-test-secret",
        PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  server.stdout.on("data", (b) => {
    logs += b;
  });
  server.stderr.on("data", (b) => {
    logs += b;
  });
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(logs);
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server failed to start: ${logs}`);
}
async function stop() {
  if (server?.exitCode === null) {
    const exit = once(server, "exit");
    server.kill("SIGTERM");
    await exit;
  }
}
async function request(path, token, method = "GET", body, expected = 200) {
  if (path === "/driver/orders/available") await refreshOfferLocations(User);
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  assert.equal(
    response.status,
    expected,
    `${method} ${path}: ${JSON.stringify(data)}`,
  );
  return data;
}
// POST that returns the status, Retry-After header and body without asserting.
async function raw(path, token, body) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    retryAfter: response.headers.get("retry-after"),
    data: await response.json(),
  };
}
try {
  await connectDatabase();
  await mongoose.connection.dropDatabase();
  await Promise.all([
    User.syncIndexes(),
    Order.syncIndexes(),
    DriverCashRecord.syncIndexes(),
    CodeAttemptState.syncIndexes(),
    CodeAttempt.syncIndexes(),
  ]);
  await seed();
  // Test-only explicit dispatch preparation; new/legacy real drivers stay offline.
  await User.updateMany({ role: "driver" }, { $set: { availableForOrders: true, serviceAreas: ["kafr-kanna"] } });
  await start();
  const sessions = {};
  for (const login of ["admin", "store1", "driver1", "driver2"])
    sessions[login] = await request("/auth/login", null, "POST", {
      login,
      password: "WaselhaDemo123!",
    });
  const admin = sessions.admin.token,
    store = sessions.store1.token,
    d1 = sessions.driver1.token,
    d2 = sessions.driver2.token;
  assert.equal(sessions.admin.user.passwordHash, undefined);
  await request(
    "/auth/login",
    null,
    "POST",
    { login: "admin", password: "wrong" },
    401,
  );
  const s2 = await request(
    "/admin/accounts",
    admin,
    "POST",
    {
      login: "store2",
      role: "store",
      name: "متجر ثانٍ",
      storeName: "חנות שנייה",
      pickupAddress: "רחוב השוק 20",
      password: "Test123!",
    },
    201,
  );
  const store2 = (
    await request("/auth/login", null, "POST", {
      login: "store2",
      password: "Test123!",
    })
  ).token;
  const areaOnly = await request(
    "/orders",
    store,
    "POST",
    { area: "المركز", serviceArea: "kafr-kanna", deliveryFeePaidBy: "customer" },
    201,
  );
  assert.equal(areaOnly.area, "المركز");
  assert.ok(areaOnly.missingRequirements.includes("customer_details_required"));
  await request("/orders", store, "POST", { serviceArea: "kafr-kanna", deliveryFeePaidBy: "customer" }, 400);
  await request("/orders", store, "POST", { area: "   ", serviceArea: "kafr-kanna", deliveryFeePaidBy: "customer" }, 400);
  const availableToDriver = (await request("/driver/orders/available", d1)).find(
    (o) => o._id === areaOnly._id,
  );
  assert.equal(availableToDriver.area, "المركز");
  for (const field of ["pickupCode", "deliveryCode", "customerToken", "customerLink"])
    assert.equal(availableToDriver[field], undefined);
  await request(
    `/orders/${areaOnly._id}`,
    store,
    "PATCH",
    { observed: areaOnly.confirmationSnapshot, area: "" },
    400,
  );
  const areaEdited = await request(`/orders/${areaOnly._id}`, store, "PATCH", {
    observed: areaOnly.confirmationSnapshot,
    area: "الشمال",
  });
  assert.equal(areaEdited.area, "الشمال");
  await request(`/admin/orders/${areaOnly._id}/cancel`, admin, "POST", {
    reason: "area test",
  });
  // STEP 4: demo orders are created with the demo store's pickup snapshot.
  const demoOrder = await request("/orders/000000000000000000000101", store);
  assert.equal(demoOrder.pickupLocation.address, "Demo pickup location");
  assert.equal(areaOnly.pickupLocation.lat, demoOrder.pickupLocation.lat);
  passed("login, demo accounts, administrator account creation, area-only request");
  const create = async (values = {}) => {
    // This long scenario sets up many independent orders; quota behavior has
    // dedicated HTTP/Redis regressions instead of bypasses in production.
    await resetOrderActionLimits(User);
    return request(
      "/orders",
      store,
      "POST",
      { customerPhone: "0500000000", serviceArea: "kafr-kanna", deliveryFeePaidBy: "customer", ...values },
      201,
    );
  };
  const get = (o) => request(`/orders/${o._id}`, store);
  const tokenOf = (o) => o.customerLink.split("/").at(-1);
  async function customerConfirm(o, distance = 1250) {
    const token = tokenOf(await get(o));
    router.distance = distance;
    await request(`/customer/${token}/location`, null, "POST", {
      lat: 32.7459, lng: 35.3398,
      address: "شارع الزيتون 5 / רחוב הזית 5", source: "pin",
    });
    const view = await request(`/customer/${token}`);
    const confirmed = await request(`/customer/${token}/confirm`, null, "POST", {
      observed: view.confirmationSnapshot,
      recipientName: "سارة / שרה",
      finalAddress: "شارع الزيتون 5 / רחוב הזית 5",
      deliveryInstructions: "الطابق الثاني / קומה שנייה",
    });
    // STEP 4: pickup also needs a confirmed destination. Re-confirming the
    // same one changes nothing, so repeated calls keep store/driver approvals.
    await request(`/customer/${token}/location`, null, "POST", {
      lat: 32.7459,
      lng: 35.3398,
      address: "شارع الزيتون 5 / רחוב הזית 5",
      source: "pin",
    });
    return confirmed;
  }
  async function confirmBoth(o, driverToken = d1) {
    let view = await get(o);
    await request(`/orders/${o._id}/confirm`, store, "POST", {
      observed: view.confirmationSnapshot,
    });
    view = await request(`/orders/${o._id}`, driverToken);
    await request(`/orders/${o._id}/confirm`, driverToken, "POST", {
      observed: view.confirmationSnapshot,
    });
  }
  let order = await create();
  await request(`/orders/${order._id}`, store2, "GET", undefined, 404);
  await request(`/orders/${order._id}`, d2, "GET", undefined, 404);
  await request(`/orders/${order._id}/accept`, d1, "POST", {});
  await request(`/orders/${order._id}/arrive-store`, d1, "POST", {});
  const blocked = await request(
    `/orders/${order._id}/pickup`,
    d1,
    "POST",
    { code: "000000" },
    422,
  );
  assert.equal(blocked.code, "pickup_blocked");
  assert.ok(blocked.missingRequirements.includes("fee_required"));
  assert.ok(blocked.missingRequirements.includes("parcel_not_ready"));
  await request(
    `/admin/accounts/${sessions.driver1.user._id}`,
    admin,
    "PATCH",
    { active: false },
    409,
  );
  const unavailable = await create();
  await request(`/orders/${unavailable._id}/accept`, d1, "POST", {}, 409);
  order = await get(order);
  order = await request(`/orders/${order._id}`, store, "PATCH", {
    observed: order.confirmationSnapshot,
    parcelDescription: "صندوق ملابس",
    parcelReady: true,
    goodsAmountAgorot: 15000,
    deliveryFeeAgorot: 3000,
  });
  await customerConfirm(order, 1500);
  await confirmBoth(order);
  let confirmed = await get(order);
  assert.ok(
    confirmed.customerConfirmed &&
      confirmed.storeConfirmed &&
      confirmed.driverConfirmed,
  );
  const oldSnapshot = confirmed.confirmationSnapshot;
  order = await request(`/orders/${order._id}`, store, "PATCH", {
    observed: oldSnapshot,
    goodsAmountAgorot: 15100,
  });
  assert.ok(
    !order.customerConfirmed && !order.storeConfirmed && !order.driverConfirmed,
  );
  await request(
    `/orders/${order._id}/confirm`,
    store,
    "POST",
    { observed: oldSnapshot },
    409,
  );
  order = await request(`/orders/${order._id}`, store, "PATCH", {
    observed: order.confirmationSnapshot,
    goodsAmountAgorot: 15000,
  });
  await customerConfirm(order);
  await confirmBoth(order);
  await customerConfirm(order);
  confirmed = await get(order);
  assert.ok(confirmed.storeConfirmed && confirmed.driverConfirmed);
  order = await request(`/orders/${order._id}`, store, "PATCH", {
    observed: confirmed.confirmationSnapshot,
    parcelReady: false,
  });
  assert.ok(
    order.customerConfirmed && !order.storeConfirmed && !order.driverConfirmed,
  );
  await request(
    `/orders/${order._id}/pickup`,
    d1,
    "POST",
    { code: order.pickupCode },
    422,
  );
  order = await request(`/orders/${order._id}`, store, "PATCH", {
    observed: order.confirmationSnapshot,
    parcelReady: true,
  });
  await confirmBoth(order);
  passed(
    "incomplete acceptance, ownership, pickup gate, confirmation invalidation and stale forms",
  );
  const driverView = await request(`/orders/${order._id}`, d1);
  for (const field of [
    "pickupCode",
    "deliveryCode",
    "customerToken",
    "customerLink",
  ])
    assert.equal(driverView[field], undefined);
  assert.equal(
    (await request(`/customer/${tokenOf(order)}`)).deliveryCode,
    undefined,
  );
  await request(
    `/orders/${order._id}/pickup`,
    d1,
    "POST",
    { code: "000000" },
    422,
  );
  await request(`/orders/${order._id}/pickup`, d1, "POST", {
    code: order.pickupCode.replace(/\d/g, (digit) =>
      String.fromCharCode(1632 + Number(digit)),
    ),
  });
  await request(
    `/orders/${order._id}/pickup`,
    d1,
    "POST",
    { code: order.pickupCode },
    409,
  );
  await request(
    `/orders/${order._id}`,
    store,
    "PATCH",
    { observed: order.confirmationSnapshot, parcelReady: false },
    409,
  );
  await request(
    `/admin/orders/${order._id}/cancel`,
    admin,
    "POST",
    { reason: "test" },
    409,
  );
  await request(
    `/admin/orders/${order._id}/assign`,
    admin,
    "POST",
    { driverId: sessions.driver2.user._id },
    409,
  );
  await request(`/customer/${tokenOf(order)}/confirm`, null, "POST", {}, 409);
  await request(`/orders/${order._id}/arrive-customer`, d1, "POST", {});
  const customer = await request(`/customer/${tokenOf(order)}`);
  assert.match(customer.deliveryCode, /^[1-9]\d{3}$/);
  await request(
    `/orders/${order._id}/deliver`,
    d1,
    "POST",
    {
      code: "000000",
      actualCashCollectedAgorot: 18000,
      observedExpectedAgorot: 18000,
    },
    422,
  );
  assert.equal((await get(order)).actualCashCollectedAgorot, null);
  await request(`/orders/${order._id}/deliver`, d1, "POST", {
    code: customer.deliveryCode,
    actualCashCollectedAgorot: 18000,
    observedExpectedAgorot: 18000,
  });
  await request(
    `/orders/${order._id}/deliver`,
    d1,
    "POST",
    {
      code: customer.deliveryCode,
      actualCashCollectedAgorot: 99999,
      observedExpectedAgorot: 18000,
      confirmDifference: true,
    },
    404, // Assignment ended: access is denied before checking the transition.
  );
  assert.equal(await request("/driver/orders/current", d1), null);
  assert.equal((await get(order)).actualCashCollectedAgorot, 18000);
  assert.equal((await get(order)).parcelHolder, "customer");
  passed(
    "complete delivery, hidden codes, incorrect codes, repeated actions, post-pickup lock",
  );
  let summary = await request("/driver/summary", d1);
  assert.equal(summary.cashHeldAgorot, 18000);
  assert.equal(summary.unpaidEarningsAgorot, 2700);
  const handover = {
    orderId: order._id,
    driverId: sessions.driver1.user._id,
    type: "cash_handover",
    amountAgorot: 18000,
    requestId: "test-handover",
    note: "استلام نقد / מזומן",
  };
  await Promise.all([
    request("/admin/driver-cash-records", admin, "POST", handover, 201),
    request("/admin/driver-cash-records", admin, "POST", handover, 201),
  ]);
  assert.equal(
    (await Order.findById(order._id).lean()).events.filter(e => e.type === "cash_handover_completed").length,
    1,
  );
  await request(
    "/admin/driver-cash-records",
    admin,
    "POST",
    { ...handover, amountAgorot: 1 },
    409,
  );
  summary = await request("/driver/summary", d1);
  assert.equal(summary.cashHeldAgorot, 0);
  assert.equal(summary.unpaidEarningsAgorot, 2700);
  const payment = {
    orderId: order._id,
    driverId: sessions.driver1.user._id,
    type: "driver_payment",
    requestId: "test-payment",
  };
  await request("/admin/driver-cash-records", admin, "POST", payment, 201);
  await request("/admin/driver-cash-records", admin, "POST", payment, 201);
  assert.equal(
    (await Order.findById(order._id).lean()).events.filter(e => e.type === "driver_payout_completed").length,
    1,
  );
  summary = await request("/driver/summary", d1);
  assert.equal(summary.cashHeldAgorot, 0);
  assert.equal(summary.unpaidEarningsAgorot, 0);
  assert.deepEqual(price(0, 5), {
    platformCommissionAgorot: 1,
    driverEarningsAgorot: 4,
    expectedCustomerCashAgorot: 5,
  });
  passed(
    "10/90 pricing, persistent financial submissions, separate cash and earnings",
  );
  const race = await create();
  const raceResults = await Promise.all(
    [d1, d2].map((token) =>
      fetch(`${base}/orders/${race._id}/accept`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    ),
  );
  assert.deepEqual(raceResults.map((r) => r.status).sort(), [200, 409]);
  await request(`/admin/orders/${race._id}/cancel`, admin, "POST", {
    reason: "race cleanup",
  });
  const pair = [await create(), await create()];
  const pairResults = await Promise.all(
    pair.map((o) =>
      fetch(`${base}/orders/${o._id}/accept`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${d1}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    ),
  );
  assert.deepEqual(pairResults.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    await Order.countDocuments({
      driverId: sessions.driver1.user._id,
      activeAssignment: true,
    }),
    1,
  );
  for (const o of pair)
    await request(`/admin/orders/${o._id}/cancel`, admin, "POST", {
      reason: "cleanup",
    });
  const assign = await create();
  await request(`/admin/orders/${assign._id}/assign`, admin, "POST", {
    driverId: sessions.driver1.user._id,
  });
  await request(`/orders/${assign._id}/arrive-store`, d1, "POST", {});
  await request(`/admin/orders/${assign._id}/assign`, admin, "POST", {
    driverId: sessions.driver2.user._id,
  });
  assert.equal(await request("/driver/orders/current", d1), null);
  await request(`/admin/orders/${assign._id}/cancel`, admin, "POST", {
    reason: "إلغاء قبل الاستلام",
  });
  assert.equal((await get(assign)).parcelHolder, "store");
  assert.equal(await request("/driver/orders/current", d2), null);
  passed(
    "two-driver accept race, one-driver two-order race, reassignment and cancellation",
  );
  const returned = await create({
    parcelDescription: "علبة أدوات",
    parcelReady: true,
    deliveryFeeAgorot: 2000,
  });
  await request(`/orders/${returned._id}/accept`, d1, "POST", {});
  await customerConfirm(returned);
  await confirmBoth(returned);
  await request(`/orders/${returned._id}/arrive-store`, d1, "POST", {});
  await request(`/orders/${returned._id}/pickup`, d1, "POST", {
    code: returned.pickupCode,
  });
  await request(`/orders/${returned._id}/fail`, d1, "POST", {
    reason: "تعذر التسليم / לא ניתן למסור",
    actualCashCollectedAgorot: 500,
  });
  assert.equal((await get(returned)).parcelHolder, "driver");
  await request(`/orders/${unavailable._id}/accept`, d1, "POST", {}, 409);
  await request(
    `/admin/orders/${returned._id}/authorize-return`,
    admin,
    "POST",
    {},
  );
  await request(
    `/orders/${returned._id}/confirm-return`,
    store2,
    "POST",
    {},
    404,
  );
  await request(`/orders/${returned._id}/confirm-return`, store, "POST", {});
  await request(
    `/orders/${returned._id}/confirm-return`,
    store,
    "POST",
    {},
    409,
  );
  assert.equal((await get(returned)).actualCashCollectedAgorot, 500);
  assert.equal((await get(returned)).parcelHolder, "store");
  assert.equal(await request("/driver/orders/current", d1), null);
  summary = await request("/driver/summary", d1);
  assert.equal(summary.earningsAgorot, 2700);
  assert.equal(summary.cashHeldAgorot, 500);
  passed(
    "failed delivery, retained parcel and cash, authorized return, store receipt",
  );
  const mismatch = await create({
    parcelDescription: "חבילה",
    parcelReady: true,
    deliveryFeeAgorot: 500,
  });
  await request(`/orders/${mismatch._id}/accept`, d2, "POST", {});
  await customerConfirm(mismatch, 250);
  await confirmBoth(mismatch, d2);
  await request(`/orders/${mismatch._id}/arrive-store`, d2, "POST", {});
  await request(`/orders/${mismatch._id}/pickup`, d2, "POST", {
    code: mismatch.pickupCode,
  });
  await request(`/orders/${mismatch._id}/arrive-customer`, d2, "POST", {});
  const mismatchCustomer = await request(`/customer/${tokenOf(mismatch)}`);
  await request(`/orders/${mismatch._id}/deliver`, d2, "POST", {
    code: mismatchCustomer.deliveryCode,
    actualCashCollectedAgorot: 1400,
    observedExpectedAgorot: 1500,
    confirmDifference: true,
  });
  const finances = await request("/admin/finance", admin);
  assert.equal(finances.commissionAgorot, 450);
  assert.equal(finances.driverEarningsAgorot, 4050);
  assert.equal(finances.expectedCashAgorot, 19500);
  assert.equal(finances.actualDeliveredCashAgorot, 19400);
  assert.equal(finances.cashCollectedAgorot, 19900);
  assert.equal(finances.cashHeldAgorot, 1900);
  assert.equal(finances.unpaidEarningsAgorot, 1350);
  assert.equal(finances.discrepancies.length, 1);
  assert.equal(finances.discrepancies[0].differenceAgorot, -100);
  passed(
    "actual-cash discrepancy, administrator totals and no fee double counting",
  );
  for (const path of ["/store", "/admin", `/customer/${tokenOf(order)}`]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<div id="root">/);
  }
  await request("/does-not-exist", null, "GET", undefined, 404);
  await stop();
  await start();
  assert.equal((await get(order)).status, "delivered");
  assert.equal((await get(returned)).status, "returned");
  assert.equal((await request("/driver/summary", d1)).cashHeldAgorot, 500);
  assert.equal((await Order.findById(order._id).lean()).cashHandover.requestId, handover.requestId);
  assert.equal((await Order.findById(order._id).lean()).driverPayout.requestId, payment.requestId);
  await seed();
  assert.equal((await get(order)).status, "delivered");
  assert.equal((await Order.findById(order._id).lean()).cashHandover.requestId, handover.requestId);
  assert.equal((await Order.findById(order._id).lean()).driverPayout.requestId, payment.requestId);
  passed(
    "same-port deep links, API 404, backend process restart and non-destructive reseed",
  );
  // ---- Phase 1: code lockout, attempt audit trail, cash difference ----
  const driver1Id = sessions.driver1.user._id,
    driver2Id = sessions.driver2.user._id;
  const wrongCode = "000000"; // real codes are 100000-999999, so never correct
  const pickupPath = (o) => `/orders/${o._id}/pickup`;
  const stateOf = (o, actorId, type) =>
    CodeAttemptState.findOne({ orderId: o._id, actorId, type }).lean();
  // Simulates the passing of a temporary lock without waiting for it.
  const expire = (o, actorId, type) =>
    CodeAttemptState.updateOne(
      { orderId: o._id, actorId, type },
      { $set: { lockedUntil: new Date(Date.now() - 1000) } },
    );
  async function atStore(driverToken, values = {}) {
    const o = await create({
      parcelDescription: "طرد",
      parcelReady: true,
      goodsAmountAgorot: 10000,
      deliveryFeeAgorot: 2000,
      ...values,
    });
    await request(`/orders/${o._id}/accept`, driverToken, "POST", {});
    await customerConfirm(o);
    await confirmBoth(o, driverToken);
    await request(`/orders/${o._id}/arrive-store`, driverToken, "POST", {});
    return o;
  }
  async function atCustomer(o, driverToken) {
    await request(pickupPath(o), driverToken, "POST", { code: o.pickupCode });
    await request(`/orders/${o._id}/arrive-customer`, driverToken, "POST", {});
    return (await request(`/customer/${tokenOf(o)}`)).deliveryCode;
  }
  const deliverPath = (o) => `/orders/${o._id}/deliver`;
  const indexes = await CodeAttemptState.collection.indexes();
  assert.ok(
    indexes.some(
      (i) => i.unique && i.key.orderId && i.key.actorId && i.key.type,
    ),
    "unique (orderId, actorId, type) index is required for atomic counting",
  );

  const lockOrder = await atStore(d1);
  for (let i = 1; i <= 4; i++) {
    // actorId / verificationType in the body must be ignored
    const r = await raw(pickupPath(lockOrder), d1, {
      code: wrongCode,
      actorId: driver2Id,
      verificationType: "delivery",
    });
    assert.equal(r.status, 422, `attempt ${i}`);
    assert.equal(r.data.code, "incorrect_pickup_code");
  }
  assert.equal(await CodeAttemptState.countDocuments({ orderId: lockOrder._id }), 1);
  assert.equal((await stateOf(lockOrder, driver1Id, "pickup")).failures, 4);
  let r = await raw(pickupPath(lockOrder), d1, { code: wrongCode });
  assert.equal(r.status, 429, "5th failure locks");
  assert.deepEqual(Object.keys(r.data).sort(), ["code", "retryAfterSeconds"]);
  assert.equal(r.data.code, "too_many_attempts");
  assert.ok(r.data.retryAfterSeconds >= 1 && r.data.retryAfterSeconds <= 60);
  assert.equal(r.retryAfter, String(r.data.retryAfterSeconds));
  // while locked even the correct code is refused, with the same response shape
  r = await raw(pickupPath(lockOrder), d1, { code: lockOrder.pickupCode });
  assert.equal(r.status, 429);
  assert.deepEqual(Object.keys(r.data).sort(), ["code", "retryAfterSeconds"]);
  assert.equal((await get(lockOrder)).status, "driver_at_store");
  // the lock lives in the database: a backend restart does not clear it
  await stop();
  await start();
  r = await raw(pickupPath(lockOrder), d1, { code: lockOrder.pickupCode });
  assert.equal(r.status, 429);
  assert.equal((await get(lockOrder)).status, "driver_at_store");
  for (const n of [6, 7, 8, 9]) {
    await expire(lockOrder, driver1Id, "pickup");
    r = await raw(pickupPath(lockOrder), d1, { code: wrongCode });
    assert.equal(r.status, 429, `failure ${n}`);
    assert.ok(r.data.retryAfterSeconds <= 60, `failure ${n} is a short lock`);
  }
  for (const n of [10, 11, 12, 13, 14]) {
    await expire(lockOrder, driver1Id, "pickup");
    r = await raw(pickupPath(lockOrder), d1, { code: wrongCode });
    assert.equal(r.status, 429, `failure ${n}`);
    assert.ok(
      r.data.retryAfterSeconds > 60 && r.data.retryAfterSeconds <= 600,
      `failure ${n} is a long lock`,
    );
  }
  await expire(lockOrder, driver1Id, "pickup");
  r = await raw(pickupPath(lockOrder), d1, { code: wrongCode });
  assert.equal(r.status, 429, "15th failure");
  assert.deepEqual(r.data, { code: "too_many_attempts", requiresAdmin: true });
  assert.equal(r.retryAfter, null);
  // a manual lock ignores the clock
  await expire(lockOrder, driver1Id, "pickup");
  r = await raw(pickupPath(lockOrder), d1, { code: lockOrder.pickupCode });
  assert.equal(r.status, 429);
  assert.deepEqual(r.data, { code: "too_many_attempts", requiresAdmin: true });
  assert.equal((await get(lockOrder)).status, "driver_at_store");

  const report = await request(`/admin/orders/${lockOrder._id}/code-attempts`, admin);
  assert.equal(report.states.length, 1);
  const [lockState] = report.states;
  assert.equal(lockState.actorId, driver1Id);
  assert.equal(lockState.actorName, sessions.driver1.user.name);
  assert.equal(lockState.type, "pickup");
  assert.equal(lockState.failures, 15);
  assert.equal(lockState.totalAttempts, 15);
  assert.ok(lockState.manualLock && lockState.locked);
  assert.equal(lockState.blockedCount, 3, "refused requests are counted, not logged");
  assert.equal(report.attempts.length, 15, "blocked requests add no audit rows");
  const wrongRows = report.attempts
    .filter((a) => a.result === "wrong_code")
    .sort((a, b) => a.attemptNumber - b.attemptNumber);
  assert.deepEqual(
    wrongRows.map((a) => a.attemptNumber),
    Array.from({ length: 15 }, (_, i) => i + 1),
  );
  assert.deepEqual(
    wrongRows.map((a) => a.lock),
    [
      ...Array(4).fill(null),
      ...Array(5).fill("short"),
      ...Array(5).fill("long"),
      "manual",
    ],
  );
  for (const a of wrongRows) {
    assert.equal(a.verificationType, "pickup");
    assert.equal(a.actorId, driver1Id);
    assert.ok(a.ip && a.userAgent, "ip and user agent are recorded");
  }
  // the audit trail never stores the submitted or the real code
  const auditKeys = new Set([
    "_id", "orderId", "actorId", "verificationType", "attemptNumber",
    "result", "lock", "ip", "userAgent", "adminId", "note", "createdAt", "__v",
  ]);
  for (const row of await CodeAttempt.find({}).lean())
    for (const [k, v] of Object.entries(row)) {
      assert.ok(auditKeys.has(k), `unexpected audit field ${k}`);
      if (["ip", "userAgent", "note"].includes(k))
        for (const secret of [wrongCode, lockOrder.pickupCode])
          assert.ok(!String(v).includes(secret), `audit ${k} contains a code`);
    }
  passed(
    "pickup code lockout 5/10/15, correct code refused while locked, persistence across restart, audit trail without the code",
  );

  const unlockPath = `/admin/orders/${lockOrder._id}/unlock-code`;
  await request(`/admin/orders/${lockOrder._id}/code-attempts`, store, "GET", undefined, 403);
  await request(`/admin/orders/${lockOrder._id}/code-attempts`, d1, "GET", undefined, 403);
  await request(`/admin/orders/${lockOrder._id}/code-attempts`, null, "GET", undefined, 401);
  await request(`/admin/orders/000000000000000000000999/code-attempts`, admin, "GET", undefined, 404);
  await request(unlockPath, d1, "POST", { actorId: driver1Id, verificationType: "pickup" }, 403);
  for (const bad of [
    { actorId: driver1Id, verificationType: { $ne: "x" } },
    { actorId: { $ne: null }, verificationType: "pickup" },
    { actorId: driver1Id, verificationType: "refund" },
    { verificationType: "pickup" },
  ])
    await request(unlockPath, admin, "POST", bad, 400);
  await request(unlockPath, admin, "POST", { actorId: driver2Id, verificationType: "pickup" }, 404);
  assert.ok((await stateOf(lockOrder, driver1Id, "pickup")).manualLock);
  const unlocked = await request(unlockPath, admin, "POST", {
    actorId: driver1Id,
    verificationType: "pickup",
    note: "اتصل السائق",
  });
  assert.equal(unlocked.states[0].failures, 0);
  assert.equal(unlocked.states[0].locked, false);
  assert.equal(unlocked.states[0].totalAttempts, 15);
  assert.equal(unlocked.states[0].blockedCount, 3);
  const unlockRow = unlocked.attempts.find((a) => a.result === "admin_unlock");
  assert.equal(unlockRow.note, "اتصل السائق");
  assert.equal(unlockRow.adminId, sessions.admin.user._id);
  assert.equal(unlockRow.actorId, driver1Id);
  assert.equal(
    (await request(pickupPath(lockOrder), d1, "POST", { code: lockOrder.pickupCode })).status,
    "collected",
  );
  const afterUnlock = await request(`/admin/orders/${lockOrder._id}/code-attempts`, admin);
  assert.equal(
    afterUnlock.attempts.find((a) => a.result === "success").attemptNumber,
    16,
    "attempt numbers keep counting after an unlock",
  );
  assert.equal(afterUnlock.states[0].failures, 0);
  await request(`/orders/${lockOrder._id}/arrive-customer`, d1, "POST", {});
  const lockOrderCode = (await request(`/customer/${tokenOf(lockOrder)}`)).deliveryCode;
  await request(deliverPath(lockOrder), d1, "POST", {
    code: lockOrderCode,
    actualCashCollectedAgorot: 12500,
    observedExpectedAgorot: 12500,
  });
  passed("administrator unlock: authorization, strict input, audit row, numbering continues");

  const scope = await atStore(d1);
  for (let i = 0; i < 5; i++)
    await raw(pickupPath(scope), d1, { code: wrongCode });
  assert.ok((await stateOf(scope, driver1Id, "pickup")).lockedUntil);
  await request(`/admin/orders/${scope._id}/assign`, admin, "POST", {
    driverId: driver2Id,
  });
  const scopeView = await request(`/orders/${scope._id}`, d2);
  await request(`/orders/${scope._id}/confirm`, d2, "POST", {
    observed: scopeView.confirmationSnapshot,
  });
  await request(`/orders/${scope._id}/arrive-store`, d2, "POST", {});
  r = await raw(pickupPath(scope), d2, { code: wrongCode });
  assert.equal(r.status, 422, "another driver starts with a fresh budget");
  r = await raw(pickupPath(scope), d1, { code: scope.pickupCode });
  assert.equal(r.status, 404, "the previous driver no longer owns the order");
  const scopeStates = (await request(`/admin/orders/${scope._id}/code-attempts`, admin)).states;
  assert.equal(scopeStates.length, 2);
  assert.equal(scopeStates.find((s) => s.actorId === driver1Id).locked, true);
  assert.equal(scopeStates.find((s) => s.actorId === driver2Id).failures, 1);
  await request(pickupPath(scope), d2, "POST", { code: scope.pickupCode });
  await request(`/orders/${scope._id}/arrive-customer`, d2, "POST", {});
  await request(deliverPath(scope), d2, "POST", {
    code: (await request(`/customer/${tokenOf(scope)}`)).deliveryCode,
    actualCashCollectedAgorot: 12500,
    observedExpectedAgorot: 12500,
  });
  passed("lock is keyed by order and driver: reassignment gives a fresh budget, body cannot spoof the actor");

  const burstOrder = await atStore(d1);
  const burst = await Promise.all(
    Array.from({ length: 30 }, () =>
      raw(pickupPath(burstOrder), d1, { code: wrongCode }),
    ),
  );
  const counts = {};
  for (const x of burst) counts[x.status] = (counts[x.status] || 0) + 1;
  assert.deepEqual(counts, { 422: 4, 429: 26 }, "30 parallel guesses");
  const burstState = await stateOf(burstOrder, driver1Id, "pickup");
  assert.equal(burstState.failures, 5);
  assert.equal(burstState.totalAttempts, 5);
  assert.equal(burstState.blockedCount, 25);
  assert.equal(
    await CodeAttempt.countDocuments({ orderId: burstOrder._id, result: "wrong_code" }),
    5,
  );
  await request(`/admin/orders/${burstOrder._id}/cancel`, admin, "POST", {
    reason: "burst cleanup",
  });
  passed("30 parallel wrong codes: exactly 5 are evaluated, the rest are refused");

  // Same race without HTTP between the guesses: all 60 start in the same tick,
  // which a check-then-write implementation cannot survive.
  const raceOrder = await atStore(d1);
  const guesses = await Promise.allSettled(
    Array.from({ length: 60 }, () =>
      verifyCode({
        order: raceOrder,
        actor: { _id: driver1Id },
        type: "pickup",
        submitted: wrongCode,
        expected: raceOrder.pickupCode,
      }),
    ),
  );
  assert.ok(guesses.every((g) => g.status === "rejected"));
  const raceCounts = {};
  for (const g of guesses)
    raceCounts[g.reason.status] = (raceCounts[g.reason.status] || 0) + 1;
  assert.deepEqual(raceCounts, { 422: 4, 429: 56 });
  const raceState = await stateOf(raceOrder, driver1Id, "pickup");
  assert.equal(raceState.failures, 5);
  assert.equal(raceState.totalAttempts, 5);
  assert.equal(raceState.blockedCount, 55);
  assert.equal(
    await CodeAttempt.countDocuments({ orderId: raceOrder._id, result: "wrong_code" }),
    5,
  );
  await request(`/admin/orders/${raceOrder._id}/cancel`, admin, "POST", {
    reason: "race cleanup",
  });
  passed("60 simultaneous guesses straight at the guard: exactly 5 are evaluated");

  const cashOrder = await atStore(d1);
  const cashCode = await atCustomer(cashOrder, d1);
  const body = (extra = {}) => ({
    code: cashCode,
    actualCashCollectedAgorot: 12500,
    observedExpectedAgorot: 12500,
    ...extra,
  });
  r = await raw(deliverPath(cashOrder), d1, {
    code: cashCode,
    actualCashCollectedAgorot: 12500,
  });
  assert.deepEqual([r.status, r.data.code], [400, "invalid_amount"]);
  r = await raw(deliverPath(cashOrder), d1, body({ observedExpectedAgorot: 11000 }));
  assert.equal(r.status, 409);
  assert.deepEqual(r.data, { code: "expected_amount_changed", expectedAgorot: 12500 });
  r = await raw(deliverPath(cashOrder), d1, body({ actualCashCollectedAgorot: 10000 }));
  assert.equal(r.status, 422);
  assert.deepEqual(r.data, {
    code: "difference_confirmation_required",
    expectedAgorot: 12500,
    actualAgorot: 10000,
    differenceAgorot: -2500,
  });
  r = await raw(
    deliverPath(cashOrder),
    d1,
    body({ actualCashCollectedAgorot: 10000, confirmDifference: "yes" }),
  );
  assert.deepEqual([r.status, r.data.code], [400, "invalid_input"]);
  for (const bad of [-5, 12000.5, "12000"])
    assert.equal(
      (await raw(deliverPath(cashOrder), d1, body({ actualCashCollectedAgorot: bad }))).status,
      400,
    );
  assert.equal(
    await stateOf(cashOrder, driver1Id, "delivery"),
    null,
    "amount rejections never consume a code attempt",
  );
  let cashView = await get(cashOrder);
  assert.equal(cashView.status, "driver_at_destination");
  assert.equal(cashView.actualCashCollectedAgorot, null);
  assert.equal(cashView.cashDifferenceAgorot, null);
  for (let i = 1; i <= 4; i++) {
    r = await raw(deliverPath(cashOrder), d1, body({ code: wrongCode }));
    assert.equal(r.status, 422);
    assert.equal(r.data.code, "incorrect_delivery_code");
  }
  r = await raw(deliverPath(cashOrder), d1, body({ code: wrongCode }));
  assert.equal(r.status, 429, "5th wrong delivery code locks");
  r = await raw(deliverPath(cashOrder), d1, body());
  assert.equal(r.status, 429, "correct delivery code refused while locked");
  assert.equal((await get(cashOrder)).status, "driver_at_destination");
  assert.equal((await stateOf(cashOrder, driver1Id, "pickup")).failures, 0);
  assert.equal((await stateOf(cashOrder, driver1Id, "delivery")).failures, 5);
  await expire(cashOrder, driver1Id, "delivery");
  r = await raw(
    deliverPath(cashOrder),
    d1,
    body({ actualCashCollectedAgorot: 11500, confirmDifference: true }),
  );
  assert.equal(r.status, 200, JSON.stringify(r.data));
  cashView = await get(cashOrder);
  assert.equal(cashView.status, "delivered");
  assert.equal(cashView.actualCashCollectedAgorot, 11500);
  assert.equal(cashView.cashDifferenceAgorot, -1000);
  assert.ok(cashView.cashDifferenceConfirmedAt);
  const recorded = (await request("/admin/finance", admin)).discrepancies.find(
    (x) => x._id === cashOrder._id,
  );
  assert.equal(recorded.differenceAgorot, -1000);
  passed(
    "delivery: server-side expected amount, stale/unconfirmed amounts rejected without burning attempts, delivery lock independent of pickup, difference recorded",
  );

  const staleOrder = await atStore(d1);
  let staleView = await get(staleOrder);
  await request(`/orders/${staleOrder._id}`, store, "PATCH", {
    observed: staleView.confirmationSnapshot,
    goodsAmountAgorot: 11000,
  });
  await customerConfirm(staleOrder);
  await confirmBoth(staleOrder);
  const staleCode = await atCustomer(staleOrder, d1);
  // the driver's screen still shows the 125.00 that was true before the edit
  r = await raw(deliverPath(staleOrder), d1, {
    code: staleCode,
    actualCashCollectedAgorot: 12500,
    observedExpectedAgorot: 12500,
  });
  assert.equal(r.status, 409);
  assert.deepEqual(r.data, { code: "expected_amount_changed", expectedAgorot: 13500 });
  assert.equal(await stateOf(staleOrder, driver1Id, "delivery"), null);
  assert.equal((await get(staleOrder)).status, "driver_at_destination");
  await request(deliverPath(staleOrder), d1, "POST", {
    code: staleCode,
    actualCashCollectedAgorot: 13500,
    observedExpectedAgorot: 13500,
  });
  staleView = await get(staleOrder);
  assert.equal(staleView.cashDifferenceAgorot, 0);
  assert.equal(staleView.cashDifferenceConfirmedAt, null);
  const overOrder = await atStore(d1);
  const overCode = await atCustomer(overOrder, d1);
  r = await raw(deliverPath(overOrder), d1, {
    code: overCode,
    actualCashCollectedAgorot: 13000,
    observedExpectedAgorot: 12500,
    confirmDifference: true,
  });
  assert.equal(r.status, 200);
  assert.equal((await get(overOrder)).cashDifferenceAgorot, 500);
  passed("stale expected amount within one order is rejected; exact amount needs no confirmation; overpayment is recorded as a positive difference");
  console.log(
    `\n${checkpoints.length} workflow groups passed against real MongoDB.`,
  );
} finally {
  await stop();
  await closeOfferLocations();
  await mongoose.disconnect();
  await router.close();
}
