// Google encoded polyline (precision 5), shared by the backend (off-route
// detection) and the driver app (map rendering). No dependency. Decoding is
// strict: any malformed or out-of-range input returns null, never a partial line.
export const MAX_POLYLINE_CHARS = 200_000;
export const MAX_POLYLINE_POINTS = 20_000;

export function decodePolyline(encoded) {
  if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > MAX_POLYLINE_CHARS) return null;
  const points = [];
  let index = 0, lat = 0, lng = 0;
  const next = () => {
    let result = 0, shift = 0, byte;
    do {
      if (index >= encoded.length || shift > 30) return null;
      byte = encoded.charCodeAt(index++) - 63;
      if (byte < 0 || byte > 63) return null;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    const dLat = next(), dLng = dLat === null ? null : next();
    if (dLat === null || dLng === null) return null;
    lat += dLat; lng += dLng;
    const point = { latitude: lat / 1e5, longitude: lng / 1e5 };
    if (Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180) return null;
    if (points.push(point) > MAX_POLYLINE_POINTS) return null;
  }
  return points;
}

// Test/fixture helper; production code only decodes.
export function encodePolyline(points) {
  let previousLat = 0, previousLng = 0, output = "";
  const write = value => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    while (v >= 0x20) { output += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    output += String.fromCharCode(v + 63);
  };
  for (const { latitude, longitude } of points) {
    const lat = Math.round(latitude * 1e5), lng = Math.round(longitude * 1e5);
    write(lat - previousLat); write(lng - previousLng);
    previousLat = lat; previousLng = lng;
  }
  return output;
}

// Shortest distance in metres from a point to the line, using a local flat
// projection around the point. Accurate to a few metres at city scale, which is
// all off-route detection needs.
export function distanceToPolylineMeters(point, line) {
  if (!Array.isArray(line) || line.length === 0) return Infinity;
  const metresPerDegree = 111_320, cosLat = Math.cos(point.latitude * Math.PI / 180);
  const project = p => [(p.longitude - point.longitude) * metresPerDegree * cosLat, (p.latitude - point.latitude) * metresPerDegree];
  let best = Infinity, [ax, ay] = project(line[0]);
  if (line.length === 1) return Math.hypot(ax, ay);
  for (let i = 1; i < line.length; i++) {
    const [bx, by] = project(line[i]);
    const dx = bx - ax, dy = by - ay, lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    ax = bx; ay = by;
  }
  return best;
}
