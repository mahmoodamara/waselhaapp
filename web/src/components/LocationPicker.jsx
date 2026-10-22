import { useEffect, useReducer, useRef, useState } from "react";
import { api } from "../api.js";
import { LocateFixed } from "lucide-react";
import { useLanguage } from "./UI.jsx";
import {
  initialState,
  pickerReducer,
  canConfirm,
  confirmBody,
} from "../locationPicker.js";

// Chooses and confirms one place on a map: current position, address search or
// a pin. Selecting only creates a candidate; nothing is saved until the person
// presses the confirm button, and `value` (from the server) is the only thing
// shown as confirmed.
const tiles = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const attribution =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';
const round = (n) => Number(n.toFixed(6));

export default function LocationPicker({
  value,
  center,
  canEdit,
  searchPath,
  reversePath,
  onConfirm,
  onError,
  title = "deliveryLocation",
  confirmKey = "confirmLocation",
  hint,
  disabled = false,
  onPendingChange,
  showTitle = true,
  purpose = "delivery",
  centerZoom = 16,
}) {
  const { t, language } = useLanguage();
  const pickup = purpose === "pickup";
  const [state, dispatch] = useReducer(pickerReducer, initialState);
  const [query, setQuery] = useState(""),
    [results, setResults] = useState(null),
    [searching, setSearching] = useState(false),
    [confirming, setConfirming] = useState(false),
    [error, setError] = useState(null),
    [ready, setReady] = useState(false),
    [mapError, setMapError] = useState(false),
    [mapAttempt, setMapAttempt] = useState(0);
  const box = useRef(null),
    map = useRef(null),
    marker = useRef(null),
    leaflet = useRef(null),
    latest = useRef({}),
    mounted = useRef(false),
    gpsRequest = useRef(0),
    searchRequest = useRef(0),
    confirmLock = useRef(false);
  const { candidate } = state;
  const shown = candidate ?? (value ? { lat: value.lat, lng: value.lng } : null);
  latest.current = { shown, center, centerZoom, disabled: disabled || confirming };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; gpsRequest.current++; searchRequest.current++; };
  }, []);
  useEffect(() => { onPendingChange?.(!!candidate && canConfirm(candidate, value)); },
    [candidate, value, onPendingChange]);

  // The map is loaded on demand so pages without a picker do not pay for it.
  useEffect(() => {
    if (!canEdit) return;
    setMapError(false);
    let disposed = false,
      instance = null,
      observer = null;
    (async () => {
      const [module] = await Promise.all([
        import("leaflet"),
        import("leaflet/dist/leaflet.css"),
      ]);
      if (disposed || !box.current) return;
      const L = module.default ?? module;
      const start = latest.current.shown ?? latest.current.center;
      instance = L.map(box.current, {
        center: start ? [start.lat, start.lng] : [20, 0],
        zoom: latest.current.shown ? 16 : start ? latest.current.centerZoom : 2,
        scrollWheelZoom: false,
        // A saved point can close this picker immediately. Leaflet's delayed
        // zoom transition callback otherwise runs after its map pane is removed.
        zoomAnimation: false,
      });
      L.tileLayer(tiles, { maxZoom: 19, attribution }).addTo(instance);
      // wrap(): panning across the date line must still give a valid longitude.
      instance.on("click", (event) => {
        if (latest.current.disabled) return;
        const at = event.latlng.wrap();
        choose({ type: "pin-move", lat: round(at.lat), lng: round(at.lng) });
      });
      observer = new ResizeObserver(() => { if (!disposed) instance?.invalidateSize(); });
      observer.observe(box.current);
      leaflet.current = L;
      map.current = instance;
      setReady(true);
    })().catch(() => { if (!disposed) setMapError(true); });
    return () => {
      disposed = true;
      marker.current = null;
      map.current = null;
      setReady(false);
      observer?.disconnect();
      instance?.remove();
    };
  }, [canEdit, mapAttempt]);

  // A town is a starting view, not a candidate. Never move an existing pin
  // just because a background update or an area selection changed the centre.
  useEffect(() => {
    if (ready && !shown && center)
      map.current?.setView([center.lat, center.lng], centerZoom, { animate: false });
  }, [ready, center?.lat, center?.lng, centerZoom, !!shown]);

  // Keep one draggable pin on the shown position.
  useEffect(() => {
    const L = leaflet.current,
      current = map.current;
    if (!ready || !current) return;
    if (!shown) {
      marker.current?.remove();
      marker.current = null;
      return;
    }
    const at = [shown.lat, shown.lng];
    if (marker.current) marker.current.setLatLng(at);
    else {
      marker.current = L.marker(at, {
        draggable: true,
        icon: L.divIcon({
          className: "map-pin",
          iconSize: [30, 30],
          iconAnchor: [15, 30],
        }),
      }).addTo(current);
      marker.current.on("dragend", (event) => {
        if (latest.current.disabled) return;
        const to = event.target.getLatLng().wrap();
        choose({ type: "pin-move", lat: round(to.lat), lng: round(to.lng) });
      });
    }
    // Follow GPS and search results; never fight a pin the person is placing.
    if (candidate && candidate.source !== "pin")
      current.setView(at, Math.max(current.getZoom(), 17), { animate: false });
  }, [ready, shown?.lat, shown?.lng]);
  useEffect(() => {
    if (disabled || confirming) marker.current?.dragging?.disable();
    else marker.current?.dragging?.enable();
  }, [disabled, confirming, ready, shown?.lat, shown?.lng]);

  // A readable address for a GPS fix or a moved pin. It is optional: failures
  // are silent and the location can still be confirmed without it.
  const needsAddress = !!candidate && !candidate.address;
  useEffect(() => {
    if (!needsAddress || !reversePath) return;
    const { lat, lng } = candidate;
    const timer = setTimeout(async () => {
      try {
        const found = await api(
          `${reversePath}?lat=${lat}&lng=${lng}&lang=${language}`,
        );
        if (mounted.current && found.label)
          dispatch({ type: "address-resolved", lat, lng, label: found.label });
      } catch {
        // Optional.
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [needsAddress, candidate?.lat, candidate?.lng, reversePath, language]);

  function choose(action) {
    if (latest.current.disabled || confirmLock.current) return;
    gpsRequest.current++;
    searchRequest.current++;
    setSearching(false);
    setResults(null);
    setError(null);
    dispatch(action);
  }

  function locate() {
    if (latest.current.disabled || confirmLock.current) return;
    setError(null);
    if (!window.isSecureContext) {
      dispatch({ type: "gps-error", insecure: true });
      return;
    }
    if (!navigator.geolocation) {
      dispatch({ type: "gps-error", denied: false });
      return;
    }
    dispatch({ type: "gps-start" });
    const request = ++gpsRequest.current;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (!mounted.current || request !== gpsRequest.current || latest.current.disabled) return;
        dispatch({
          type: "gps-success",
          lat: round(position.coords.latitude),
          lng: round(position.coords.longitude),
          accuracy: position.coords.accuracy,
        });
      },
      (failure) => {
        if (!mounted.current || request !== gpsRequest.current || latest.current.disabled) return;
        dispatch({ type: "gps-error", denied: failure.code === 1, timeout: failure.code === 3 });
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  }
  async function search(event) {
    event.preventDefault();
    const text = query.trim();
    if (text.length < 3 || searching) return;
    setSearching(true);
    setError(null);
    setResults(null);
    const request = ++searchRequest.current;
    try {
      const found = await api(`${searchPath}?q=${encodeURIComponent(text)}&lang=${language}`);
      if (mounted.current && request === searchRequest.current) setResults(found);
    } catch (failure) {
      if (!mounted.current || request !== searchRequest.current) return;
      onError?.(failure);
      setError(failure);
    } finally {
      if (mounted.current && request === searchRequest.current) setSearching(false);
    }
  }
  async function confirm() {
    if (disabled || confirmLock.current || !canConfirm(candidate, value)) return;
    confirmLock.current = true;
    gpsRequest.current++;
    setConfirming(true);
    setError(null);
    try {
      await onConfirm(confirmBody(candidate));
      if (!mounted.current) return;
      dispatch({ type: "reset" });
      setResults(null);
      setQuery("");
    } catch (failure) {
      if (!mounted.current) return;
      onError?.(failure);
      setError(failure);
    } finally {
      confirmLock.current = false;
      if (mounted.current) setConfirming(false);
    }
  }
  return (
    <section className={`location-picker ${pickup ? "pickup-picker" : ""}`} aria-label={t(title)}>
      {showTitle && <h2>{t(title)}</h2>}
      {hint && <p className="muted">{t(hint)}</p>}
      {value && !candidate ? (
        <div className="callout success" role="status">
          <strong>{t(pickup ? "storeLocationConfirmed" : "locationConfirmed")}</strong>
          {value.address && <p dir="auto">{value.address}</p>}
        </div>
      ) : !candidate && !pickup ? (
        <p className="callout attention" role="status">
          {t("locationNotConfirmed")}
        </p>
      ) : null}
      {canEdit && (
        <>
          {/* The fastest way is the phone's own position: it is the main action until a place is chosen. */}
          <button
            type="button"
            className={`button-block ${candidate || value ? "quiet" : ""}`}
            disabled={disabled || confirming || state.locating}
            onClick={locate}
          >
            {pickup && <LocateFixed size={20} aria-hidden="true" />}
            {t(state.locating ? "locating" : pickup ? "useStoreLocation" : "useMyLocation")}
          </button>
          {pickup && <p className="pickup-gps-hint">{t("storeGpsHint")}</p>}
          {state.locating && <p className="muted" role="status">{t("locating")}</p>}
          {state.notice && <p className="callout error" role="alert">{t(state.notice)}</p>}
          <p className="or-divider">{t("orSearchAddress")}</p>
          {pickup && <p className="pickup-search-hint">{t("storeSearchHint")}</p>}
          <form className="search-row" onSubmit={search}>
            <input
              type="search"
              disabled={disabled || confirming}
              value={query}
              maxLength={200}
              dir="auto"
              placeholder={t("searchPlaceholder")}
              aria-label={t("searchAddress")}
              onChange={(event) => {
                searchRequest.current++;
                setSearching(false);
                setResults(null);
                setQuery(event.target.value);
              }}
            />
            <button disabled={disabled || confirming || searching || query.trim().length < 3}>
              {t(searching ? "searchingAddress" : "searchButton")}
            </button>
          </form>
          {results?.length === 0 && <p className="muted">{t("noResults")}</p>}
          {results?.length > 0 && (
            <ul className="search-results">
              {results.map((place, index) => (
                <li key={`${place.lat},${place.lng},${index}`}>
                  <button
                    type="button"
                    disabled={disabled || confirming}
                    className="quiet"
                    dir="auto"
                    onClick={() => {
                      choose({
                        type: "search-pick",
                        lat: place.lat,
                        lng: place.lng,
                        label: place.label,
                      });
                    }}
                  >
                    {place.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="muted">{t(pickup ? "storeMapHint" : "mapHint")}</p>
          {!ready && <p className="callout" role="status">{t(mapError ? "mapLoadFailed" : "mapLoading")}
            {mapError && <button type="button" className="quiet" onClick={() => setMapAttempt(n => n + 1)}>{t("retryLocation")}</button>}
          </p>}
          <div ref={box} className="map-box" role="region" aria-label={t("locationMap")} aria-busy={!ready} />
          {candidate && (
            <div className="callout attention" role="status">
              <strong>{t(pickup ? "storeReviewEntrance" : "selectedLocation")}</strong>
              <p dir="auto">{candidate.address || t("pinOnMap")}</p>
              {candidate.accuracy && <p>{t("locationAccuracy").replace("{meters}",
                new Intl.NumberFormat(language === "he" ? "he-IL" : "ar-IL").format(Math.ceil(candidate.accuracy)))}</p>}
            </div>
          )}
          {error && (
            <div className="callout error" role="alert">
              {t(error.code ?? error.message)}
            </div>
          )}
          <button
            type="button"
            className="confirm-location"
            disabled={disabled || confirming || !canConfirm(candidate, value)}
            onClick={confirm}
          >
            {t(confirming ? "savingLocation" : confirmKey)}
          </button>
        </>
      )}
    </section>
  );
}
