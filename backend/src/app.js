import express from "express";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import auth from "./routes/auth.js";
import orders from "./routes/orders.js";
import customer from "./routes/customer.js";
import tracking from "./routes/tracking.js";
import driver from "./routes/driver.js";
import backgroundLocation from "./routes/backgroundLocation.js";
import admin from "./routes/admin.js";
import store from "./routes/store.js";
import maps from "./routes/maps.js";
import dataRequests from './routes/dataRequests.js';
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { Order } from "./models/index.js";
import { rateLimit } from "./services/rateLimit.js";
import { sweepStatus } from "./services/orderTimeouts.js";
import { routingHealth } from "./services/routing.js";
import { log } from "./services/log.js";
import { ordersChanged } from "./services/orderSignals.js";
import { createDriverRouteService } from "./services/driverRoute.js";
import { createGoogleRoutesClient } from "./services/googleRoutes.js";
import { createOfferEtaService } from "./services/offerEta.js";
import { createTextMeClient } from "./services/textMe.js";
import { PUBLIC_ERROR_FIELDS as publicErrorFields } from '../../shared/apiContract.js';
const webContentSecurityPolicy = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org",
  "font-src 'self' data:", "connect-src 'self'", "object-src 'none'", "base-uri 'self'",
  "form-action 'self'", "frame-ancestors 'none'",
].join("; ");
export function createApp({ locationStore, redis, driverRoutes, offerEta, textMe } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.locals.textMe = textMe ?? createTextMeClient();
  if (locationStore) app.locals.locationStore = locationStore;
  // Tests inject a service with a fake Google transport; production never calls Google from tests.
  if (driverRoutes) app.locals.driverRoutes = driverRoutes;
  if (offerEta) app.locals.offerEta = offerEta;
  if (locationStore && !(driverRoutes && offerEta)) {
    // One Google client for both uses, so its failure backoff protects both.
    const routesClient = createGoogleRoutesClient();
    if (!driverRoutes) app.locals.driverRoutes = createDriverRouteService({ routesClient, locationStore });
    if (!offerEta) app.locals.offerEta = createOfferEtaService({ routesClient });
  }
  if (config.trustProxy) app.set("trust proxy", config.trustProxy);
  // Correlates a client report with the server log. The ID is generated here and
  // is never derived from client input.
  app.use((req, res, next) => {
    if (["POST", "PATCH", "DELETE"].includes(req.method)) res.on("finish", () => {
      if (res.statusCode < 400 && !req.path.startsWith("/api/driver/location/")) ordersChanged();
    });
    req.id = randomUUID();
    res.set("X-Request-Id", req.id);
    // The customer link secret lives in the page and API path: keep it out of
    // caches and out of Referer headers sent to map tile servers (origin only).
    res.set("Referrer-Policy", "no-referrer");
    res.set("X-Content-Type-Options", "nosniff");
    res.set("X-Frame-Options", "DENY");
    // Pages only run their own bundle; the sole external resource is the map tile images.
    if (!req.path.startsWith("/api")) res.set("Content-Security-Policy", webContentSecurityPolicy);
    if (req.path.startsWith("/api") || req.path.startsWith("/customer")) res.set("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "100kb" }));
  app.use("/api", (req, res, next) => {
    if (["POST", "PATCH"].includes(req.method)) {
      if (req.body === undefined) req.body = {};
      if (
        req.body === null ||
        Array.isArray(req.body) ||
        typeof req.body !== "object"
      )
        return res.status(400).json({ code: "invalid_input" });
    }
    next();
  });
  app.get("/api/health", (req, res) => res.json({ ok: true, name: "Waselha" }));
  app.post('/api/diagnostics', rateLimit(10), (req, res) => {
    const { kind, platform, releaseId, fingerprint, frames = [], ...extra } = req.body;
    if (Object.keys(extra).length || !['render','global'].includes(kind) || !['android','ios','web','unknown'].includes(platform) ||
      typeof releaseId !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(releaseId) || typeof fingerprint !== 'string' || !/^[a-f0-9]{8}$/.test(fingerprint) ||
      !Array.isArray(frames) || frames.length > 8 || frames.some(frame => !frame || Object.keys(frame).sort().join(',') !== 'column,file,line' ||
        !/^(?:index(?:\.(?:android|ios))?|App|Home|Summary|CurrentTrip)\.(?:js|bundle|hbc)$/.test(frame.file) || !Number.isSafeInteger(frame.line) || frame.line < 0 || frame.line > 100000000 ||
        !Number.isSafeInteger(frame.column) || frame.column < 0 || frame.column > 100000000)) return res.status(400).json({ code: 'invalid_input' });
    log('error', 'driver_js_error', { kind, platform, releaseId, fingerprint, frames });
    res.status(202).json({ ok: true });
  });
  // Readiness: the database answers, the driver-exclusivity index exists and the
  // timeout worker (when it runs in this process) swept recently.
  app.get("/api/ready", async (req, res) => {
    const checks = {};
    try {
      await mongoose.connection.db.command({ ping: 1 });
      checks.database = true;
      checks.activeDriverIndex = await Order.collection.indexExists("one_active_order_per_driver");
    } catch { checks.database = false; checks.activeDriverIndex = false; }
    const lastSuccess = sweepStatus.lastSuccessAt?.getTime() ?? sweepStatus.startedAt?.getTime() ?? null;
    const lagMs = lastSuccess === null ? null : Date.now() - lastSuccess;
    checks.timeoutWorker = sweepStatus.startedAt === null ? "not_running_here"
      : lagMs <= config.orderTimeoutSweepIntervalMs * 3 + 5000;
    if (redis) {
      try { checks.redis = redis.isReady && await redis.ping() === "PONG"; }
      catch { checks.redis = false; }
    }
    const ok = checks.database && checks.activeDriverIndex && checks.timeoutWorker !== false && checks.redis !== false;
    // Informational: prices cannot be calculated while the routing service is unreachable.
    res.status(ok ? 200 : 503).json({ ok, ...checks, routing: await routingHealth(), sweepLagMs: lagMs });
  });
  app.use("/api/auth/login", rateLimit(config.rateLimitLoginPerMin));
  app.use('/api/data-requests', dataRequests);
  app.get('/api/public-info', (req, res) => res.json({
    locationRetentionSeconds: { latest: config.locationTtlSeconds,
      known: Math.max(config.locationTtlSeconds, config.pushLocationMaxAgeSeconds),
      baseline: Math.max(900, config.locationTtlSeconds, config.pushLocationMaxAgeSeconds), geoSweepInterval: 10 },
  }));
  app.use("/api/customer", rateLimit(config.rateLimitCustomerPerMin));
  app.use("/api/auth", auth);
  app.use("/api/orders", orders);
  app.use("/api/customer", customer);
  app.use("/api/tracking", tracking);
  app.use("/api/driver/location/background", backgroundLocation);
  app.use("/api/driver", driver);
  app.use("/api/admin", admin);
  app.use("/api/store", store);
  app.use("/api/maps", maps);
  app.use("/api", (req, res) => res.status(404).json({ code: "not_found" }));
  const dist = fileURLToPath(new URL("../../web/dist/", import.meta.url));
  app.use(express.static(dist));
  app.get(/^\/(?:store|admin|customer|privacy|support|data-request)(?:\/.*)?$/, (req, res) =>
    existsSync(`${dist}/index.html`)
      ? res.sendFile(`${dist}/index.html`)
      : res
          .status(503)
          .send("Build the web application first: npm --prefix web run build"),
  );
  app.get("/", (req, res) => res.redirect("/store"));
  app.use((req, res) => res.status(404).json({ code: "not_found" }));
  app.use((error, req, res, next) => {
    let status = error.status || 500,
      code = typeof error.code === "string" ? error.code : "server_error";
    if (error.code === 11000) {
      status = 409;
      code = "duplicate_record";
    }
    if (
      ["ValidationError", "CastError"].includes(error.name) ||
      error.type === "entity.parse.failed"
    ) {
      status = 400;
      code = "invalid_input";
    }
    // Operational detail only (no request body, headers or URL: the customer
    // link secret is part of the path).
    if (status >= 500) log("error", "request_failed", { requestId: req.id, method: req.method,
      route: req.route?.path ?? null, status, code });
    // Only these extra fields ever reach the client.
    const extra = Object.fromEntries(
      publicErrorFields
        .filter((k) => error[k] !== undefined)
        .map((k) => [k, error[k]]),
    );
    if (extra.retryAfterSeconds)
      res.set("Retry-After", String(extra.retryAfterSeconds));
    res.status(status).json({ code, ...extra });
  });
  return app;
}
