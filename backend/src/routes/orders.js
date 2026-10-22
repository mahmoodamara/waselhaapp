import { Router } from "express";
import { Order, statuses } from "../models/index.js";
import { auth, roles } from "../middleware/auth.js";
import { fail, id } from "../services/validation.js";
import { retrySearch, cancelSearch, withdrawDriver, reportDriverIssue } from "../services/orderTimeouts.js";
import { supportedServiceAreas } from "../services/serviceAreas.js";
import { rateLimit } from "../services/rateLimit.js";
import { orderActionLimit } from "../services/orderActionLimit.js";
import { orderCreationId } from "../services/orderCreationId.js";
import { selectNearbyDrivers } from "../services/nearbyOffers.js";
import { customerLinkSms, automaticCustomerLinkSms } from "../services/orderSms.js";
import {
  ownedOrder,
  createOrder,
  orderView,
  editOrder,
  confirmDetails,
  assignOrder,
  transition,
  reissueCustomerLink,
  recalculatePrice,
  correctPickupLocation,
  verifyDeliveryCode,
} from "../services/orders.js";
const router = Router();
router.use(auth);
const automaticSmsIpLimit = rateLimit(10);
const automaticSmsUserLimit = rateLimit(5, 60000, req => String(req.user._id));
function automaticSmsGuard(req, res, next) {
  if (!req.app.locals.textMe.enabled || (req.method === "PATCH" && !Object.hasOwn(req.body, "customerPhone"))) return next();
  automaticSmsIpLimit(req, res, () => automaticSmsUserLimit(req, res, next));
}
async function createdOrderView(req, order) {
  await automaticCustomerLinkSms(req.user, order._id, req.app.locals.textMe);
  return orderView(order, req.user.role);
}
router.get("/service-areas", roles("store", "admin", "driver"), (req, res) => res.json(supportedServiceAreas));
router.get("/", roles("store", "admin"), async (req, res) => {
  const query = req.user.role === "store" ? { storeId: req.user._id } : {};
  if (req.query.status) {
    if (!statuses.includes(req.query.status)) fail("invalid_input");
    query.status = req.query.status;
  }
  const orders = await Order.find(query).sort({ createdAt: -1 }).lean();
  res.json(await Promise.all(orders.map((o) => orderView(o, req.user.role))));
});
// Scope retry IDs to the authenticated merchant; the unique primary key is
// the atomic idempotency boundary, including retries after a process restart.
router.post("/", roles("store"), orderActionLimit("create"), automaticSmsGuard, async (req, res) => {
  const operationId = req.body.operationId;
  if (operationId !== undefined && (typeof operationId !== "string" || !/^[a-f0-9]{24}$/.test(operationId))) fail("invalid_input");
  const creationId = operationId && orderCreationId(req.user._id, operationId);
  // Honor previously created, owned IDs when replaying a pre-migration request.
  const existing = operationId && await Order.findOne({ storeId: req.user._id,
    _id: { $in: [operationId, creationId] } }).lean();
  if (existing) {
    return res.json(await createdOrderView(req, existing));
  }
  try {
    res.status(201).json(await createdOrderView(req, await createOrder(req.user, req.body, creationId)));
  } catch (error) {
    if (operationId && error.code === 11000) {
      const saved = await Order.findOne({ _id: creationId, storeId: req.user._id }).lean();
      if (saved) return res.json(await createdOrderView(req, saved));
    }
    throw error;
  }
});
router.post("/:id/accept", roles("driver"), orderActionLimit("accept"), async (req, res) => {
  const order = await Order.findById(id(req.params.id)).lean();
  if (!order) fail("not_found", 404);
  if (order.workflowVersion === 3) {
    if (req.user.supportedWorkflowVersion !== 3 || req.body.supportedWorkflowVersion !== 3) fail("app_update_required", 409);
    if (req.body.dispatchVersion !== order.dispatchVersion) fail("offer_expired", 409);
    if (!order.activeAssignment) {
      const locationStore = req.app.locals.locationStore;
      if (!locationStore) fail("realtime_unavailable", 503);
      const { candidates } = await selectNearbyDrivers(order, locationStore);
      if (!candidates.some(c => c.driverId === String(req.user._id))) fail("order_unavailable", 409);
    }
  }
  res.json(
    await orderView(await assignOrder(order, req.user._id, true, undefined, undefined, req.body), "driver"),
  );
});
router.post("/:id/retry-search", roles("store", "admin"), async (req, res) =>
  res.json(await orderView(await retrySearch(await ownedOrder(req.user, req.params.id), req.user, req.body), req.user.role)),
);
router.post("/:id/cancel", roles("store"), async (req, res) =>
  res.json(await orderView(await cancelSearch(await ownedOrder(req.user, req.params.id), req.user, undefined, req.body), req.user.role)),
);
router.post("/:id/withdraw", roles("driver"), async (req, res) =>
  res.json(await orderView(await withdrawDriver(await ownedOrder(req.user, req.params.id), req.user, req.body), "driver")),
);
router.post("/:id/report-issue", roles("driver"), async (req, res) =>
  res.json(await orderView(await reportDriverIssue(await ownedOrder(req.user, req.params.id), req.user, req.body), "driver")),
);
router.get("/:id", roles("store", "admin", "driver"), async (req, res) =>
  res.json(
    await orderView(await ownedOrder(req.user, req.params.id), req.user.role),
  ),
);
router.post("/:id/customer-link/reissue", roles("store", "admin"), automaticSmsGuard, async (req, res) => {
  const replacement = await reissueCustomerLink(await ownedOrder(req.user, req.params.id), req.user, req.body);
  await automaticCustomerLinkSms(req.user, req.params.id, req.app.locals.textMe);
  res.json(replacement);
});
// One send per current link, regardless of concurrent clicks, restarts or fresh client IDs.
router.get("/:id/customer-link/sms", roles("store", "admin"), async (req, res) =>
  res.json(await customerLinkSms(req.user, req.params.id)),
);
router.post("/:id/customer-link/sms", roles("store", "admin"),
  rateLimit(10), rateLimit(5, 60000, req => String(req.user._id)), async (req, res) => {
    if (Object.keys(req.body).length) fail("invalid_input");
    res.json(await customerLinkSms(req.user, req.params.id, { send: true, client: req.app.locals.textMe }));
  },
);
router.post("/:id/recalculate-price", roles("store", "admin"), async (req, res) =>
  res.json(await orderView(await recalculatePrice(await ownedOrder(req.user, req.params.id)), req.user.role)),
);
router.post("/:id/pickup-location", roles("store"), async (req, res) =>
  res.json(await orderView(await correctPickupLocation(await ownedOrder(req.user, req.params.id), req.body, req.user), "store")),
);
router.patch("/:id", roles("store"), automaticSmsGuard, async (req, res) => {
  const saved = await editOrder(await ownedOrder(req.user, req.params.id), req.body, req.user);
  if (Object.hasOwn(req.body, "customerPhone"))
    await automaticCustomerLinkSms(req.user, saved._id, req.app.locals.textMe);
  res.json(await orderView(saved, "store"));
});
router.post("/:id/confirm", roles("store", "driver"), async (req, res) =>
  res.json(
    await orderView(
      await confirmDetails(
        await ownedOrder(req.user, req.params.id),
        req.user,
        req.body,
      ),
      req.user.role,
    ),
  ),
);
router.post("/:id/readiness", roles("store"), async (req, res) => {
  if (Object.keys(req.body).some(key => !["ready", "observed"].includes(key)) || typeof req.body.ready !== "boolean") fail("invalid_input");
  res.json(await orderView(await editOrder(await ownedOrder(req.user, req.params.id), {
    parcelReady: req.body.ready, observed: req.body.observed,
  }, req.user), "store"));
});
router.post("/:id/verify-delivery-code", roles("driver"), rateLimit(60), async (req, res) =>
  res.json(await verifyDeliveryCode(await ownedOrder(req.user, req.params.id), req.body,
    { actor: req.user, ip: req.ip, userAgent: req.get("user-agent") })),
);
for (const action of [
  "arrive-store",
  "pickup",
  "arrive-customer",
  "deliver",
  "fail",
])
  router.post(`/:id/${action}`, roles("driver"), async (req, res) =>
    res.json(
      await orderView(
        await transition(
          await ownedOrder(req.user, req.params.id, req.body),
          action,
          req.body,
          // actor always comes from the token, never from the request body
          { actor: req.user, ip: req.ip, userAgent: req.get("user-agent") },
        ),
        "driver",
      ),
    ),
  );
router.post("/:id/confirm-return", roles("store"), async (req, res) =>
  res.json(
    await orderView(
      await transition(
        await ownedOrder(req.user, req.params.id),
        "confirm-return",
        req.body,
        { actor: req.user },
      ),
      "store",
    ),
  ),
);
export default router;
