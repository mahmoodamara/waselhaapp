import { Order } from "../models/index.js";
import { config } from "../config.js";
import { searchableFilter } from "../services/orderTimeouts.js";
import { selectNearbyDrivers, offerDto, eligibilitySnapshot } from "../services/nearbyOffers.js";
import { onOrdersChanged } from "../services/orderSignals.js";
import { log } from "../services/log.js";
import { REALTIME } from "../../../shared/realtimeContract.js";
import { createPushNotifier } from "../services/push.js";

export const driverRoom = id => `driver:${id}`;

// Single-instance pilot, serialized and coalesced invalidations. Memory stores
// only delivered DTO signatures, never reservations or assignment authority.
export function createOfferDispatcher(io, store, settings = config, notifier = createPushNotifier(settings)) {
  let delivered = new Map(), assignments = new Map(), selectionStats = new Map(), running, dirty = false, stopped = false;
  // orderId -> driverId -> push state: one delivered push per driver per order, never repeated on updates.
  // A push that reached nobody (no device yet, push service down) is retried a few times, never in parallel.
  const pushed = new Map();
  const MAX_PUSH_ATTEMPTS = 3;
  const emit = (id, event, payload) => io.to(`${driverRoom(id)}${payload.workflowVersion === 3 ? ":v3" : ""}`).emit(event, payload);
  async function reconcile() {
    const next = new Map(), nextStats = new Map(), nextPush = new Map();
    const snapshot = await eligibilitySnapshot();
    for await (const order of Order.find(searchableFilter(null)).lean().cursor({ batchSize: 100 })) {
      const { candidates, wakeCandidates, stats } = await selectNearbyDrivers(order, store, settings, { includeLastKnown: notifier.enabled, snapshot });
      const recipients = new Map(), pushRecipients = new Map();
      let socketUnavailableCount = 0;
      for (const candidate of candidates) {
        const presence = await store.getDriverPresence(candidate.driverId);
        const latest = await store.getLatestDriverLocation(candidate.driverId);
        if (!presence.connected || !io.sockets.adapter.rooms.get(`${driverRoom(candidate.driverId)}${order.workflowVersion === 3 ? ":v3" : ""}`)?.size) {
          socketUnavailableCount++;
          // No live connection (app closed or in the background) but a fresh position: the phone's push channel.
          if (latest.fresh) pushRecipients.set(candidate.driverId, offerDto(order, candidate.distance));
          continue;
        }
        if (!latest.fresh) continue;
        recipients.set(candidate.driverId, offerDto(order, candidate.distance));
      }
      // A closed app reports no fresh position: wake it by push from its last known one, unless it is connected.
      for (const candidate of wakeCandidates) {
        const presence = await store.getDriverPresence(candidate.driverId);
        if (!presence.connected || !io.sockets.adapter.rooms.get(`${driverRoom(candidate.driverId)}${order.workflowVersion === 3 ? ":v3" : ""}`)?.size)
          pushRecipients.set(candidate.driverId, offerDto(order, candidate.distance));
      }
      // Never resurrect a committed accept/cancel while GEO calls were pending.
      if (await Order.exists({ _id: order._id, ...searchableFilter(null) })) {
        next.set(String(order._id), recipients);
        if (notifier.enabled) nextPush.set(String(order._id), pushRecipients);
      }
      const counts = { ...stats, selectedCount: candidates.length, socketUnavailableCount, ...(notifier.enabled ? { wakeCount: wakeCandidates.length } : {}) };
      nextStats.set(String(order._id), JSON.stringify(counts));
      if (selectionStats.get(String(order._id)) !== JSON.stringify(counts))
        log("info", "offer_candidates_selected", { orderId: String(order._id), ...counts });
    }
    // Notify each driver once per order; orders that left the search are forgotten.
    for (const orderId of pushed.keys()) if (!nextPush.has(orderId)) pushed.delete(orderId);
    for (const [orderId, recipients] of nextPush) {
      const done = pushed.get(orderId) ?? new Map();
      for (const [driverId, dto] of recipients) {
        const oldState = done.get(driverId);
        const state = oldState && oldState.version === dto.dispatchVersion ? oldState : { attempts: 0, busy: false, sent: false, version: dto.dispatchVersion };
        if (state.sent || state.busy || state.attempts >= MAX_PUSH_ATTEMPTS) continue;
        state.busy = true; state.attempts++; done.set(driverId, state);
        void notifier.offer(driverId, dto).then(count => { state.sent = count > 0; }, () => {}).finally(() => { state.busy = false; });
      }
      pushed.set(orderId, done);
    }
    for (const [orderId, previous] of delivered) {
      for (const driverId of previous.keys()) if (!next.get(orderId)?.has(driverId)) {
        emit(driverId, REALTIME.offerRemoved, { orderId });
        log("info", "offer_removed", { orderId, driverId });
      }
    }
    for (const [orderId, recipients] of next) for (const [driverId, dto] of recipients) {
      const old = delivered.get(orderId)?.get(driverId);
      if (!old || JSON.stringify(old) !== JSON.stringify(dto)) {
        emit(driverId, old ? REALTIME.offerUpdated : REALTIME.offerCreated, dto);
        log("info", "offer_emitted", { orderId, driverId, offerEvent: old ? "updated" : "created" });
      }
    }
    delivered = next;
    selectionStats = nextStats;
    const current = new Map();
    for await (const order of Order.find({ activeAssignment: true }).select("_id driverId updatedAt status").lean().cursor({ batchSize: 100 }))
      current.set(String(order.driverId), { orderId: String(order._id), revision: String(order.updatedAt), status: order.status });
    for (const driverId of new Set([...current.keys(), ...assignments.keys()])) {
      if (JSON.stringify(current.get(driverId)) !== JSON.stringify(assignments.get(driverId)))
        emit(driverId, REALTIME.orderChanged, { orderId: (current.get(driverId) ?? assignments.get(driverId)).orderId });
    }
    assignments = current;
  }
  function refresh() {
    if (stopped) return Promise.resolve();
    dirty = true;
    if (!running) running = (async () => {
      while (dirty && !stopped) { dirty = false; await reconcile(); }
    })().catch(() => {
      // Preserve last delivered map on outage; REST fails closed and periodic
      // resync retries. A committed Mongo command never fails on Socket failure.
      log("error", "offers_reconcile_failed", { code: "realtime_unavailable" });
    }).finally(() => { running = undefined; });
    return running;
  }
  notifier.start?.();
  const unsubscribe = onOrdersChanged(() => { void refresh(); });
  const timer = setInterval(() => { void refresh(); }, settings.offerReconcileIntervalMs);
  timer.unref();
  return { refresh, async close() { stopped = true; clearInterval(timer); unsubscribe(); notifier.close?.(); await running; delivered.clear(); assignments.clear(); selectionStats.clear(); pushed.clear(); } };
}
