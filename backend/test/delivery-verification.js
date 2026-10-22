import assert from "node:assert/strict";
import { test } from "node:test";
import { create, pickedUp, request, sessions, models } from "./helpers/security.js";

const verify = (o, code, token = sessions.driver1.token, expected = 200) =>
  request(`/orders/${o._id}/verify-delivery-code`, token, "POST", { code }, expected);

test("verification authenticates the assigned driver and never completes delivery or collects cash", async () => {
  const o = await create();
  await pickedUp(o);
  await request(`/orders/${o._id}/arrive-customer`, sessions.driver1.token, "POST", {});
  const before = await models.Order.findById(o._id).lean();
  const view = (await request(`/orders/${o._id}`, sessions.driver1.token)).data;
  assert.match(before.deliveryCode, /^[1-9]\d{3}$/);
  assert.equal(view.deliveryCodeLength, 4);
  assert.equal(view.pickupCodeLength, 6);
  assert.equal(view.storePhone, (await models.User.findById(o.storeId).lean()).phone || null);
  assert.equal(view.deliveryCode, undefined);
  await verify(o, before.deliveryCode, null, 401);
  await verify(o, before.deliveryCode, sessions.driver2.token, 404);
  await verify(o, before.deliveryCode, sessions.store1.token, 403);
  const result = await verify(o, before.deliveryCode);
  assert.deepEqual(result.data, { verified: true });
  const after = await models.Order.findById(o._id).lean();
  for (const key of ["status", "activeAssignment", "actualCashCollectedAgorot", "deliveredAt"])
    assert.deepEqual(after[key], before[key], key);
  // A green client state does not bypass the final code and cash checks.
  await request(`/orders/${o._id}/deliver`, sessions.driver1.token, "POST", {
    code: "000000", actualCashCollectedAgorot: before.expectedCustomerCashAgorot,
    observedExpectedAgorot: before.expectedCustomerCashAgorot,
  }, 422);
  await request(`/orders/${o._id}/deliver`, sessions.driver1.token, "POST", {
    code: before.deliveryCode, actualCashCollectedAgorot: before.expectedCustomerCashAgorot,
    observedExpectedAgorot: before.expectedCustomerCashAgorot,
  });
});

test("verification shares final delivery attempt locks, rejects malformed input and premature stages", async () => {
  const o = await create();
  await pickedUp(o);
  await verify(o, "000000", sessions.driver1.token, 409);
  await request(`/orders/${o._id}/arrive-customer`, sessions.driver1.token, "POST", {});
  await verify(o, { $ne: null }, sessions.driver1.token, 400);
  await verify(o, "123456", sessions.driver1.token, 400);
  for (let i = 0; i < 4; i++) await verify(o, "0000", sessions.driver1.token, 422);
  const locked = await verify(o, "0000", sessions.driver1.token, 429);
  assert.ok(locked.data.retryAfterSeconds > 0);
  const raw = await models.Order.findById(o._id).lean();
  await verify(o, raw.deliveryCode, sessions.driver1.token, 429);
  const state = await models.CodeAttemptState.findOne({ orderId: o._id, type: "delivery" }).lean();
  assert.equal(state.failures, 5);
  await request(`/orders/${o._id}/deliver`, sessions.driver1.token, "POST", {
    code: raw.deliveryCode, actualCashCollectedAgorot: raw.expectedCustomerCashAgorot,
    observedExpectedAgorot: raw.expectedCustomerCashAgorot,
  }, 429);
});

test("legacy six-digit codes keep their length and support Arabic digits", async () => {
  const o = await create();
  await pickedUp(o);
  await models.Order.updateOne({ _id: o._id }, { $set: { workflowVersion: 2, deliveryCode: "482731" } });
  const view = (await request(`/orders/${o._id}`, sessions.driver1.token)).data;
  assert.equal(view.deliveryCodeLength, 6);
  assert.equal(view.deliveryCode, undefined);
  assert.deepEqual((await verify(o, "٤٨٢٧٣١")).data, { verified: true });
  const raw = await models.Order.findById(o._id).lean();
  assert.equal(raw.status, "collected");
  assert.equal(raw.deliveredAt, undefined);
});
