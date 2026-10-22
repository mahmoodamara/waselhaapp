import { config } from "../config.js";
import { price } from "./money.js";

import { isQuickWorkflow } from "../../../shared/workflow.js";
export const isQuickOrder = isQuickWorkflow;
export const goodsKnown = order => !isQuickOrder(order) || !!order.goodsAmountRecordedAt;
// Display-only estimates by (pickup area -> delivery area). A missing pair has
// no estimate. Add pairs here when a second service area exists.
const pairEstimates = {};
export function estimateFor(from, to) {
  if (!from || !to) return null;
  return from === to ? config.localDeliveryEstimateAgorot : pairEstimates[`${from}>${to}`] ?? null;
}
// Estimates are presentation only. No estimate enters the ledger or snapshot.
export function deliveryFlowView(order) {
  const known = goodsKnown(order);
  const estimate = isQuickOrder(order) && order.priceStatus !== "final"
    ? estimateFor(order.pickupServiceArea, order.serviceArea) : null;
  return {
    workflowVersion: order.workflowVersion ?? 1,
    goodsAmountKnown: known,
    goodsAmountAgorot: known ? order.goodsAmountAgorot : null,
    expectedCustomerCashAgorot: known ? order.expectedCustomerCashAgorot : null,
    estimatedDeliveryFeeAgorot: estimate,
    estimatedDriverEarningsAgorot: estimate == null ? null : price(0, estimate).driverEarningsAgorot,
  };
}
