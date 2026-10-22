import { Router } from "express";
import { auth, roles } from "../middleware/auth.js";
import { searchAddress, reverseGeocode } from "../services/maps.js";
const router = Router();
router.use(auth, roles("store", "admin"));
router.get("/search", async (req, res) =>
  res.json(await searchAddress(req.query.q, req.query.lang)),
);
router.get("/reverse", async (req, res) =>
  res.json(await reverseGeocode(req.query.lat, req.query.lng, req.query.lang)),
);
export default router;
