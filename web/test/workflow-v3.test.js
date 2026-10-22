import assert from "node:assert/strict";
import { test } from "node:test";
import { unifiedPayload } from "../src/merchant/quickPayload.js";
import { merchantTasks, operationalState } from "../src/merchant/model.js";
import { dispatchWave } from "../../shared/workflow.js";

test("unified merchant payload needs no destination area and keeps cash/payment/readiness distinct", () => {
  const payload = unifiedPayload({ phone: "٠٥٠١٢٣٤٥٦٧", name: "", vehicle: "motorcycle", size: "large",
    goods: "80", goodsPaymentStatus: "prepaid", parcelReady: false, deliveryFeePaidBy: "store", notes: "", reference: "" });
  assert.equal(payload.workflowVersion, 3); assert.equal(payload.customerPhone, "0501234567");
  assert.equal(payload.vehicleType, "car"); assert.equal(payload.goodsAmountAgorot, 8000);
  assert.equal(payload.parcelReady, false); assert.equal(payload.goodsPaymentStatus, "prepaid");
  assert.equal(Object.hasOwn(payload, "serviceArea"), false);
  assert.throws(() => unifiedPayload({ ...payload, phone: "wrong", goods: "80", vehicle: "car", size: "small" }), { code: "invalid_phone" });
});
test("store task is readiness, with no pickup-code or extra store confirmation task", () => {
  const order = { _id: "order", workflowVersion: 3, status: "searching_driver", canEdit: true,
    parcelReady: false, dispatchState: "waiting_store", customerConfirmed: true, priceStatus: "final" };
  assert.deepEqual(merchantTasks(order).map(task => task.kind), ["ready"]);
  assert.equal(operationalState(order).title, "waitingStore");
  assert.deepEqual(merchantTasks({ ...order, parcelReady: true }), []);
});
test("search expands in three bounded waves and preserves the legacy policy", () => {
  const order = { workflowVersion: 3, searchStartedAt: new Date(1000), searchDeadlineAt: new Date(10000) };
  assert.equal(dispatchWave(order, 1000), 1); assert.equal(dispatchWave(order, 4000), 2);
  assert.equal(dispatchWave(order, 7000), 3); assert.equal(dispatchWave(order, 100000), 3);
  assert.equal(dispatchWave({ ...order, workflowVersion: 2 }, 1000), 3);
});
