import { Router } from "express";
import bcrypt from "bcryptjs";
import { User, Order, PushDevice } from "../models/index.js";
import { auth, roles, publicUser } from "../middleware/auth.js";
import { fail, id, string } from "../services/validation.js";
import {
  ownedOrder,
  assignOrder,
  transition,
  orderView,
  terminal,
  editOrder,
} from "../services/orders.js";
import { adminFinance, recordCash } from "../services/finance.js";
import { codeAttemptsReport, unlockCode } from "../services/codeGuard.js";
import { parseLocation } from "../services/location.js";
import { parseServiceAreas } from "../services/serviceAreas.js";
import { parseVehicleType } from "../services/driverEligibility.js";
import { reconcileOrder } from "../services/orderFinance.js";
import { config } from "../config.js";
import { dispatchState } from "../services/dispatchGate.js";
import { DataRequest } from '../models/dataRequest.js';
import { driverCashHistory } from '../services/driverSummary.js';
import { randomBytes } from 'node:crypto';
const router = Router();
router.use(auth, roles("admin"));
router.get('/data-requests', async (req, res) => {
  const cursor = req.query.cursor;
  if (cursor !== undefined && (typeof cursor !== 'string' || !/^[a-f\d]{24}$/i.test(cursor))) fail('invalid_input');
  const rows = await DataRequest.find(cursor ? { _id: { $lt: id(cursor) } } : {}).sort({ _id: -1 }).limit(51).lean();
  res.json({ items: rows.slice(0, 50), nextCursor: rows.length > 50 ? String(rows[49]._id) : null });
});
router.get('/accounts/:id/cash-records', async (req,res) => {
  if (Object.keys(req.query).some(key => key !== 'cursor') || (req.query.cursor !== undefined && (typeof req.query.cursor !== 'string' || req.query.cursor.length > 1024))) fail('invalid_input');
  const account = await User.findOne({ _id:id(req.params.id), role:'driver' }).select('_id').lean();
  if (!account) fail('not_found',404);
  res.json(await driverCashHistory(account._id,{admin:true,cursor:req.query.cursor}));
});
router.post('/data-requests/:id/resolve', async (req, res) => {
  const { action, identityVerified, userId, ...extra } = req.body;
  if (Object.keys(extra).length || !['completed','rejected'].includes(action) || (action === 'completed' && identityVerified !== true)) fail('invalid_input');
  const request = await DataRequest.findById(id(req.params.id)).lean();
  if (!request) fail('not_found', 404);
  if (request.status !== 'pending') return res.json({ ok: true });
  if (action === 'completed' && request.type === 'deletion') {
    const account = await User.findOne({ _id: id(userId), role: { $in: ['driver','store'] } }).lean();
    if (!account || (String(request.verifiedUserId ?? '') !== String(account._id) && ![String(account._id), account.login].includes(request.identifier.toLowerCase()))) fail('invalid_input');
    await DataRequest.updateOne({ _id: request._id, status: 'pending' }, { $set: { verifiedUserId: account._id } });
    // Same disable-before-check protocol as the existing account lifecycle.
    await User.updateOne({ _id: account._id }, { $set: { active: false } });
    if (await Order.exists({ [account.role === 'driver' ? 'driverId' : 'storeId']: account._id,
      ...(account.role === 'driver' ? { activeAssignment: true } : {}), status: { $nin: terminal } })) {
      await User.updateOne({ _id: account._id }, { $set: { active: account.active } }); fail('unfinished_orders', 409);
    }
    await User.updateOne({ _id: account._id }, { $set: { name: 'Deleted account', phone: '', login: `deleted-${account._id}`,
      passwordHash: await bcrypt.hash(randomBytes(32).toString('hex'), 10), active: false, deletedAt: new Date(), availableForOrders: false, storeName: '', pickupAddress: '', serviceAreas: [] },
      $unset: { pickupLocation: 1 }, $inc: { authVersion: 1 } });
    await PushDevice.deleteMany({ userId: account._id });
    await req.app.locals.locationStore?.purgeDriver(String(account._id));
  }
  await DataRequest.updateOne({ _id: request._id, status: 'pending' }, { $set: { status: action, resolvedBy: req.user._id,
    resolvedAt: new Date(), ...(request.type === 'deletion' && action === 'completed' ? { identifier: '[removed]', contact: '[removed]' } : {}) } });
  res.json({ ok: true });
});
router.get("/accounts", async (req, res) =>
  res.json(
    (
      await User.find({ role: { $in: ["store", "driver"] } })
        .sort({ createdAt: -1 })
        .lean()
    ).map(publicUser),
  ),
);
router.post("/accounts", async (req, res) => {
  const b = req.body;
  if (!["store", "driver"].includes(b.role)) fail("invalid_input");
  const password = string(b.password, true, 200);
  if (password.length < 8) fail("password_short");
  const data = {
    login: string(b.login, true, 80).toLowerCase(),
    name: string(b.name, true),
    phone: string(b.phone ?? ""),
    role: b.role,
    passwordHash: await bcrypt.hash(password, 10),
  };
  if (b.role === "store")
    Object.assign(data, {
      storeName: string(b.storeName, true),
      pickupAddress: string(b.pickupAddress, true),
      ...(b.pickupLocation === undefined
        ? {}
        : { pickupLocation: parseLocation(b.pickupLocation) }),
    });
  if (b.role === "driver" && Object.hasOwn(b, "serviceAreas"))
    data.serviceAreas = parseServiceAreas(b.serviceAreas);
  if (Object.hasOwn(b, "vehicleType")) {
    if (b.role !== "driver") fail("invalid_input");
    data.vehicleType = parseVehicleType(b.vehicleType);
  }
  res.status(201).json(publicUser(await User.create(data)));
});
router.patch("/accounts/:id", async (req, res) => {
  const user = await User.findOne({
    _id: id(req.params.id),
    role: { $in: ["store", "driver"] },
  }).lean();
  if (user?.deletedAt) fail('not_found', 404);
  if (!user) fail("not_found", 404);
  const changes = {};
  if (Object.hasOwn(req.body, "serviceAreas")) {
    if (user.role !== "driver") fail("invalid_input");
    changes.serviceAreas = parseServiceAreas(req.body.serviceAreas);
  }
  if (Object.hasOwn(req.body, "vehicleType")) {
    if (user.role !== "driver") fail("invalid_input");
    // PATCH only: null explicitly clears a vehicle; omission leaves it intact.
    changes.vehicleType = req.body.vehicleType === null ? null : parseVehicleType(req.body.vehicleType);
  }
  for (const key of [
    "name",
    "phone",
    ...(user.role === "store" ? ["storeName", "pickupAddress"] : []),
  ])
    if (Object.hasOwn(req.body, key))
      changes[key] = string(req.body[key], key !== "phone");
  if (user.role === "store" && Object.hasOwn(req.body, "pickupLocation"))
    changes.pickupLocation = parseLocation(req.body.pickupLocation);
  let revokeSessions = false;
  // Validate and hash before the first write: a rejected password must not
  // leave the account deactivated by the coordination step below.
  if (req.body.password) {
    const password = string(req.body.password, true, 200);
    if (password.length < 8) fail("password_short");
    changes.passwordHash = await bcrypt.hash(password, 10);
    revokeSessions = true;
  }
  if (Object.hasOwn(req.body, "active")) {
    if (typeof req.body.active !== "boolean") fail("invalid_input");
    changes.active = req.body.active;
    if (!req.body.active && user.active) {
      // Deactivate first, then look for unfinished work. Order acceptance and
      // creation re-check the account after their own write, so the two sides
      // cannot both succeed (a check-then-write here could not guarantee that).
      await User.updateOne({ _id: user._id }, { $set: { active: false } });
      if (await Order.exists({
        [user.role === "store" ? "storeId" : "driverId"]: user._id,
        ...(user.role === "driver" ? { activeAssignment: true } : {}),
        status: { $nin: terminal },
      })) {
        await User.updateOne({ _id: user._id }, { $set: { active: true } });
        fail("unfinished_orders", 409);
      }
      revokeSessions = true;
    }
  }
  // Same update as the change: the history cannot be lost or detached from it.
  const event = { type: "account_updated", at: new Date(), adminId: req.user._id,
    changes: Object.keys(changes).map((field) => field === "passwordHash"
      ? { field: "password" } : { field, ...(["active", "serviceAreas", "vehicleType"].includes(field)
        ? { from: user[field] ?? null, to: changes[field] } : {}) }) };
  // A concurrent failed disable may have restored active=true since this
  // request read a temporary inactive state. Never disable it again without
  // checking its live work; likewise, do not overwrite a concurrent reactivation.
  const updated = await User.findOneAndUpdate(
    { _id: user._id, ...(changes.active === false ? { active: false } : {}) },
    { $set: changes, $push: { accountEvents: event }, ...(revokeSessions ? { $inc: { authVersion: 1 } } : {}) },
    { new: true, runValidators: true },
  ).lean();
  if (!updated) fail("state_conflict", 409);
  if (revokeSessions) {
    await PushDevice.deleteMany({ userId: user._id, $or: [{ authVersion: { $lt: updated.authVersion } }, { authVersion: { $exists: false } }] });
    await req.app.locals.locationStore?.invalidateDriver(String(user._id));
  }
  res.json(publicUser(updated));
});
router.get("/accounts/:id/audit", async (req, res) => {
  const user = await User.findOne({ _id: id(req.params.id), role: { $in: ["store", "driver"] } })
    .select("+accountEvents").lean();
  if (!user) fail("not_found", 404);
  res.json(user.accountEvents ?? []);
});
router.post("/orders/:id/assign", async (req, res) =>
  res.json(
    await orderView(
      await assignOrder(
        await ownedOrder(req.user, req.params.id),
        req.body.driverId,
        false,
        undefined,
        req.user,
      ),
      "admin",
    ),
  ),
);
for (const action of ["cancel", "authorize-return"])
  router.post(`/orders/:id/${action}`, async (req, res) =>
    res.json(
      await orderView(
        await transition(
          await ownedOrder(req.user, req.params.id),
          action,
          req.body,
          { actor: req.user },
        ),
        "admin",
      ),
    ),
  );
// Recovery after pickup: the admin records the failed delivery for a driver who
// cannot (lost phone/account). The assignment is not released and the parcel is
// not reassigned or cancelled; return then follows the normal authorize-return.
router.post("/orders/:id/recover", async (req, res) => {
  const order = await ownedOrder(req.user, req.params.id);
  res.json(await orderView(await transition(order, "fail", req.body, { actor: req.user }), "admin"));
});
router.get("/orders/:id/code-attempts", async (req, res) =>
  res.json(
    await codeAttemptsReport((await ownedOrder(req.user, req.params.id))._id),
  ),
);
router.post("/orders/:id/unlock-code", async (req, res) => {
  const order = await ownedOrder(req.user, req.params.id);
  await unlockCode(order, req.user, req.body, {
    ip: req.ip,
    userAgent: req.get("user-agent"),
  });
  res.json(await codeAttemptsReport(order._id));
});
// Orders that have not changed for too long. The worker handles expired searches
// and arrivals by itself; this list is for everything that needs a person.
router.get("/ops/stuck", async (req, res) => {
  const now = Date.now(), cutoff = new Date(now - config.stuckOrderHours * 3600 * 1000);
  const overdue = new Date(now - config.orderTimeoutSweepIntervalMs * 3 - 5000);
  const unpriced = new Date(now - 5 * 60000);
  const orders = await Order.find({ $or: [
    // A confirmed destination that still has no price: the routing service is not answering.
    { priceSource: "route", priceStatus: "pending", routeError: { $ne: null }, status: { $in: ["searching_driver", "driver_assigned", "driver_at_store"] },
      "destinationLocation.confirmedAt": { $lt: unpriced } },
    { status: { $in: ["driver_assigned", "driver_at_store", "collected", "driver_at_destination", "delivery_failed", "returning"] }, updatedAt: { $lt: cutoff } },
    { status: "searching_driver", driverSearchStatus: "searching", searchDeadlineAt: { $lt: overdue } },
    // A quick order still waiting for its customer (never cancelled automatically).
    { status: "searching_driver", driverSearchStatus: "waiting", activeAssignment: false, updatedAt: { $lt: cutoff } },
    { status: "driver_assigned", activeAssignment: true, arrivedStoreAt: null, storeArrivalDeadlineAt: { $lt: overdue } },
  ] }).select("status storeName driverId updatedAt searchDeadlineAt storeArrivalDeadlineAt priceStatus routeError driverSearchStatus parcelReady workflowVersion customerConfirmed customerAvailable").sort({ updatedAt: 1 }).limit(200).lean();
  res.json(orders.map((o) => ({ ...o, reason: o.priceStatus === "pending" && o.routeError ? "route_unavailable"
    : o.driverSearchStatus === "waiting" ? dispatchState(o) || "waiting_customer"
    : o.status === "searching_driver" || o.storeArrivalDeadlineAt < overdue ? "worker_overdue" : "no_progress" })));
});
router.get("/finance", async (req, res) => res.json(await adminFinance()));
router.patch("/orders/:id/finance-terms", async (req, res) => {
  if (Object.keys(req.body).some(key => !["deliveryFeePaidBy", "observed"].includes(key))) fail("invalid_input");
  res.json(await orderView(await editOrder(await ownedOrder(req.user, req.params.id), req.body, req.user), "admin"));
});
for (const action of ["resolve-adjustment", "cash-handover", "driver-payout", "store-settlement", "reverse-record"])
  router.post(`/orders/:id/finance/${action}`, async (req, res) =>
    res.json(await orderView(await reconcileOrder(await ownedOrder(req.user, req.params.id), req.user, action, req.body), "admin")));
router.post("/driver-cash-records", async (req, res) =>
  res.status(201).json(await recordCash(req.user._id, req.body)),
);
export default router;
