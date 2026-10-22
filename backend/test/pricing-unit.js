import assert from "node:assert/strict";
import { test } from "node:test";
import * as money from "../src/services/money.js";

const calculate = (meters) => {
  assert.equal(typeof money.calculateRoutePrice, "function", "STEP 5 route pricing is missing");
  return money.calculateRoutePrice(meters);
};
test("pricing: distance fee is 2 agorot per meter above the minimum", () => {
  for (const meters of [750, 751, 1250, 2000, 5000, 12340]) {
    const p = calculate(meters);
    assert.equal(p.routeDistanceMeters, meters);
    assert.equal(p.deliveryFeeAgorot, meters * 2);
  }
});
test("pricing: the 15 NIS minimum is applied on the server", () => {
  assert.equal(money.MINIMUM_DELIVERY_FEE_AGOROT, 1500);
  for (const meters of [0, 1, 100, 300, 749]) {
    const p = calculate(meters);
    assert.equal(p.routeDistanceMeters, meters, "the real distance is preserved");
    assert.equal(p.deliveryFeeAgorot, 1500);
    assert.equal(p.platformCommissionAgorot + p.driverEarningsAgorot, 1500);
  }
  assert.equal(calculate(750).deliveryFeeAgorot, 1500); // exactly the minimum
  assert.equal(calculate(751).deliveryFeeAgorot, 1502); // just above the minimum
  assert.equal(calculate(2000).deliveryFeeAgorot, 4000);
});
test("pricing: existing commission rounding and exact remainder", () => {
  for (const meters of [750, 751, 1253, 1257, 3001, 12341]) {
    const p = calculate(meters);
    assert.equal(p.platformCommissionAgorot, Math.floor((meters * 2 + 5) / 10));
    assert.equal(p.driverEarningsAgorot + p.platformCommissionAgorot, p.deliveryFeeAgorot);
  }
  assert.deepEqual(money.price(0, 5), { platformCommissionAgorot: 1, driverEarningsAgorot: 4, expectedCustomerCashAgorot: 5 });
});
test("pricing: malformed or unnormalized meter inputs rejected", () => {
  assert.equal(typeof money.calculateRoutePrice, "function");
  for (const value of [-1, null, NaN, Infinity, "1234", 1234.4, Number.MAX_SAFE_INTEGER])
    assert.throws(() => calculate(value));
});
test("pricing: integer money and exact split across 10000 distances", () => {
  for (let meters = 1; meters <= 10000; meters++) {
    const p = calculate(meters);
    assert.equal(p.deliveryFeeAgorot, Math.max(2 * meters, 1500));
    for (const key of ["deliveryFeeAgorot", "driverEarningsAgorot", "platformCommissionAgorot"])
      assert.ok(Number.isSafeInteger(p[key]));
    assert.equal(p.driverEarningsAgorot + p.platformCommissionAgorot, p.deliveryFeeAgorot);
  }
});
