import boundary from "../../../shared/kafr-kanna-boundary.json" with { type: "json" };
import { fail } from "./validation.js";

function inRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    const cross = (lng - xi) * (yj - yi) - (lat - yi) * (xj - xi);
    if (Math.abs(cross) < 1e-12 && lng >= Math.min(xi, xj) && lng <= Math.max(xi, xj) && lat >= Math.min(yi, yj) && lat <= Math.max(yi, yj)) return true;
    if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function deliveryAreaFor(location) {
  if (!Number.isFinite(location?.lat) || !Number.isFinite(location?.lng)) return null;
  const polygons = boundary.geometry.type === "Polygon" ? [boundary.geometry.coordinates] : boundary.geometry.coordinates;
  return polygons.some(([outer, ...holes]) => inRing(location.lng, location.lat, outer) && !holes.some(hole => inRing(location.lng, location.lat, hole))) ? boundary.area : null;
}
export function requireDeliveryCoverage(location) {
  const area = deliveryAreaFor(location);
  if (!area) fail("outside_delivery_area", 422);
  return area;
}
