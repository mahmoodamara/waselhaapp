// Creates a driver who can actually receive offers, or repairs an existing one.
//
// A driver is offered an order only when the account is active, switched on
// ("available"), has at least one service area and a vehicle: a car takes every
// order, a motorcycle only motorcycle orders, and a driver with no vehicle sees
// only historical orders. An account missing any of these silently gets nothing.
//
//   DRIVER_LOGIN=driver-car DRIVER_PASSWORD='<12+ chars>' DRIVER_NAME='Driver' \
//     DRIVER_VEHICLE=car npm run create-driver
//
// Optional: DRIVER_PHONE, DRIVER_AREAS (comma separated, default: every supported
// area), DRIVER_AVAILABLE (new drivers default to true; the driver can switch it in
// the app). For an existing driver, leave DRIVER_PASSWORD out to keep the password;
// areas and availability already set are kept unless given.
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { connectDatabase, User } from "../models/index.js";
import { demoPassword } from "../services/startupChecks.js";
import { supportedServiceAreas, validServiceAreas } from "../services/serviceAreas.js";
import { offerProblems } from "../services/driverEligibility.js";

const vehicles = ["car", "motorcycle"];
export async function createDriver({
  login,
  password,
  name,
  phone,
  vehicleType,
  serviceAreas,
  available,
  production = process.env.NODE_ENV === "production",
}) {
  login = String(login ?? "").trim().toLowerCase();
  if (!login || login.length > 80) throw new Error("DRIVER_LOGIN is required");
  if (!vehicles.includes(vehicleType)) throw new Error("DRIVER_VEHICLE must be car or motorcycle");
  if (serviceAreas !== undefined && (!validServiceAreas(serviceAreas) || !serviceAreas.length))
    throw new Error(`DRIVER_AREAS must list supported areas: ${supportedServiceAreas.join(", ")}`);
  if (password !== undefined && password !== "") {
    if (typeof password !== "string" || password.length < 12)
      throw new Error("DRIVER_PASSWORD must be at least 12 characters");
    if (production && password === demoPassword) throw new Error("DRIVER_PASSWORD must not be the demo password");
  }
  const existing = await User.findOne({ login }).lean();
  if (existing && existing.role !== "driver") throw new Error("That login belongs to a non-driver account");
  if (existing && existing.active === false) throw new Error("That driver is deactivated; reactivate it from the admin portal first");
  const now = new Date();
  if (!existing) {
    if (!password) throw new Error("DRIVER_PASSWORD is required for a new driver");
    if (!name) throw new Error("DRIVER_NAME is required for a new driver");
    await User.create({
      login, name, phone: phone ?? "", role: "driver", active: true,
      passwordHash: await bcrypt.hash(password, 10),
      vehicleType, serviceAreas: serviceAreas ?? [...supportedServiceAreas],
      availableForOrders: available ?? true, availabilityUpdatedAt: now,
    });
    return "created";
  }
  // A repair never re-enables a driver who switched off, nor widens areas already set.
  const keptAreas = validServiceAreas(existing.serviceAreas) && existing.serviceAreas.length ? existing.serviceAreas : null;
  const set = { vehicleType, serviceAreas: serviceAreas ?? keptAreas ?? [...supportedServiceAreas] };
  if (available !== undefined) set.availableForOrders = available;
  if (name) set.name = name;
  if (phone !== undefined) set.phone = phone;
  if (available !== undefined && available !== existing.availableForOrders) set.availabilityUpdatedAt = now;
  const changes = Object.entries(set)
    .filter(([field, to]) => JSON.stringify(existing[field] ?? null) !== JSON.stringify(to ?? null))
    .map(([field, to]) => ({ field, from: existing[field] ?? null, to }));
  const update = { $set: set };
  if (password) {
    update.$set.passwordHash = await bcrypt.hash(password, 10);
    update.$inc = { authVersion: 1 }; // signs the driver out everywhere
    changes.push({ field: "password" });
  }
  if (changes.length) update.$push = { accountEvents: { type: "account_updated", at: now, changes } };
  await User.updateOne({ _id: existing._id }, update);
  return changes.length ? "updated" : "unchanged";
}
// Prints what, if anything, still keeps a driver from receiving offers.
export async function describeDriver(login) {
  const driver = await User.findOne({ login: String(login).trim().toLowerCase() }).lean();
  return { driver, problems: offerProblems(driver) };
}
if (process.argv[1]?.endsWith("/create-driver.js") || process.argv[1]?.endsWith("\\create-driver.js")) {
  try {
    await connectDatabase();
    const env = process.env;
    const result = await createDriver({
      login: env.DRIVER_LOGIN,
      password: env.DRIVER_PASSWORD,
      name: env.DRIVER_NAME,
      phone: env.DRIVER_PHONE,
      vehicleType: env.DRIVER_VEHICLE,
      ...(env.DRIVER_AREAS ? { serviceAreas: env.DRIVER_AREAS.split(",").map((area) => area.trim()) } : {}),
      ...(env.DRIVER_AVAILABLE === undefined ? {} : { available: env.DRIVER_AVAILABLE !== "false" }),
    });
    const { driver, problems } = await describeDriver(env.DRIVER_LOGIN);
    console.log(`Driver ${driver.login} ${result}: ${driver.vehicleType}, areas ${driver.serviceAreas.join("/")}, ` +
      `${driver.availableForOrders ? "available" : "not available"}.`);
    if (problems.length) console.log(`Still not receiving offers: ${problems.join(", ")}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}
