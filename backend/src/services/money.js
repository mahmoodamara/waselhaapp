import { fail } from "./validation.js";
export function integerAmount(value, nullable = false) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) fail("invalid_amount", 400);
  return value;
}
export function price(goods, fee) {
  integerAmount(goods);
  integerAmount(fee, true);
  if (fee === null)
    return {
      platformCommissionAgorot: null,
      driverEarningsAgorot: null,
      expectedCustomerCashAgorot: null,
    };
  if (!Number.isSafeInteger(goods + fee) || !Number.isSafeInteger(fee + 5))
    fail("invalid_amount", 400);
  const commission = Math.floor((fee + 5) / 10);
  return {
    platformCommissionAgorot: commission,
    driverEarningsAgorot: fee - commission,
    expectedCustomerCashAgorot: goods + fee,
  };
}
// Pilot rule, enforced here and nowhere else: fee = max(road distance * 20 NIS/km,
// 15 NIS). The code constant is deliberate: changing it must be a reviewed
// deploy, because final prices of open orders are validated against it.
export const MINIMUM_DELIVERY_FEE_AGOROT = 1500;
// The routing adapter has already rounded to integer road meters. No shekel
// arithmetic; only the minimum above and the existing safe-money bound.
export function calculateRoutePrice(routeDistanceMeters) {
  if (!Number.isSafeInteger(routeDistanceMeters) || routeDistanceMeters < 0)
    fail("invalid_amount", 400);
  const deliveryFeeAgorot = integerAmount(Math.max(routeDistanceMeters * 2, MINIMUM_DELIVERY_FEE_AGOROT));
  const { platformCommissionAgorot, driverEarningsAgorot } = price(0, deliveryFeeAgorot);
  return { routeDistanceMeters, deliveryFeeAgorot, platformCommissionAgorot, driverEarningsAgorot };
}
