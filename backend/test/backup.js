// P1-07: a real backup restored into a fresh database keeps orders, money, events,
// deadlines and the unique indexes. Needs SECURITY_TEST_URI (a *_test database).
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { create, request, sessions, models, pickedUp, tokenOf, confirmLocation, router } from "./helpers/security.js";
import { backupDatabase, restoreDatabase, verifyRestore } from "../src/scripts/backup.js";

test("backup restores into a new database with identical data and the unique indexes", async () => {
  router.reset(); router.distance = 1500;
  const delivered = await create({ goodsAmountAgorot: 15000 });
  await confirmLocation(tokenOf(delivered)); await pickedUp(delivered);
  await request(`/orders/${delivered._id}/arrive-customer`, sessions.driver1.token, "POST", {});
  const raw = await models.Order.findById(delivered._id).lean();
  await request(`/orders/${delivered._id}/deliver`, sessions.driver1.token, "POST", { code: raw.deliveryCode,
    actualCashCollectedAgorot: 17500, observedExpectedAgorot: 18000, confirmDifference: true });
  const searching = await create();
  const deadline = new Date(Date.now() + 1000);
  await models.Order.updateOne({ _id: searching._id }, { $set: { searchDeadlineAt: deadline } });
  const folder = join(await mkdtemp(join(tmpdir(), "waselha-backup-")), "dump");
  const targetUri = new URL(process.env.SECURITY_TEST_URI);
  targetUri.pathname += "_restore";
  const target = await mongoose.createConnection(targetUri.href).asPromise();
  try {
    await target.dropDatabase();
    const manifest = await backupDatabase(mongoose.connection.db, folder);
    const summary = await restoreDatabase(target.db, folder);
    assert.equal(summary.collections.orders, 2);
    const original = await models.Order.find().sort({ _id: 1 }).lean();
    const restored = await target.db.collection("orders").find().sort({ _id: 1 }).toArray();
    assert.deepEqual(JSON.parse(JSON.stringify(restored)), JSON.parse(JSON.stringify(original)));
    const money = restored.find((o) => String(o._id) === delivered._id);
    assert.equal(money.actualCashCollectedAgorot, 17500);
    assert.equal(money.collectionAdjustment.status, "open");
    assert.ok(money.financialSnapshot.capturedAt instanceof Date);
    const live = restored.find((o) => String(o._id) === searching._id);
    assert.equal(live.searchDeadlineAt.getTime(), (await models.Order.findById(searching._id).lean()).searchDeadlineAt.getTime());
    // Boot the real server on the restored database: readiness, financial
    // access and worker recovery must work without renewing stored deadlines.
    const probe = createServer();
    await new Promise(r => probe.listen(0, "127.0.0.1", r));
    const port = probe.address().port;
    await new Promise(r => probe.close(r));
    const server = spawn(process.execPath, [fileURLToPath(new URL("../src/server.js", import.meta.url))], {
      env: { ...process.env, MONGODB_URI: targetUri.href, PORT: String(port), HOST: "127.0.0.1",
        ORDER_TIMEOUT_SWEEP_INTERVAL_MS: "100", GOOGLE_ROUTES_ENABLED: "false" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = ""; server.stdout.on("data", b => { logs += b; }); server.stderr.on("data", b => { logs += b; });
    try {
      let ready, expired;
      for (let i = 0; i < 100; i++) {
        assert.equal(server.exitCode, null, logs);
        try {
          ready = await fetch(`http://127.0.0.1:${port}/api/ready`).then(r => r.json());
          expired = await target.db.collection("orders").findOne({ _id: live._id });
          if (ready.ok && expired.driverSearchStatus === "no_driver") break;
        } catch {}
        await new Promise(r => setTimeout(r, 100));
      }
      assert.equal(ready?.ok, true, logs);
      assert.equal(expired.driverSearchStatus, "no_driver");
      assert.equal(expired.searchDeadlineAt.getTime(), deadline.getTime());
      assert.equal(expired.events.filter(e => e.type === "driver_search_timed_out").length, 1);
      const response = await fetch(`http://127.0.0.1:${port}/api/orders/${delivered._id}`, {
        headers: { Authorization: `Bearer ${sessions.admin.token}` },
      });
      assert.equal(response.status, 200);
      const order = await response.json();
      assert.equal(order.actualCashCollectedAgorot, 17500);
      assert.equal(order.collectionAdjustment.status, "open");
      assert.deepEqual(order.financialSnapshot, JSON.parse(JSON.stringify(money.financialSnapshot)));
    } finally {
      if (server.exitCode === null) { const exited = once(server, "exit"); server.kill(); await exited; }
    }
    const indexes = (await target.db.collection("orders").indexes()).map((i) => i.name);
    assert.ok(indexes.includes("one_active_order_per_driver"));
    // The restored unique index still stops a second active order for one driver.
    const driverId = new mongoose.Types.ObjectId();
    await target.db.collection("orders").updateOne({ _id: live._id }, { $set: { activeAssignment: true, driverId } });
    await assert.rejects(target.db.collection("orders").updateOne({ _id: money._id }, { $set: { activeAssignment: true, driverId } }), /E11000/);
    await target.db.collection("orders").dropIndex("one_active_order_per_driver");
    await target.db.collection("orders").createIndex({ driverId: 1 }, { name: "one_active_order_per_driver" });
    await assert.rejects(verifyRestore(target.db, manifest), /index.*definition/i);
    await assert.rejects(restoreDatabase(target.db, folder), /not empty/);
  } finally {
    await target.dropDatabase();
    await target.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test("restore preserves empty collections and verifies index definitions, not only their names", async () => {
  const folder = join(await mkdtemp(join(tmpdir(), "waselha-empty-backup-")), "dump");
  const source = mongoose.connection.useDb(`${mongoose.connection.db.databaseName}_empty_source_test`).db;
  const target = mongoose.connection.useDb(`${mongoose.connection.db.databaseName}_empty_target_test`).db;
  try {
    await source.dropDatabase(); await target.dropDatabase();
    await source.createCollection("empty");
    await source.createCollection("indexed");
    await source.collection("indexed").createIndex({ driverId: 1 }, {
      name: "one_active_order_per_driver", unique: true, partialFilterExpression: { activeAssignment: true },
    });
    const manifest = await backupDatabase(source, folder);
    await restoreDatabase(target, folder);
    assert.ok((await target.listCollections().toArray()).some(c => c.name === "empty"));
    await target.collection("indexed").dropIndex("one_active_order_per_driver");
    await target.collection("indexed").createIndex({ driverId: 1 }, { name: "one_active_order_per_driver" });
    await assert.rejects(verifyRestore(target, manifest), /index.*definition/i);
  } finally {
    await source.dropDatabase(); await target.dropDatabase();
    await rm(folder, { recursive: true, force: true });
  }
});
