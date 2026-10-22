import { createHash } from "node:crypto";

// Client retry IDs are scoped to their authenticated merchant. They cannot
// reserve, collide with or probe a chosen order ID belonging to another user.
export const orderCreationId = (storeId, operationId) => createHash("sha256")
  .update(`order-create:${storeId}:${operationId}`).digest("hex").slice(0, 24);
