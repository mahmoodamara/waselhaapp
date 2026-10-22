import { timingSafeEqual } from "node:crypto";
import {
  CodeAttempt,
  CodeAttemptState,
  User,
  codeTypes,
} from "../models/index.js";
import { fail, id, string } from "./validation.js";

// Lock policy, driven by the number of failures for one (order, actor, type).
// Every failure from the 5th on re-locks; the 15th needs an admin to unlock.
const SHORT_LOCK_AT = 5,
  LONG_LOCK_AT = 10,
  MANUAL_LOCK_AT = 15;
const SHORT_LOCK_MS = 60 * 1000,
  LONG_LOCK_MS = 10 * 60 * 1000;
const wrongCode = {
  pickup: "incorrect_pickup_code",
  delivery: "incorrect_delivery_code",
};

function lockFor(failures) {
  if (failures >= MANUAL_LOCK_AT) return "manual";
  if (failures >= LONG_LOCK_AT) return "long";
  if (failures >= SHORT_LOCK_AT) return "short";
  return undefined;
}
// Counts the attempt and computes the lock from the new failure count in ONE
// atomic update, so parallel requests cannot exceed the limit.
function reservation(now) {
  return [
    {
      $set: {
        totalAttempts: { $add: ["$totalAttempts", 1] },
        failures: { $add: ["$failures", 1] },
      },
    },
    {
      $set: {
        manualLock: { $gte: ["$failures", MANUAL_LOCK_AT] },
        lockedUntil: {
          $switch: {
            branches: [
              { case: { $gte: ["$failures", MANUAL_LOCK_AT] }, then: null },
              {
                case: { $gte: ["$failures", LONG_LOCK_AT] },
                then: { $add: [now, LONG_LOCK_MS] },
              },
              {
                case: { $gte: ["$failures", SHORT_LOCK_AT] },
                then: { $add: [now, SHORT_LOCK_MS] },
              },
            ],
            default: null,
          },
        },
      },
    },
  ];
}
function lockedError(state, now) {
  if (state.manualLock) fail("too_many_attempts", 429, { requiresAdmin: true });
  fail("too_many_attempts", 429, {
    retryAfterSeconds: Math.max(1, Math.ceil((state.lockedUntil - now) / 1000)),
  });
}
async function ensureState(key) {
  try {
    await CodeAttemptState.updateOne(
      key,
      {
        $setOnInsert: {
          totalAttempts: 0,
          failures: 0,
          lockedUntil: null,
          manualLock: false,
          blockedCount: 0,
        },
      },
      { upsert: true },
    );
  } catch (e) {
    if (e.code !== 11000) throw e;
  }
}
async function reserve(key) {
  for (let i = 0; i < 3; i++) {
    const now = new Date();
    const state = await CodeAttemptState.findOneAndUpdate(
      {
        ...key,
        manualLock: false,
        $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
      },
      reservation(now),
      { new: true },
    ).lean();
    if (state) return { state, now };
    const current = await CodeAttemptState.findOne(key).lean();
    if (!current) {
      await ensureState(key);
      continue;
    }
    // The lock may have expired between the two reads; try to reserve again.
    if (!current.manualLock && !(current.lockedUntil > now)) continue;
    await CodeAttemptState.updateOne(key, {
      $inc: { blockedCount: 1 },
      $set: { lastBlockedAt: now },
    });
    lockedError(current, now);
  }
  fail("state_conflict", 409);
}
function sameCode(submitted, expected) {
  const a = Buffer.from(typeof submitted === "string" ? submitted : ""),
    b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}
function clientMeta(meta) {
  return {
    ip: meta.ip,
    userAgent: meta.userAgent?.slice(0, 300),
  };
}
// Verifies a pickup/delivery code. Resolves on success, throws otherwise.
// The submitted code is never stored or logged. While locked, even the correct
// code is refused so a lock reveals nothing about it.
export async function verifyCode({
  order,
  actor,
  type,
  submitted,
  expected,
  meta = {},
}) {
  if (!actor?._id || !codeTypes.includes(type))
    throw new Error("verifyCode: actor and type are required");
  const key = { orderId: order._id, actorId: actor._id, type };
  const { state, now } = await reserve(key);
  const audit = {
    orderId: order._id,
    actorId: actor._id,
    verificationType: type,
    attemptNumber: state.totalAttempts,
    ...clientMeta(meta),
  };
  if (sameCode(submitted, expected)) {
    await CodeAttemptState.updateOne(key, {
      $set: { failures: 0, lockedUntil: null, manualLock: false },
    });
    await CodeAttempt.create({ ...audit, result: "success" });
    return;
  }
  const lock = lockFor(state.failures);
  await CodeAttempt.create({
    ...audit,
    result: "wrong_code",
    ...(lock ? { lock } : {}),
  });
  if (lock) lockedError(state, now);
  fail(wrongCode[type], 422);
}

export async function codeAttemptsReport(orderId) {
  const [states, attempts] = await Promise.all([
    CodeAttemptState.find({ orderId }).sort({ type: 1 }).lean(),
    CodeAttempt.find({ orderId }).sort({ createdAt: -1 }).limit(200).lean(),
  ]);
  const actorIds = [
    ...new Set([...states, ...attempts].map((r) => String(r.actorId))),
  ];
  const names = new Map(
    (await User.find({ _id: { $in: actorIds } }).select("name").lean()).map(
      (u) => [String(u._id), u.name],
    ),
  );
  const now = Date.now();
  return {
    states: states.map((s) => ({
      actorId: s.actorId,
      actorName: names.get(String(s.actorId)) ?? null,
      type: s.type,
      totalAttempts: s.totalAttempts,
      failures: s.failures,
      locked: Boolean(
        s.manualLock || (s.lockedUntil && s.lockedUntil.getTime() > now),
      ),
      lockedUntil: s.lockedUntil,
      manualLock: s.manualLock,
      blockedCount: s.blockedCount,
      lastBlockedAt: s.lastBlockedAt ?? null,
    })),
    attempts: attempts.map((a) => ({
      _id: a._id,
      actorId: a.actorId,
      actorName: names.get(String(a.actorId)) ?? null,
      verificationType: a.verificationType,
      attemptNumber: a.attemptNumber,
      result: a.result,
      lock: a.lock ?? null,
      ip: a.ip ?? null,
      userAgent: a.userAgent ?? null,
      adminId: a.adminId ?? null,
      note: a.note || null,
      createdAt: a.createdAt,
    })),
  };
}
// Admin-only. Resets the lock but keeps totalAttempts/blockedCount as evidence.
export async function unlockCode(order, admin, body, meta = {}) {
  const actorId = id(body.actorId),
    type = body.verificationType;
  if (typeof type !== "string" || !codeTypes.includes(type))
    fail("invalid_input");
  const note = string(body.note ?? "", false, 500);
  const state = await CodeAttemptState.findOneAndUpdate(
    { orderId: order._id, actorId, type },
    { $set: { failures: 0, lockedUntil: null, manualLock: false },
      $push: { unlocks: { at: new Date(), adminId: admin._id, note } } },
    { new: true },
  ).lean();
  if (!state) fail("not_found", 404);
  await CodeAttempt.create({
    orderId: order._id,
    actorId,
    verificationType: type,
    attemptNumber: state.totalAttempts,
    result: "admin_unlock",
    adminId: admin._id,
    note,
    ...clientMeta(meta),
  });
  return state;
}
