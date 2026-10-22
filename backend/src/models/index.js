import mongoose from "mongoose";
import { SmsOperation } from "./smsOperation.js";
import { DataRequest } from './dataRequest.js';
import { config } from "../config.js";
import { locationSources, addressMax } from "../services/location.js";
import { supportedServiceAreas, validServiceAreas } from "../services/serviceAreas.js";

export const statuses = [
  "searching_driver",
  "driver_assigned",
  "driver_at_store",
  "collected",
  "driver_at_destination",
  "delivered",
  "cancelled",
  "delivery_failed",
  "returning",
  "returned",
];
const amount = {
  type: Number,
  default: null,
  validate: (v) => v === null || (Number.isSafeInteger(v) && v >= 0),
};
const text = { type: String, trim: true, default: "", maxlength: 2000 };
// A confirmed place: a store's saved pickup, an order's pickup snapshot and an
// order's destination. "Confirmed" is derived from valid lat/lng + confirmedAt.
const locationSchema = new mongoose.Schema(
  {
    address: { type: String, trim: true, default: "", maxlength: addressMax },
    lat: { type: Number, required: true, min: -90, max: 90 },
    lng: { type: Number, required: true, min: -180, max: 180 },
    source: { type: String, enum: locationSources, required: true },
    confirmedAt: { type: Date, required: true },
  },
  { _id: false },
);
const location = { type: locationSchema, default: undefined };
const userSchema = new mongoose.Schema(
  {
    login: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      maxlength: 80,
    },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ["admin", "store", "driver"], required: true },
    name: { ...text, required: true },
    phone: text,
    active: { type: Boolean, default: true },
    deletedAt: Date,
    // Bumped on password reset and deactivation; JWTs carry the value they were
    // issued with, so older sessions stop working (see middleware/auth.js).
    authVersion: { type: Number, default: 0 },
    // Admin changes to this account, written in the same update as the change.
    accountEvents: { type: [{ _id: false, type: { type: String }, at: Date, adminId: mongoose.Schema.Types.ObjectId,
      changes: [{ _id: false, field: String, from: mongoose.Schema.Types.Mixed, to: mongoose.Schema.Types.Mixed }] }],
      select: false, default: undefined },
    availableForOrders: { type: Boolean, default: false },
    supportedWorkflowVersion: { type: Number, enum: [2, 3] },
    availabilityUpdatedAt: Date,
    serviceAreas: { type: [String], default: [], validate: validServiceAreas },
    // Drivers only; set by the administrator. Decides which quick orders a driver may see and accept.
    vehicleType: { type: String, enum: ["motorcycle", "car"] },
    storeName: text,
    pickupAddress: text,
    pickupLocation: location,
    pickupServiceArea: { type: String, enum: supportedServiceAreas },
  },
  { timestamps: true },
);
// No defaults on these embedded records: absence on historical orders means
// unknown, never "pending" or "completed" inferred from delivery status.
const settlementSchema = new mongoose.Schema({
  status: { type: String, enum: ["pending", "completed"], required: true },
  // Optional on existing records; each reversal advances the write generation.
  revision: { type: Number, min: 0, validate: Number.isSafeInteger },
  amountAgorot: { ...amount, default: undefined },
  completedAt: Date,
  completedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  requestId: { type: String, maxlength: 120 },
  note: { type: String, maxlength: 300 },
  // Store settlements only: who owes whom. Derived by the server, never sent.
  direction: { type: String, enum: ["pay_store", "collect_from_store"] },
}, { _id: false });
const financialSnapshotSchema = new mongoose.Schema({
  goodsPaymentStatus: { type: String, enum: ["unpaid", "prepaid"] },
  goodsAmountAgorot: amount,
  deliveryFeeAgorot: amount,
  deliveryFeePaidBy: { type: String, enum: ["customer", "store"], required: true },
  expectedCustomerCashAgorot: amount,
  driverEarningsAgorot: amount,
  platformCommissionAgorot: amount,
  storeDeliveryFeeLiabilityAgorot: amount,
  driverId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  routeDistanceMeters: { ...amount, default: undefined },
  priceSource: String,
  capturedAt: { type: Date, required: true },
}, { _id: false });
const adjustmentSchema = new mongoose.Schema({
  type: { type: String, enum: ["shortage", "overage"], required: true },
  amountAgorot: amount,
  status: { type: String, enum: ["open", "resolved"], required: true },
  createdAt: { type: Date, required: true },
  resolvedAt: Date,
  resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  resolutionNote: { type: String, maxlength: 300 },
  // Explicit decision: who covers a shortage / who gets an overage, with the
  // external reference (receipt, refund, approval) that proves it.
  resolutionType: { type: String, enum: ["driver_pays", "store_absorbs", "platform_absorbs",
    "refund_customer", "credit_store", "platform_revenue"] },
  resolutionParty: { type: String, enum: ["driver", "store", "platform", "customer"] },
  resolutionReference: { type: String, maxlength: 120 },
  requestId: { type: String, maxlength: 120 },
}, { _id: false });
const orderSchema = new mongoose.Schema(
  {
    piiRemovedAt: { type: Date, default: null },
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    storeName: text,
    pickupAddress: text,
    // Copied from the store when the order is created; never follows the store.
    pickupLocation: location,
    // Confirmed by the customer through their secure link.
    destinationLocation: location,
    // Absent on pre-STEP-5 orders: their manual monetary data is preserved.
    priceSource: { type: String, enum: ["route", "manual"] },
    // Absent on existing orders: their original workflow stays in effect.
    workflowVersion: { type: Number, enum: [1, 2, 3] },
    detailsRevision: { type: Number, min: 1 },
    customerConfirmedRevision: Number,
    customerAgreement: { type: mongoose.Schema.Types.Mixed, default: undefined },
    driverAgreement: { type: mongoose.Schema.Types.Mixed, default: undefined },
    dispatchVersion: { type: Number, min: 0 },
    goodsPaymentStatus: { type: String, enum: ["unpaid", "prepaid"] },
    goodsPaymentRecordedAt: Date,
    goodsPaymentRecordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    goodsPaymentReference: { type: String, maxlength: 120 },
    merchantOrderReference: { type: String, maxlength: 120 },
    parcelReadyUpdatedAt: Date,
    operations: { type: [{ _id: false, requestId: String, action: String, actorId: mongoose.Schema.Types.ObjectId, digest: String, at: Date }], default: undefined },
    storeAuthorizedAt: Date,
    pickupServiceArea: { type: String, enum: supportedServiceAreas },
    goodsAmountRecordedAt: Date,
    priceStatus: { type: String, enum: ["pending", "final"] },
    routeDistanceMeters: { ...amount, default: undefined, validate: (v) => v == null || (Number.isSafeInteger(v) && v >= 0) },
    routeCalculatedAt: Date,
    routeProvider: { type: String, enum: ["osrm", null] },
    routeError: { type: String, enum: ["routing_unavailable", null] },
    area: text,
    // Separate from human area/address text; absent on unclassified legacy orders.
    serviceArea: { type: String, enum: supportedServiceAreas },
    customerPhone: text,
    preliminaryAddress: text,
    recipientName: text,
    finalAddress: text,
    deliveryInstructions: text,
    parcelDescription: text,
    // Optional for historical orders; no size is inferred for existing parcels.
    parcelSize: { type: String, enum: ["small", "medium", "large"] },
    // Required on new quick orders; absent on historical ones (no vehicle inferred).
    vehicleType: { type: String, enum: ["motorcycle", "car"] },
    parcelReady: { type: Boolean, default: false },
    goodsAmountAgorot: { ...amount, default: 0 },
    deliveryFeePaidBy: { type: String, enum: ["customer", "store"] },
    storeDeliveryFeeLiabilityAgorot: { ...amount, default: undefined },
    financialSnapshot: { type: financialSnapshotSchema, default: undefined },
    collectionAdjustment: { type: adjustmentSchema, default: undefined },
    cashHandover: { type: settlementSchema, default: undefined },
    driverPayout: { type: settlementSchema, default: undefined },
    storeSettlement: { type: settlementSchema, default: undefined },
    deliveryFeeAgorot: amount,
    platformCommissionAgorot: amount,
    driverEarningsAgorot: amount,
    expectedCustomerCashAgorot: amount,
    actualCashCollectedAgorot: amount,
    // actual − expected at delivery; signed, so it cannot reuse `amount`.
    cashDifferenceAgorot: {
      type: Number,
      default: null,
      validate: (v) => v === null || Number.isSafeInteger(v),
    },
    cashDifferenceConfirmedAt: { type: Date, default: null },
    collectionDifferenceReason: { type: String, maxlength: 300 },
    customerConfirmed: { type: Boolean, default: false },
    // The customer can receive the parcel now. Set on quick orders from the
    // dispatch gate on; absent on older orders, whose search began at creation.
    customerAvailable: { type: Boolean },
    customerAvailabilityUpdatedAt: Date,
    storeConfirmed: { type: Boolean, default: false },
    driverConfirmed: { type: Boolean, default: false },
    status: { type: String, enum: statuses, default: "searching_driver" },
    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    activeAssignment: { type: Boolean, default: false },
    // "waiting": a quick order whose customer is not ready yet; no driver sees it.
    driverSearchStatus: { type: String, enum: ["waiting", "searching", "no_driver", null] },
    searchStartedAt: Date,
    searchDeadlineAt: Date,
    acceptedAt: Date,
    storeArrivalDeadlineAt: Date,
    arrivedStoreAt: Date,
    arrivedCustomerAt: Date,
    excludedDriverIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    events: [{
      _id: false,
      type: { type: String, required: true, enum: ["driver_search_started", "driver_search_timed_out",
        "driver_search_retried", "driver_assigned", "driver_assignment_timed_out", "driver_withdrawn", "driver_issue_reported",
        "driver_arrived_store", "driver_arrived_customer", "store_cancelled",
        "financial_terms_captured", "cash_collected", "collection_adjustment_opened",
        "collection_adjustment_resolved", "cash_handover_completed", "driver_payout_completed",
        "store_settlement_completed", "finance_record_reversed", "driver_assignment_revoked",
        "order_cancelled", "delivery_failed", "return_authorized", "return_confirmed",
        "customer_link_reissued", "order_details_edited", "customer_availability_changed", "driver_search_paused"] },
      at: { type: Date, required: true },
      actorType: { type: String, enum: ["system", "store", "admin", "driver"] },
      actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      driverId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      reason: { type: String, maxlength: 80 },
      note: { type: String, maxlength: 300 },
      amountAgorot: { ...amount, default: undefined },
      requestId: { type: String, maxlength: 120 },
      reference: { type: String, maxlength: 120 },
      fromStatus: { type: String, enum: statuses },
      toStatus: { type: String, enum: statuses },
      // Field-level before/after for audited edits. Free-text PII fields are
      // listed by name only; money and routing fields carry their values.
      changes: { type: [{ _id: false, field: String, from: mongoose.Schema.Types.Mixed, to: mongoose.Schema.Types.Mixed }], default: undefined },
    }],
    // Recent client command IDs (retry-search, link reissue): a replayed command
    // is answered without being executed again.
    commandIds: { type: [String], default: undefined },
    customerToken: { type: String, required: true, unique: true },
    // Missing only on legacy orders; access uses createdAt + configured TTL.
    customerTokenExpiresAt: Date,
    pickupCode: { type: String, required: function () { return this.workflowVersion !== 3; } },
    deliveryCode: { type: String, required: true },
    failureReason: text,
    cancellationReason: text,
    collectedAt: Date,
    deliveredAt: Date,
    failedAt: Date,
    cancelledAt: Date,
    returnAuthorizedAt: Date,
    returnedAt: Date,
  },
  { timestamps: true },
);
orderSchema.index(
  { driverId: 1 },
  {
    unique: true,
    partialFilterExpression: { activeAssignment: true },
    name: "one_active_order_per_driver",
  },
);
orderSchema.index({ status: 1, activeAssignment: 1, driverSearchStatus: 1, searchDeadlineAt: 1 }, { name: "driver_search_deadline" });
orderSchema.index({ status: 1, activeAssignment: 1, storeArrivalDeadlineAt: 1 }, { name: "driver_arrival_deadline" });
orderSchema.index({ driverId: 1, status: 1, deliveredAt: -1, _id: -1 }, { name: 'driver_history' });
orderSchema.index({ status: 1, activeAssignment: 1, piiRemovedAt: 1, updatedAt: 1 }, { name: 'customer_retention' });
const recordSchema = new mongoose.Schema(
  {
    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    type: {
      type: String,
      enum: ["cash_handover", "driver_payment"],
      required: true,
    },
    amountAgorot: {
      ...amount,
      required: true,
      validate: (v) => Number.isSafeInteger(v) && v > 0,
    },
    recordedByAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    note: text,
    requestId: { type: String, required: true, unique: true, maxlength: 120 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
export const codeTypes = ["pickup", "delivery"];
const objectId = (ref) => ({
  type: mongoose.Schema.Types.ObjectId,
  ref,
  required: true,
});
// One document per (order, actor, code type); it drives the lock and is the
// single atomic place where attempts are counted.
const codeStateSchema = new mongoose.Schema({
  orderId: objectId("Order"),
  actorId: objectId("User"),
  type: { type: String, enum: codeTypes, required: true },
  totalAttempts: { type: Number, default: 0 },
  failures: { type: Number, default: 0 },
  lockedUntil: { type: Date, default: null },
  manualLock: { type: Boolean, default: false },
  blockedCount: { type: Number, default: 0 },
  lastBlockedAt: Date,
  // Admin unlocks are written with the unlock itself, so the proof cannot be lost.
  unlocks: { type: [{ _id: false, at: Date, adminId: mongoose.Schema.Types.ObjectId, note: String }], default: undefined },
});
codeStateSchema.index({ orderId: 1, actorId: 1, type: 1 }, { unique: true });
// Append-only audit trail. It never stores the submitted code.
const codeAttemptSchema = new mongoose.Schema(
  {
    orderId: objectId("Order"),
    actorId: objectId("User"),
    verificationType: { type: String, enum: codeTypes, required: true },
    attemptNumber: { type: Number, required: true },
    result: {
      type: String,
      enum: ["success", "wrong_code", "admin_unlock"],
      required: true,
    },
    lock: { type: String, enum: ["short", "long", "manual"] },
    ip: { type: String, maxlength: 100 },
    userAgent: { type: String, maxlength: 300 },
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    note: text,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
codeAttemptSchema.index({ orderId: 1, createdAt: -1 });
// One row per installed driver app that agreed to notifications. The token is unique: signing in
// on a phone moves it to that account, so a shared phone never notifies the previous driver.
const pushDeviceSchema = new mongoose.Schema({
  authVersion: { type: Number, default: 0 },
  supportedWorkflowVersion: { type: Number, enum: [2, 3] },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  token: { type: String, required: true, unique: true, maxlength: 120 },
  platform: { type: String, enum: ["android", "ios"], required: true },
  language: { type: String, enum: ["ar", "he"], default: "ar" },
}, { timestamps: true });
recordSchema.index({ driverId: 1, createdAt: -1, _id: -1 }, { name: 'driver_cash_history' });
export const User = mongoose.model("User", userSchema);
export const PushDevice = mongoose.model("PushDevice", pushDeviceSchema);
export const Order = mongoose.model("Order", orderSchema);
export const DriverCashRecord = mongoose.model(
  "DriverCashRecord",
  recordSchema,
);
export const CodeAttemptState = mongoose.model(
  "CodeAttemptState",
  codeStateSchema,
);
export const CodeAttempt = mongoose.model("CodeAttempt", codeAttemptSchema);
// Normalized login is the unique key, including identities with no account.
// This avoids revealing account existence through different lock responses.
export const LoginAttemptState = mongoose.model("LoginAttemptState", new mongoose.Schema({
  _id: { type: String, maxlength: 80 },
  failures: { type: Number, default: 0 },
  lockedUntil: { type: Date, default: null },
  // Anonymous/unknown identities are cleaned up by MongoDB (TTL) after a quiet period.
  expiresAt: { type: Date, index: { expireAfterSeconds: 0 } },
}));
export async function connectDatabase() {
  await mongoose.connect(config.mongoUri);
  // The unique index on CodeAttemptState must exist before serving requests.
  await Promise.all([
    User.init(),
    Order.init(),
    DriverCashRecord.init(),
    CodeAttemptState.init(),
    CodeAttempt.init(),
    LoginAttemptState.init(),
    PushDevice.init(),
    SmsOperation.init(),
    DataRequest.init(),
  ]);
}
