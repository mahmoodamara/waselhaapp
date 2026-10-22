// Creates the real administrator, or resets its password (which also signs out
// its existing sessions). The password comes from the environment so it is never
// stored in a file or shell history:
//   ADMIN_LOGIN=owner ADMIN_PASSWORD='<12+ chars>' npm run create-admin
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { connectDatabase, User } from "../models/index.js";
import { demoPassword } from "../services/startupChecks.js";

export async function createAdmin({ login, password, name = "Admin" }) {
  login = String(login ?? "").trim().toLowerCase();
  if (!login || login.length > 80) throw new Error("ADMIN_LOGIN is required");
  if (typeof password !== "string" || password.length < 12 || password === demoPassword)
    throw new Error("ADMIN_PASSWORD must be at least 12 characters and not the demo password");
  const passwordHash = await bcrypt.hash(password, 10);
  const existing = await User.findOne({ login }).lean();
  if (existing && existing.role !== "admin") throw new Error("That login belongs to a non-admin account");
  if (existing) {
    await User.updateOne({ _id: existing._id }, { $set: { passwordHash, active: true }, $inc: { authVersion: 1 } });
    return "updated";
  }
  await User.create({ login, passwordHash, role: "admin", name, active: true });
  return "created";
}
if (process.argv[1]?.endsWith("/create-admin.js") || process.argv[1]?.endsWith("\create-admin.js")) {
  try {
    await connectDatabase();
    console.log(`Admin ${await createAdmin({ login: process.env.ADMIN_LOGIN, password: process.env.ADMIN_PASSWORD,
      name: process.env.ADMIN_NAME || "Admin" })}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}
