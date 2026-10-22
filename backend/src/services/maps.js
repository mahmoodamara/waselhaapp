import { config } from "../config.js";
import { fail } from "./validation.js";
import { addressMax, parseCoordinates, validCoordinates } from "./location.js";

// The only place that talks to a geocoding provider (Nominatim-compatible).
// No routing, distance or pricing calls belong here. The provider is untrusted:
// only a bounded label and a valid coordinate pair are ever taken from it.
const timeoutMs = 5000;
const maxWaiting = 8;
const maxResults = 5;
const userAgent = `Waselha/0.1${config.mapsContact ? ` (${config.mapsContact})` : ""}`;

// Serialises provider calls and spaces their starts, as the public service
// requires. When too many are already waiting, fail fast instead of piling up.
let queue = Promise.resolve();
let waiting = 0;
let lastStart = 0;
async function waitForTurn() {
  if (waiting >= maxWaiting) fail("maps_unavailable", 503);
  waiting += 1;
  const previous = queue;
  let release;
  queue = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  waiting -= 1;
  const wait = lastStart + config.mapsMinIntervalMs - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastStart = Date.now();
  release();
}
async function getJson(path, params) {
  await waitForTurn();
  try {
    const response = await fetch(
      `${config.mapsGeocoderUrl}${path}?${new URLSearchParams(params)}`,
      {
        headers: { "User-Agent": userAgent, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok) throw new Error(`provider status ${response.status}`);
    return await response.json();
  } catch (error) {
    // Never log the query: it is an address a customer typed.
    console.warn("maps provider request failed");
    return fail("maps_unavailable", 503);
  }
}
const languages = (lang) => (lang === "he" ? "he,ar,en" : "ar,he,en");
const label = (value) =>
  typeof value === "string" ? value.trim().slice(0, addressMax) : "";

export async function searchAddress(query, lang) {
  const q = typeof query === "string" ? query.trim() : "";
  if (q.length < 3 || q.length > 200) fail("invalid_input");
  const data = await getJson("/search", {
    q,
    format: "jsonv2",
    limit: String(maxResults),
    "accept-language": languages(lang),
    ...(config.mapsCountryCodes ? { countrycodes: config.mapsCountryCodes } : {}),
  });
  if (!Array.isArray(data)) fail("maps_unavailable", 503);
  return data
    .map((item) => ({
      label: label(item?.display_name),
      lat: Number(item?.lat),
      lng: Number(item?.lon),
    }))
    .filter((place) => place.label && validCoordinates(place.lat, place.lng))
    .slice(0, maxResults);
}
export async function reverseGeocode(lat, lng, lang) {
  const [latitude, longitude] = parseCoordinates(lat, lng);
  const data = await getJson("/reverse", {
    lat: String(latitude),
    lon: String(longitude),
    format: "jsonv2",
    zoom: "18",
    "accept-language": languages(lang),
  });
  if (!data || typeof data !== "object") fail("maps_unavailable", 503);
  return { label: label(data.display_name) };
}
