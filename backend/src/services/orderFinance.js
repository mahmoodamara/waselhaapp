import { Order } from "../models/index.js";
import { price, integerAmount } from "./money.js";
import { fail, string } from "./validation.js";
import { operationalEvent } from "./orderTimeouts.js";

export function parseFeePayer(value) {
  if (value === undefined || value === null || value === "") fail("fee_payer_required", 422);
  if (value !== "customer" && value !== "store") fail("invalid_fee_payer");
  return value;
}
// STEP 5 remains the sole split/rounding authority. A missing legacy payer
// preserves the old expectation until an operator explicitly prepares it.
export function financeAmounts(goods, fee, payer, goodsPaymentStatus = "unpaid") {
  const amounts = price(goods, fee);
  if (payer == null) return amounts;
  parseFeePayer(payer);
  return { ...amounts,
    expectedCustomerCashAgorot: fee === null ? null : (goodsPaymentStatus === "prepaid" ? 0 : goods) + (payer === "customer" ? fee : 0),
    storeDeliveryFeeLiabilityAgorot: fee === null ? null : payer === "store" ? fee : 0,
  };
}
export function captureFinancialTerms(order, capturedAt) {
  const payer = parseFeePayer(order.deliveryFeePaidBy);
  const expected = financeAmounts(order.goodsAmountAgorot, integerAmount(order.deliveryFeeAgorot), payer, order.goodsPaymentStatus);
  if (!order.driverId || order.financialSnapshot ||
    Object.keys(expected).some(key => expected[key] !== order[key])) fail("financial_terms_required", 422);
  return {
    goodsAmountAgorot: order.goodsAmountAgorot, deliveryFeeAgorot: order.deliveryFeeAgorot,
    ...(order.goodsPaymentStatus ? { goodsPaymentStatus: order.goodsPaymentStatus } : {}),
    deliveryFeePaidBy: payer, ...expected, driverId: order.driverId,
    ...(order.routeDistanceMeters != null ? { routeDistanceMeters: order.routeDistanceMeters } : {}),
    priceSource: order.priceSource ?? "manual", capturedAt,
  };
}
// After a failed delivery the driver may still hold collected cash. Only that
// cash is settled there; no fee, payout or store settlement is invented.
export const failedStatuses = ["delivery_failed", "returning", "returned"];
// Explicit decision for a collection difference. The party is derived from the
// type, never from the client. Nothing is deducted automatically.
export const resolutionTypes = {
  shortage: { driver_pays: "driver", store_absorbs: "store", platform_absorbs: "platform" },
  overage: { refund_customer: "customer", credit_store: "store", platform_revenue: "platform" },
};
// What each record must equal for the order to balance. Everything is derived
// from the immutable snapshot, the delivered cash and the resolution decision.
export function financeDue(order) {
  const s = order.financialSnapshot, actual = order.actualCashCollectedAgorot;
  if (!s || !Number.isSafeInteger(actual)) return null;
  if (failedStatuses.includes(order.status)) return { cashHandoverAgorot: actual };
  const adjustment = order.collectionAdjustment, difference = adjustment?.amountAgorot ?? 0;
  let cash = actual, store = (s.goodsPaymentStatus === "prepaid" ? 0 : s.goodsAmountAgorot) - (s.storeDeliveryFeeLiabilityAgorot ?? 0);
  if (adjustment?.resolutionType === "driver_pays") cash += difference;
  if (adjustment?.resolutionType === "store_absorbs") store -= difference;
  if (adjustment?.resolutionType === "credit_store") store += difference;
  return { cashHandoverAgorot: cash, driverPayoutAgorot: s.driverEarningsAgorot,
    storeSettlementAgorot: Math.abs(store), storeSettlementDirection: store < 0 ? "collect_from_store" : "pay_store" };
}
export function financeComplete(order) {
  const due = financeDue(order);
  if (!due) return false;
  const done = (record, amount) => record?.status === "completed" && record.amountAgorot === amount;
  if (failedStatuses.includes(order.status))
    return order.actualCashCollectedAgorot === 0 || done(order.cashHandover, due.cashHandoverAgorot);
  const adjustment = order.collectionAdjustment;
  return order.status === "delivered" &&
    (!adjustment || (adjustment.status === "resolved" && !!adjustment.resolutionType)) &&
    done(order.cashHandover, due.cashHandoverAgorot) && done(order.driverPayout, due.driverPayoutAgorot) &&
    done(order.storeSettlement, due.storeSettlementAgorot) &&
    order.storeSettlement.direction === due.storeSettlementDirection;
}
export function financeView(order, role) {
  const value = { financeLegacy: ["collected", "driver_at_destination", "delivery_failed", "returning", "returned", "delivered"].includes(order.status) && !order.financialSnapshot,
    financeComplete: financeComplete(order) };
  if (role === "admin") return { ...value, financeDue: financeDue(order) };
  const record = (r) => r ? { status: r.status, ...(r.amountAgorot == null ? {} : { amountAgorot: r.amountAgorot }),
    ...(r.completedAt ? { completedAt: r.completedAt } : {}) } : null;
  return { ...value,
    financialSnapshot: role === "driver" && order.financialSnapshot ? {
      goodsAmountAgorot: order.financialSnapshot.goodsAmountAgorot,
      deliveryFeeAgorot: order.financialSnapshot.deliveryFeeAgorot,
      deliveryFeePaidBy: order.financialSnapshot.deliveryFeePaidBy,
      expectedCustomerCashAgorot: order.financialSnapshot.expectedCustomerCashAgorot,
      driverEarningsAgorot: order.financialSnapshot.driverEarningsAgorot,
      capturedAt: order.financialSnapshot.capturedAt,
    } : null,
    collectionAdjustment: order.collectionAdjustment ? {
      type: order.collectionAdjustment.type, amountAgorot: order.collectionAdjustment.amountAgorot,
      status: order.collectionAdjustment.status,
    } : null,
    cashHandover: record(order.cashHandover),
    ...(role === "driver" ? { driverPayout: record(order.driverPayout) } : {
      storeSettlement: record(order.storeSettlement),
      // Store-facing, derived amounts only; admin notes and command IDs stay private.
      storeNetDueAgorot: order.collectionAdjustment?.status === "open" ? null : financeDue(order)?.storeSettlementAgorot ?? null,
      storeNetDirection: financeDue(order)?.storeSettlementDirection ?? null,
    }),
  };
}
const actions = {
  "resolve-adjustment": { field: "collectionAdjustment", from: "open", to: "resolved", event: "collection_adjustment_resolved" },
  "cash-handover": { field: "cashHandover", from: "pending", to: "completed", event: "cash_handover_completed" },
  "driver-payout": { field: "driverPayout", from: "pending", to: "completed", event: "driver_payout_completed" },
  "store-settlement": { field: "storeSettlement", from: "pending", to: "completed", event: "store_settlement_completed" },
};
const dueKey = { "cash-handover": "cashHandoverAgorot", "driver-payout": "driverPayoutAgorot", "store-settlement": "storeSettlementAgorot" };
const keysFor = { "resolve-adjustment": ["resolutionNote", "resolutionType", "reference", "amountAgorot"],
  "cash-handover": ["amountAgorot", "note"], "store-settlement": ["amountAgorot", "note"], "driver-payout": [] };
// Amounts are never trusted: the client echoes what it expects to record and
// the server rejects anything that is not exactly what the order owes.
export async function reconcileOrder(order, actor, action, body) {
  if (actor?.role !== "admin") fail("forbidden", 403);
  if (action === "reverse-record") return reverseRecord(order, actor, body);
  const rule = actions[action];
  if (!rule) fail("invalid_input");
  if (Object.keys(body).some(key => !["requestId", ...keysFor[action]].includes(key))) fail("invalid_input");
  const requestId = string(body.requestId, true, 120);
  const resolution = action === "resolve-adjustment", payout = action === "driver-payout";
  const note = resolution ? string(body.resolutionNote, true, 300) : payout ? "" : string(body.note ?? "", false, 300);
  if (!order.financialSnapshot) fail("legacy_finance_unavailable", 409);
  const failedCash = failedStatuses.includes(order.status);
  if (failedCash ? action !== "cash-handover" : order.status !== "delivered") fail("finance_not_ready", 409);
  if (!Number.isSafeInteger(order.actualCashCollectedAgorot)) fail("finance_not_ready", 409);
  const adjustment = order.collectionAdjustment, due = financeDue(order);
  let amountAgorot, resolutionType, party, reference = "";
  if (resolution) {
    amountAgorot = adjustment?.amountAgorot;
    resolutionType = body.resolutionType;
    if (adjustment?.status === "open") {
      party = resolutionTypes[adjustment.type][resolutionType];
      if (!party) fail("invalid_resolution", 422);
      reference = string(body.reference, true, 120);
      if (body.amountAgorot !== amountAgorot) fail("amount_mismatch", 422, { expectedAgorot: amountAgorot });
    } else reference = string(body.reference ?? "", false, 120);
  } else amountAgorot = payout ? due[dueKey[action]] : integerAmount(body.amountAgorot);
  integerAmount(amountAgorot);
  function replay(current) {
    const record = current?.[rule.field];
    if (record?.status !== rule.to || record.requestId !== requestId) fail("finance_already_completed", 409);
    if (record.amountAgorot !== amountAgorot || (resolution ? record.resolutionNote : record.note ?? "") !== note ||
      (resolution && (record.resolutionType !== resolutionType || (record.resolutionReference ?? "") !== reference)))
      fail("request_conflict", 409);
    return current;
  }
  if (order[rule.field]?.status === rule.to) return replay(order);
  // Reversal clears the live record's ID, but never its event. A delayed
  // request from before that reversal must not record the payment again.
  if (order.events?.some(e => e.type === rule.event && e.requestId === requestId)) fail("request_conflict", 409);
  if (failedCash ? order.actualCashCollectedAgorot === 0 : order[rule.field]?.status !== rule.from) fail("finance_not_ready", 409);
  if (!resolution && !payout && adjustment?.status === "open") fail("adjustment_unresolved", 409);
  if (!resolution && !payout && amountAgorot !== due[dueKey[action]])
    fail("amount_mismatch", 422, { expectedAgorot: due[dueKey[action]] });
  const now = new Date();
  const prefix = rule.field;
  const values = { [`${prefix}.status`]: rule.to, [`${prefix}.requestId`]: requestId };
  if (resolution) Object.assign(values, { [`${prefix}.resolvedAt`]: now, [`${prefix}.resolvedBy`]: actor._id,
    [`${prefix}.resolutionNote`]: note, [`${prefix}.resolutionType`]: resolutionType,
    [`${prefix}.resolutionParty`]: party, [`${prefix}.resolutionReference`]: reference });
  else Object.assign(values, { [`${prefix}.amountAgorot`]: amountAgorot, [`${prefix}.completedAt`]: now,
    [`${prefix}.completedBy`]: actor._id, [`${prefix}.note`]: note,
    ...(action === "store-settlement" ? { [`${prefix}.direction`]: due.storeSettlementDirection } : {}) });
  // The inputs of the calculation (snapshot, delivered cash, adjustment decision)
  // are part of the write condition: a concurrent change makes this write a no-op.
  const result = await Order.findOneAndUpdate(
    { _id: order._id, status: failedCash ? { $in: failedStatuses } : "delivered",
      [`${prefix}.status`]: failedCash ? { $ne: "completed" } : rule.from,
      [`${prefix}.revision`]: order[prefix]?.revision ?? { $exists: false },
      "financialSnapshot.capturedAt": order.financialSnapshot.capturedAt,
      actualCashCollectedAgorot: order.actualCashCollectedAgorot,
      events: { $not: { $elemMatch: { type: rule.event, requestId } } },
      "collectionAdjustment.status": adjustment ? adjustment.status : { $exists: false },
      "collectionAdjustment.resolutionType": adjustment?.resolutionType ?? { $exists: false },
      ...(payout ? { "financialSnapshot.driverEarningsAgorot": amountAgorot } : {}) },
    { $set: values, $push: { events: operationalEvent(rule.event, now, actor, { amountAgorot, requestId,
      ...(resolution ? { reason: resolutionType, ...(reference ? { reference } : {}) } : {}), ...(note ? { note } : {}) }) } },
    { new: true, runValidators: true },
  ).lean();
  return result ?? replay(await Order.findById(order._id).lean());
}
// A wrongly recorded payment is reopened, never edited: the old amount and the
// reason stay in the event history and the record returns to pending.
async function reverseRecord(order, actor, body) {
  if (Object.keys(body).some(key => !["requestId", "record", "reason"].includes(key))) fail("invalid_input");
  const requestId = string(body.requestId, true, 120), reason = string(body.reason, true, 300);
  const rule = actions[body.record];
  if (!rule || body.record === "resolve-adjustment") fail("invalid_input");
  if (order.events?.some(e => e.type === "finance_record_reversed" && e.requestId === requestId)) return order;
  const record = order[rule.field];
  if (!order.financialSnapshot || record?.status !== "completed") fail("finance_not_ready", 409);
  const payout = body.record === "driver-payout", prefix = rule.field;
  const result = await Order.findOneAndUpdate(
    { _id: order._id, status: { $in: ["delivered", ...failedStatuses] }, [`${prefix}.status`]: "completed",
      [`${prefix}.requestId`]: record.requestId, "events.requestId": { $ne: requestId } },
    { $set: { [`${prefix}.status`]: "pending", ...(payout ? { [`${prefix}.amountAgorot`]: order.financialSnapshot.driverEarningsAgorot } : {}) },
      $inc: { [`${prefix}.revision`]: 1 },
      $unset: { [`${prefix}.completedAt`]: "", [`${prefix}.completedBy`]: "", [`${prefix}.requestId`]: "",
        [`${prefix}.note`]: "", [`${prefix}.direction`]: "", ...(payout ? {} : { [`${prefix}.amountAgorot`]: "" }) },
      $push: { events: operationalEvent("finance_record_reversed", new Date(), actor,
        { amountAgorot: record.amountAgorot, requestId, reference: body.record, note: reason }) } },
    { new: true, runValidators: true },
  ).lean();
  if (!result) fail("state_conflict", 409);
  return result;
}
