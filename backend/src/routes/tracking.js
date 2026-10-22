import { Router } from "express";
import { rateLimit } from "../services/rateLimit.js";
import { verifyTrackingCredential, discloseTracking } from "../services/customerTracking.js";
const router = Router();
router.get("/snapshot", rateLimit(60), async (req, res) => {
  const bearer = req.headers.authorization?.split(" ");
  const claims = verifyTrackingCredential(bearer?.[0] === "Bearer" ? bearer[1] : null);
  await discloseTracking(claims, req.app.locals.locationStore, snapshot => res.json(snapshot));
});
export default router;
