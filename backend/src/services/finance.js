import { Order, DriverCashRecord, User } from "../models/index.js";
import { fail, id } from "./validation.js";
import { reconcileOrder } from "./orderFinance.js";
import { driverSummary } from './driverSummary.js';
export { driverSummary };
export async function adminFinance() {
  const [drivers, orders] = await Promise.all([
    User.find({ role: "driver" }).select("name login active").lean(),
    Order.find().lean(),
  ]);
  const summaries = await Promise.all(
    drivers.map(async (driver) => ({
      ...(await driverSummary(driver._id, { admin: true })),
      driver,
    })),
  );
  const delivered = orders.filter((o) => o.status === "delivered");
  const sum = (list, field) =>
    list.reduce((n, item) => n + (item[field] ?? 0), 0);
  return {
    deliveredCount: delivered.length,
    deliveryFeesAgorot: sum(delivered, "deliveryFeeAgorot"),
    commissionAgorot: sum(delivered, "platformCommissionAgorot"),
    driverEarningsAgorot: sum(delivered, "driverEarningsAgorot"),
    goodsAgorot: sum(delivered, "goodsAmountAgorot"),
    expectedCashAgorot: sum(delivered, "expectedCustomerCashAgorot"),
    actualDeliveredCashAgorot: sum(delivered, "actualCashCollectedAgorot"),
    cashCollectedAgorot: sum(summaries, "cashCollectedAgorot"),
    cashHandedOverAgorot: sum(summaries, "cashHandedOverAgorot"),
    driverShortagePaidAgorot: sum(summaries, "driverShortagePaidAgorot"),
    cashHeldAgorot: sum(summaries, "cashHeldAgorot"),
    paymentsAgorot: sum(summaries, "paymentsAgorot"),
    unpaidEarningsAgorot: sum(summaries, "unpaidEarningsAgorot"),
    drivers: summaries,
    discrepancies: delivered
      .filter(
        (o) => o.actualCashCollectedAgorot !== o.expectedCustomerCashAgorot,
      )
      .map((o) => ({
        _id: o._id,
        driverId: o.driverId,
        storeName: o.storeName,
        expectedCashAgorot: o.expectedCustomerCashAgorot,
        actualCashAgorot: o.actualCashCollectedAgorot,
        differenceAgorot:
          o.actualCashCollectedAgorot - o.expectedCustomerCashAgorot,
      })),
  };
}
export async function recordCash(adminId, body) {
  // Historical driver-wide records remain readable. New writes must name one
  // order so this endpoint cannot bypass its one-time reconciliation guards.
  if (!body.orderId) fail("finance_order_required", 409);
  if (!["cash_handover", "driver_payment"].includes(body.type)) fail("invalid_input");
  const order = await Order.findById(id(body.orderId)).lean();
  if (!order) fail("not_found", 404);
  if (body.driverId && String(id(body.driverId)) !== String(order.driverId)) fail("forbidden", 403);
  const payout = body.type === "driver_payment";
  if (payout && Object.hasOwn(body, "amountAgorot")) fail("invalid_input");
  return reconcileOrder(order, { role: "admin", _id: adminId }, payout ? "driver-payout" : "cash-handover", {
    requestId: body.requestId,
    ...(payout ? {} : { amountAgorot: body.amountAgorot, note: body.note ?? "" }),
  });
}
