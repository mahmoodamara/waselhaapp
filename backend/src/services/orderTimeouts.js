import { Order } from "../models/index.js";
import { config } from "../config.js";
import { fail, string } from "./validation.js";
import { parseServiceArea } from "./serviceAreas.js";
import { log } from "./log.js";
import { ordersChanged } from "./orderSignals.js";
import { isGated, readyFilter, pausedSearch } from "./dispatchGate.js";

export const withdrawalReasons = ["details_changed", "order_incomplete", "cannot_complete", "other"];
// What a driver can report from the trip screen without giving the order up.
export const issueReasons = ["store_not_ready"];
export function searchWindow(now = new Date()) {
  return { driverSearchStatus: "searching", searchStartedAt: now,
    searchDeadlineAt: new Date(now.getTime() + config.driverSearchTimeoutMs) };
}
export function operationalEvent(type, at, actor, extra = {}) {
  return { type, at, actorType: actor?.role || "system", ...(actor ? { actorId: actor._id } : {}), ...extra };
}
export function searchableFilter(driverId, now = new Date()) {
  return { status: "searching_driver", activeAssignment: false, collectedAt: null,
    driverSearchStatus: "searching", searchDeadlineAt: { $gt: now },
    excludedDriverIds: { $ne: driverId } };
}
const unassignedSearch = { status: "searching_driver", activeAssignment: false, collectedAt: null };
const commandEventTypes = ["driver_search_retried", "customer_link_reissued"];
// commandIds is only a bounded cache; immutable events remember older IDs,
// including those already evicted by previous application versions.
export const hasOrderCommand = (order, requestId) => order?.commandIds?.includes(requestId) ||
  order?.events?.some(e => commandEventTypes.includes(e.type) && e.requestId === requestId);
export const unusedOrderCommand = (requestId) => ({ $not: { $elemMatch: { type: { $in: commandEventTypes }, requestId } } });
// `requestId` identifies the user's click. A replay of the same command (lost
// response, or a stale retry arriving after a later search cycle ended) returns
// the current order and never opens another search window.
export async function retrySearch(order, actor, body = {}, now = new Date()) {
  const requestId = string(body.requestId, true, 120);
  if (hasOrderCommand(order, requestId)) return order;
  const serviceArea = parseServiceArea(order.serviceArea);
  const result = await Order.findOneAndUpdate(
    { _id: order._id, ...unassignedSearch, driverSearchStatus: "no_driver", ...(isGated(order) ? readyFilter() : {}),
      serviceArea, commandIds: { $ne: requestId }, events: unusedOrderCommand(requestId),
      ...(actor.role === "store" ? { storeId: actor._id } : {}) },
    { $set: searchWindow(now), ...(order.workflowVersion === 3 ? { $inc: { dispatchVersion: 1 } } : {}),
      $push: { commandIds: { $each: [requestId], $slice: -50 },
      events: operationalEvent("driver_search_retried", now, actor, { requestId }) } },
    { new: true, runValidators: true },
  ).lean();
  if (result) { ordersChanged(); return result; }
  const current = await Order.findById(order._id).lean();
  if (hasOrderCommand(current, requestId)) return current;
  fail("state_conflict", 409);
}
export async function cancelSearch(order, actor, now = new Date(), body = {}) {
  const reason = body.reason === undefined ? "store_cancelled" : string(body.reason, true, 300);
  const result = await Order.findOneAndUpdate(
    { _id: order._id, ...unassignedSearch, driverSearchStatus: { $in: ["waiting", "searching", "no_driver"] },
      ...(actor.role === "store" ? { storeId: actor._id } : {}) },
    { $set: { status: "cancelled", activeAssignment: false, driverSearchStatus: null,
      cancelledAt: now, cancellationReason: reason },
      $push: { events: operationalEvent("store_cancelled", now, actor, reason === "store_cancelled" ? {} : { note: reason }) } },
    { new: true, runValidators: true },
  ).lean();
  if (!result) fail("state_conflict", 409);
  ordersChanged();
  return result;
}
// A gated order goes back to the search only while it is still ready (the store
// may have changed the goods since the accept); otherwise it waits for the
// customer. Each attempt is one CAS, so a lost race never releases twice.
export async function releaseAssignment(order, filter, event, now) {
  const attempts = isGated(order) ? [[readyFilter(), searchWindow(now)], [{}, pausedSearch()]] : [[{}, searchWindow(now)]];
  for (const [ready, search] of attempts) {
    const result = await Order.findOneAndUpdate(
      { _id: order._id, driverId: order.driverId, acceptedAt: order.acceptedAt ?? null,
        activeAssignment: true, collectedAt: null, ...filter, ...ready },
      { $set: { activeAssignment: false, status: "searching_driver", driverConfirmed: false, ...search },
        ...(order.workflowVersion === 3 ? { $inc: { dispatchVersion: 1 }, $unset: { driverAgreement: "" } } : {}),
        $addToSet: { excludedDriverIds: order.driverId }, $push: { events: event } },
      { new: true, runValidators: true },
    ).lean();
    if (result) { ordersChanged(); return result; }
  }
  return null;
}
export async function withdrawDriver(order, actor, body, now = new Date()) {
  if (!withdrawalReasons.includes(body.reason)) fail("withdrawal_reason_required");
  const note = body.note === undefined ? "" : string(body.note, false, 300);
  if (note && body.reason !== "other") fail("invalid_input");
  const result = await releaseAssignment(order,
    { driverId: actor._id, status: { $in: ["driver_assigned", "driver_at_store"] } },
    operationalEvent("driver_withdrawn", now, actor, { driverId: actor._id, reason: body.reason, note }), now);
  if (!result) fail("state_conflict", 409);
  return result;
}
// "The store is not ready": the store sees it in the order history and the driver keeps the order.
// Reporting twice for the same assignment is a no-op, never a second event.
export async function reportDriverIssue(order, actor, body, now = new Date()) {
  if (!issueReasons.includes(body?.reason) || Object.keys(body).some(key => key !== "reason")) fail("invalid_input");
  const mine = { driverId: actor._id, activeAssignment: true, collectedAt: null, status: { $in: ["driver_assigned", "driver_at_store"] } };
  const since = order.acceptedAt ?? new Date(0);
  const result = await Order.findOneAndUpdate(
    { _id: order._id, ...mine, events: { $not: { $elemMatch: { type: "driver_issue_reported", reason: body.reason, driverId: actor._id, at: { $gte: since } } } } },
    { $push: { events: operationalEvent("driver_issue_reported", now, actor, { driverId: actor._id, reason: body.reason }) } },
    { new: true, runValidators: true },
  ).lean();
  if (result) { ordersChanged(); return result; }
  const unchanged = await Order.findOne({ _id: order._id, ...mine }).lean();
  if (!unchanged) fail("state_conflict", 409);
  return unchanged;
}
export async function processExpiredSearches(now = new Date()) {
  const result = await Order.updateMany(
    { ...unassignedSearch, driverSearchStatus: "searching", searchDeadlineAt: { $lte: now } },
    { $set: { driverSearchStatus: "no_driver" },
      $push: { events: operationalEvent("driver_search_timed_out", now) } },
  );
  if (result.modifiedCount) ordersChanged();
  return result.modifiedCount;
}
export async function processExpiredAssignments(now = new Date()) {
  const filter = { status: "driver_assigned", activeAssignment: true, driverId: { $ne: null },
    collectedAt: null, arrivedStoreAt: null, storeArrivalDeadlineAt: { $lte: now } };
  let released = 0;
  // Only expired assignments, streamed in small batches; never load all orders.
  for await (const order of Order.find(filter).select("_id driverId acceptedAt storeArrivalDeadlineAt customerAvailable workflowVersion").lean().cursor({ batchSize: 100 })) {
    const result = await releaseAssignment(order, { ...filter, driverId: order.driverId,
      storeArrivalDeadlineAt: order.storeArrivalDeadlineAt },
      operationalEvent("driver_assignment_timed_out", now, null, { driverId: order.driverId }), now);
    if (result) released++;
  }
  return released;
}
// Expand/migrate: missing deadlines are derived from existing UTC evidence,
// never renewed on restart. CAS makes this resumable and safe across instances.
async function migrateDeadline(filter, changes) {
  for (let attempt = 0; ; attempt++) {
    try { return await Order.updateOne(filter, { $set: changes }); }
    catch (error) {
      const transient = error.hasErrorLabel?.("RetryableWriteError") || error.code === 112 ||
        ["MongoNetworkError", "MongoServerSelectionError"].includes(error.name);
      if (!transient || attempt === 2) throw error;
    }
  }
}
export async function initializeLegacyDeadlines() {
  let migrated = 0;
  const filter = { $or: [
    // A gated order waiting for its customer has no deadline on purpose.
    { ...unassignedSearch, searchDeadlineAt: { $exists: false }, driverSearchStatus: { $ne: "waiting" } },
    { status: "driver_assigned", activeAssignment: true, storeArrivalDeadlineAt: { $exists: false } },
  ] };
  for await (const order of Order.find(filter).lean().cursor({ batchSize: 100 })) {
    const searching = order.status === "searching_driver";
    const start = searching ? order.searchStartedAt || order.createdAt : order.acceptedAt || order.updatedAt || order.createdAt;
    const missingField = searching ? "searchDeadlineAt" : "storeArrivalDeadlineAt";
    const result = await migrateDeadline({ _id: order._id, status: order.status,
      activeAssignment: order.activeAssignment, driverId: order.driverId,
      updatedAt: order.updatedAt, [missingField]: { $exists: false } },
    searching ? searchWindow(start) : { acceptedAt: start,
      storeArrivalDeadlineAt: new Date(start.getTime() + config.driverArrivalTimeoutMs), driverSearchStatus: null });
    migrated += result.modifiedCount;
  }
  return migrated;
}
export async function runTimeoutSweep(now = new Date()) {
  const result = { searches: await processExpiredSearches(now), assignments: await processExpiredAssignments(now) };
  // Orders that could not be priced while the routing service was unavailable. A failure here
  // must not stop the timeout work above from being reported as done.
  const { retryPendingRoutePrices, startReadyDispatches } = await import("./orders.js");
  result.prices = await retryPendingRoutePrices({ now }).catch((error) => {
    log("error", "route_price_retry_failed", { error: error.message });
    return 0;
  });
  // Safety net: a ready order whose start signal was lost still reaches drivers.
  result.dispatches = await startReadyDispatches({ now }).catch((error) => {
    log("error", "dispatch_start_failed", { error: error.message });
    return 0;
  });
  return result;
}
// Read by /api/ready: a worker that stopped sweeping is an outage, not a quiet system.
export const sweepStatus = { startedAt: null, lastSuccessAt: null, lastErrorAt: null, lastError: null, lastResult: null };
let timer, running;
export function startOrderTimeoutWorker() {
  if (timer) return;
  sweepStatus.startedAt = new Date();
  const tick = () => {
    if (running) return;
    running = runTimeoutSweep()
      .then((result) => { Object.assign(sweepStatus, { lastSuccessAt: new Date(), lastResult: result }); })
      .catch((error) => {
        Object.assign(sweepStatus, { lastErrorAt: new Date(), lastError: error.message });
        log("error", "order_timeout_sweep_failed", { error: error.message });
      })
      .finally(() => { running = undefined; });
  };
  timer = setInterval(tick, config.orderTimeoutSweepIntervalMs);
  timer.unref();
  tick();
}
export async function stopOrderTimeoutWorker() {
  clearInterval(timer);
  timer = undefined;
  await running;
}
