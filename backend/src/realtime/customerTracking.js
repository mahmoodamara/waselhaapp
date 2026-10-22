import { Order } from "../models/index.js";
import { TRACKING } from "../../../shared/realtimeContract.js";
import { verifyTrackingCredential, trackingOrder, discloseTracking, trackingAllowed,
  trackingRoom, customerOrderRoom } from "../services/customerTracking.js";
import { onDriverLocationAccepted } from "../services/locationSignals.js";
import { onOrdersChanged } from "../services/orderSignals.js";
import { socketError } from "./auth.js";
import { log } from "../services/log.js";
import { publicOrderReference } from "../services/publicOrderReference.js";

export function createCustomerTracking(io, store) {
  const namespace = io.of(TRACKING.namespace), viewers = new Map(), hits = new Map();
  let stopped = false, refreshing, dirty = false;
  const jobs = new Set();
  const run = work => {
    const job = work().catch(() => log("error", "customer_tracking_failed", { code: "realtime_unavailable" }));
    jobs.add(job); void job.finally(() => jobs.delete(job)); return job;
  };
  function take(ip) {
    const now = Date.now();
    // Bounded memory even when many unauthenticated addresses attempt joins.
    for (const [key, bucket] of hits) if (bucket.until <= now) hits.delete(key);
    if (!hits.has(ip) && hits.size >= 10000) return false;
    const bucket = hits.get(ip) ?? { count: 0, until: now + 60000 };
    hits.set(ip, bucket); return ++bucket.count <= 30;
  }
  namespace.use(async (socket, next) => {
    try {
      // Transport address only: never trust a caller's X-Forwarded-For here.
      if (!take(socket.handshake.address)) return next(socketError("rate_limited"));
      const auth = socket.handshake.auth;
      if (!auth || Object.keys(auth).length !== 1 || !Object.hasOwn(auth, "credential")) throw Object.assign(new Error(), { code: "unauthorized" });
      const claims = verifyTrackingCredential(auth.credential);
      await trackingOrder(claims);
      socket.data.tracking = claims;
      delete socket.handshake.auth.credential;
      next();
    } catch (error) { next(socketError(error.code === "unauthorized" ? "unauthorized" : "realtime_unavailable")); }
  });
  function end(socket, code) {
    if (!socket.connected) return;
    socket.emit(TRACKING.ended, { orderId: publicOrderReference({ _id: socket.data.tracking.orderId }), status: "unavailable" });
    socket.emit(TRACKING.error, { code }); socket.disconnect(true);
  }
  async function reconcile(socket, mode) {
    if (stopped || !socket.connected) return;
    try {
      await discloseTracking(socket.data.tracking, store, async (snapshot, order) => {
        if (stopped || !socket.connected) return;
        const state = viewers.get(socket.id);
        if (!state) return;
        if (trackingAllowed(order)) await socket.join(trackingRoom(order._id));
        else await socket.leave(trackingRoom(order._id));
        if (!socket.connected) return;
        const revision = `${order.status}:${order.updatedAt?.getTime() ?? 0}`;
        if (mode === "snapshot") socket.emit(TRACKING.snapshot, snapshot);
        else if (mode === "location") {
          if (trackingAllowed(order)) socket.emit(TRACKING.location, snapshot);
          else if (state.allowed) socket.emit(TRACKING.ended, { orderId: snapshot.orderId, status: snapshot.status });
        } else {
          if (state.revision !== revision) socket.emit(TRACKING.orderChanged, { orderId: snapshot.orderId, status: snapshot.status });
          if (state.allowed && !trackingAllowed(order)) socket.emit(TRACKING.ended, { orderId: snapshot.orderId, status: snapshot.status });
          socket.emit(TRACKING.snapshot, snapshot);
        }
        state.allowed = trackingAllowed(order);
        state.revision = revision;
      });
    } catch (error) { end(socket, error.code === "unauthorized" ? "unauthorized" : "realtime_unavailable"); }
  }
  namespace.on("connection", socket => {
    const claims = socket.data.tracking;
    viewers.set(socket.id, { allowed: false });
    const expiry = setTimeout(() => end(socket, "credential_expired"), Math.max(0, claims.expiresAt - Date.now()));
    socket.on("disconnect", () => { clearTimeout(expiry); viewers.delete(socket.id); });
    let pending = false, lastResync = 0;
    socket.on(TRACKING.resync, () => {
      if (pending || Date.now() - lastResync < 10000 || !take(socket.handshake.address)) return;
      pending = true; lastResync = Date.now();
      void run(async () => { try { await reconcile(socket, "snapshot"); } finally { pending = false; } });
    });
    void run(async () => {
      await socket.join(customerOrderRoom(claims.orderId));
      await reconcile(socket, "snapshot");
    });
  });
  function refresh() {
    if (stopped) return Promise.resolve();
    dirty = true;
    if (!refreshing) refreshing = run(async () => {
      while (dirty && !stopped) {
        dirty = false;
        await Promise.all([...namespace.sockets.values()].map(socket => reconcile(socket, "order")));
      }
    }).finally(() => { refreshing = undefined; });
    return refreshing;
  }
  const unsubscribeOrders = onOrdersChanged(() => { void refresh(); });
  const unsubscribeLocation = onDriverLocationAccepted(store, driverId => run(async () => {
    if (stopped) return;
    // Assignment comes from MongoDB, never from the GPS packet or customer.
    const order = await Order.findOne({ driverId, activeAssignment: true, status: { $in: TRACKING.allowedStatuses } }).select("_id").lean();
    if (!order) return;
    const ids = namespace.adapter.rooms.get(trackingRoom(order._id));
    if (!ids) return;
    await Promise.all([...ids].map(id => {
      const socket = namespace.sockets.get(id);
      return socket ? reconcile(socket, "location") : undefined;
    }));
  }));
  // Reconcile revocation even without GPS; lifecycle transitions use the signal
  // above immediately. This is server recovery, not client GPS polling.
  const timer = setInterval(() => { void refresh(); }, 10000); timer.unref();
  return { namespace, refresh, async close() {
    stopped = true; clearInterval(timer); unsubscribeOrders(); unsubscribeLocation();
    namespace.disconnectSockets(true); await Promise.allSettled([...jobs]); viewers.clear(); hits.clear();
  } };
}
