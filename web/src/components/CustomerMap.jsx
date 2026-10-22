import { useEffect, useRef, useState } from "react";
import { MapPin } from "lucide-react";
import { useLanguage } from "./UI.jsx";

// The customer's map: the pin stays in the middle of the screen and the person
// moves the map under it. Only a move made by the person reports a position;
// views set by the page (a GPS fix, a search result, a resize) never do, so
// nothing is chosen on the customer's behalf.
const tiles = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const attribution =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>';
const round = (n) => Number(n.toFixed(6));
// Less than about a metre: the same place.
const sameSpot = (a, b) => !!a && Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lng - b.lng) < 1e-5;

export default function CustomerMap({
  point, // where the pin is (candidate, or the confirmed place); null before one exists
  follow, // set only for a GPS fix or a search result: the map flies there
  center, // where an empty map opens (the store's town), never a chosen place
  centerZoom = 16,
  interactive = true,
  disabled = false,
  onMove,
  driverLocation = null,
  children,
}) {
  const { t } = useLanguage();
  const box = useRef(null),
    leaflet = useRef(null), driver = useRef(null), destination = useRef(null),
    map = useRef(null),
    latest = useRef({}),
    silent = useRef(false),
    lastMove = useRef(null);
  const [ready, setReady] = useState(false),
    [failed, setFailed] = useState(false),
    [attempt, setAttempt] = useState(0),
    [moving, setMoving] = useState(false),
    [moved, setMoved] = useState(false);
  latest.current = { point, center, centerZoom, onMove, disabled };

  // Run a change of view made by the page without reporting it as a move.
  const quietly = (fn) => {
    silent.current = true;
    try { fn(); } finally { silent.current = false; }
  };

  useEffect(() => {
    setFailed(false);
    let disposed = false, instance = null, observer = null;
    (async () => {
      const [module] = await Promise.all([import("leaflet"), import("leaflet/dist/leaflet.css")]);
      if (disposed || !box.current) return;
      const L = module.default ?? module;
      leaflet.current = L;
      const { point, center, centerZoom } = latest.current;
      const start = point ?? center;
      instance = L.map(box.current, {
        center: start ? [start.lat, start.lng] : [20, 0],
        zoom: point ? 17 : start ? centerZoom : 2,
        zoomControl: false,
        scrollWheelZoom: interactive,
        dragging: interactive && !latest.current.disabled,
        touchZoom: interactive,
        doubleClickZoom: interactive,
        boxZoom: false,
        keyboard: false,
        // Leaflet's delayed zoom callback otherwise runs after the map is removed.
        zoomAnimation: false,
      });
      L.tileLayer(tiles, { maxZoom: 19, attribution }).addTo(instance);
      instance.on("movestart", () => { if (!silent.current) setMoving(true); });
      instance.on("moveend", () => {
        setMoving(false);
        if (silent.current || !latest.current.onMove || latest.current.disabled) return;
        const at = instance.getCenter().wrap();
        const next = { lat: round(at.lat), lng: round(at.lng) };
        if (sameSpot(lastMove.current, next)) return;
        lastMove.current = next;
        setMoved(true);
        latest.current.onMove(next.lat, next.lng);
      });
      observer = new ResizeObserver(() => { if (!disposed) quietly(() => instance.invalidateSize()); });
      observer.observe(box.current);
      map.current = instance;
      setReady(true);
    })().catch(() => { if (!disposed) setFailed(true); });
    return () => {
      disposed = true;
      map.current = null;
      driver.current = null; destination.current = null;
      setReady(false);
      observer?.disconnect();
      instance?.remove();
    };
  }, [attempt, interactive]);

  // A GPS fix or a search result: bring the map to it.
  useEffect(() => {
    if (!ready || !follow) return;
    quietly(() => map.current.setView([follow.lat, follow.lng], Math.max(map.current.getZoom(), 17), { animate: false }));
    lastMove.current = { lat: follow.lat, lng: follow.lng };
  }, [ready, follow?.lat, follow?.lng]);

  // A town is only a starting view: it never moves a map that already shows a place.
  useEffect(() => {
    if (ready && !point && center)
      quietly(() => map.current.setView([center.lat, center.lng], centerZoom, { animate: false }));
  }, [ready, center?.lat, center?.lng, centerZoom, !!point]);

  // A place saved elsewhere (or a refresh) while nothing is being chosen.
  useEffect(() => {
    if (ready && point && !follow && !moved)
      quietly(() => map.current.setView([point.lat, point.lng], Math.max(map.current.getZoom(), 17), { animate: false }));
  }, [ready, point?.lat, point?.lng]);

  useEffect(() => {
    if (!ready) return;
    const drag = map.current.dragging;
    if (interactive && !disabled) drag.enable(); else drag.disable();
  }, [ready, interactive, disabled]);

  useEffect(() => {
    if (!ready || interactive) return;
    const L = leaflet.current, instance = map.current;
    if (point) {
      if (!destination.current) destination.current = L.circleMarker([point.lat, point.lng],
        { radius: 9, color: "#fff", weight: 3, fillColor: "#af4b28", fillOpacity: 1 }).addTo(instance);
      else destination.current.setLatLng([point.lat, point.lng]);
    } else { destination.current?.remove(); destination.current = null; }
    if (!driverLocation) { driver.current?.remove(); driver.current = null; return; }
    const at = [driverLocation.latitude, driverLocation.longitude];
    if (!driver.current) driver.current = L.marker(at, { keyboard: true,
      icon: L.divIcon({ className: "cu-driver-marker", html: '<span aria-hidden="true">●</span>', iconSize: [32, 32], iconAnchor: [16, 16] }) }).addTo(instance);
    else driver.current.setLatLng(at);
    driver.current.getElement()?.setAttribute("aria-label", t("trackingDriverMarker"));
    if (point) instance.fitBounds([at, [point.lat, point.lng]], { padding: [55, 75], maxZoom: 17, animate: false });
    else instance.setView(at, 16, { animate: false });
  }, [ready, interactive, point?.lat, point?.lng, driverLocation?.latitude, driverLocation?.longitude, t]);

  return (
    <div className="cu-map" aria-busy={!ready}>
      <div ref={box} className="cu-map-canvas" role="region" aria-label={t("locationMap")} />
      {ready && interactive && (
        <span className={`cu-pin ${moving ? "lifted" : ""} ${point ? "" : "unset"}`} aria-hidden="true">
          <span className="cu-pin-halo" />
          <MapPin size={46} strokeWidth={1.5} className="cu-pin-icon" />
          <span className="cu-pin-shadow" />
        </span>
      )}
      {!ready && (
        <p className="cu-map-note" role="status">
          {t(failed ? "mapLoadFailed" : "mapLoading")}
          {failed && <button type="button" className="cu-link" onClick={() => setAttempt((n) => n + 1)}>{t("retryLocation")}</button>}
        </p>
      )}
      {children}
    </div>
  );
}
