import assert from "node:assert/strict";
import { test } from "node:test";
import { merchantTasks } from "../src/merchant/model.js";

test("quick merchant tasks never demand customer details, readiness or additional consent", () => {
  const o = { _id: "quick", workflowVersion: 2, canEdit: true, status: "driver_assigned",
    serviceArea: "kafr-kanna", parcelReady: false, storeConfirmed: false,
    missingRequirements: ["customer_details_required", "goods_amount_required", "customer_confirmation_required"] };
  assert.deepEqual(merchantTasks(o), []);
  assert.deepEqual(merchantTasks({ ...o, workflowVersion: 1 }).map(t => t.kind).sort(), ["edit", "ready"]);
  assert.deepEqual(merchantTasks({ ...o, status: "searching_driver", driverSearchStatus: "no_driver" }).map(t => t.kind), ["retry"]);
  assert.deepEqual(merchantTasks({ ...o, status: "returning", canEdit: false }).map(t => t.kind), ["return"]);
});
import { goodsInput, quickPayload } from "../src/merchant/quickPayload.js";

test("quick payload: goods only, Arabic digits, large forces a car, never a fee", () => {
  const p = quickPayload({ area: "kafr-kanna", vehicle: "motorcycle", size: "large", goods: "١٥٠" });
  assert.equal(p.goodsAmountAgorot, 15000);
  assert.equal(p.vehicleType, "car");
  assert.equal(p.parcelSize, "large");
  assert.equal(p.deliveryFeeAgorot, undefined);
  assert.equal(p.customerPhone, undefined);
  assert.equal(quickPayload({ area: "kafr-kanna", vehicle: "motorcycle", size: "small", goods: "0" }).goodsAmountAgorot, 0);
  assert.throws(() => quickPayload({ area: "kafr-kanna", vehicle: "car", size: "medium", goods: "" }));
  assert.throws(() => quickPayload({ area: "kafr-kanna", vehicle: "", size: "medium", goods: "10" }));
  assert.throws(() => quickPayload({ area: "", vehicle: "car", size: "medium", goods: "10" }));
});
test("goods input accepts Arabic digits and rejects junk", () => {
  assert.equal(goodsInput("١٥٠"), 15000);
  assert.equal(goodsInput("150.5"), 15050);
  assert.equal(goodsInput("150,5"), 15050);
  assert.equal(goodsInput("abc"), null);
  assert.equal(goodsInput("-5"), null);
  assert.equal(goodsInput("1.234"), null);
});
test("choosing a large parcel first supplies the automatic car without a prior vehicle choice", () => {
  const p = quickPayload({ area: "kafr-kanna", vehicle: "", size: "large", goods: "150" });
  assert.equal(p.vehicleType, "car");
  assert.equal(p.goodsAmountAgorot, 15000);
  assert.throws(() => quickPayload({ area: "kafr-kanna", vehicle: "", size: "medium", goods: "150" }));
});
test("a quick order created without goods asks the store to record them", () => {
  const o = { _id: "legacy", workflowVersion: 2, canEdit: true, status: "driver_assigned", serviceArea: "kafr-kanna",
    goodsAmountKnown: false, missingRequirements: ["goods_amount_required"] };
  assert.deepEqual(merchantTasks(o).map(t => t.kind), ["edit"]);
  assert.deepEqual(merchantTasks({ ...o, goodsAmountKnown: true }), []);
});
