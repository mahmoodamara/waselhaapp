import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { translations as web, translate } from "../src/translations.js";
import { translations as driver, translate as driverTranslate } from "../../driver-app/translations.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name === "dist") return [];
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
// Literal t("key") calls only; template keys such as t(`status.${s}`) are dynamic.
function usedKeys(files) {
  const used = new Map();
  for (const file of files)
    for (const [, key] of readFileSync(file, "utf8").matchAll(/\bt\(\s*"([^"$`]+)"\s*\)/g))
      used.set(key, [...(used.get(key) ?? []), relative(root, file)]);
  return used;
}
const sources = (dir, pattern) => walk(join(root, dir)).filter((f) => pattern.test(f));

for (const [name, table] of [["web", web], ["driver", driver]])
  test(`${name}: every entry has a non-empty Arabic and Hebrew text`, () => {
    const broken = Object.entries(table).filter(
      ([, value]) =>
        !Array.isArray(value) ||
        value.length !== 2 ||
        value.some((text) => typeof text !== "string" || !text.trim()),
    );
    assert.deepEqual(broken.map(([key]) => key), []);
    // Hebrew text must actually be Hebrew and Arabic text Arabic, not a copy.
    const same = Object.entries(table).filter(([, [ar, he]]) => ar === he && /[֐-׿؀-ۿ]/.test(ar));
    assert.deepEqual(same.map(([key]) => key), [], "identical Arabic and Hebrew text");
  });
test("web: every literal t() key used in the web app is translated", () => {
  const missing = [...usedKeys(sources("web/src", /\.jsx?$/))].filter(([key]) => !web[key]);
  assert.deepEqual(missing.map(([key, files]) => `${key} (${files[0]})`), []);
});
test("driver: every literal t() key used in the driver app is translated", () => {
  const files = [join(root, "driver-app/App.js"), ...sources("driver-app/screens", /\.js$/)];
  const missing = [...usedKeys(files)].filter(([key]) => !driver[key]);
  assert.deepEqual(missing.map(([key, f]) => `${key} (${f[0]})`), []);
});
// Keys the server sends in error codes and missing-requirement lists.
const serverKeys = ["destination_location_required", "pickup_location_required", "maps_unavailable"];
const uiKeys = [
  "deliveryLocation", "useMyLocation", "searchAddress", "searchButton", "searchPlaceholder",
  "noResults", "confirmLocation", "locationConfirmed", "locationNotConfirmed", "locationLater",
  "locationPermissionDenied", "locationUnavailable", "mapHint", "selectedLocation",
  "locating", "pinOnMap", "pickupLocation", "savePickupLocation", "pickupLocationMissing",
];
test("STEP 4 location texts exist in Arabic and Hebrew for the web app", () => {
  assert.deepEqual([...serverKeys, ...uiKeys].filter((k) => !web[k]), []);
});
test("STEP 4 location texts exist in Arabic and Hebrew for the driver app", () => {
  const needed = ["destination_location_required", "deliveryLocation", "pickupLocation", "openNavigation", "locationNotConfirmed", "pinOnMap"];
  assert.deepEqual(needed.filter((k) => !driver[k]), []);
});
test("STEP 5 server/UI pricing states are translated for web and driver", () => {
  const common = ["pricePending", "priceFinal", "legacyManualPrice", "routeDistance", "meters", "route_price_required", "pickup_location_required"];
  assert.deepEqual(common.filter((k) => !web[k] || !driver[k]), []);
  assert.deepEqual(["priceWaitingLocation", "routing_unavailable", "retryRoutePrice", "serverRoutePricing", "route_inputs_required"].filter((k) => !web[k]), []);
});
test("STEP 6 operational states, events and withdrawal reasons are translated", () => {
  const reasons = ["details_changed", "order_incomplete", "cannot_complete", "other"];
  for (const reason of reasons) assert.ok(web[`withdrawal.${reason}`] && driver[`withdrawal.${reason}`]);
  for (const type of ["driver_search_started", "driver_search_timed_out", "driver_search_retried", "driver_assigned",
    "driver_assignment_timed_out", "driver_withdrawn", "driver_arrived_store", "driver_arrived_customer", "store_cancelled"])
    assert.ok(web[`event.${type}`]);
  for (const key of ["noDriverFound", "retrySearch", "assignmentExpiredSearching", "operationalHistory", "arrivedStoreAt", "arrivedCustomerAt"])
    assert.ok(web[key]);
  for (const key of ["withdrawOrder", "withdrawalReason", "withdrawalNote", "confirmWithdrawal", "withdrawal_reason_required"])
    assert.ok(driver[key]);
});
test("STEP 7 canonical service area, availability and API errors are translated", () => {
  for (const key of ["serviceArea.kafr-kanna", "driverServiceAreas", "noServiceAreas", "availability", "availableForOrders", "unavailableForOrders", "driver_not_eligible"])
    assert.ok(web[key] && driver[key]);
  for (const key of ["serviceArea", "chooseServiceArea", "unclassifiedServiceArea", "service_area_required", "invalid_service_area"])
    assert.ok(web[key]);
  assert.ok(driver.unavailableOffersHint);
});
test("STEP 8 fee payer, collection, manual reconciliation and financial events are translated", () => {
  for (const key of ["deliveryFeePaidBy", "feePayer.customer", "feePayer.store", "cashHandover", "driverPayout",
    "financeStatus.pending", "financeStatus.completed", "fee_payer_required", "financial_terms_required"])
    assert.ok(web[key] && driver[key], key);
  for (const key of ["storeSettlement", "storeDeliveryFeeLiability", "shortage", "overage", "resolutionNote", "financeCompleted",
    "financePending", "legacyFinanceUnknown", "deliveryPaidByStore", "manualFinanceHint"])
    assert.ok(web[key], key);
  for (const type of ["financial_terms_captured", "cash_collected", "collection_adjustment_opened", "collection_adjustment_resolved",
    "cash_handover_completed", "driver_payout_completed", "store_settlement_completed"])
    assert.ok(web[`event.${type}`]);
});
for (const [name, table, fn] of [["web", web, translate], ["driver", driver, driverTranslate]])
  test(`${name}: an unknown server code gets the server message, a missing label never claims a server failure`, () => {
    for (const [index, language] of ["ar", "he"].entries()) {
      const generic = table.server_error[index];
      assert.equal(fn(language, "some_new_server_code"), generic);
      assert.equal(fn(language, ""), generic);
      assert.equal(fn(language, undefined), generic);
      assert.notEqual(fn(language, "missingLabel"), generic);
      assert.equal(fn(language, "m.missingLabel"), "missingLabel");
      assert.equal(fn(language, "serviceArea.undefined"), "—");
      assert.equal(fn(language, "login"), table.login[index]);
    }
  });
