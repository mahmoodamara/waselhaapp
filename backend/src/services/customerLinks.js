import { randomBytes } from "node:crypto";
import { config } from "../config.js";

export function issueCustomerToken() {
  return {
    customerToken: randomBytes(24).toString("hex"),
    customerTokenExpiresAt: new Date(Date.now() + config.customerLinkTtlMs),
  };
}
export function customerLink(order) {
  return `${config.publicBaseUrl}/customer/${order.customerToken}`;
}
// The same predicate is used when reading and atomically writing. Legacy
// links get a finite lifetime without rewriting existing orders in bulk.
export function customerAccessFilter(token, now = new Date()) {
  return {
    customerToken: token,
    $or: [
      { customerTokenExpiresAt: { $gte: now } },
      {
        customerTokenExpiresAt: { $exists: false },
        createdAt: { $gte: new Date(now.getTime() - config.customerLinkTtlMs) },
      },
    ],
  };
}
