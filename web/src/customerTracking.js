import { TRACKING } from "../../shared/realtimeContract.js";

// A pure display policy: use server age at receipt + elapsed local time. A
// customer's wall clock never makes an old coordinate look fresh.
export function trackingDisplay(snapshot, connected, elapsedMs = 0) {
  if (!snapshot) return { state: "unavailable", location: null, ageSeconds: null };
  if (!TRACKING.allowedStatuses.includes(snapshot.status) || snapshot.state === "ended")
    return { state: snapshot.state === "ended" ? "ended" : "not_started", location: null, ageSeconds: null };
  const location = snapshot.location;
  if (!location) return { state: "unavailable", location: null, ageSeconds: null };
  const age = Math.max(0, snapshot.serverTime - location.measuredAt, snapshot.serverTime - location.receivedAt) + Math.max(0, elapsedMs);
  return { state: connected && location.fresh && age <= snapshot.freshForMs ? "live" : "stale",
    location, ageSeconds: Math.floor(age / 1000) };
}

export function createCustomerTracker({ token, api, createSocket, onSnapshot, onOrderChanged,
  onConnection, onError, lifecycle = globalThis, schedule = setTimeout, cancel = clearTimeout }) {
  let disposed = false, authenticating = false, refreshOrder = true;
  let retryTimer, retries = 0;
  const retry = () => {
    if (disposed || retryTimer || retries >= 5) return;
    retryTimer = schedule(() => { retryTimer = null; if (!disposed) socket.connect(); }, Math.min(15000, 2000 * 2 ** retries++));
  };
  const socket = createSocket(TRACKING.namespace, { autoConnect: false, forceNew: true,
    reconnection: true, reconnectionAttempts: 5, reconnectionDelay: 2000, reconnectionDelayMax: 15000,
    auth: async callback => {
      if (disposed || authenticating) return;
      authenticating = true;
      try {
        const { credential } = await api(`/customer/${token}/tracking-credential`, { method: "POST", body: {} });
        if (!disposed) callback({ credential });
      } catch (error) {
        if (!disposed) {
          if (error.code === "not_found") onSnapshot({ state: "ended", status: "unavailable", location: null });
          onError(error.code === "not_found" ? "trackingAccessExpired" : "trackingReconnect"); socket.disconnect();
          if (error.code !== "not_found" && error.code !== "rate_limited") retry();
        }
      } finally { authenticating = false; }
    } });
  const handlers = {
    connect: () => { if (!disposed) { refreshOrder = true; retries = 0; cancel(retryTimer); retryTimer = null; onConnection(false); } },
    disconnect: () => { if (!disposed) onConnection(false); },
    connect_error: error => { if (!disposed) {
      if (error.data?.code === "unauthorized") onSnapshot({ state: "ended", status: "unavailable", location: null });
      onConnection(false); onError(error.data?.code === "unauthorized" ? "trackingAccessExpired" : "trackingReconnect");
      if (error.data?.code === "realtime_unavailable") retry();
    } },
    [TRACKING.snapshot]: snapshot => { if (!disposed) {
      onSnapshot(snapshot); onConnection(true);
      if (refreshOrder) { refreshOrder = false; onOrderChanged(snapshot); }
    } },
    [TRACKING.location]: snapshot => { if (!disposed) { onSnapshot(snapshot); onConnection(true); } },
    [TRACKING.orderChanged]: value => { if (!disposed) onOrderChanged(value); },
    [TRACKING.ended]: value => {
      if (disposed) return;
      onSnapshot({ ...value, state: "ended", location: null, serverTime: Date.now() });
      onOrderChanged(value);
    },
    [TRACKING.error]: value => {
      if (disposed) return;
      onConnection(false);
      if (value.code === "credential_expired") {
        // Wait for the server disconnect event, then exchange the existing link
        // again. A revoked/expired link fails closed in the auth callback.
        socket.once("disconnect", () => { if (!disposed) socket.connect(); });
      } else {
        onError(value.code === "unauthorized" ? "trackingAccessExpired" : "trackingReconnect");
        if (value.code === "realtime_unavailable") retry();
      }
    },
  };
  for (const [name, listener] of Object.entries(handlers)) socket.on(name, listener);
  const resume = () => {
    if (disposed || lifecycle.document?.visibilityState === "hidden") return;
    if (socket.connected) { refreshOrder = true; socket.emit(TRACKING.resync); }
    else { onError(null); socket.connect(); }
  };
  lifecycle.document?.addEventListener("visibilitychange", resume);
  lifecycle.addEventListener?.("online", resume);
  socket.connect();
  return { refresh: resume, stop() {
    disposed = true;
    cancel(retryTimer);
    lifecycle.document?.removeEventListener("visibilitychange", resume);
    lifecycle.removeEventListener?.("online", resume);
    socket.removeAllListeners(); socket.disconnect();
  } };
}
