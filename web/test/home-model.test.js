import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ageParts,
  countKey,
  customerState,
  driverStage,
  greetingIcon,
  greetingKey,
  homeAction,
  homeActions,
  homeStats,
} from "../src/merchant/home.js";

const now = Date.parse("2026-10-10T18:00:00+03:00");
const minutesAgo = (n) => new Date(now - n * 60000).toISOString();
// The five orders of the home design: at the store, no driver found, driver on
// the way, searching, and with the customer.
const order = (id, minutes, extra) => ({
  _id: id,
  workflowVersion: 2,
  canEdit: true,
  serviceArea: "kafr-kanna",
  goodsAmountKnown: true,
  missingRequirements: [],
  customerConfirmed: true,
  destinationLocation: { confirmedAt: minutesAgo(minutes - 1) },
  createdAt: minutesAgo(minutes),
  ...extra,
});
const atStore = order("a1042", 14, { status: "driver_at_store", arrivedStoreAt: minutesAgo(3) });
const noDriver = order("a1039", 11, {
  status: "searching_driver",
  driverSearchStatus: "no_driver",
  searchDeadlineAt: minutesAgo(9),
});
const noLocation = order("a1041", 18, {
  status: "driver_assigned",
  destinationLocation: undefined,
  customerConfirmed: false,
});
const searching = order("a1043", 2, {
  status: "searching_driver",
  driverSearchStatus: "searching",
  destinationLocation: undefined,
  customerConfirmed: false,
});
const delivering = order("a1040", 25, { status: "collected" });
const orders = [atStore, noDriver, noLocation, searching, delivering];

test("driver stage: one of four steps, from finding a driver to the customer", () => {
  assert.deepEqual(orders.map((o) => driverStage(o).step), [3, 1, 2, 1, 4]);
  assert.equal(driverStage(noDriver).label, "stageNoDriver");
  assert.equal(driverStage(noDriver).since, noDriver.searchDeadlineAt);
  assert.equal(driverStage(searching).label, "stageSearching");
  assert.equal(driverStage({ status: "driver_at_destination" }).label, "stageAtCustomer");
});

test("customer state: waiting is kept for ten minutes, then the store is asked to resend", () => {
  assert.equal(customerState(searching, now).kind, "waiting");
  assert.equal(customerState(noLocation, now).kind, "overdue");
  assert.equal(customerState(noLocation, now).since, noLocation.createdAt);
  assert.equal(customerState(atStore, now).kind, "done");
  const unconfirmed = { ...atStore, customerConfirmed: false };
  assert.deepEqual(customerState(unconfirmed, now), { kind: "waiting", label: "customerConfirming", icon: "clock" });
});

test("every state has an icon that the icon set knows", async () => {
  const source = (await import("node:fs")).readFileSync(new URL("../src/merchant/components.jsx", import.meta.url), "utf8");
  const known = new Set([...source.matchAll(/^  (\w+): \w+,$/gm)].map((m) => m[1]));
  const used = new Set([
    ...orders.flatMap((o) => [driverStage(o).icon, customerState(o, now).icon, homeAction(o, now)?.icon]),
    ...["greetMorning", "greetAfternoon", "greetEvening"].map((k) => greetingIcon[k]),
    driverStage({ status: "driver_at_destination" }).icon, driverStage({ status: "returning" }).icon,
    driverStage({ status: "delivery_failed" }).icon,
  ].filter(Boolean));
  assert.deepEqual([...used].filter((name) => !known.has(name)), []);
  assert.equal(homeAction(noDriver, now).tone, "attention");
  assert.equal(homeAction(atStore, now).tone, "normal");
});

test("home actions: hand over the parcel, retry the search, resend the link", () => {
  const actions = homeActions(orders, now);
  assert.deepEqual(
    actions.map((a) => [a.order._id, a.kind]),
    [["a1042", "handover"], ["a1039", "retry"], ["a1041", "resend"]],
  );
  assert.equal(actions[0].button, "handoverAction");
  assert.equal(actions[1].situation, "situationNoDriver");
  assert.equal(actions[2].step, "resendStep");
});

test("home actions: nothing to do for orders that are moving on their own", () => {
  assert.equal(homeAction(searching, now), null);
  assert.equal(homeAction(delivering, now), null);
  // The driver is at the store but something is still missing: not the store's move.
  assert.equal(homeAction({ ...atStore, missingRequirements: ["driver_confirmation_required"] }, now), null);
  // Finished orders never ask for anything.
  assert.equal(homeAction({ ...noLocation, status: "delivered" }, now), null);
  assert.equal(homeAction({ ...noLocation, status: "cancelled" }, now), null);
});

test("home actions: a server task wins over a nudge and keeps its own labels", () => {
  const task = homeAction({ ...noLocation, status: "searching_driver", driverSearchStatus: "no_driver", serviceArea: "kafr-kanna" }, now);
  assert.equal(task.kind, "retry");
  assert.equal(task.id, "a1041:retry");
  assert.equal(task.task.kind, "retry");
});

test("home stats count active orders by where the driver is", () => {
  const stats = homeStats(orders, homeActions(orders, now));
  assert.deepEqual(stats, { active: 5, needsAction: 3, searching: 2, onTheWay: 2, atStore: 1 });
  const finished = [...orders, { ...atStore, _id: "done", status: "delivered" }];
  assert.equal(homeStats(finished, []).active, 5);
});

test("age: minutes, then hours, then days", () => {
  assert.deepEqual(ageParts(minutesAgo(14), now), { unit: "ageMinutes", n: 14 });
  assert.deepEqual(ageParts(minutesAgo(0), now), { unit: "ageMinutes", n: 1 });
  assert.deepEqual(ageParts(minutesAgo(135), now), { unit: "ageHours", n: 2 });
  assert.deepEqual(ageParts(minutesAgo(60 * 50), now), { unit: "ageDays", n: 2 });
});

test("count keys follow the Arabic and Hebrew plural forms", () => {
  const ar = [1, 2, 3, 10, 11, 99, 100].map((n) => countKey("needs", n, "ar"));
  assert.deepEqual(ar, ["needsOne", "needsTwo", "needsFew", "needsFew", "needsMany", "needsMany", "needsOther"]);
  assert.equal(countKey("active", 1, "he"), "activeOne");
  assert.equal(countKey("active", 2, "he"), "activeTwo");
  assert.ok(["activeMany", "activeOther"].includes(countKey("active", 5, "he")));
});

test("greeting follows the hour in Israel", () => {
  assert.equal(greetingKey(new Date("2026-10-10T07:00:00+03:00")), "greetMorning");
  assert.equal(greetingKey(new Date("2026-10-10T13:00:00+03:00")), "greetAfternoon");
  assert.equal(greetingKey(new Date("2026-10-10T20:00:00+03:00")), "greetEvening");
});

// Quick orders wait for their customer before any driver is searched (dispatch gate).
test("an order waiting for its customer is not a driver search", async () => {
  const { operationalState } = await import("../src/merchant/model.js");
  const waiting = order("w1", 5, { status: "searching_driver", driverSearchStatus: "waiting", dispatchState: "waiting_customer",
    destinationLocation: undefined, customerConfirmed: false });
  const later = order("w2", 5, { status: "searching_driver", driverSearchStatus: "waiting", dispatchState: "customer_later",
    customerAvailable: false, priceStatus: "final" });
  const searching = order("w3", 5, { status: "searching_driver", driverSearchStatus: "searching", dispatchState: "searching",
    priceStatus: "final" });
  for (const o of [waiting, later]) assert.deepEqual(driverStage(o), { step: 0, label: "stageWaitingCustomer", icon: "clock" });
  assert.equal(driverStage(searching).label, "stageSearching");
  assert.equal(operationalState(waiting).title, "waitingCustomer");
  assert.equal(operationalState(later).title, "customerLater");
  assert.equal(operationalState(searching).title, "searching");
  assert.equal(customerState(later, now).label, "customerLaterShort");
  assert.equal(homeStats([waiting, later, searching], []).searching, 1);
  // A released order that is not ready again waits for the customer; it is not "searching for another driver".
  const released = { ...later, events: [{ type: "driver_withdrawn" }] };
  assert.equal(operationalState(released).title, "customerLater");
});
