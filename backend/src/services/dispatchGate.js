import { isConfirmedLocation } from "./location.js";
import { goodsKnown } from "./deliveryFlow.js";
import { isUnifiedOrder } from "../../../shared/workflow.js";

// A quick order is offered to drivers only once the trip cannot change under them:
// the store asked for the delivery, the customer placed the destination, the final
// route price exists, the customer confirmed that total and can receive the parcel
// now. "Ready for dispatch" is derived from those fields, never stored.
//
// Gated orders carry `customerAvailable`; orders created before the gate do not,
// and keep the rule they were created under (search from creation).
export const isGated = order => typeof order?.customerAvailable === "boolean";

// Why a gated order is not ready, in the order the customer works through it.
export function dispatchMissing(order) {
  if (!isGated(order)) return [];
  const missing = [];
  if (isUnifiedOrder(order) && !order.parcelReady) missing.push("parcel_not_ready");
  if (isUnifiedOrder(order) && order.customerConfirmedRevision !== order.detailsRevision) missing.push("customer_confirmation_required");
  if (!order.storeAuthorizedAt) missing.push("store_authorization_required");
  if (!goodsKnown(order)) missing.push("goods_amount_required");
  if (!isConfirmedLocation(order.destinationLocation)) missing.push("destination_location_required");
  if (order.priceSource !== "route" || order.priceStatus !== "final" || order.routeProvider !== "osrm")
    missing.push("route_price_required");
  if (order.deliveryFeeAgorot == null || order.expectedCustomerCashAgorot == null) missing.push("fee_required");
  if (!order.customerPhone) missing.push("customer_details_required");
  if (!order.customerConfirmed) missing.push("customer_confirmation_required");
  if (order.customerAvailable !== true) missing.push("customer_availability_required");
  return missing;
}

// The same conditions as a MongoDB filter, so every write that starts or resumes a
// search re-checks them atomically with the write itself.
export const readyFilter = () => ({
  $or: [{ workflowVersion: { $ne: 3 } }, { parcelReady: true, $expr: { $eq: ["$customerConfirmedRevision", "$detailsRevision"] } }],
  customerAvailable: true, customerConfirmed: true,
  storeAuthorizedAt: { $ne: null }, goodsAmountRecordedAt: { $ne: null },
  "destinationLocation.confirmedAt": { $ne: null },
  priceSource: "route", priceStatus: "final", routeProvider: "osrm",
  deliveryFeeAgorot: { $ne: null }, expectedCustomerCashAgorot: { $ne: null },
  customerPhone: { $nin: ["", null] },
});

// Takes an unassigned order out of the search: offers disappear on the next reconcile.
export const pausedSearch = () => ({ driverSearchStatus: "waiting", searchStartedAt: null, searchDeadlineAt: null });

// What the store and the customer are told about an unassigned gated order.
export function dispatchState(order) {
  if (!isGated(order) || order.status !== "searching_driver" || order.activeAssignment) return null;
  if (order.driverSearchStatus === "searching") return "searching";
  if (order.driverSearchStatus === "no_driver") return "no_driver";
  if (order.customerConfirmed && order.customerAvailable === false) return "customer_later";
  if (isUnifiedOrder(order) && order.customerConfirmed && !order.parcelReady) return "waiting_store";
  return dispatchMissing(order).length ? "waiting_customer" : "customer_ready";
}
