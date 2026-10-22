import { Router } from "express";
import { Order, User } from "../models/index.js";
import {
  customerView,
  terminal,
  confirmCustomer,
  confirmDestination,
  beforePickup,
  saveCustomerDetails,
  setCustomerAvailability,
} from "../services/orders.js";
import { fail } from "../services/validation.js";
import { customerAccessFilter } from "../services/customerLinks.js";
import { searchAddress, reverseGeocode } from "../services/maps.js";
import { issueTrackingCredential } from "../services/customerTracking.js";
import { rateLimit } from "../services/rateLimit.js";
const router = Router();
async function find(token) {
  if (!/^[a-f0-9]{48}$/.test(token)) fail("not_found", 404);
  const order = await Order.findOne(customerAccessFilter(token)).lean();
  if (!order) fail("not_found", 404);
  return order;
}
// The link only reaches the map provider while the order can still change, so
// it cannot be used as an open proxy once the order is past pickup or closed.
async function findEditable(token) {
  const order = await find(token);
  if (!beforePickup.includes(order.status)) fail("editing_blocked", 409);
  return order;
}
// While the order is open the customer may call the store that sent it; a closed
// order keeps the minimal view.
async function view(order) {
  const result = customerView(order);
  if (terminal.includes(order.status)) return result;
  const store = await User.findById(order.storeId).select("phone").lean();
  return store?.phone ? { ...result, storePhone: store.phone } : result;
}
router.get("/:token", async (req, res) =>
  res.json(await view(await find(req.params.token))),
);
router.post("/:token/tracking-credential", rateLimit(20), async (req, res) => {
  if (Object.keys(req.body).length) fail("invalid_payload");
  res.json(issueTrackingCredential(await find(req.params.token)));
});
router.post("/:token/details", async (req, res) =>
  res.json(await view(await saveCustomerDetails(await find(req.params.token), req.body))),
);
router.post("/:token/confirm", async (req, res) =>
  res.json(await view(await confirmCustomer(await find(req.params.token), req.body))),
);
// "I am ready now" / "not now": the only thing that starts or pauses the driver
// search from the customer's side once the total is confirmed.
router.post("/:token/availability", async (req, res) =>
  res.json(await view(await setCustomerAvailability(await find(req.params.token), req.body))),
);
router.post("/:token/location", async (req, res) => {
  await confirmDestination(await find(req.params.token), req.body);
  // Routing may take seconds; a revoked/expired link must not receive a fresh
  // customer view after the wait. Location was already checked atomically.
  res.json(await view(await find(req.params.token)));
});
router.get("/:token/maps/search", async (req, res) => {
  await findEditable(req.params.token);
  res.json(await searchAddress(req.query.q, req.query.lang));
});
router.get("/:token/maps/reverse", async (req, res) => {
  await findEditable(req.params.token);
  res.json(await reverseGeocode(req.query.lat, req.query.lng, req.query.lang));
});
export default router;
