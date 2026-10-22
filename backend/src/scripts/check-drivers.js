// Lists every driver and what, if anything, keeps them from receiving offers.
// Read-only:  npm run check-drivers
import mongoose from "mongoose";
import { connectDatabase, User } from "../models/index.js";
import { offerProblems } from "../services/driverEligibility.js";

try {
  await connectDatabase();
  const drivers = await User.find({ role: "driver" }).sort({ login: 1 }).lean();
  for (const driver of drivers) {
    const problems = offerProblems(driver);
    console.log(`${problems.length ? "NOT READY" : "ready    "}  ${driver.login.padEnd(16)} ` +
      `${(driver.vehicleType ?? "-").padEnd(11)} ${(driver.serviceAreas ?? []).join("/").padEnd(12) || "-".padEnd(12)} ` +
      `${problems.join(", ")}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
