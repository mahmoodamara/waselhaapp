import { createHash } from "node:crypto";
import { config } from "../config.js";
import { Order } from "../models/index.js";
import { SmsOperation } from "../models/smsOperation.js";
import { ownedOrder, terminal } from "./orders.js";
import { customerLink } from "./customerLinks.js";
import { fail } from "./validation.js";
import { log } from "./log.js";

const operationId = order => createHash("sha256").update(`customer-link:v1:${order._id}:${order.customerToken}`).digest("hex");
export function smsView(operation) {
  return { state: operation?.state ?? "not_requested", code: operation?.code ?? null,
    externalId: operation?.externalId ?? null, shipmentId: operation?.shipmentId ?? null };
}
async function existingOperation(key) {
  // A process may die after dispatch but before recording the response. An old
  // pending record is uncertain, never a lease that another worker may resend.
  await SmsOperation.updateOne({ _id: key, state: "pending", createdAt: { $lt: new Date(Date.now() - 60000) } },
    { $set: { state: "uncertain", code: "sms_interrupted" } });
  return SmsOperation.findById(key).lean();
}
export async function customerLinkSms(user, orderId, { send = false, client } = {}) {
  // Keep service callers subject to the same role and object permissions as HTTP callers.
  if (!["store", "admin"].includes(user.role)) fail("forbidden", 403);
  const order = await ownedOrder(user, orderId);
  const key = operationId(order), previous = await existingOperation(key);
  if (previous || !send) return smsView(previous);
  if (terminal.includes(order.status)) fail("editing_blocked", 409);
  const expiresAt = new Date(order.customerTokenExpiresAt ?? new Date(order.createdAt).getTime() + config.customerLinkTtlMs);
  if (!order.customerToken || expiresAt <= new Date()) fail("sms_link_expired", 409);
  const input = client.prepare({ recipient: order.customerPhone,
    message: `وصّلها: يرجى تأكيد بيانات طلب التوصيل عبر الرابط: ${customerLink(order)}`, externalId: key });
  // Recheck the snapshot before claiming. Persist no customer phone, message or link secret.
  const current = await Order.exists({ _id: order._id, storeId: order.storeId, customerToken: order.customerToken,
    customerPhone: order.customerPhone, status: { $nin: terminal } });
  if (!current) fail("state_conflict", 409);
  try {
    await SmsOperation.create([{ _id: key, orderId: order._id, actorId: user._id, externalId: key,
      state: "pending", code: "sms_pending" }], { writeConcern: { w: "majority", j: true } });
  } catch (error) {
    if (error.code === 11000) return smsView(await existingOperation(key));
    throw error; // Never contact TextMe without a durable claim.
  }
  let result;
  try { result = await client.send(input); }
  catch { result = { state: "uncertain", code: "sms_interrupted", shipmentId: null, providerStatus: null }; }
  // A failed DB write leaves the durable claim in place: a replay still cannot send again.
  const saved = await SmsOperation.findOneAndUpdate({ _id: key, state: { $in: ["pending", "uncertain"] } },
    { $set: result }, { new: true, runValidators: true, writeConcern: { w: "majority", j: true } }).lean();
  log("info", "customer_link_sms", { orderId: String(order._id), operationId: key, state: saved.state, code: saved.code });
  return smsView(saved);
}

// Only after an authenticated merchant command commits. Keep the saved order
// successful even if messaging fails; never invite creation of a duplicate order.
export async function automaticCustomerLinkSms(user, orderId, client) {
  if (!client?.enabled) return;
  try {
    return await customerLinkSms(user, orderId, { send: true, client });
  } catch (error) {
    log("error", "automatic_customer_sms_failed", { orderId: String(orderId),
      code: ["sms_not_configured", "sms_unsupported_phone", "invalid_phone", "required_fields", "sms_link_expired"].includes(error.code)
        ? error.code : "sms_automatic_failed" });
  }
}
