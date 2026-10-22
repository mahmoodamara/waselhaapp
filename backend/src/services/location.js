import { fail, string } from "./validation.js";

// Small on purpose: where something is, how it was chosen, and when a person
// confirmed it. Nothing here knows about cities, routes or prices.
export const locationSources = ["gps", "search", "pin"];
export const addressMax = 300;

export const validCoordinates = (lat, lng) =>
  Number.isFinite(lat) &&
  Number.isFinite(lng) &&
  Math.abs(lat) <= 90 &&
  Math.abs(lng) <= 180;
// Numbers, or plain decimal strings; NaN, Infinity, null, booleans, arrays and
// other strings are not coordinates.
function toNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim()))
    return Number(value.trim());
  return NaN;
}
export function parseCoordinates(lat, lng) {
  const pair = [toNumber(lat), toNumber(lng)];
  if (!validCoordinates(...pair)) fail("invalid_input");
  return pair;
}
// The only way client input becomes a stored location. The confirmation time is
// always the server's, never the client's.
export function parseLocation(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail("invalid_input");
  const [lat, lng] = parseCoordinates(input.lat, input.lng);
  if (!locationSources.includes(input.source)) fail("invalid_input");
  const address =
    input.address === undefined ? "" : string(input.address, false, addressMax);
  return { address, lat, lng, source: input.source, confirmedAt: new Date() };
}
// "Confirmed" is derived from the data itself; there is no separate state flag.
export const isConfirmedLocation = (location) =>
  !!location && validCoordinates(location.lat, location.lng) && !!location.confirmedAt;
export const sameLocation = (a, b) =>
  !!a &&
  !!b &&
  a.lat === b.lat &&
  a.lng === b.lng &&
  (a.address ?? "") === (b.address ?? "") &&
  a.source === b.source;
// Independent copy, so an order never shares state with the store's setting.
export const snapshotLocation = ({ address, lat, lng, source, confirmedAt }) => ({
  address,
  lat,
  lng,
  source,
  confirmedAt,
});
