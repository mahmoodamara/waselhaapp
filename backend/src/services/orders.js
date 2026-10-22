import { randomInt, createHash } from "node:crypto";
import { isUnifiedOrder, isQuickWorkflow, PAYMENT_STATUSES, supportsUnifiedWorkflow } from "../../../shared/workflow.js";
import { requireDeliveryCoverage } from "./coverage.js";
import { Order, User } from "../models/index.js";
import { fail, id, string, customerPhone } from "./validation.js";
import { integerAmount, calculateRoutePrice } from "./money.js";
import { financeAmounts, parseFeePayer, captureFinancialTerms, financeView } from "./orderFinance.js";
import { getRouteDistance } from "./routing.js";
import { verifyCode } from "./codeGuard.js";
import { issueCustomerToken, customerLink, customerAccessFilter } from "./customerLinks.js";
import { searchWindow, operationalEvent, releaseAssignment, hasOrderCommand, unusedOrderCommand } from "./orderTimeouts.js";
import { eligibleOrderFilter } from "./driverEligibility.js";
import { parseServiceArea } from "./serviceAreas.js";
import { config } from "../config.js";
import { ordersChanged } from "./orderSignals.js";
import { withTrackingOrder } from "./trackingGate.js";
import { log } from "./log.js";
import { publicOrderReference } from "./publicOrderReference.js";
import { isQuickOrder, goodsKnown, deliveryFlowView } from "./deliveryFlow.js";
import { isGated, dispatchMissing, dispatchState, readyFilter, pausedSearch } from "./dispatchGate.js";
import {
  parseLocation,
  isConfirmedLocation,
  validCoordinates,
  sameLocation,
  snapshotLocation,
} from "./location.js";

export const beforePickup = [
  "searching_driver",
  "driver_assigned",
  "driver_at_store",
];
export const terminal = ["delivered", "cancelled", "returned"];
const customerFields = [
  "customerPhone",
  "preliminaryAddress",
  "recipientName",
  "finalAddress",
  "deliveryInstructions",
  "goodsAmountAgorot",
  "deliveryFeeAgorot",
  "deliveryFeePaidBy",
  "expectedCustomerCashAgorot",
  "customerConfirmed",
  "priceStatus",
  "routeDistanceMeters",
  "routeCalculatedAt",
  "goodsAmountRecordedAt",
  "workflowVersion",
];
const detailFields = [
  ...customerFields,
  "pickupAddress",
  "parcelDescription",
  "parcelSize",
  "vehicleType",
  "parcelReady",
  "driverId",
  "area",
  "serviceArea",
  // Derived: lets a store/driver holding an older view be told it is stale
  // when the customer changes the destination.
  "destinationConfirmedAt",
  "pickupConfirmedAt",
  "storeAuthorizedAt",
];
const flags = ["storeConfirmed", "driverConfirmed"];
const commandDigest = body => createHash("sha256").update(JSON.stringify(body, (_key, value) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)).digest("hex");
const editableTexts = [
  "area",
  "customerPhone",
  "preliminaryAddress",
  "recipientName",
  "finalAddress",
  "deliveryInstructions",
  "parcelDescription",
];
const allCustomerChanges = [
  "customerPhone",
  "preliminaryAddress",
  "recipientName",
  "finalAddress",
  "deliveryInstructions",
  "goodsAmountAgorot",
  "deliveryFeeAgorot",
  "deliveryFeePaidBy",
];
function normalize(v) {
  if (v instanceof Date) return v.toISOString();
  return v?.toHexString ? v.toHexString() : (v ?? null);
}
// Where a snapshot key lives on the order, and the MongoDB path to match it by.
const read = (order, k) =>
  k === "destinationConfirmedAt"
    ? (order.destinationLocation?.confirmedAt ?? null)
    : k === "pickupConfirmedAt" ? (order.pickupLocation?.confirmedAt ?? null) : (order[k] ?? null);
const path = (k) =>
  k === "destinationConfirmedAt" ? "destinationLocation.confirmedAt"
    : k === "pickupConfirmedAt" ? "pickupLocation.confirmedAt" : k;
export function snapshot(order, customer = false) {
  const fields = [...(customer ? (isQuickOrder(order)
    ? [...customerFields, "destinationConfirmedAt", "pickupConfirmedAt"] : customerFields) : detailFields)];
  if (isUnifiedOrder(order)) fields.push("detailsRevision", "goodsPaymentStatus");
  return Object.fromEntries(
    fields.map((k) => [
      k,
      normalize(read(order, k)),
    ]),
  );
}
function observedFilter(order, observed, customer = false) {
  if (!observed || typeof observed !== "object") fail("stale_details", 409);
  const current = snapshot(order, customer);
  // Older clients have no parcelSize key. Only tolerate its absence on an
  // order which also has no size; never overwrite a new size from a stale view.
  if (Object.keys(current).some((k) => normalize(observed[k]) !== current[k]))
    fail("stale_details", 409);
  return Object.fromEntries(
    Object.keys(current).map((k) => [path(k), read(order, k)]),
  );
}
function currentFilter(order) {
  return {
    _id: order._id,
    status: order.status,
    activeAssignment: order.activeAssignment,
    acceptedAt: order.acceptedAt ?? null,
    ...(isUnifiedOrder(order) ? { detailsRevision: order.detailsRevision, dispatchVersion: order.dispatchVersion,
      parcelReady: order.parcelReady, goodsPaymentStatus: order.goodsPaymentStatus } : {}),
    ...Object.fromEntries(
      [...detailFields, ...flags].map((k) => [path(k), read(order, k)]),
    ),
  };
}
async function update(order, changes, extra = {}, event, operation) {
  const events = event ? (Array.isArray(event) ? [...event] : [event]) : [];
  const filter = { ...currentFilter(order), ...extra };
  // Identity and effects commit together. Append to the stored ledger rather
  // than replacing it from a document read before another command committed.
  if (operation) filter["operations.requestId"] = { $ne: operation.requestId };
  if (isUnifiedOrder(order) && changes.customerConfirmed === false) {
    changes = { ...changes, detailsRevision: order.detailsRevision + 1, customerConfirmedRevision: null, customerAgreement: null };
  }
  // A gated order whose customer must confirm again, or who is no longer free to
  // receive it, leaves the driver search in this same write. Matching the search
  // state makes a concurrent dispatch start and this write exclusive.
  if (isGated(order) && order.status === "searching_driver" && !order.activeAssignment &&
      (changes.customerConfirmed === false || changes.customerAvailable === false || (isUnifiedOrder(order) && changes.parcelReady === false))) {
    changes = { ...changes, ...pausedSearch() };
    filter.driverSearchStatus = order.driverSearchStatus ?? null;
    if (["searching", "no_driver"].includes(order.driverSearchStatus))
      events.push(operationalEvent("driver_search_paused", new Date(), null,
        { reason: changes.customerConfirmed === false ? "confirmation_voided" : "customer_unavailable" }));
  }
  const push = {
    ...(events.length ? { events: { $each: events } } : {}),
    ...(operation ? { operations: operation } : {}),
  };
  return withTrackingOrder(order._id, async () => {
    const result = await Order.findOneAndUpdate(
      filter,
      { $set: changes, ...(Object.keys(push).length ? { $push: push } : {}) },
      { new: true, runValidators: true },
    ).lean();
    if (!result) fail("state_conflict", 409);
    ordersChanged();
    return result;
  });
}
export async function ownedOrder(user, orderId, operation) {
  const order = await Order.findById(id(orderId)).lean();
  if (!order) fail("not_found", 404);
  if (user.role === "store" && String(order.storeId) !== String(user._id))
    fail("not_found", 404);
  if (
    user.role === "driver" &&
    (String(order.driverId) !== String(user._id) || (order.activeAssignment !== true &&
      !(isUnifiedOrder(order) && typeof operation?.requestId === "string" && order.operations?.some(op =>
        op.requestId === operation.requestId && String(op.actorId) === String(user._id)))))
  )
    fail("not_found", 404);
  if (isUnifiedOrder(order) && user.role === "driver" && user.supportedWorkflowVersion !== 3) fail("app_update_required", 409);
  return order;
}
export function missingPickup(order) {
  const missing = [];
  const quick = isQuickOrder(order);
  if (isUnifiedOrder(order) && (!order.parcelReady || !order.driverAgreement ||
      order.customerConfirmedRevision !== order.detailsRevision)) missing.push("parcel_not_ready");
  if (quick && !order.storeAuthorizedAt) missing.push("store_authorization_required");
  if (!goodsKnown(order)) missing.push("goods_amount_required");
  try { parseFeePayer(order.deliveryFeePaidBy); } catch { missing.push("fee_payer_required"); }
  if (!order.driverId || !order.activeAssignment)
    missing.push("driver_required");
  if (!order.customerPhone || (!quick && !order.finalAddress))
    missing.push("customer_details_required");
  if (!order.customerConfirmed) missing.push("customer_confirmation_required");
  if (!isConfirmedLocation(order.destinationLocation))
    missing.push("destination_location_required");
  if (order.priceSource === "route") {
    if (!validCoordinates(order.pickupLocation?.lat, order.pickupLocation?.lng))
      missing.push("pickup_location_required");
    if (!hasFinalRoutePrice(order)) missing.push("route_price_required");
  }
  if (!order.pickupAddress || (!quick && !order.parcelDescription))
    missing.push("parcel_details_required");
  if (!quick && !order.parcelReady) missing.push("parcel_not_ready");
  if (
    order.deliveryFeeAgorot === null ||
    order.expectedCustomerCashAgorot === null
  )
    missing.push("fee_required");
  if (!quick && !order.storeConfirmed) missing.push("store_confirmation_required");
  if (!quick && !order.driverConfirmed) missing.push("driver_confirmation_required");
  return missing;
}
export function holder(status) {
  return status === "delivered"
    ? "customer"
    : [
          "collected",
          "driver_at_destination",
          "delivery_failed",
          "returning",
        ].includes(status)
      ? "driver"
      : "store";
}
export async function orderView(order, role) {
  // No customer details or confirmation snapshot before assignment or once
  // assignment ends (including the successful delivery response).
  if (role === "driver" && order.activeAssignment !== true)
    return {
      _id: order._id,
      storeId: order.storeId,
      storeName: order.storeName,
      pickupAddress: order.pickupAddress,
      area: order.area,
      serviceArea: order.serviceArea ?? null,
      // Enough to decide on an offer; nothing about the customer.
      pickupServiceArea: order.pickupServiceArea ?? null,
      vehicleType: order.vehicleType ?? null,
      parcelSize: order.parcelSize ?? null,
      parcelDescription: order.parcelDescription,
      parcelReady: order.parcelReady,
      goodsAmountAgorot: order.goodsAmountAgorot,
      deliveryFeeAgorot: order.deliveryFeeAgorot,
      platformCommissionAgorot: order.platformCommissionAgorot,
      driverEarningsAgorot: order.driverEarningsAgorot,
      expectedCustomerCashAgorot: order.expectedCustomerCashAgorot,
      priceSource: pricingView(order).priceSource,
      priceStatus: pricingView(order).priceStatus,
      customerConfirmed: order.customerConfirmed,
      storeConfirmed: order.storeConfirmed,
      status: order.status,
      createdAt: order.createdAt,
      missingRequirements: missingPickup(order),
      ...deliveryFlowView(order),
    };
  const value = {
    ...order,
    ...pricingView(order),
    ...deliveryFlowView(order),
    ...financeView(order, role),
    dispatchState: dispatchState(order),
    dispatchMissing: dispatchMissing(order),
    confirmationSnapshot: snapshot(order),
    missingRequirements: missingPickup(order),
    parcelHolder: holder(order.status),
    canEdit: beforePickup.includes(order.status),
  };
  delete value.__v;
  delete value.pickupCode;
  delete value.deliveryCode;
  delete value.customerToken;
  delete value.commandIds;
  delete value.operations;
  if (role === "driver") {
    // Length only: neither secret is ever disclosed to the driver.
    if (!isUnifiedOrder(order)) value.pickupCodeLength = String(order.pickupCode).length;
    value.deliveryCodeLength = String(order.deliveryCode).length;
    const store = await User.findById(order.storeId).select("phone").lean();
    value.storePhone = store?.phone || null;
  }
  if (role === "driver") delete value.customerTokenExpiresAt;
  if (role !== "admin") {
    // Financial audit notes, request IDs and other parties' records are private.
    value.events = (order.events ?? []).filter(e => !["collection_adjustment_resolved", "cash_handover_completed",
      "driver_payout_completed", "store_settlement_completed", "finance_record_reversed"].includes(e.type));
    delete value[role === "driver" ? "storeSettlement" : "driverPayout"];
  }
  if (order.driverId && order.status !== "searching_driver") {
    const driver = await User.findById(order.driverId)
      .select("name phone vehicleType")
      .lean();
    value.assignedDriver = driver
      ? { _id: driver._id, name: driver.name, phone: driver.phone, vehicleType: driver.vehicleType ?? null }
      : null;
  } else value.assignedDriver = null;
  if (role === "store") {
    value.customerLink = customerLink(order);
    if (value.canEdit && !isUnifiedOrder(order)) value.pickupCode = order.pickupCode;
  }
  return value;
}
export function customerView(order) {
  if (terminal.includes(order.status))
    return { publicReference: publicOrderReference(order), storeName: order.storeName, status: order.status, canEdit: false,
      ...(isUnifiedOrder(order) ? { workflowVersion: 3, goodsAmountAgorot: order.goodsAmountAgorot,
        deliveryFeeAgorot: order.deliveryFeeAgorot, expectedCustomerCashAgorot: order.expectedCustomerCashAgorot,
        actualCashCollectedAgorot: order.actualCashCollectedAgorot, deliveredAt: order.deliveredAt ?? null } : {}) };
  return {
    publicReference: publicOrderReference(order),
    storeName: order.storeName,
    recipientName: order.recipientName,
    customerPhone: order.customerPhone,
    goodsPaymentStatus: order.goodsPaymentStatus ?? "unpaid",
    detailsRevision: order.detailsRevision ?? null,
    customerConfirmedRevision: order.customerConfirmedRevision ?? null,
    dispatchMissing: dispatchMissing(order),
    preliminaryAddress: order.preliminaryAddress,
    finalAddress: order.finalAddress,
    deliveryInstructions: order.deliveryInstructions,
    deliveryFeeAgorot: order.deliveryFeeAgorot,
    deliveryFeePaidBy: order.deliveryFeePaidBy ?? null,
    ...pricingView(order),
    workflowVersion: order.workflowVersion ?? 1,
    goodsAmountKnown: goodsKnown(order),
    goodsAmountAgorot: goodsKnown(order) ? order.goodsAmountAgorot : null,
    expectedCustomerCashAgorot: goodsKnown(order) ? order.expectedCustomerCashAgorot : null,
    estimatedDeliveryFeeAgorot: deliveryFlowView(order).estimatedDeliveryFeeAgorot,
    status: order.status,
    customerConfirmed: order.customerConfirmed,
    // Gated orders ask the customer whether they can receive it now; none of the
    // dispatch machinery is shown beyond this simple state.
    availabilityRequired: isGated(order),
    customerAvailable: order.customerAvailable ?? null,
    dispatchState: dispatchState(order),
    // Once a driver has accepted a gated order, the destination is final.
    canChangeLocation: beforePickup.includes(order.status) && !(isGated(order) && order.activeAssignment),
    // The customer's own confirmed destination; null until they confirm one.
    destinationLocation: order.destinationLocation ?? null,
    // Only where the map should open; legacy orders have none.
    mapCenter: order.pickupLocation
      ? { lat: order.pickupLocation.lat, lng: order.pickupLocation.lng }
      : null,
    canEdit: beforePickup.includes(order.status),
    confirmationSnapshot: snapshot(order, true),
    ...(order.status === "driver_at_destination" || (isQuickOrder(order) && order.status === "collected")
      ? { deliveryCode: order.deliveryCode }
      : {}),
  };
}
function allowedEdits(body, manualFee = false) {
  const fields = {};
  if (Object.hasOwn(body, "parcelSize")) {
    if (!["small", "medium", "large"].includes(body.parcelSize)) fail("invalid_input");
    fields.parcelSize = body.parcelSize;
  }
  for (const key of editableTexts)
    if (Object.hasOwn(body, key))
      fields[key] = string(body[key]);
  if (Object.hasOwn(body, "parcelReady")) {
    if (typeof body.parcelReady !== "boolean") fail("invalid_input");
    fields.parcelReady = body.parcelReady;
  }
  if (Object.hasOwn(body, "goodsAmountAgorot"))
    fields.goodsAmountAgorot = integerAmount(body.goodsAmountAgorot);
  if (Object.hasOwn(body, "goodsPaymentStatus")) {
    if (!PAYMENT_STATUSES.includes(body.goodsPaymentStatus)) fail("invalid_input");
    fields.goodsPaymentStatus = body.goodsPaymentStatus;
  }
  for (const key of ["goodsPaymentReference", "merchantOrderReference"])
    if (Object.hasOwn(body, key)) fields[key] = string(body[key], false, 120);
  if (Object.hasOwn(body, "deliveryFeePaidBy")) fields.deliveryFeePaidBy = parseFeePayer(body.deliveryFeePaidBy);
  if (Object.hasOwn(body, "deliveryFeeAgorot") && body.deliveryFeeAgorot !== null)
    integerAmount(body.deliveryFeeAgorot);
  if (manualFee && Object.hasOwn(body, "deliveryFeeAgorot"))
    fields.deliveryFeeAgorot = integerAmount(body.deliveryFeeAgorot, true);
  return fields;
}
const vehicleTypes = ["motorcycle", "car"];
// A large parcel needs a car. Smaller parcels fit either vehicle.
const fitsVehicle = (vehicleType, parcelSize) => !(vehicleType === "motorcycle" && parcelSize === "large");
export async function createOrder(store, body, fixedId) {
  if (body.workflowVersion !== undefined && ![1, 2, 3].includes(body.workflowVersion)) fail("invalid_input");
  const unified = isUnifiedOrder(body), quick = isQuickWorkflow(body);
  if (unified && !config.unifiedDeliveryEnabled) fail("unified_delivery_disabled", 409);
  if (quick && !config.quickDeliveryEnabled) fail("quick_delivery_disabled", 409);
  if (quick && body.storeAuthorization !== true) fail("store_authorization_required", 422);
  const fields = allowedEdits(body);
  if (quick) {
    // The store alone supplies what a driver needs to decide, plus the invoice
    // (goods only, never the delivery fee). Nothing about the customer.
    if (body.vehicleType == null) fail("vehicle_type_required", 422);
    if (!vehicleTypes.includes(body.vehicleType)) fail("invalid_input");
    if (body.parcelSize == null) fail("parcel_size_required", 422);
    if (!Object.hasOwn(body, "goodsAmountAgorot")) fail("goods_amount_required", 422);
    if (!fitsVehicle(body.vehicleType, body.parcelSize)) fail("vehicle_size_mismatch", 422);
    fields.vehicleType = body.vehicleType;
  }
  fields.deliveryFeePaidBy = parseFeePayer(quick ? body.deliveryFeePaidBy ?? "customer" : body.deliveryFeePaidBy);
  if (quick && !unified && fields.deliveryFeePaidBy !== "customer") fail("invalid_fee_payer");
  const serviceArea = parseServiceArea(body.serviceArea ?? (unified ? store.pickupServiceArea : undefined));
  if (quick && !store.pickupServiceArea) fail("pickup_service_area_required", 422);
  if (!quick && !fields.area && !fields.customerPhone) fail("required_fields");
  if (quick) { fields.area = serviceArea; if (!unified) fields.parcelReady = false; }
  if (unified) {
    fields.customerPhone = customerPhone(body.customerPhone);
    if (typeof body.parcelReady !== "boolean") fail("invalid_input");
    fields.goodsPaymentStatus ??= "unpaid";
    fields.goodsPaymentRecordedAt = new Date(); fields.goodsPaymentRecordedBy = store._id;
    fields.parcelReadyUpdatedAt = new Date();
  }
  // A physical delivery needs a known pickup point; nothing is guessed.
  if (!isConfirmedLocation(store.pickupLocation))
    fail("pickup_location_required", 422);
  const goods = fields.goodsAmountAgorot ?? 0, fee = null;
  const created = (
    await Order.create({
      ...fields,
      ...(quick ? { workflowVersion: body.workflowVersion, storeAuthorizedAt: new Date(), pickupServiceArea: store.pickupServiceArea,
        ...(Object.hasOwn(fields, "goodsAmountAgorot") ? { goodsAmountRecordedAt: new Date() } : {}) } : {}),
      serviceArea,
      ...(unified ? { detailsRevision: 1, dispatchVersion: 0 } : {}),
      // A quick order waits for its customer; the search starts in startDispatchIfReady.
      ...(quick ? { customerAvailable: false, ...pausedSearch() } : searchWindow()),
      events: quick ? [] : [operationalEvent("driver_search_started", new Date(), store)],
      ...(fixedId ? { _id: fixedId } : {}),
      storeId: store._id,
      storeName: store.storeName || store.name,
      pickupAddress: store.pickupAddress,
      pickupLocation: snapshotLocation(store.pickupLocation),
      priceSource: "route",
      ...pendingRoute(),
      goodsAmountAgorot: goods,
      deliveryFeeAgorot: fee,
      ...financeAmounts(goods, fee, fields.deliveryFeePaidBy, fields.goodsPaymentStatus),
      ...issueCustomerToken(),
      ...(!unified ? { pickupCode: String(randomInt(100000, 1000000)) } : {}),
      deliveryCode: String(randomInt(1000, 10000)),
    })
  ).toObject();
  // Disabling a store checks for open orders after it deactivates the account;
  // this is the matching check on the creating side, so one of the two always
  // loses the race and an inactive store never keeps a live order.
  if (!(await User.exists({ _id: store._id, role: "store", active: true }))) {
    const now = new Date();
    await Order.updateOne({ _id: created._id, status: "searching_driver", activeAssignment: false },
      { $set: { status: "cancelled", driverSearchStatus: null, cancelledAt: now, cancellationReason: "store_inactive" },
        $push: { events: operationalEvent("order_cancelled", now, null,
          { fromStatus: "searching_driver", toStatus: "cancelled", reason: "store_inactive" }) } });
    fail("unauthorized", 401);
  }
  ordersChanged();
  return created;
}
// Values that are safe to repeat in the history. Free-text PII fields are
// recorded by name only.
const auditedValues = ["goodsAmountAgorot", "deliveryFeeAgorot", "deliveryFeePaidBy", "serviceArea", "goodsPaymentStatus", "parcelReady"];
function editEvent(order, values, changed, actor) {
  return operationalEvent("order_details_edited", new Date(), actor, {
    changes: changed.map((field) => ({ field, ...(auditedValues.includes(field)
      ? { from: order[field] ?? null, to: values[field] ?? null } : {}) })),
  });
}
export async function editOrder(order, body, actor) {
  if (!beforePickup.includes(order.status)) fail("editing_blocked", 409);
  observedFilter(order, body.observed);
  const values = allowedEdits(body, order.priceSource !== "route");
  if (!isUnifiedOrder(order)) { delete values.goodsPaymentStatus; delete values.goodsPaymentReference; delete values.merchantOrderReference; }
  if (values.parcelSize && order.vehicleType && !fitsVehicle(order.vehicleType, values.parcelSize))
    fail("vehicle_size_mismatch", 422);
  if (Object.hasOwn(body, "serviceArea")) {
    values.serviceArea = parseServiceArea(body.serviceArea);
    if (values.serviceArea !== order.serviceArea && order.activeAssignment)
      fail("editing_blocked", 409);
  }
  if (
    !(values.area ?? order.area) &&
    !(values.customerPhone ?? order.customerPhone)
  )
    fail("required_fields");
  const changed = Object.keys(values).filter(
    (k) => values[k] !== (k === "area" ? (order[k] ?? "") : order[k]),
  );
  const recordsGoods = isQuickOrder(order) && Object.hasOwn(values, "goodsAmountAgorot") && !goodsKnown(order);
  if (!changed.length && !recordsGoods) return order;
  if (isUnifiedOrder(order)) {
    if (order.activeAssignment) fail("editing_blocked", 409);
    if (Object.hasOwn(values, "customerPhone")) values.customerPhone = customerPhone(values.customerPhone);
    if (changed.includes("goodsPaymentStatus")) Object.assign(values, { goodsPaymentRecordedAt: new Date(), goodsPaymentRecordedBy: actor._id });
    if (changed.includes("parcelReady")) values.parcelReadyUpdatedAt = new Date();
    if (changed.every(key => ["parcelReady", "merchantOrderReference"].includes(key)))
      return startDispatchIfReady(await update(order, values, {}, editEvent(order, values, changed, actor)));
  }
  if (isQuickOrder(order) && !isUnifiedOrder(order) && values.deliveryFeePaidBy && values.deliveryFeePaidBy !== "customer") fail("invalid_fee_payer");
  // Dispatch metadata is independent of the destination and financial details.
  if (changed.length && changed.every((key) => key === "serviceArea") && !recordsGoods)
    return update(order, values, {}, editEvent(order, values, changed, actor));
  const changes = { ...values, storeConfirmed: false, driverConfirmed: false };
  if (isUnifiedOrder(order)) changes.customerConfirmed = false;
  if (isQuickOrder(order) && Object.hasOwn(values, "goodsAmountAgorot")) changes.goodsAmountRecordedAt = new Date();
  if (recordsGoods) changes.customerConfirmed = false;
  if (changed.some((k) => allCustomerChanges.includes(k)))
    changes.customerConfirmed = false;
  if (
    changed.some((k) => ["goodsAmountAgorot", "deliveryFeeAgorot", "deliveryFeePaidBy", "goodsPaymentStatus"].includes(k))
  )
    Object.assign(
      changes,
      financeAmounts(
        values.goodsAmountAgorot ?? order.goodsAmountAgorot,
        Object.hasOwn(values, "deliveryFeeAgorot")
          ? values.deliveryFeeAgorot
          : order.deliveryFeeAgorot,
        values.deliveryFeePaidBy ?? order.deliveryFeePaidBy,
        values.goodsPaymentStatus ?? order.goodsPaymentStatus,
      ),
    );
  return update(order, changes, {}, editEvent(order, values, changed, actor));
}
export async function confirmCustomer(order, body) {
  let operation;
  if (isUnifiedOrder(order) && body.requestId !== undefined) {
    const requestId = string(body.requestId, true, 120);
    const digest = commandDigest(body);
    operation = { requestId, action: "customer-confirm", digest, at: new Date() };
    const prior = order.operations?.find(op => op.requestId === requestId);
    if (prior) {
      if (prior.action !== operation.action || prior.digest !== digest || prior.actorId) fail("operation_conflict", 409);
      return order;
    }
  }
  if (!beforePickup.includes(order.status)) fail("editing_blocked", 409);
  if (isUnifiedOrder(order) && order.activeAssignment) fail("editing_blocked", 409);
  const filter = observedFilter(order, body.observed, true);
  const values = {
    recipientName: string(body.recipientName === undefined ? order.recipientName ?? "" : body.recipientName),
    finalAddress: string(isQuickOrder(order) ? body.finalAddress ?? order.finalAddress ?? "" : body.finalAddress, !isQuickOrder(order)),
    deliveryInstructions: string(body.deliveryInstructions ?? ""),
  };
  if (isQuickOrder(order)) {
    values.customerPhone = customerPhone(body.customerPhone);
    if (!goodsKnown(order)) fail("goods_amount_required", 422);
    if (!isConfirmedLocation(order.destinationLocation)) fail("destination_location_required", 422);
  }
  if (order.deliveryFeeAgorot === null) fail("fee_required", 422);
  if (order.priceSource === "route" && !hasFinalRoutePrice(order)) fail("route_price_required", 422);
  // "Ready now" or "later" is chosen in the same step as the total; it is not a
  // second confirmation. The first answer is recorded even when it is "later".
  const now = new Date(), answer = availabilityAnswer(order, body);
  if (answer) Object.assign(values, { customerAvailable: answer.available, customerAvailabilityUpdatedAt: now });
  const changed = Object.keys(values).some((k) => k !== "customerAvailabilityUpdatedAt" && values[k] !== order[k]) ||
    (!!answer && !order.customerAvailabilityUpdatedAt);
  if (!changed && order.customerConfirmed && !operation) return startDispatchIfReady(order);
  let saved;
  try { saved = await update(
    order,
    {
      ...values,
      customerConfirmed: true,
      ...(isUnifiedOrder(order) ? { customerConfirmedRevision: order.detailsRevision,
        customerAgreement: { confirmedAt: now, detailsRevision: order.detailsRevision,
          deliveryFeeAgorot: order.deliveryFeeAgorot, expectedCustomerCashAgorot: order.expectedCustomerCashAgorot,
          routeDistanceMeters: order.routeDistanceMeters, goodsPaymentStatus: order.goodsPaymentStatus } } : {}),
      storeConfirmed: false,
      driverConfirmed: false,
    },
    { ...filter, ...customerAccessFilter(order.customerToken) },
    answer ? availabilityEvent(answer.available, now) : undefined,
    operation,
  ); } catch (error) {
    const latest = operation && error.code === "state_conflict" && await Order.findOne({ _id: order._id, ...customerAccessFilter(order.customerToken) }).lean();
    const prior = latest?.operations?.find(op => op.requestId === operation.requestId);
    if (!prior) throw error;
    if (prior.digest !== operation.digest || prior.action !== operation.action || prior.actorId) fail("operation_conflict", 409);
    saved = latest;
  }
  return startDispatchIfReady(saved);
}
const availabilityEvent = (available, at) =>
  operationalEvent("customer_availability_changed", at, null, { reason: available ? "available" : "unavailable" });
// D1: once a driver has accepted, the customer cannot take their availability back.
function availabilityAnswer(order, body) {
  if (!isGated(order) || !Object.hasOwn(body, "available")) return null;
  if (typeof body.available !== "boolean") fail("invalid_input");
  if (body.available === order.customerAvailable && order.customerAvailabilityUpdatedAt) return null;
  if (body.available !== order.customerAvailable && (order.activeAssignment || order.status !== "searching_driver"))
    fail("editing_blocked", 409);
  return { available: body.available };
}
// "I am ready now" / "not now" after the total was confirmed. Ready again needs no
// new confirmation: any change to the place, price or goods already voided it.
export async function setCustomerAvailability(order, body) {
  if (!body || typeof body.available !== "boolean" || Object.keys(body).some((key) => key !== "available"))
    fail("invalid_input");
  if (!isGated(order) || order.status !== "searching_driver" || order.activeAssignment) fail("editing_blocked", 409);
  if (body.available === order.customerAvailable) return startDispatchIfReady(order);
  const now = new Date();
  let saved;
  try {
    saved = await update(order, { customerAvailable: body.available, customerAvailabilityUpdatedAt: now },
      { ...customerAccessFilter(order.customerToken), customerAvailable: order.customerAvailable },
      availabilityEvent(body.available, now));
  } catch (error) {
    // A double tap: the other request already recorded the same answer.
    const current = error.code === "state_conflict" &&
      await Order.findOne({ _id: order._id, ...customerAccessFilter(order.customerToken) }).lean();
    if (!current || current.customerAvailable !== body.available || current.activeAssignment) throw error;
    saved = current;
  }
  return startDispatchIfReady(saved);
}
// The only way a gated order enters the driver search. The readiness check is
// repeated in the atomic filter, together with the exact version that was checked,
// so a concurrent change to the place, price, goods or availability always wins.
async function startDispatch(order, now) {
  if (!isGated(order) || order.status !== "searching_driver" || order.activeAssignment ||
      order.driverSearchStatus !== "waiting" || dispatchMissing(order).length || !hasFinalRoutePrice(order)) return null;
  const result = await Order.findOneAndUpdate(
    { _id: order._id, status: "searching_driver", activeAssignment: false, collectedAt: null,
      driverSearchStatus: "waiting", updatedAt: order.updatedAt, ...readyFilter() },
    { $set: searchWindow(now), ...(isUnifiedOrder(order) ? { $inc: { dispatchVersion: 1 } } : {}),
      $push: { events: operationalEvent("driver_search_started", now, null) } },
    { new: true, runValidators: true },
  ).lean();
  if (!result) return null;
  ordersChanged();
  log("info", "dispatch_started", { orderId: String(order._id) });
  return result;
}
export async function startDispatchIfReady(order, now = new Date()) {
  return (await startDispatch(order, now)) ?? (isGated(order) && order.driverSearchStatus === "waiting"
    ? (await Order.findById(order._id).lean()) ?? order : order);
}
// Background safety net for a ready order whose start was missed (a crash between
// the customer's write and the start). Each start is the same single CAS.
export async function startReadyDispatches({ now = new Date(), limit = 20 } = {}) {
  const orders = await Order.find({ status: "searching_driver", activeAssignment: false, collectedAt: null,
    driverSearchStatus: "waiting", ...readyFilter() }).sort({ updatedAt: 1 }).limit(limit).lean();
  let started = 0;
  for (const order of orders) if (await startDispatch(order, now)) started++;
  return started;
}
// A link holder can save their own contact details before the invoice is known.
// This never grants financial consent or edits merchant/driver financial terms.
export async function saveCustomerDetails(order, body) {
  if (!isQuickOrder(order) || !beforePickup.includes(order.status)) fail("editing_blocked", 409);
  if (isUnifiedOrder(order) && order.activeAssignment) fail("editing_blocked", 409);
  const filter = observedFilter(order, body.observed, true);
  const values = { recipientName: string(body.recipientName === undefined ? order.recipientName ?? "" : body.recipientName), customerPhone: customerPhone(body.customerPhone),
    finalAddress: string(body.finalAddress ?? order.finalAddress ?? ""), deliveryInstructions: string(body.deliveryInstructions ?? "") };
  if (Object.keys(values).every(key => values[key] === order[key])) return order;
  return update(order, { ...values, customerConfirmed: false, driverConfirmed: false },
    { ...filter, ...customerAccessFilter(order.customerToken) });
}
// Persist location and invalidate the old price before attempting HTTP. A
// provider failure never rolls the confirmed destination back.
export async function confirmDestination(order, body) {
  if (!beforePickup.includes(order.status)) fail("editing_blocked", 409);
  // D1: a driver accepted this trip and its fare; the place no longer changes silently.
  if (isGated(order) && order.activeAssignment) fail("editing_blocked", 409);
  const location = parseLocation(body);
  const destinationArea = isUnifiedOrder(order) ? requireDeliveryCoverage(location) : null;
  if (sameLocation(order.destinationLocation, location)) {
    if (order.priceSource === "route" && !hasFinalRoutePrice(order) && routeInputs(order))
      return recalculatePrice(order);
    return order;
  }
  // Monotonic even for rapid A -> B -> A edits within one millisecond.
  const previousTime = new Date(order.destinationLocation?.confirmedAt ?? 0).getTime();
  if (location.confirmedAt.getTime() <= previousTime) location.confirmedAt = new Date(previousTime + 1);
  const saved = await update(
    order,
    {
      destinationLocation: location,
      ...(destinationArea ? { serviceArea: destinationArea, area: destinationArea } : {}),
      storeConfirmed: false,
      driverConfirmed: false,
      ...(order.priceSource === "route" ? { ...pendingRoute(), customerConfirmed: false } : {}),
    },
    customerAccessFilter(order.customerToken),
  );
  return saved.priceSource === "route" && routeInputs(saved) ? recalculatePrice(saved) : saved;
}
// Explicit per-order correction; changing store settings never silently moves
// an existing order. Invalidate consent and price before the routing request.
export async function correctPickupLocation(order, body, actor) {
  if (!beforePickup.includes(order.status)) fail("editing_blocked", 409);
  if (isUnifiedOrder(order) && order.activeAssignment) fail("editing_blocked", 409);
  observedFilter(order, body.observed);
  const location = parseLocation(body);
  if (sameLocation(order.pickupLocation, location)) {
    return order.priceSource === "route" && !hasFinalRoutePrice(order) && routeInputs(order)
      ? recalculatePrice(order) : order;
  }
  const previous = new Date(order.pickupLocation?.confirmedAt ?? 0).getTime();
  if (location.confirmedAt.getTime() <= previous) location.confirmedAt = new Date(previous + 1);
  const changes = { pickupLocation: location, pickupAddress: location.address || order.pickupAddress,
    customerConfirmed: false, storeConfirmed: false, driverConfirmed: false,
    ...(order.priceSource === "route" ? pendingRoute() : {}) };
  const saved = await update(order, changes, {}, editEvent(order, changes, ["pickupLocation"], actor));
  return saved.priceSource === "route" && routeInputs(saved) ? recalculatePrice(saved) : saved;
}
function routeInputs(order) {
  return validCoordinates(order.pickupLocation?.lat, order.pickupLocation?.lng) && isConfirmedLocation(order.destinationLocation);
}
function hasFinalRoutePrice(order) {
  if (order.priceStatus !== "final" || !routeInputs(order) || !order.routeCalculatedAt || order.routeProvider !== "osrm") return false;
  try {
    const calculated = calculateRoutePrice(order.routeDistanceMeters);
    const amounts = financeAmounts(order.goodsAmountAgorot, calculated.deliveryFeeAgorot, order.deliveryFeePaidBy, order.goodsPaymentStatus);
    return order.deliveryFeeAgorot === calculated.deliveryFeeAgorot &&
      Object.keys(amounts).every((key) => order[key] === amounts[key]);
  } catch { return false; }
}
function pricingView(order) {
  const route = order.priceSource === "route";
  return {
    priceSource: route ? "route" : "manual",
    priceStatus: route ? order.priceStatus ?? "pending" : order.deliveryFeeAgorot == null ? "pending" : "final",
    routeDistanceMeters: route ? order.routeDistanceMeters ?? null : null,
    routeCalculatedAt: route ? order.routeCalculatedAt ?? null : null,
    routeProvider: route ? order.routeProvider ?? null : null,
    routeError: route ? order.routeError ?? null : null,
  };
}
function pendingRoute() {
  return {
    priceStatus: "pending", routeDistanceMeters: null, routeCalculatedAt: null,
    routeProvider: null, routeError: null, deliveryFeeAgorot: null, storeDeliveryFeeLiabilityAgorot: null, ...financeAmounts(0, null),
  };
}
export async function recalculatePrice(order) {
  if (isUnifiedOrder(order) && order.customerConfirmed && order.priceStatus === "final") return order;
  if (!beforePickup.includes(order.status)) fail("editing_blocked", 409);
  if (order.priceSource !== "route" || !routeInputs(order)) fail("route_inputs_required", 422);
  if (hasFinalRoutePrice(order)) return order; // Final route for unchanged input is immutable.
  const guard = {
    _id: order._id, priceSource: "route", priceStatus: "pending", status: { $in: beforePickup },
    "pickupLocation.lat": order.pickupLocation.lat, "pickupLocation.lng": order.pickupLocation.lng,
    "pickupLocation.confirmedAt": order.pickupLocation.confirmedAt,
    ...Object.fromEntries(["lat", "lng", "address", "source", "confirmedAt"].map((key) => [
      `destinationLocation.${key}`, order.destinationLocation[key],
    ])),
  };
  const latest = () => Order.findById(order._id).lean();
  let route;
  try { route = await getRouteDistance({ pickup: order.pickupLocation, destination: order.destinationLocation }); }
  catch {
    await Order.updateOne(guard, { $set: { routeError: "routing_unavailable" } });
    return latest();
  }
  // Use current goods, not the value from before the HTTP call. A bounded CAS
  // retry handles a concurrent goods edit; no stale destination or past-pickup
  // write is ever allowed. Another successful retry cannot be regressed.
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await latest();
    let amounts;
    try {
      const calculated = calculateRoutePrice(route.distanceMeters);
      amounts = { ...calculated, ...financeAmounts(current.goodsAmountAgorot, calculated.deliveryFeeAgorot, current.deliveryFeePaidBy, current.goodsPaymentStatus) };
    } catch {
      await Order.updateOne(guard, { $set: { routeError: "routing_unavailable" } });
      return latest();
    }
    const result = await Order.findOneAndUpdate(
      { ...guard, goodsAmountAgorot: current.goodsAmountAgorot, deliveryFeePaidBy: current.deliveryFeePaidBy ?? null,
        ...(isUnifiedOrder(current) ? { goodsPaymentStatus: current.goodsPaymentStatus, detailsRevision: current.detailsRevision, customerConfirmed: false } : {}) },
      { $set: { ...amounts, priceStatus: "final", routeCalculatedAt: new Date(), routeProvider: route.provider,
        routeError: null, customerConfirmed: false, storeConfirmed: false, driverConfirmed: false } },
      { new: true, runValidators: true },
    ).lean();
    if (result) { ordersChanged(); return result; }
  }
  return latest();
}
// A route price that could not be calculated (the routing service was down or
// slow) is tried again by the background sweep, so nobody has to press "retry"
// once the service is back and the order is never stuck without a price, a
// confirmation or a pickup code. An order is left alone for `quietMs` after its
// last attempt, and the batch stops at the first failure: the service is down and
// the next sweep tries again.
export async function retryPendingRoutePrices({ now = new Date(), limit = 10, quietMs = 30000 } = {}) {
  if (!config.routingBaseUrl) return 0;
  const orders = await Order.find({
    priceSource: "route", priceStatus: "pending", status: { $in: beforePickup },
    "destinationLocation.confirmedAt": { $ne: null }, "pickupLocation.lat": { $ne: null },
    updatedAt: { $lt: new Date(now.getTime() - quietMs) },
  }).sort({ updatedAt: 1 }).limit(limit).lean();
  let priced = 0;
  for (const order of orders) {
    let result;
    try { result = await recalculatePrice(order); } catch { continue; }
    if (result?.priceStatus === "final") priced++;
    else if (result?.routeError) break;
  }
  return priced;
}
// Client commands carry a request ID. A replay (lost response, delayed retry) is
// answered with the current state and never executes a second time.
export function commandId(body) {
  return string(body?.requestId, true, 120);
}
export const rememberCommand = (requestId) => ({ $each: [requestId], $slice: -50 });
export async function reissueCustomerLink(order, actor, body) {
  return withTrackingOrder(order._id, async () => {
    const requestId = commandId(body);
    const linkOf = (o) => ({ customerLink: customerLink(o), customerTokenExpiresAt: o.customerTokenExpiresAt });
    if (hasOrderCommand(order, requestId)) return linkOf(order);
    if (terminal.includes(order.status)) fail("editing_blocked", 409);
    const now = new Date();
    const result = await Order.findOneAndUpdate(
      { _id: order._id, customerToken: order.customerToken, status: { $nin: terminal }, commandIds: { $ne: requestId }, events: unusedOrderCommand(requestId) },
      { $set: issueCustomerToken(),
        $push: { commandIds: rememberCommand(requestId),
          events: operationalEvent("customer_link_reissued", now, actor, { requestId }) } },
      { new: true, runValidators: true },
    ).lean();
    if (result) { ordersChanged(); return linkOf(result); }
    const current = await Order.findById(order._id).lean();
    if (hasOrderCommand(current, requestId)) return linkOf(current);
    fail("state_conflict", 409);
  });
}
export async function confirmDetails(order, user, body) {
  if (!beforePickup.includes(order.status)) fail("editing_blocked", 409);
  observedFilter(order, body.observed);
  const missing = missingPickup(order).filter(
    (k) =>
      ![
        "driver_required",
        "parcel_not_ready",
        "store_confirmation_required",
        "driver_confirmation_required",
      ].includes(k),
  );
  if (missing.length)
    fail("pickup_blocked", 422, { missingRequirements: missing });
  const field = user.role === "store" ? "storeConfirmed" : "driverConfirmed";
  if (order[field]) return order;
  return update(order, { [field]: true });
}
export async function assignOrder(order, driverId, accepting = false, now, actor, offer = {}) {
  id(driverId);
  const driver = await User.findOne({
    _id: driverId,
    role: "driver",
    active: true,
  }).lean();
  if (!driver) fail("driver_unavailable", 409);
  if (isUnifiedOrder(order)) {
    if (!supportsUnifiedWorkflow(driver) || (accepting && offer.supportedWorkflowVersion !== 3)) fail("app_update_required", 409);
    if (accepting && (!Number.isSafeInteger(offer.dispatchVersion) || offer.dispatchVersion !== order.dispatchVersion)) fail("offer_expired", 409);
    if (accepting && order.activeAssignment && String(order.driverId) === String(driverId)) return order;
    if (!accepting) fail("driver_acceptance_required", 409);
  }
  const injectedNow = now !== undefined;
  now ??= new Date();
  if (accepting && order.status !== "searching_driver")
    fail("order_unavailable", 409);
  if (!beforePickup.includes(order.status)) fail("editing_blocked", 409);
  if (!accepting && order.activeAssignment && String(order.driverId) === String(driverId)) return order;
  const eligibility = await eligibleOrderFilter(driver, now);
  if (!eligibility) fail("driver_not_eligible", 409);
  // A fresh admin assignment is subject to the same live search as an accept.
  // Reassignment of an existing active order keeps the approved admin workflow.
  const requiresSearch = accepting || order.activeAssignment !== true;
  try {
    const result = await Order.findOneAndUpdate(
      {
        _id: order._id,
        status: order.status,
        driverId: order.driverId,
        activeAssignment: order.activeAssignment,
        acceptedAt: order.acceptedAt ?? null,
        ...(isUnifiedOrder(order) ? { dispatchVersion: offer.dispatchVersion, detailsRevision: order.detailsRevision } : {}),
        excludedDriverIds: { $ne: driverId },
        ...(requiresSearch ? eligibility : { serviceArea: eligibility.serviceArea, vehicleType: eligibility.vehicleType }),
        // A gated order is taken only while it is still ready for dispatch.
        ...(requiresSearch && isGated(order) ? readyFilter() : {}),
        // Production acceptance also checks MongoDB time at the atomic write,
        // so a slow driver lookup/request cannot cross the deadline unnoticed.
        ...(requiresSearch && !injectedNow ? { $expr: { $gt: ["$searchDeadlineAt", "$$NOW"] } } : {}),
      },
      {
        $set: {
          driverId,
          activeAssignment: true,
          status: "driver_assigned",
          driverConfirmed: false,
          driverSearchStatus: null,
          acceptedAt: now,
          ...(isUnifiedOrder(order) ? { driverAgreement: { acceptedAt: now, driverId,
            dispatchVersion: order.dispatchVersion, detailsRevision: order.detailsRevision,
            driverEarningsAgorot: order.driverEarningsAgorot, deliveryFeeAgorot: order.deliveryFeeAgorot,
            expectedCustomerCashAgorot: order.expectedCustomerCashAgorot } } : {}),
          storeArrivalDeadlineAt: new Date(now.getTime() + config.driverArrivalTimeoutMs),
        },
        $unset: { arrivedStoreAt: "", arrivedCustomerAt: "" },
        $push: { events: operationalEvent("driver_assigned", now, accepting ? { role: "driver", _id: driverId } : actor ?? null, { driverId }) },
      },
      { new: true, runValidators: true },
    ).lean();
    if (!result) {
      log("info", "order_accept_race_lost", { orderId: String(order._id), driverId: String(driverId) });
      fail("order_unavailable", 409);
    }
    // Disabling a driver deactivates the account first and then looks for an
    // assignment; this is the matching check on the assigning side. Whichever
    // runs second sees the other's write, so an inactive driver never keeps an
    // order. (A User read before the Order write cannot give this guarantee.)
    if (!(await User.exists({ _id: driverId, role: "driver", active: true }))) {
      const at = new Date();
      await releaseAssignment(result, { driverId, status: "driver_assigned" },
        operationalEvent("driver_assignment_revoked", at, null, { driverId, reason: "driver_inactive" }), at);
      fail("driver_unavailable", 409);
    }
    ordersChanged();
    log("info", "order_accept_success", { orderId: String(order._id), driverId: String(driverId) });
    return result;
  } catch (e) {
    if (e.code === 11000) fail("driver_busy", 409);
    throw e;
  }
}
const transitions = {
  "arrive-store": { from: ["driver_assigned"], to: "driver_at_store", time: "arrivedStoreAt" },
  pickup: { from: ["driver_at_store"], to: "collected", time: "collectedAt" },
  "arrive-customer": { from: ["collected"], to: "driver_at_destination", time: "arrivedCustomerAt" },
  deliver: {
    from: ["driver_at_destination"],
    to: "delivered",
    time: "deliveredAt",
    release: true,
  },
  fail: {
    from: ["collected", "driver_at_destination"],
    to: "delivery_failed",
    time: "failedAt",
  },
  cancel: {
    from: beforePickup,
    to: "cancelled",
    time: "cancelledAt",
    release: true,
  },
  "authorize-return": {
    from: ["delivery_failed"],
    to: "returning",
    time: "returnAuthorizedAt",
  },
  "confirm-return": {
    from: ["returning"],
    to: "returned",
    time: "returnedAt",
    release: true,
  },
};
// `ctx` = { actor, ip, userAgent } of the caller; it is required for the two
// code-verified actions (pickup, deliver) and ignored by the others.
// Preview verification shares the delivery lock and audit trail. It grants no
// delivery permission: transition() still rechecks the code, custody and cash.
export async function verifyDeliveryCode(order, body, ctx) {
  if (ctx.actor?.role !== "driver" || String(order.driverId) !== String(ctx.actor._id) || !order.activeAssignment)
    fail("forbidden", 403);
  if (order.status !== "driver_at_destination" && !(isQuickOrder(order) && order.status === "collected"))
    fail("state_conflict", 409);
  if (typeof body.code !== "string") fail("invalid_input");
  const code = body.code.replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 1632))
    .replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 1776));
  if (!/^\d+$/.test(code) || code.length !== String(order.deliveryCode).length) fail("invalid_input");
  await verifyCode({ order, actor: ctx.actor, type: "delivery", submitted: code, expected: order.deliveryCode, meta: ctx });
  return { verified: true };
}

export async function transition(order, action, body, ctx = {}) {
  const unified = isUnifiedOrder(order);
  if (unified && ctx.actor?.role === "driver" && ctx.actor.supportedWorkflowVersion !== 3) fail("app_update_required", 409);
  let operation;
  if (unified && ctx.actor?.role === "driver" && ["pickup", "deliver", "arrive-store", "arrive-customer", "fail"].includes(action)) {
    const requestId = string(body.requestId, true, 120);
    const canonical = Object.fromEntries(Object.keys(body).filter(k => k !== "requestId").sort().map(k => [k, body[k]]));
    const digest = commandDigest(canonical);
    operation = { requestId, action, actorId: ctx.actor?._id, digest, at: new Date() };
    const previous = order.operations?.find(op => op.requestId === requestId);
    if (previous) {
      if (previous.action !== action || String(previous.actorId) !== String(ctx.actor?._id) || previous.digest !== digest) fail("operation_conflict", 409);
      return order;
    }
  }
  const rule = transitions[action];
  const quick = isQuickOrder(order);
  const mergedArrival = quick && ((action === "pickup" && order.status === "driver_assigned") ||
    (action === "deliver" && order.status === "collected"));
  if (!rule || (!rule.from.includes(order.status) && !mergedArrival)) fail("state_conflict", 409);
  const changes = { status: rule.to };
  const filter = {};
  const now = new Date();
  if (ctx.actor?.role === "driver") {
    filter.driverId = ctx.actor._id;
    filter.activeAssignment = true;
  }
  const code =
    typeof body.code === "string"
      ? body.code
          .trim()
          .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 1632))
          .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 1776))
          .replace(/\D/g, "")
      : null;
  if (rule.time) changes[rule.time] = now;
  if (rule.release) {
    changes.activeAssignment = false;
    changes.driverSearchStatus = null;
  }
  if (action === "pickup") {
    if (quick) {
      if (ctx.actor?.role !== "driver" || (!unified && body.acceptDetails !== true)) fail("driver_confirmation_required", 422);
      if (!unified) Object.assign(filter, observedFilter(order, body.observed));
      changes.driverConfirmed = true;
      changes.parcelReady = true; // The code-verified physical handover is readiness.
      if (order.status === "driver_assigned") {
        if (!order.storeArrivalDeadlineAt || new Date(order.storeArrivalDeadlineAt) <= now) fail("assignment_expired", 409);
        filter.$expr = { $gt: ["$storeArrivalDeadlineAt", "$$NOW"] };
        if (!unified) changes.arrivedStoreAt = now;
      }
    }
    const missing = missingPickup(order);
    if (missing.length)
      fail("pickup_blocked", 422, { missingRequirements: missing });
    changes.financialSnapshot = captureFinancialTerms(order, now);
    if (unified && (order.driverAgreement?.detailsRevision !== order.detailsRevision ||
      order.driverAgreement?.deliveryFeeAgorot !== order.deliveryFeeAgorot ||
      order.driverAgreement?.driverEarningsAgorot !== order.driverEarningsAgorot ||
      order.driverAgreement?.expectedCustomerCashAgorot !== order.expectedCustomerCashAgorot ||
      order.customerAgreement?.expectedCustomerCashAgorot !== order.expectedCustomerCashAgorot)) fail("financial_terms_required", 422);
    if (!unified) await verifyCode({
      order,
      actor: ctx.actor,
      type: "pickup",
      submitted: code,
      expected: order.pickupCode,
      meta: ctx,
    });
    if (!unified) filter.pickupCode = order.pickupCode;
    filter.activeAssignment = true;
    filter.financialSnapshot = null;
  }
  if (action === "deliver") {
    if (mergedArrival && !unified) changes.arrivedCustomerAt = now;
    // Amount checks come first so a rejected amount never burns a code attempt.
    // The expected amount is always read from the order, never from the client;
    // the client only echoes what it displayed so a stale screen is detected.
    const actual = integerAmount(body.actualCashCollectedAgorot),
      observed = integerAmount(body.observedExpectedAgorot),
      expected = order.financialSnapshot?.expectedCustomerCashAgorot ?? order.expectedCustomerCashAgorot;
    if (
      Object.hasOwn(body, "confirmDifference") &&
      typeof body.confirmDifference !== "boolean"
    )
      fail("invalid_input");
    if (expected === null || expected === undefined) fail("fee_required", 422);
    if (observed !== expected)
      fail("expected_amount_changed", 409, { expectedAgorot: expected });
    const difference = actual - expected;
    if (unified && difference !== 0) changes.collectionDifferenceReason = string(body.differenceReason, true, 300);
    if (difference !== 0 && body.confirmDifference !== true)
      fail("difference_confirmation_required", 422, {
        expectedAgorot: expected,
        actualAgorot: actual,
        differenceAgorot: difference,
      });
    await verifyCode({
      order,
      actor: ctx.actor,
      type: "delivery",
      submitted: code,
      expected: order.deliveryCode,
      meta: ctx,
    });
    changes.actualCashCollectedAgorot = actual;
    changes.cashDifferenceAgorot = difference;
    changes.cashDifferenceConfirmedAt = difference !== 0 ? new Date() : null;
    if (order.financialSnapshot) {
      if (String(order.financialSnapshot.driverId) !== String(order.driverId)) fail("financial_terms_required", 422);
      changes.cashHandover = { status: "pending" };
      changes.driverPayout = { status: "pending", amountAgorot: order.financialSnapshot.driverEarningsAgorot };
      changes.storeSettlement = { status: "pending" };
      if (difference !== 0) changes.collectionAdjustment = {
        type: difference < 0 ? "shortage" : "overage", amountAgorot: Math.abs(difference), status: "open", createdAt: now,
      };
      filter["financialSnapshot.capturedAt"] = order.financialSnapshot.capturedAt;
    }
    filter.actualCashCollectedAgorot = order.actualCashCollectedAgorot ?? null;
    filter.deliveryCode = order.deliveryCode;
  }
  if (action === "fail") {
    // An administrator can record the failure for a driver who cannot (lost
    // phone, no account access), but only after attesting the parcel and any
    // cash are still with that driver. The assignment and custody stay open.
    if (ctx.actor?.role === "admin" && body.custodyConfirmed !== true) fail("custody_confirmation_required", 422);
    changes.failureReason = string(body.reason, true);
    changes.actualCashCollectedAgorot = integerAmount(
      body.actualCashCollectedAgorot ?? 0,
    );
    filter.activeAssignment = true;
    // Cash kept after a failed attempt must be handed back like any other cash.
    if (order.financialSnapshot && changes.actualCashCollectedAgorot > 0) changes.cashHandover = { status: "pending" };
  }
  if (action === "cancel")
    changes.cancellationReason = string(body.reason, true);
  const eventType = action === "arrive-store" ? "driver_arrived_store" : action === "arrive-customer" ? "driver_arrived_customer" : null;
  const events = eventType ? [operationalEvent(eventType, now, ctx.actor, { driverId: order.driverId })] : [];
  if (mergedArrival && !unified) events.push(operationalEvent(action === "pickup" ? "driver_arrived_store" : "driver_arrived_customer",
    now, ctx.actor, { driverId: order.driverId }));
  const auditEvent = { cancel: "order_cancelled", fail: "delivery_failed", "authorize-return": "return_authorized",
    "confirm-return": "return_confirmed" }[action];
  if (auditEvent) events.push(operationalEvent(auditEvent, now, ctx.actor, { driverId: order.driverId,
    fromStatus: order.status, toStatus: rule.to,
    ...(changes.failureReason || changes.cancellationReason ? { note: (changes.failureReason || changes.cancellationReason).slice(0, 300) } : {}),
    ...(action === "fail" ? { amountAgorot: changes.actualCashCollectedAgorot } : {}) }));
  if (action === "pickup") events.push(operationalEvent("financial_terms_captured", now, ctx.actor));
  if (action === "deliver") {
    events.push(operationalEvent("cash_collected", now, ctx.actor, { amountAgorot: changes.actualCashCollectedAgorot }));
    if (changes.collectionAdjustment) events.push(operationalEvent("collection_adjustment_opened", now, ctx.actor,
      { amountAgorot: changes.collectionAdjustment.amountAgorot, reason: changes.collectionAdjustment.type }));
  }
  try { return await update(order, changes, filter, events.length ? events : undefined, operation); }
  catch (error) {
    if (operation && error.code === "state_conflict") {
      const latest = await Order.findById(order._id).lean();
      const previous = latest?.operations?.find(op => op.requestId === operation.requestId);
      if (previous?.digest === operation.digest && previous.action === action && String(previous.actorId) === String(ctx.actor?._id)) return latest;
      if (previous) fail("operation_conflict", 409);
    }
    throw error;
  }
}
