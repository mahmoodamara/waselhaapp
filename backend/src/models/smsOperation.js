import mongoose from "mongoose";

// The built-in unique _id is the sending boundary: one customer-link event per order.
// No TTL: forgetting an uncertain/accepted attempt could charge the customer twice.
export const SmsOperation = mongoose.model("SmsOperation", new mongoose.Schema({
  _id: { type: String, required: true, maxlength: 64 },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  externalId: { type: String, required: true, maxlength: 64 },
  state: { type: String, enum: ["pending", "accepted", "rejected", "uncertain"], required: true },
  code: { type: String, required: true },
  shipmentId: { type: String, default: null, maxlength: 120 },
  providerStatus: { type: Number, default: null },
}, { timestamps: true }));
