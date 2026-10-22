import { Server } from "socket.io";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { log } from "../services/log.js";
import { authenticateDriver, socketError } from "./auth.js";
import { locationIngest } from "../services/locationIngest.js";
import { REALTIME } from "../../../shared/realtimeContract.js";
import { createOfferDispatcher, driverRoom } from "./offers.js";
import { createCustomerTracking } from "./customerTracking.js";

export function attachRealtime(server, store, settings = config, notifier = undefined) {
  const allowedOrigins = new Set([settings.publicBaseUrl, ...(settings.realtimeAllowedOrigins ?? [])]);
  const io = new Server(server, {
    maxHttpBufferSize: REALTIME.maxPayloadBytes, serveClient: false,
    // Android React Native adds the HTTP(S) API Origin to WebSocket upgrades.
    // Explicit deployment/LAN aliases are allowed; Origin never replaces JWT.
    cors: { origin: [...allowedOrigins], methods: ["GET", "POST"] },
    allowRequest: (req, next) => next(null, !req.headers.origin || allowedOrigins.has(req.headers.origin)),
  });
  const active = new Map(), activationQueues = new Map(), releases = new Set();
  const ingest = locationIngest(store);
  const offers = createOfferDispatcher(io, store, { ...config, ...settings }, notifier);
  const tracking = createCustomerTracking(io, store);
  io.use(async (socket, next) => {
    try {
      socket.data.auth = await authenticateDriver(socket.handshake.auth?.token);
      next();
    } catch (error) { next(socketError(error.code === "forbidden" ? "forbidden" : "unauthenticated")); }
  });
  io.on("connection", socket => {
    const id = String(socket.data.auth.user._id), sessionId = randomUUID();
    const token = socket.handshake.auth.token;
    // Do not retain the handshake's credentials in diagnostic state.
    delete socket.handshake.auth.token;
    let ready = false, pending = false, renewing = false, heartbeat;
    const terminate = code => {
      socket.emit(REALTIME.error, { code });
      socket.disconnect(true);
    };
    const expiry = setTimeout(() => terminate("unauthenticated"),
      Math.max(0, socket.data.auth.expiresAt - Date.now()));
    socket.on("disconnect", () => {
      ready = false;
      clearTimeout(expiry); clearInterval(heartbeat);
      if (active.get(id) === socket) active.delete(id);
      const cleanup = store.releaseSession(id, sessionId).catch(() => {});
      releases.add(cleanup);
      void cleanup.finally(() => releases.delete(cleanup));
    });
    socket.on(REALTIME.location, async (payload, ack) => {
      const reply = value => {
        // Rejections otherwise vanish: log only the code and clock offset, never coordinates.
        if (value?.ok === false) log("warn", "driver_location_rejected", { driverId: id, code: value.code,
          clockSkewMs: Number.isFinite(payload?.measuredAt) ? Date.now() - payload.measuredAt : null,
          accuracy: Number.isFinite(payload?.accuracy) ? payload.accuracy : null });
        if (typeof ack === "function") ack(value);
      };
      if (!ready || !socket.connected) return reply({ ok: false, code: "stale_session" });
      if (!ingest.take(id) || pending) return reply({ ok: false, code: "rate_limited" });
      pending = true;
      try {
        const result = await ingest({ payload, sessionId, authenticate: () => authenticateDriver(token),
          source: "socket", stillCurrent: () => ready && socket.connected });
        if (result.ok) void offers.refresh();
        const code = result.code === "session_expired" ? "realtime_unavailable" : result.code;
        reply(result.ok ? result : { ...result, code });
        if (["stale_session", "realtime_unavailable"].includes(code)) terminate(code);
      } catch (error) {
        const code = ["unauthorized", "forbidden"].includes(error.code) ? "unauthenticated" : "realtime_unavailable";
        reply({ ok: false, code }); terminate(code);
        log("error", "realtime_operation_failed", { driverId: id, code });
      } finally { pending = false; }
    });
    const activate = async () => {
      if (!socket.connected) return;
      await authenticateDriver(token);
      await store.activateSession(id, sessionId);
      if (!socket.connected) { await store.releaseSession(id, sessionId); return; }
      const previous = active.get(id);
      active.set(id, socket);
      if (previous && previous !== socket) {
        previous.emit(REALTIME.error, { code: "stale_session" }); previous.disconnect(true);
      }
      ready = true;
      await socket.join(driverRoom(id));
      if (socket.handshake.auth?.supportedWorkflowVersion === 3) await socket.join(`${driverRoom(id)}:v3`);
      socket.emit(REALTIME.session, { sessionId, publishIntervalMs: REALTIME.publishIntervalMs });
      // No high-frequency client heartbeat. JWT/account revocation is checked
      // even when the phone has no fresh GPS fix to publish.
      heartbeat = setInterval(async () => {
        if (renewing || !socket.connected) return;
        renewing = true;
        try {
          await authenticateDriver(token);
          if (!socket.connected) return;
          const renewal = await store.touchPresence(id, sessionId);
          if (renewal === 0) terminate("stale_session");
          if (renewal === -1) terminate("realtime_unavailable");
        } catch (error) {
          terminate(["unauthorized", "forbidden"].includes(error.code) ? "unauthenticated" : "realtime_unavailable");
        } finally { renewing = false; }
      }, Math.min(15000, Math.max(250, Math.floor(settings.presenceTtlSeconds * 1000 / 3))));
    };
    // Serial activation also prevents two asynchronous handshakes from swapping
    // the local socket registry after Redis has already elected the newer one.
    const job = (activationQueues.get(id) || Promise.resolve()).then(activate).catch(error => {
      terminate(["unauthorized", "forbidden"].includes(error.code) ? "unauthenticated" : "realtime_unavailable");
    });
    activationQueues.set(id, job);
    void job.finally(() => { if (activationQueues.get(id) === job) activationQueues.delete(id); });
  });
  return {
    io,
    offers,
    tracking,
    async close() {
      await tracking.close();
      await offers.close();
      await new Promise(resolve => io.close(resolve));
      await Promise.allSettled([...activationQueues.values()]);
      await Promise.allSettled([...releases]);
    },
  };
}
