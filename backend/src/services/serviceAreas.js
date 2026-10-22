import { fail } from "./validation.js";

// Canonical operational IDs. Labels live in the Arabic/Hebrew dictionaries.
export const supportedServiceAreas = Object.freeze(["kafr-kanna"]);
export function isServiceArea(value) {
  return typeof value === "string" && supportedServiceAreas.includes(value);
}
export function parseServiceArea(value) {
  if (value === undefined || value === null || value === "") fail("service_area_required", 422);
  if (!isServiceArea(value)) fail("invalid_service_area");
  return value;
}
export function validServiceAreas(value) {
  return Array.isArray(value) && value.length <= supportedServiceAreas.length &&
    value.every(isServiceArea) && new Set(value).size === value.length;
}
export function parseServiceAreas(value) {
  if (!validServiceAreas(value)) fail("invalid_service_area");
  return [...value];
}
