import { Router } from "express";
import jwt from "jsonwebtoken";
import { auth, publicUser } from "../middleware/auth.js";
import { config } from "../config.js";
import { string } from "../services/validation.js";
import { verifyLogin } from "../services/loginGuard.js";
import { User, PushDevice } from "../models/index.js";
const router = Router();
router.post("/login", async (req, res) => {
  const login = string(req.body.login, true, 80).toLowerCase(),
    password = string(req.body.password, true, 200);
  const user = await verifyLogin(login, password);
  res.json({
    token: jwt.sign({ ver: user.authVersion ?? 0 }, config.jwtSecret, {
      subject: String(user._id),
      expiresIn: "7d",
    }),
    user: publicUser(user),
  });
});
router.get("/me", auth, (req, res) => res.json(publicUser(req.user)));
router.post("/logout", auth, async (req, res) => {
  await User.updateOne({ _id: req.user._id }, { $inc: { authVersion: 1 } });
  await PushDevice.deleteMany({ userId: req.user._id, $or: [{ authVersion: { $lte: req.user.authVersion ?? 0 } }, { authVersion: { $exists: false } }] });
  await req.app.locals.locationStore?.invalidateDriver(String(req.user._id));
  res.json({ ok: true });
});
export default router;
