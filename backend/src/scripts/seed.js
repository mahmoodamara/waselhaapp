import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { connectDatabase, User, Order } from "../models/index.js";
import { createOrder } from "../services/orders.js";
import { supportedServiceAreas } from "../services/serviceAreas.js";
function assertDemoSeedAllowed() {
  // Demo accounts share a published password: never create them in production.
  if (process.env.NODE_ENV === "production") throw new Error("seed creates demo accounts and is disabled in production; use npm run create-admin");
  if (process.env.NODE_ENV === "staging" && process.env.ALLOW_DEMO_SEED !== "true")
    throw new Error("seed in staging requires ALLOW_DEMO_SEED=true");
}
export async function seed() {
  assertDemoSeedAllowed();
  const passwordHash = await bcrypt.hash("WaselhaDemo123!", 10);
  const users = [
    { login: "admin", role: "admin", name: "مدير واصلها" },
    {
      login: "store1",
      role: "store",
      name: "متجر النور",
      storeName: "متجر النور",
      pickupAddress: "شارع السوق 10، الطابق الأرضي",
    },
    { login: "driver1", role: "driver", name: "أحمد" },
    { login: "driver2", role: "driver", name: "ليلى" },
  ];
  for (const user of users)
    await User.updateOne(
      { login: user.login },
      { $setOnInsert: { ...user, passwordHash, active: true } },
      { upsert: true },
    );
  // Demo data only: a placeholder pickup point for the demo store, set only when
  // it has none, so demo orders can be created. Real stores are never touched.
  await User.updateOne(
    { login: "store1", "pickupLocation.lat": { $exists: false } },
    {
      $set: {
        pickupLocation: {
          address: "Demo pickup location",
          lat: 32.7459862,
          lng: 35.3398025,
          source: "pin",
          confirmedAt: new Date(),
        },
      },
    },
  );
  const store = await User.findOne({ login: "store1" }).lean();
  const samples = [
    [
      "000000000000000000000101",
      "DEMO-HAPPY",
      {
        parcelReady: true,
        parcelDescription: "صندوق ملابس",
        goodsAmountAgorot: 15000,
        deliveryFeeAgorot: 3000,
      },
    ],
    ["000000000000000000000102", "DEMO-MISSING", {}],
    ["000000000000000000000103", "DEMO-CANCEL", { deliveryFeeAgorot: 2000 }],
    [
      "000000000000000000000104",
      "DEMO-RETURN",
      {
        parcelReady: true,
        parcelDescription: "علبة أدوات",
        deliveryFeeAgorot: 2000,
      },
    ],
  ];
  for (const [fixedId, label, values] of samples) {
    if (!(await Order.exists({ _id: fixedId })))
      await createOrder(
        store,
        { customerPhone: "0500000000", serviceArea: "kafr-kanna", deliveryFeePaidBy: "customer", ...values },
        fixedId,
      );
    console.log(`${label}: ${fixedId}`);
  }
  console.log(
    "Demo accounts: admin, store1, driver1, driver2 / WaselhaDemo123! (existing data preserved)",
  );
}
// A driver receives offers only with a service area and a vehicle, and only while
// switched on. The demo drivers get them from `npm run seed`, filling in only what
// is missing so a choice already made (a switch the driver turned off) stays.
// Not part of seed(): suites seed too and set up their drivers themselves.
export async function readyDemoDrivers() {
  const demo = { driver1: "car", driver2: "motorcycle" };
  for (const [login, vehicleType] of Object.entries(demo)) {
    await User.updateOne({ login, role: "driver", $or: [{ serviceAreas: { $exists: false } }, { serviceAreas: { $size: 0 } }] },
      { $set: { serviceAreas: [...supportedServiceAreas] } });
    await User.updateOne({ login, role: "driver", vehicleType: { $exists: false } }, { $set: { vehicleType } });
    // The model defaults a new driver to "off"; only a switch nobody has touched (no timestamp) is turned on.
    await User.updateOne({ login, role: "driver", availableForOrders: { $ne: true }, availabilityUpdatedAt: { $exists: false } },
      { $set: { availableForOrders: true, availabilityUpdatedAt: new Date() } });
  }
  console.log("Demo drivers ready: driver1 (car), driver2 (motorcycle), both in every supported area.");
}
if (
  process.argv[1]?.endsWith("/seed.js") ||
  process.argv[1]?.endsWith("\\seed.js")
) {
  try {
    assertDemoSeedAllowed();
    await connectDatabase();
    await seed();
    await readyDemoDrivers();
  } finally {
    await mongoose.disconnect();
  }
}
