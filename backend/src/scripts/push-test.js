// Sends one harmless test notification to a driver's registered phones and prints whether Google/Apple
// accepted it (the Expo receipt). Prints no token.   npm run push-test -- <driver login>
import mongoose from "mongoose";
import { connectDatabase, User, PushDevice } from "../models/index.js";
import { sendTestPush } from "../services/push.js";

const login = process.argv[2];
try {
  if (!login) throw new Error("Usage: npm run push-test -- <driver login>");
  await connectDatabase();
  const driver = await User.findOne({ login, role: "driver" }).lean();
  if (!driver) throw new Error("No driver with that login.");
  const registered = await PushDevice.countDocuments({ userId: driver._id });
  console.log(`${login}: ${registered} registered phone(s)`);
  const { devices, results } = await sendTestPush(driver._id);
  if (!devices) console.log("Nothing sent: the driver's phone has not registered for notifications (open the app, press Start work, allow notifications).");
  for (const r of results) {
    console.log(`${r.platform}: ticket=${r.ticket}${r.ticketError ? ` (${r.ticketError})` : ""} receipt=${r.receipt ?? "not available yet"}${r.receiptError ? ` (${r.receiptError})` : ""}${r.reason ? ` - ${r.reason}` : ""}`);
    if (r.receiptError === "InvalidCredentials" || r.receiptError === "MismatchSenderId")
      console.log("  -> Google (FCM) credentials are missing or wrong in EAS: run `eas credentials`, Android, Google Service Account Key for push notifications (FCM V1).");
    if (r.receiptError === "DeviceNotRegistered") console.log("  -> The app was uninstalled or its push token is stale: sign in again on the phone.");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
