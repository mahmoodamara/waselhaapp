import { Order } from "../models/index.js";
import { searchableFilter } from "./orderTimeouts.js";
import { validServiceAreas } from "./serviceAreas.js";
import { fail } from "./validation.js";

// A car carries anything a motorcycle does; a motorcycle only motorcycle orders.
// Orders without a vehicle (historical) stay visible to every eligible driver.
const covers = { car: ["motorcycle", "car"], motorcycle: ["motorcycle"] };
export function driverEligibleForOrder(driver, order, busyIds, now = new Date()) {
  return driverCanReceiveOffers(driver) && !busyIds.has(String(driver._id)) &&
    order.status === 'searching_driver' && order.activeAssignment === false && order.collectedAt == null &&
    order.driverSearchStatus === 'searching' && new Date(order.searchDeadlineAt) > now &&
    !(order.excludedDriverIds ?? []).some(id => String(id) === String(driver._id)) &&
    (order.workflowVersion !== 3 || driver.supportedWorkflowVersion === 3) &&
    typeof order.serviceArea === 'string' && driver.serviceAreas.includes(order.serviceArea) &&
    (order.vehicleType == null || (covers[driver.vehicleType] ?? []).includes(order.vehicleType));
}
export const vehicleFilter = driver => ({ vehicleType: { $in: [...(covers[driver?.vehicleType] ?? []), null] } });
export function driverCanReceiveOffers(driver) {
  return driver?.role === "driver" && driver.active === true && driver.availableForOrders === true &&
    validServiceAreas(driver.serviceAreas) && driver.serviceAreas.length > 0;
}
// Why a driver is not offered new orders; empty means the account is ready. A
// missing vehicle only hides new orders (historical ones stay visible), but that
// is the same silence to the driver, so it is reported too.
export function offerProblems(driver) {
  if (driver?.role !== "driver") return ["not_a_driver"];
  const problems = [];
  if (driver.active !== true) problems.push("inactive");
  if (driver.availableForOrders !== true) problems.push("not_available");
  if (!validServiceAreas(driver.serviceAreas) || driver.serviceAreas.length === 0) problems.push("no_service_area");
  if (!covers[driver.vehicleType]) problems.push("no_vehicle");
  return problems;
}
// Both offer listing and direct assignment use this predicate. The busy read
// avoids offering additional work; the existing unique index remains the final
// authority when two accepts race after this read.
export async function eligibleOrderFilter(driver, now = new Date()) {
  if (!driverCanReceiveOffers(driver) || await Order.exists({ driverId: driver._id, activeAssignment: true }))
    return null;
  // MongoDB $in also matches array elements. Legacy/corrupt array values must
  // not be treated as a canonical scalar order area, even if one ID is valid.
  return { ...searchableFilter(driver._id, now),
    ...(driver.supportedWorkflowVersion !== 3 ? { workflowVersion: { $ne: 3 } } : {}),
    serviceArea: { $in: driver.serviceAreas, $not: { $type: "array" } }, ...vehicleFilter(driver) };
}
export function parseVehicleType(value) {
  if (!Object.keys(covers).includes(value)) fail("invalid_input");
  return value;
}
