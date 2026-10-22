import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { User } from "../models/index.js";
import { fail } from "../services/validation.js";
export async function authenticateToken(token) {
  if (typeof token !== "string" || !token || token.length > 4096) fail("unauthorized", 401);
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] });
    if (payload.scope || payload.aud || typeof payload.sub !== "string" || !/^[a-f\d]{24}$/i.test(payload.sub) ||
        !Number.isSafeInteger(payload.exp)) fail("unauthorized", 401);
  } catch {
    fail("unauthorized", 401);
  }
  const user = await User.findById(payload.sub).lean();
  // `ver` binds a token to the account's session version: a password reset or
  // deactivation bumps it and every older token stops working. Tokens issued
  // before this field existed carry no `ver` and match the default of 0.
  if (!user?.active || (payload.ver ?? 0) !== (user.authVersion ?? 0)) fail("unauthorized", 401);
  return { user, expiresAt: payload.exp * 1000 };
}
export async function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ");
  if (token?.[0] !== "Bearer" || !token[1]) fail("unauthorized", 401);
  const session = await authenticateToken(token[1]);
  req.user = session.user;
  if (req.user.role === "driver") {
    const supported = req.get("x-waselha-workflow") === "3" ? 3 : 2;
    if (supported === 3 && req.user.supportedWorkflowVersion !== 3)
      await User.updateOne({ _id: req.user._id }, { $set: { supportedWorkflowVersion: 3 } });
    // Request capability is local to this client, even if another device upgraded.
    req.user.supportedWorkflowVersion = supported;
  }
  req.authExpiresAt = session.expiresAt;
  next();
}
export function roles(...allowed) {
  return (req, res, next) => {
    if (!allowed.includes(req.user.role)) fail("forbidden", 403);
    next();
  };
}
export function publicUser(user) {
  const { passwordHash, __v, authVersion, accountEvents, ...safe } = user.toObject ? user.toObject() : user;
  return safe;
}
