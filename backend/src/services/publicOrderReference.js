import { createHmac } from "node:crypto";
import { config } from "../config.js";

// Stable across customer-link rotations, without exposing MongoDB identifiers.
export const publicOrderReference = order => createHmac("sha256", config.jwtSecret)
  .update(`customer-order:${order._id}`).digest("hex").slice(0, 16).toUpperCase();
