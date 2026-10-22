import { Router } from "express";
import { Order, PushDevice, User } from "../models/index.js";
import { auth, roles, publicUser } from "../middleware/auth.js";
import { orderView } from "../services/orders.js";
import { driverSummary } from "../services/finance.js";
import { driverCashHistory } from '../services/driverSummary.js';
import { eligibleOrderFilter } from "../services/driverEligibility.js";
import { fail } from "../services/validation.js";
import { availableNearbyOffers } from "../services/nearbyOffers.js";
import { config } from "../config.js";
import { rateLimit } from "../services/rateLimit.js";
import { pushLanguages, pushPlatforms, validPushToken } from "../services/push.js";
const router = Router();
router.use(auth, roles("driver"));
router.patch("/availability", async (req, res) => {
  if (typeof req.body.available !== "boolean" || Object.keys(req.body).some((key) => key !== "available"))
    fail("invalid_input");
  const driver = await User.findOneAndUpdate(
    { _id: req.user._id, role: "driver", active: true },
    { $set: { availableForOrders: req.body.available, availabilityUpdatedAt: new Date() } },
    { new: true, runValidators: true },
  ).lean();
  if (!driver) fail("unauthorized", 401);
  if (!driver.availableForOrders && !await Order.exists({ driverId: driver._id, activeAssignment: true }))
    await req.app.locals.locationStore?.clearDriverLocation(String(driver._id));
  res.json(publicUser(driver));
});
// The app registers its push token after the driver agrees to notifications, and removes it on sign-out.
router.put("/push-token", rateLimit(30, 60000, req => String(req.user._id)), async (req, res) => {
  const { token, platform, language = "ar", ...extra } = req.body ?? {};
  if (Object.keys(extra).length || !validPushToken(token) || !pushPlatforms.includes(platform) || !pushLanguages.includes(language)) fail("invalid_input");
  await PushDevice.updateOne({ token }, { $set: { userId: req.user._id, platform, language,
    authVersion: req.user.authVersion ?? 0, supportedWorkflowVersion: req.user.supportedWorkflowVersion ?? 2 } }, { upsert: true });
  // An already authenticated request can finish after logout/reset cleanup.
  // Recheck after the write and remove only this account/version, preserving a
  // token that has since moved to another account or a newer session.
  const current = await User.findById(req.user._id).select('active authVersion').lean();
  if (!current?.active || (current.authVersion ?? 0) !== (req.user.authVersion ?? 0)) {
    await PushDevice.deleteOne({ token, userId: req.user._id, authVersion: req.user.authVersion ?? 0 });
    fail('unauthorized', 401);
  }
  res.json({ ok: true });
});
router.delete("/push-token", rateLimit(30, 60000, req => String(req.user._id)), async (req, res) => {
  if (!validPushToken(req.body?.token) || Object.keys(req.body).length !== 1) fail("invalid_input");
  await PushDevice.deleteOne({ token: req.body.token, userId: req.user._id });
  res.json({ ok: true });
});
router.get("/orders/available", rateLimit(config.rateLimitOffersPerMin, 60000, req => String(req.user._id)), async (req, res) => {
  const filter = await eligibleOrderFilter(req.user);
  if (!filter) return res.json([]);
  const store = req.app.locals.locationStore;
  if (!store) fail("realtime_unavailable", 503);
  try {
    const offers = await availableNearbyOffers(req.user, store, config, req.app.locals.offerEta);
    // Keep the historical REST _id alias for existing clients. Wire events use
    // orderId only. No sensitive legacy fields are reintroduced.
    res.json(offers.map(offer => ({ ...offer, _id: offer.orderId, offerExpiresAt: offer.expiresAt })));
  } catch { fail("realtime_unavailable", 503); }
});
router.get("/orders/current", async (req, res) => {
  const order = await Order.findOne({
    driverId: req.user._id,
    activeAssignment: true,
  }).lean();
  if (order?.workflowVersion === 3 && req.user.supportedWorkflowVersion !== 3) fail("app_update_required", 409);
  res.json(order ? await orderView(order, "driver") : null);
});
// Operational route (distance, ETA, polyline) for the authenticated driver's own
// active assignment. No parameters: the server picks origin and destination.
router.get("/orders/current/route", async (req, res) => {
  const routes = req.app.locals.driverRoutes;
  if (!routes) fail("route_unavailable", 503);
  res.json(await routes.currentRoute(req.user));
});
router.get('/summary', async (req, res) => {
  if (Object.keys(req.query).some(key => key !== 'cursor')) fail('invalid_input');
  if (req.query.cursor !== undefined && (typeof req.query.cursor !== 'string' || req.query.cursor.length > 1024)) fail('invalid_input');
  res.json(await driverSummary(req.user._id, { cursor: req.query.cursor }));
});
router.get('/summary/records', async (req,res) => {
  if (Object.keys(req.query).some(key => key !== 'cursor')) fail('invalid_input');
  if (req.query.cursor !== undefined && typeof req.query.cursor !== 'string') fail('invalid_input');
  res.json(await driverCashHistory(req.user._id, { cursor: req.query.cursor }));
});
export default router;
