import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { LoginAttemptState, User } from "../models/index.js";
import { config } from "../config.js";
import { fail } from "./validation.js";

// Missing/inactive accounts do the same password work as active accounts.
const dummyHash = bcrypt.hash(randomBytes(32).toString("hex"), 10);
function rejectLocked(state, now = new Date()) {
  if (state?.lockedUntil > now)
    fail("login_locked", 429, {
      retryAfterSeconds: Math.max(1, Math.ceil((state.lockedUntil - now) / 1000)),
    });
}
// Every state expires (TTL index) after a quiet period of twice the lock time, so
// random identities cannot grow the collection without bound.
const keepUntil = (now = Date.now()) => new Date(now + config.loginLockMs * 2);
async function ensureState(login) {
  try {
    await LoginAttemptState.updateOne({ _id: login }, {
      $setOnInsert: { failures: 0, lockedUntil: null, expiresAt: keepUntil() },
    }, { upsert: true });
  } catch (error) {
    // A parallel request may have inserted the unique login key first.
    if (error.code !== 11000) throw error;
  }
}
function failureUpdate(now) {
  return [
    { $set: { failures: { $add: [
      { $cond: [
        { $and: [{ $ne: ["$lockedUntil", null] }, { $lte: ["$lockedUntil", now] }] },
        0, { $ifNull: ["$failures", 0] },
      ] }, 1,
    ] } } },
    { $set: { lockedUntil: { $cond: [
      { $gte: ["$failures", config.loginMaxAttempts] },
      { $add: [now, config.loginLockMs] }, null,
    ] }, expiresAt: keepUntil(now.getTime()) } },
  ];
}
export async function verifyLogin(login, password) {
  await ensureState(login);
  rejectLocked(await LoginAttemptState.findById(login).lean());
  const user = await User.findOne({ login, active: true }).select("+passwordHash").lean();
  const matches = await bcrypt.compare(password, user?.passwordHash ?? await dummyHash);
  const valid = Boolean(user && matches);
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = new Date();
    // Lock check + failure increment/reset + lock creation are one atomic
    // write. A concurrent success cannot clear a lock another request set.
    const state = await LoginAttemptState.findOneAndUpdate({
      _id: login,
      $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
    }, valid ? { $set: { failures: 0, lockedUntil: null, expiresAt: keepUntil(now.getTime()) } } : failureUpdate(now), { new: true }).lean();
    if (state) {
      if (valid) return user;
      rejectLocked(state, now);
      fail("invalid_credentials", 401);
    }
    rejectLocked(await LoginAttemptState.findById(login).lean());
    await ensureState(login);
  }
  fail("state_conflict", 409);
}
