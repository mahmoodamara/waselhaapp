import { useEffect, useReducer, useRef, useState } from "react";
import { LocateFixed, MapPin, Search, Store } from "lucide-react";
import { api } from "../api.js";
import { useLanguage } from "./UI.jsx";
import CustomerMap from "./CustomerMap.jsx";
import { initialState, pickerReducer, canConfirm, confirmBody } from "../locationPicker.js";

// Step 1 of the customer page: where to deliver. The map fills the screen with
// the pin in the middle; a sheet below shows the address and the confirm button.
// A place is only a candidate until the confirm button saves it on the server.
export default function CustomerLocation({
  value, center, disabled = false, storeName, searchPath, reversePath,
  onConfirm, onContinue, onError, onPendingChange, tools, headingRef, notice, embedded = false, compact = false,
}) {
  const { t, language } = useLanguage();
  const [state, dispatch] = useReducer(pickerReducer, initialState);
  const [query, setQuery] = useState(""), [results, setResults] = useState(null), [searching, setSearching] = useState(false),
    [searchOpen, setSearchOpen] = useState(false), [confirming, setConfirming] = useState(false), [error, setError] = useState(null);
  const mounted = useRef(false), gpsRequest = useRef(0), searchRequest = useRef(0), confirmLock = useRef(false);
  const { candidate } = state;
  const autoConfirm = useRef(null);
  const locked = disabled || confirming;
  const point = candidate ?? (value ? { lat: value.lat, lng: value.lng } : null);
  const pending = !!candidate && canConfirm(candidate, value);
  const candidateKey = candidate ? JSON.stringify(confirmBody(candidate)) : null;
  autoConfirm.current = confirm;
  useEffect(() => {
    if (!embedded || !pending || confirming || disabled || !candidateKey) return;
    const timer = setTimeout(() => { void autoConfirm.current(); }, 650);
    return () => clearTimeout(timer);
  }, [embedded, candidateKey, pending, disabled]);
  // Only a GPS fix or a search result moves the map; a pin the person placed is already where they looked.
  const follow = candidate && candidate.source !== "pin" ? candidate : null;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; gpsRequest.current++; searchRequest.current++; };
  }, []);
  useEffect(() => { onPendingChange?.(pending || state.locating); }, [pending, state.locating, onPendingChange]);
  useEffect(() => () => onPendingChange?.(false), []);

  // A readable address for a GPS fix or a moved pin. It is optional: failures
  // are silent and the place can still be confirmed without it.
  const needsAddress = !!candidate && !candidate.address;
  useEffect(() => {
    if (!needsAddress || !reversePath) return;
    const { lat, lng } = candidate;
    const timer = setTimeout(async () => {
      try {
        const found = await api(`${reversePath}?lat=${lat}&lng=${lng}&lang=${language}`);
        if (mounted.current && found.label) dispatch({ type: "address-resolved", lat, lng, label: found.label });
      } catch {
        // Optional.
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [needsAddress, candidate?.lat, candidate?.lng, reversePath, language]);

  function choose(action) {
    if (locked || confirmLock.current) return;
    gpsRequest.current++;
    searchRequest.current++;
    setSearching(false);
    setResults(null);
    setError(null);
    dispatch(action);
  }
  function locate() {
    if (locked || confirmLock.current) return;
    setError(null);
    if (!window.isSecureContext) return dispatch({ type: "gps-error", insecure: true });
    if (!navigator.geolocation) return dispatch({ type: "gps-error", denied: false });
    dispatch({ type: "gps-start" });
    const request = ++gpsRequest.current;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (!mounted.current || request !== gpsRequest.current) return;
        dispatch({ type: "gps-success", lat: Number(position.coords.latitude.toFixed(6)),
          lng: Number(position.coords.longitude.toFixed(6)), accuracy: position.coords.accuracy });
      },
      (failure) => {
        if (!mounted.current || request !== gpsRequest.current) return;
        dispatch({ type: "gps-error", denied: failure.code === 1, timeout: failure.code === 3 });
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  }
  async function search(event) {
    event.preventDefault();
    const text = query.trim();
    if (text.length < 3 || searching || locked) return;
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
    if (locked || confirmLock.current) return;
    // Nothing new was chosen: the saved place stands, so go on without a request.
    if (!pending) { if (value) onContinue(); return; }
    confirmLock.current = true;
    gpsRequest.current++;
    setConfirming(true);
    setError(null);
    try {
      await onConfirm(confirmBody(candidate));
      if (mounted.current) { dispatch({ type: "reset" }); setResults(null); setQuery(""); }
    } catch (failure) {
      if (!mounted.current) return;
      onError?.(failure);
      setError(failure);
    } finally {
      confirmLock.current = false;
      if (mounted.current) setConfirming(false);
    }
  }

  const address = candidate ? candidate.address || t("pinOnMap") : value?.address || (value ? t("pinOnMap") : "");
  const accuracy = candidate?.accuracy
    ? t("locationAccuracy").replace("{meters}", new Intl.NumberFormat(language === "he" ? "he-IL" : "ar-IL").format(Math.ceil(candidate.accuracy)))
    : "";
  return (
    <div className={embedded ? `cu-location-inline${compact ? " compact" : ""}` : "cu-stage"}>
      <CustomerMap point={point} follow={follow} center={center} disabled={locked} interactive
        onMove={(lat, lng) => choose({ type: "pin-move", lat, lng })}>
        {!compact && <p className="cu-pill"><Store size={16} aria-hidden="true" /><span>{t("orderFromStore").replace("{store}", storeName ?? "")}</span></p>}
        {tools}
        {!point && <p className="cu-tip" role="status">{t("moveMapHint")}</p>}
        {/* The same action is the soft button in the sheet; keep one accessible control. */}
        <button type="button" className="cu-fab" aria-hidden="true" tabIndex={-1} disabled={locked || state.locating} onClick={locate}>
          <LocateFixed size={22} aria-hidden="true" />
        </button>
      </CustomerMap>
      <section className="cu-sheet" aria-labelledby="cu-where">
        {!embedded && <><div className="cu-progress" aria-hidden="true"><i className="on" /><i /></div>
        <p className="cu-step">{t("stepOfTwo").replace("{n}", "1")}</p></>}
        {compact ? <h2 id="cu-where">{t("whereToDeliver")}</h2> : <h1 id="cu-where" tabIndex={-1} ref={headingRef}>{t("whereToDeliver")}</h1>}
        <div className="cu-address" role="status">
          <span className="cu-icon"><MapPin size={20} aria-hidden="true" /></span>
          <span className="cu-address-text">
            <strong dir="auto">{address || t("noPlaceYet")}</strong>
            <small>{state.locating ? t("locating") : point ? accuracy || t("pinAtThisPlace") : t("moveMapHint")}</small>
          </span>
        </div>
        <div className={compact ? "cu-location-actions" : undefined}>
        <button type="button" className="cu-soft" disabled={locked || state.locating} onClick={locate}>
          <LocateFixed size={18} aria-hidden="true" />{t(state.locating ? "locating" : compact ? "customerUseLocation" : "useMyLocation")}
        </button>
        {searchOpen ? (
          <form className="cu-search" onSubmit={search}>
            <input type="search" autoFocus disabled={locked} value={query} maxLength={200} dir="auto"
              placeholder={t("searchPlaceholder")} aria-label={t("searchAddress")}
              onChange={(event) => { searchRequest.current++; setSearching(false); setResults(null); setQuery(event.target.value); }} />
            <button disabled={locked || searching || query.trim().length < 3}>{t(searching ? "searchingAddress" : "searchButton")}</button>
          </form>
        ) : (
          <button type="button" className="cu-link" disabled={locked} onClick={() => setSearchOpen(true)}>
            <Search size={16} aria-hidden="true" />{t("searchAddress")}
          </button>
        )}
        </div>
        {state.notice && <p className="callout error" role="alert">{t(state.notice)}</p>}
        {results?.length === 0 && <p className="cu-muted">{t("noResults")}</p>}
        {results?.length > 0 && (
          <ul className="cu-results">
            {results.map((place, index) => (
              <li key={`${place.lat},${place.lng},${index}`}>
                <button type="button" disabled={locked} dir="auto"
                  onClick={() => { choose({ type: "search-pick", lat: place.lat, lng: place.lng, label: place.label }); setSearchOpen(false); }}>
                  {place.label}
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="callout error" role="alert">{t(error.code ?? error.message)}</p>}
        {notice}
        {(!embedded || error) && <button type="button" className="cu-primary" disabled={locked || (!pending && !value)} onClick={confirm}>
          {t(confirming ? "savingLocation" : "confirmPlace")}
        </button>}
      </section>
    </div>
  );
}
