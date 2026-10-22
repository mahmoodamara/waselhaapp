import assert from "node:assert/strict";
import { test } from "node:test";
import {
  initialState,
  pickerReducer as reduce,
  canConfirm,
  confirmBody,
} from "../src/locationPicker.js";

const gps = { type: "gps-success", lat: 32.75, lng: 35.35 };

test("GPS success makes a candidate, never a confirmed location", () => {
  const state = reduce(initialState, gps);
  assert.deepEqual(state.candidate, { lat: 32.75, lng: 35.35, address: "", source: "gps" });
  assert.ok(!("confirmedAt" in state.candidate), "a GPS fix must not carry a confirmation time");
  assert.equal(state.locating, false);
  assert.equal(canConfirm(state.candidate, null), true, "the customer still has to press confirm");
});
test("GPS start shows progress and clears an old message", () => {
  const denied = reduce(initialState, { type: "gps-error", denied: true });
  const state = reduce(denied, { type: "gps-start" });
  assert.equal(state.locating, true);
  assert.equal(state.notice, "");
});
test("denied or unavailable GPS leaves the page usable and keeps any candidate", () => {
  const picked = reduce(initialState, { type: "search-pick", lat: 1, lng: 2, label: "Somewhere" });
  const denied = reduce(picked, { type: "gps-error", denied: true });
  assert.equal(denied.notice, "locationPermissionDenied");
  assert.equal(denied.locating, false);
  assert.deepEqual(denied.candidate, picked.candidate);
  const unavailable = reduce(initialState, { type: "gps-error", denied: false });
  assert.equal(unavailable.notice, "locationUnavailable");
  assert.equal(unavailable.candidate, null, "no coordinates are invented");
});
test("choosing a search result makes a candidate with its label, not a confirmation", () => {
  const state = reduce(initialState, { type: "search-pick", lat: 32.7459862, lng: 35.3398025, label: "Main Street" });
  assert.deepEqual(state.candidate, { lat: 32.7459862, lng: 35.3398025, address: "Main Street", source: "search" });
  assert.equal(canConfirm(state.candidate, null), true);
});
test("moving the pin changes the candidate, becomes source pin and drops the stale address", () => {
  const found = reduce(reduce(initialState, gps), { type: "address-resolved", lat: 32.75, lng: 35.35, label: "Old street" });
  assert.equal(found.candidate.address, "Old street");
  const moved = reduce(found, { type: "pin-move", lat: 32.76, lng: 35.36 });
  assert.deepEqual(moved.candidate, { lat: 32.76, lng: 35.36, address: "", source: "pin" });
});
test("a pin can be placed on an empty map", () => {
  const state = reduce(initialState, { type: "pin-move", lat: 10, lng: 20 });
  assert.equal(state.candidate.source, "pin");
});

test("manually choosing the entrance ends a pending GPS lookup", () => {
  const pending = reduce(initialState, { type: "gps-start" });
  const moved = reduce(pending, { type: "pin-move", lat: 32.7466, lng: 35.3424 });
  assert.equal(moved.locating, false);
  assert.equal(moved.candidate.source, "pin");
});

test("GPS distinguishes an insecure connection and timeout from denied permission", () => {
  assert.equal(reduce(initialState, { type: "gps-error", insecure: true }).notice, "locationSecureRequired");
  assert.equal(reduce(initialState, { type: "gps-error", timeout: true }).notice, "locationTimedOut");
});

test("GPS accuracy is visible to the user but is not part of the saved location", () => {
  const state = reduce(initialState, { ...gps, accuracy: 125 });
  assert.equal(state.candidate.accuracy, 125);
  assert.deepEqual(confirmBody(state.candidate), { lat: gps.lat, lng: gps.lng, address: "", source: "gps" });
  const moved = reduce(state, { type: "pin-move", lat: 32.7466, lng: 35.3424 });
  assert.equal(moved.candidate.accuracy, undefined);
});
test("a late address only applies while the pin is still where it was looked up", () => {
  const moved = reduce(reduce(initialState, gps), { type: "pin-move", lat: 32.9, lng: 35.9 });
  const late = reduce(moved, { type: "address-resolved", lat: 32.75, lng: 35.35, label: "Stale answer" });
  assert.equal(late.candidate.address, "", "an answer for an old position must be ignored");
  const current = reduce(moved, { type: "address-resolved", lat: 32.9, lng: 35.9, label: "Right answer" });
  assert.equal(current.candidate.address, "Right answer");
  assert.equal(current.candidate.source, "pin", "resolving an address does not change how it was chosen");
  assert.equal(reduce(initialState, { type: "address-resolved", lat: 1, lng: 2, label: "x" }).candidate, null);
});
test("confirm needs a candidate that differs from the saved location", () => {
  assert.equal(canConfirm(null, null), false);
  const candidate = { lat: 1, lng: 2, address: "A", source: "pin" };
  assert.equal(canConfirm(candidate, null), true);
  assert.equal(canConfirm(candidate, { ...candidate, confirmedAt: "2026-10-07T10:00:00.000Z" }), false);
  assert.equal(canConfirm({ ...candidate, lat: 1.5 }, { ...candidate, confirmedAt: "x" }), true);
});
test("the confirm request carries only the chosen place, never a time", () => {
  const body = confirmBody({ lat: 1, lng: 2, address: "A", source: "search", confirmedAt: "x", extra: 1 });
  assert.deepEqual(body, { lat: 1, lng: 2, address: "A", source: "search" });
});
test("the reducer never mutates its input and reset clears the candidate", () => {
  const before = reduce(initialState, gps);
  const snapshot = JSON.stringify(before);
  reduce(before, { type: "pin-move", lat: 5, lng: 6 });
  reduce(before, { type: "gps-error", denied: true });
  assert.equal(JSON.stringify(before), snapshot);
  assert.deepEqual(reduce(before, { type: "reset" }), initialState);
});
