import { parseMoney } from "../api.js";

export const quickVehicles = ["motorcycle", "car"];
export const quickSizes = ["small", "medium", "large"];
// Goods only: the invoice value, never the delivery fee. Null when not a valid amount.
export const goodsInput = (value) => {
  try { return parseMoney(value); } catch { return null; }
};
// A large parcel needs a car; the server enforces the same rule.
export const vehicleFor = (vehicle, size) => (size === "large" ? "car" : vehicle);
// The store sends four things and never a delivery fee or customer data.
export function quickPayload({ area, vehicle, size, goods }) {
  const vehicleType = vehicleFor(vehicle, size);
  if (!area || !quickVehicles.includes(vehicleType) || !quickSizes.includes(size)) throw new Error("incomplete_request");
  return { workflowVersion: 2, storeAuthorization: true, deliveryFeePaidBy: "customer", serviceArea: area,
    vehicleType, parcelSize: size, goodsAmountAgorot: parseMoney(goods) };
}
export function unifiedPayload({ phone, name, vehicle, size, goods, goodsPaymentStatus, parcelReady, deliveryFeePaidBy, notes, reference }) {
  const customerPhone = String(phone).trim().replace(/[٠-٩]/g, n => String(n.charCodeAt(0) - 1632))
    .replace(/[۰-۹]/g, n => String(n.charCodeAt(0) - 1776)).replace(/[\s()-]/g, "");
  if (!/^(?:0\d{8,9}|\+?[1-9]\d{7,14})$/.test(customerPhone)) throw Object.assign(new Error("invalid_phone"), { code: "invalid_phone" });
  if (!["unpaid", "prepaid"].includes(goodsPaymentStatus) || typeof parcelReady !== "boolean" || !["customer", "store"].includes(deliveryFeePaidBy)) throw new Error("incomplete_request");
  const vehicleType = vehicleFor(vehicle, size);
  if (!quickVehicles.includes(vehicleType) || !quickSizes.includes(size)) throw new Error("incomplete_request");
  return { workflowVersion: 3, storeAuthorization: true, customerPhone, recipientName: name,
    vehicleType, parcelSize: size, goodsAmountAgorot: parseMoney(goods), goodsPaymentStatus,
    parcelReady, deliveryFeePaidBy, parcelDescription: notes, merchantOrderReference: reference };
}
