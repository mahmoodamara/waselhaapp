import { Router } from "express";
import { User, Order } from "../models/index.js";
import { auth, roles, publicUser } from "../middleware/auth.js";
import { parseLocation } from "../services/location.js";
import { fail, id } from "../services/validation.js";
import { financeDue } from "../services/orderFinance.js";
import { ownedOrder, orderView } from "../services/orders.js";
import { config } from "../config.js";
import { parseServiceArea, supportedServiceAreas } from "../services/serviceAreas.js";
import { estimateFor } from "../services/deliveryFlow.js";
const router = Router();
function periodBoundary(year, month) {
  // Interpret the selected month in the store's time zone, including DST.
  // UTC boundaries would lose settlements recorded just after local midnight.
  const target = Date.UTC(year, month, 1);
  let instant = target;
  const format = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(format.formatToParts(new Date(instant)).filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
    const offset = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - instant;
    instant = target - offset;
  }
  return new Date(instant);
}
router.use(auth, roles("store"));
// This prototype's store accounts are owners. No employee/manager permission
// model is invented; financial decisions remain restricted to admin routes.
router.get("/permissions", (req, res) => res.json({ viewSettlements: true, decideFinance: false, quickDeliveryEnabled: config.quickDeliveryEnabled,
  unifiedDeliveryEnabled: config.unifiedDeliveryEnabled,
  localDeliveryEstimateAgorot: config.localDeliveryEstimateAgorot,
  // Display-only, from this store's pickup area to every supported delivery area.
  deliveryEstimatesAgorot: Object.fromEntries(supportedServiceAreas.map(area => [area, estimateFor(req.user.pickupServiceArea, area)])) }));
router.put("/pickup-service-area", async (req, res) => {
  const pickupServiceArea = parseServiceArea(req.body.pickupServiceArea);
  res.json(publicUser(await User.findByIdAndUpdate(req.user._id, { $set: { pickupServiceArea } },
    { new: true, runValidators: true }).lean()));
});
router.get("/settlements", async (req, res) => {
  const period = req.query.period;
  if (typeof period !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) fail("invalid_input");
  const [year, month] = period.split("-").map(Number);
  if (year < 2000 || year > 2200) fail("invalid_input");
  const start = periodBoundary(year, month - 1), end = periodBoundary(year, month);
  let dueAgorot = 0, payableAgorot = 0, recordedAgorot = 0, unresolvedCount = 0, legacyCount = 0;
  // Stream financial inputs in bounded batches; no full collection allocation.
  for await (const order of Order.find({ storeId: req.user._id, status: "delivered" })
    .select("financialSnapshot actualCashCollectedAgorot collectionAdjustment storeSettlement status")
    .lean().cursor({ batchSize: 100 })) {
    if (!order.financialSnapshot) { legacyCount++; continue; }
    if (order.storeSettlement?.status === "completed") {
      const at = new Date(order.storeSettlement.completedAt);
      if (at >= start && at < end) recordedAgorot += (order.storeSettlement.direction === "collect_from_store" ? -1 : 1) * order.storeSettlement.amountAgorot;
    } else if (order.collectionAdjustment?.status === "open") unresolvedCount++;
    else {
      const due = financeDue(order);
      if (due?.storeSettlementDirection === "pay_store") dueAgorot += due.storeSettlementAgorot;
      else if (due) payableAgorot += due.storeSettlementAgorot;
    }
  }
  const filter = { storeId: req.user._id, status: "delivered", "storeSettlement.status": "completed",
    "storeSettlement.completedAt": { $gte: start, $lt: end } };
  if (req.query.cursor) {
    const previous = await Order.findOne({ ...filter, _id: id(req.query.cursor) }).select("storeSettlement.completedAt").lean();
    if (!previous) fail("invalid_input");
    filter.$or = [{ "storeSettlement.completedAt": { $lt: previous.storeSettlement.completedAt } },
      { "storeSettlement.completedAt": previous.storeSettlement.completedAt, _id: { $lt: previous._id } }];
  }
  const records = await Order.find(filter).select("recipientName storeSettlement goodsAmountAgorot deliveryFeeAgorot deliveryFeePaidBy collectionAdjustment")
    .sort({ "storeSettlement.completedAt": -1, _id: -1 }).limit(31).lean();
  const more = records.length > 30;
  res.json({ period, dueAgorot, payableAgorot, recordedAgorot, unresolvedCount, legacyCount,
    inTransferAgorot: null, expectedArrivalAt: null,
    records: records.slice(0, 30).map(o => ({ _id: o._id, recipientName: o.recipientName,
      amountAgorot: o.storeSettlement.amountAgorot, direction: o.storeSettlement.direction,
      completedAt: o.storeSettlement.completedAt, status: "completed", reference: `ST-${String(o._id).slice(-6).toUpperCase()}` })),
    nextCursor: more ? String(records[29]._id) : null });
});
router.get("/settlements/:id", async (req, res) => {
  const order = await ownedOrder(req.user, req.params.id);
  if (!order.storeSettlement || order.status !== "delivered") fail("not_found", 404);
  const due = financeDue(order);
  res.json({ order: await orderView(order, "store"), reference: `ST-${String(order._id).slice(-6).toUpperCase()}`,
    goodsAgorot: order.financialSnapshot?.goodsAmountAgorot ?? null,
    deliveryLiabilityAgorot: order.financialSnapshot?.storeDeliveryFeeLiabilityAgorot ?? null,
    adjustmentAgorot: order.collectionAdjustment?.resolutionType === "store_absorbs" ? -order.collectionAdjustment.amountAgorot
      : order.collectionAdjustment?.resolutionType === "credit_store" ? order.collectionAdjustment.amountAgorot : 0,
    netAgorot: order.storeSettlement.status === "completed" ? order.storeSettlement.amountAgorot : due?.storeSettlementAgorot ?? null,
    direction: order.storeSettlement.direction ?? due?.storeSettlementDirection ?? null });
});
// The store saves its own pickup point. Existing orders keep the snapshot they
// were created with.
router.put("/pickup-location", async (req, res) =>
  res.json(
    publicUser(
      await User.findByIdAndUpdate(
        req.user._id,
        { $set: { pickupLocation: parseLocation(req.body) } },
        { new: true, runValidators: true },
      ).lean(),
    ),
  ),
);
export default router;
