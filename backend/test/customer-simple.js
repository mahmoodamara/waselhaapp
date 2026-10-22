import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { request, sessions, models, tokenOf, destination } from "./helpers/security.js";

beforeEach(async () => {
  await request("/store/pickup-service-area", sessions.store1.token, "PUT", { pickupServiceArea: "kafr-kanna" });
});
const make = async (extra = {}) => (await request("/orders", sessions.store1.token, "POST", {
  workflowVersion: 3, storeAuthorization: true, customerPhone: "0501234567", vehicleType: "motorcycle", parcelSize: "medium",
  parcelReady: true, goodsAmountAgorot: 8000, goodsPaymentStatus: "unpaid", deliveryFeePaidBy: "customer", ...extra,
}, 201)).data;
const view = async o => (await request(`/customer/${tokenOf(o)}`)).data;
const confirm = async (o, extra = {}, expected = 200) => request(`/customer/${tokenOf(o)}/confirm`, null, "POST", {
  requestId: "simple-customer-confirm", customerPhone: "0501234567", available: true,
  observed: (await view(o)).confirmationSnapshot, ...extra,
}, expected);

test("a customer confirms without a name and dispatch/pickup remain available", async () => {
  const o = await make();
  await request(`/customer/${tokenOf(o)}/location`, null, "POST", destination);
  const confirmed = (await confirm(o)).data;
  assert.equal(confirmed.customerConfirmed, true);
  assert.equal(confirmed.driverSearchStatus, undefined); // Internal search metadata stays private.
  const stored = await models.Order.findById(o._id).lean();
  assert.equal(stored.driverSearchStatus, "searching");
  assert.ok(!stored.recipientName);
  await request("/driver/orders/available", sessions.driver1.token);
  const headers = { "x-waselha-workflow": "3" };
  const accepted = (await request(`/orders/${o._id}/accept`, sessions.driver1.token, "POST", {
    dispatchVersion: stored.dispatchVersion, supportedWorkflowVersion: 3,
  }, 200, headers)).data;
  assert.ok(!accepted.missingRequirements.includes("customer_details_required"));
  assert.equal((await request(`/orders/${o._id}/pickup`, sessions.driver1.token, "POST", {
    requestId: "simple-pickup", supportedWorkflowVersion: 3,
  }, 200, headers)).data.status, "collected");
});

test("omitting the name preserves the merchant's existing optional name", async () => {
  const o = await make({ recipientName: "Merchant supplied name" });
  await request(`/customer/${tokenOf(o)}/location`, null, "POST", destination);
  await confirm(o);
  assert.equal((await models.Order.findById(o._id)).recipientName, "Merchant supplied name");
});

test("saving details without a name does not grant financial confirmation", async () => {
  const o = await make();
  await request(`/customer/${tokenOf(o)}/details`, null, "POST", {
    customerPhone: "0501234567", deliveryInstructions: "Door", observed: (await view(o)).confirmationSnapshot,
  });
  const stored = await models.Order.findById(o._id).lean();
  assert.equal(stored.customerConfirmed, false);
  assert.equal(stored.driverSearchStatus, "waiting");
  assert.ok(!stored.recipientName);
});

test("a supplied malformed name is still rejected", async () => {
  const o = await make();
  await request(`/customer/${tokenOf(o)}/location`, null, "POST", destination);
  assert.equal((await confirm(o, { recipientName: { $ne: null } }, 400)).data.code, "invalid_input");
});
