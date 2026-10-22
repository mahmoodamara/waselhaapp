import assert from "node:assert/strict";
import { test } from "node:test";
import { models, request, sessions, create, tokenOf, confirm, confirmLocation, pickedUp, restart } from "./helpers/security.js";
const reissue = (order, actor = sessions.store1.token, expected = 200) =>
  request(`/orders/${order._id}/customer-link/reissue`, actor, "POST", {}, expected);

test("CL-1: fresh link reads and confirms without customer login", async () => {
  const order = await create();
  const token = tokenOf(order);
  const view = (await request(`/customer/${token}`)).data;
  assert.equal(view.recipientName, "Customer name");
  assert.equal((await confirm(token)).customerConfirmed, true);
});
test("CL-13: an open order shows the sending store's phone; without one the field is absent", async () => {
  const order = await create();
  const token = tokenOf(order);
  const store = { login: "store1" };
  try {
    await models.User.updateOne(store, { $set: { phone: "052-123-4567" } });
    assert.equal((await request(`/customer/${token}`)).data.storePhone, "052-123-4567");
    assert.equal((await confirm(token)).storePhone, "052-123-4567");
    await models.User.updateOne(store, { $unset: { phone: "" } });
    assert.equal(Object.hasOwn((await request(`/customer/${token}`)).data, "storePhone"), false);
  } finally {
    await models.User.updateOne(store, { $unset: { phone: "" } });
  }
});
test("CL-12: newly issued links persist the configured expiry", async () => {
  const order = await create();
  const stored = await models.Order.collection.findOne({ _id: new models.Order.base.Types.ObjectId(order._id) });
  assert.ok(stored.customerTokenExpiresAt > new Date());
  const duration = stored.customerTokenExpiresAt - stored.createdAt;
  assert.ok(Math.abs(duration - 24 * 60 * 60 * 1000) < 5000, "pilot TTL is 24h");
});
test("CL-2: expired link rejects GET and POST and leaves details unchanged", async () => {
  const order = await create();
  const token = tokenOf(order);
  const view = (await request(`/customer/${token}`)).data;
  await models.Order.collection.updateOne({ customerToken: token }, { $set: { customerTokenExpiresAt: new Date(Date.now() - 1000) } });
  for (const [method, path, body] of [["GET", `/customer/${token}`], ["POST", `/customer/${token}/confirm`, { observed: view.confirmationSnapshot, recipientName: "Changed", finalAddress: "Changed" }]])
    assert.deepEqual((await request(path, null, method, body, 404)).data, { code: "not_found" });
  assert.equal((await models.Order.findById(order._id).lean()).recipientName, "Customer name");
});
test("CL-3/4/7: reissue rotates token, revokes old reads/writes and persists across server restart", async () => {
  const order = await create();
  const oldToken = tokenOf(order);
  const oldView = (await request(`/customer/${oldToken}`)).data;
  const { data: replacement } = await reissue(order);
  const newToken = tokenOf(replacement);
  assert.notEqual(newToken, oldToken);
  assert.match(newToken, /^[a-f0-9]{48}$/);
  assert.deepEqual(Object.keys(replacement).sort(), ["customerLink", "customerTokenExpiresAt"].sort());
  assert.ok(new Date(replacement.customerTokenExpiresAt) > new Date());
  await request(`/customer/${oldToken}`, null, "GET", undefined, 404);
  await request(`/customer/${oldToken}/confirm`, null, "POST", { observed: oldView.confirmationSnapshot }, 404);
  assert.equal((await confirm(newToken)).customerConfirmed, true);
  await restart();
  await request(`/customer/${oldToken}`, null, "GET", undefined, 404);
  await request(`/customer/${newToken}`);
  assert.equal((await models.Order.findById(order._id).lean()).customerToken, newToken);
});
test("CL-5: delivered customer view is minimal and mutations/reissue are rejected", async () => {
  const order = await create();
  await pickedUp(order);
  await request(`/orders/${order._id}/arrive-customer`, sessions.driver1.token, "POST", {});
  const customer = (await request(`/customer/${tokenOf(order)}`)).data;
  await request(`/orders/${order._id}/deliver`, sessions.driver1.token, "POST", {
    code: customer.deliveryCode, actualCashCollectedAgorot: 13000, observedExpectedAgorot: 13000,
  });
  const before = await models.Order.findById(order._id).lean();
  await request(`/customer/${tokenOf(order)}/confirm`, null, "POST", { recipientName: "Changed", finalAddress: "Changed", observed: customer.confirmationSnapshot }, 409);
  assert.deepEqual(await models.Order.findById(order._id).lean(), before);
  const final = (await request(`/customer/${tokenOf(order)}`)).data;
  assert.deepEqual(Object.keys(final).sort(), ["publicReference", "storeName", "status", "canEdit"].sort());
  assert.equal(final.status, "delivered");
  assert.equal(final.canEdit, false);
  await reissue(order, sessions.store1.token, 409);
});
test("CL-6: reissue during delivery preserves confirmations, pickup and customer delivery code", async () => {
  const order = await create();
  await pickedUp(order);
  const before = await models.Order.findById(order._id).lean();
  const { data: replacement } = await reissue(order, sessions.admin.token);
  const after = await models.Order.findById(order._id).lean();
  for (const key of ["status", "activeAssignment", "customerConfirmed", "storeConfirmed", "driverConfirmed", "pickupCode", "deliveryCode", "expectedCustomerCashAgorot"])
    assert.equal(after[key], before[key], `workflow preserved: ${key}`);
  await request(`/customer/${tokenOf(order)}`, null, "GET", undefined, 404);
  await request(`/orders/${order._id}/arrive-customer`, sessions.driver1.token, "POST", {});
  assert.equal((await request(`/customer/${tokenOf(replacement)}`)).data.deliveryCode, before.deliveryCode);
});
test("CL-8: unauthorized driver/other store/customer cannot reissue", async () => {
  const order = await create();
  await reissue(order, sessions.driver1.token, 403);
  await reissue(order, null, 401);
  const other = (await request("/admin/accounts", sessions.admin.token, "POST", {
    login: "other-store", password: "OtherStore123!", role: "store", name: "Other", storeName: "Other", pickupAddress: "Other pickup",
  }, 201)).data;
  const otherSession = (await request("/auth/login", null, "POST", { login: other.login, password: "OtherStore123!" })).data;
  await reissue(order, otherSession.token, 404);
  assert.equal((await models.Order.findById(order._id).lean()).customerToken, tokenOf(order));
});
test("CL-9: racing reissues leave exactly one valid token", async () => {
  const order = await create();
  const responses = await Promise.all([reissue(order, sessions.store1.token, null), reissue(order, sessions.admin.token, null)]);
  assert.ok(responses.every((r) => [200, 409].includes(r.status)));
  const links = responses.filter((r) => r.status === 200).map((r) => r.data);
  assert.ok(links.length > 0);
  const reads = await Promise.all(links.map((link) => request(`/customer/${tokenOf(link)}`, null, "GET", undefined, null)));
  assert.equal(reads.filter((r) => r.status === 200).length, 1);
  assert.ok(reads.every((r) => [200, 404].includes(r.status)));
  await request(`/customer/${tokenOf(order)}`, null, "GET", undefined, 404);
});
test("CL-10: legacy links have a finite lifetime based on createdAt without a bulk migration", async () => {
  const fresh = await create();
  await models.Order.collection.updateOne({ customerToken: tokenOf(fresh) }, { $unset: { customerTokenExpiresAt: "" } });
  await request(`/customer/${tokenOf(fresh)}`);
  await confirm(tokenOf(fresh));
  const old = await create();
  await models.Order.collection.updateOne({ customerToken: tokenOf(old) }, { $unset: { customerTokenExpiresAt: "" }, $set: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) } });
  await request(`/customer/${tokenOf(old)}`, null, "GET", undefined, 404);
  const replacement = (await reissue(old)).data;
  await request(`/customer/${tokenOf(replacement)}`);
});
test("CL-11: a confirmation that read an old token cannot write after reissue", async () => {
  const order = await create();
  await confirmLocation(tokenOf(order));
  const old = await models.Order.findById(order._id).lean();
  const view = (await request(`/customer/${tokenOf(order)}`)).data;
  await reissue(order);
  const { confirmCustomer } = await import("../src/services/orders.js");
  await assert.rejects(confirmCustomer(old, { observed: view.confirmationSnapshot, recipientName: "Stale recipient", finalAddress: "Stale address" }), (e) => e.status === 409);
  assert.equal((await models.Order.findById(order._id).lean()).recipientName, "Customer name");
});
