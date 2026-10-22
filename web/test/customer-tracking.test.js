import assert from "node:assert/strict";
import { test } from "node:test";
import { createCustomerTracker, trackingDisplay } from "../src/customerTracking.js";
import { TRACKING } from "../../shared/realtimeContract.js";
const snapshot = { status: "collected", state: "live", serverTime: 100000, freshForMs: 15000,
  location: { latitude: 32, longitude: 35, measuredAt: 99000, receivedAt: 99900, fresh: true } };
test("display ages stationary real GPS, never extrapolates; disconnect/stale/missing/end fail closed", () => {
  assert.equal(trackingDisplay(snapshot, true, 1000).state, "live");
  const stale = trackingDisplay(snapshot, true, 15000);
  assert.equal(stale.state, "stale"); assert.equal(stale.ageSeconds, 16); assert.equal(stale.location, snapshot.location);
  assert.equal(trackingDisplay(snapshot, false).state, "stale");
  assert.equal(trackingDisplay({ ...snapshot, location: null }, true).state, "unavailable");
  for (const status of ["driver_assigned", "searching_driver", "driver_at_store", "delivered", "cancelled", "delivery_failed", "returning", "returned"])
    assert.equal(trackingDisplay({ ...snapshot, status }, true).location, null);
  assert.equal(trackingDisplay({ ...snapshot, state: "ended" }, true).location, null);
});
test("one transport authenticates again at reconnect; snapshots restore order; lifecycle/cleanup ignore late responses", async () => {
  const handlers = new Map(), calls = [], snapshots = [], statuses = [], changes = [], listeners = new Map();
  let settings, authRequests = 0;
  const socket = {
    connected: false,
    on(name, fn) { handlers.set(name, fn); }, once(name, fn) { handlers.set(`once:${name}`, fn); },
    connect() { calls.push("connect"); }, disconnect() { calls.push("disconnect"); },
    emit(name) { calls.push(name); }, removeAllListeners() { handlers.clear(); },
  };
  const lifecycle = { document: { visibilityState: "visible", addEventListener: (n, f) => listeners.set(n, f), removeEventListener: n => listeners.delete(n) },
    addEventListener: (n, f) => listeners.set(n, f), removeEventListener: n => listeners.delete(n) };
  const tracker = createCustomerTracker({ token: "own-link", api: async path => { assert(path.includes("own-link")); authRequests++; return { credential: "scoped" }; },
    createSocket: (namespace, options) => { assert.equal(namespace, TRACKING.namespace); settings = options; return socket; },
    onSnapshot: v => snapshots.push(v), onOrderChanged: v => changes.push(v), onConnection: v => statuses.push(v), onError: () => {}, lifecycle });
  await settings.auth(auth => assert.deepEqual(auth, { credential: "scoped" }));
  handlers.get("connect")(); handlers.get(TRACKING.snapshot)(snapshot);
  handlers.get(TRACKING.location)(snapshot); assert.equal(changes.length, 1);
  handlers.get("disconnect")(); await settings.auth(() => {}); handlers.get("connect")(); handlers.get(TRACKING.snapshot)(snapshot);
  assert.equal(authRequests, 2); assert.equal(changes.length, 2);
  socket.connected = true; listeners.get("visibilitychange")(); assert(calls.includes(TRACKING.resync));
  handlers.get(TRACKING.ended)({ status: "delivered" }); assert.equal(snapshots.at(-1).location, null);
  const late = handlers.get(TRACKING.location), count = snapshots.length;
  tracker.stop(); late(snapshot); assert.equal(snapshots.length, count); assert.equal(handlers.size, 0); assert.equal(listeners.size, 0);
});
test("late credential exchange after navigation never reconnects or retains credentials", async () => {
  let options, resolve, callbacks = 0;
  const pending = new Promise(r => { resolve = r; });
  const tracker = createCustomerTracker({ token: "old", api: () => pending,
    createSocket: (_, o) => { options = o; return { on() {}, connect() {}, removeAllListeners() {}, disconnect() {} }; },
    onSnapshot() {}, onOrderChanged() {}, onConnection() {}, onError() {} });
  const auth = options.auth(() => { callbacks++; }); tracker.stop(); resolve({ credential: "old-secret" }); await auth;
  assert.equal(callbacks, 0);
});

test("server outage retries with bounded backoff; revocation clears the old marker and disposal cancels retry", () => {
  const handlers = new Map(), timers = new Map(), received = [], waits = [];
  let nextId = 0, connections = 0;
  const tracker = createCustomerTracker({ token: "link", api: async () => ({ credential: "scoped" }),
    createSocket: () => ({ on: (n, f) => handlers.set(n, f), connect: () => connections++,
      removeAllListeners: () => handlers.clear(), disconnect() {} }),
    onSnapshot: v => received.push(v), onOrderChanged() {}, onConnection() {}, onError() {},
    schedule: (f, ms) => { waits.push(ms); timers.set(++nextId, f); return nextId; }, cancel: id => timers.delete(id) });
  for (let i = 0; i < 6; i++) {
    handlers.get("connect_error")({ data: { code: "realtime_unavailable" } });
    const [id, fn] = [...timers][0] ?? []; if (fn) { timers.delete(id); fn(); }
  }
  assert.deepEqual(waits, [2000, 4000, 8000, 15000, 15000]);
  assert.equal(connections, 6);
  handlers.get("connect_error")({ data: { code: "unauthorized" } });
  assert.equal(received.at(-1).location, null);
  handlers.get("connect")();
  handlers.get("connect_error")({ data: { code: "realtime_unavailable" } });
  tracker.stop(); assert.equal(timers.size, 0);
});
