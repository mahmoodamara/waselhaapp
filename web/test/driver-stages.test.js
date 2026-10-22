import assert from "node:assert/strict";
import { test } from "node:test";
import { stageOf, stepIndex, stepsFor } from "../../driver-app/stages.js";
import { translations as driver } from "../../driver-app/translations.js";

const quick = { workflowVersion: 2 };
const original = { workflowVersion: 1 };

test("each order status maps to the trip stage the driver is in", () => {
  assert.equal(stageOf({ ...quick, status: "driver_assigned" }), "toStore");
  assert.equal(stageOf({ ...quick, status: "driver_at_store" }), "atStore");
  assert.equal(stageOf({ ...quick, status: "collected" }), "toCustomer", "quick orders show the drive before code delivery");
  assert.equal(stageOf({ ...original, status: "collected" }), "toCustomer", "the original workflow has an arrival step");
  assert.equal(stageOf({ ...original, status: "driver_at_destination" }), "deliver");
  assert.equal(stageOf({ ...quick, status: "delivery_failed" }), "failed");
  assert.equal(stageOf({ ...quick, status: "returning" }), "returning");
  assert.equal(stageOf({ ...quick, status: "delivered" }), "other");
  assert.equal(stageOf(null), "other");
});
test("the progress bar has one step per stage of a normal trip", () => {
  assert.deepEqual(stepsFor(quick), ["toStore", "atStore", "toCustomer", "deliver"]);
  assert.deepEqual(stepsFor(original), ["toStore", "atStore", "toCustomer", "deliver"]);
  assert.equal(stepIndex({ ...quick, status: "driver_at_store" }), 1);
  assert.equal(stepIndex({ ...original, status: "driver_at_destination" }), 3);
  assert.equal(stepIndex({ ...quick, status: "delivery_failed" }), null, "no progress bar after a failed delivery");
});
test("every stage has a title and a hint in Arabic and Hebrew", () => {
  for (const stage of ["toStore", "atStore", "toCustomer", "deliver", "failed", "returning"])
    assert.ok(driver[`stage.${stage}`], `stage.${stage}`);
  for (const key of ["toStoreHint", "pickupHint", "toCustomerHint", "deliverHint", "stepOf", "navigateStore", "navigateCustomer",
    "callCustomer", "orderDetailsAll", "hideOrderDetails", "browseOffers"])
    assert.ok(driver[key], key);
  assert.match(driver.stepOf[0], /\{n\}.*\{total\}|\{total\}.*\{n\}/);
});
