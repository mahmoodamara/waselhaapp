import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { Icon, useCopy } from "../merchant/components.jsx";
import LocationPicker from "./LocationPicker.jsx";
import { serviceAreaCenter } from "../serviceAreaMap.js";
import "./pickupLocation.css";

// A numbered step, drawn like the steps of the quick request. The number is
// decoration; the heading names the step.
function Step({ n, done, title, hint, children }) {
  return <section className="ps-step">
    <span className={`ps-num ${done ? "done" : ""}`} aria-hidden="true">{done ? <Icon name="check" size={14} /> : n}</span>
    <h2>{title}</h2>
    {hint && <p className="ps-hint">{hint}</p>}
    <div className="ps-body">{children}</div>
  </section>;
}

// The store's pickup setup, in two steps: the town, then the exact point on the
// map. New orders copy both; changing them later never moves an order that
// already exists.
export default function PickupLocation({ me, onSaved }) {
  const { c, t } = useCopy();
  const saved = me.pickupLocation;
  const [editing, setEditing] = useState(!saved);
  const [areas, setAreas] = useState(null), [area, setArea] = useState(me.pickupServiceArea || ""),
    [areaBusy, setAreaBusy] = useState(false), [areaError, setAreaError] = useState(null),
    [areaAttempt, setAreaAttempt] = useState(0);
  const areaLock = useRef(false);
  useEffect(() => {
    let active = true;
    setAreaError(null);
    api("/orders/service-areas").then(values => { if (active) {
      setAreas(values);
      setArea(current => current || (values.length === 1 ? values[0] : ""));
    } },
      error => { if (active) setAreaError(error); });
    return () => { active = false; };
  }, [areaAttempt]);
  async function saveArea(event) {
    event.preventDefault();
    if (areaLock.current || !area) return;
    areaLock.current = true;
    setAreaBusy(true); setAreaError(null);
    try { onSaved(await api("/store/pickup-service-area", { method: "PUT", body: { pickupServiceArea: area } })); }
    catch (error) { setAreaError(error); }
    finally { areaLock.current = false; setAreaBusy(false); }
  }
  async function save(body) {
    onSaved(await api("/store/pickup-location", { method: "PUT", body }));
    setEditing(false);
  }
  const areaDone = !!me.pickupServiceArea;
  const areaPending = !areaDone || area !== me.pickupServiceArea || areaBusy;
  return (
    <div className="ps">
      <header className="ps-head">
        <Link className="ps-back" to="/store/account" aria-label={c("back")}><Icon name="back" size={22} /></Link>
        <nav className="ps-crumbs" aria-label={c("settings")}>
          <Link to="/store">{c("home")}</Link><Icon name="chevron" size={14} /><span aria-current="page">{c("settings")}</span>
        </nav>
        <h1 tabIndex={-1}>{c("settings")}</h1>
        {!(areaDone && saved) && <p className="ps-sub">{t("settingsSetupIntro")}</p>}
      </header>
      <div className="ps-main">
        <Step n={1} done={areaDone} title={t("settingsStepArea")} hint={t("storeAreaHint")}>
          <form className="ps-area-form" onSubmit={saveArea}>
            <div className="ps-select">
              <span className="ps-select-icon" aria-hidden="true"><Icon name="pin" size={20} /></span>
              <select required aria-label={t("pickupServiceArea")} value={area} disabled={areaBusy || !areas}
                onChange={event => setArea(event.target.value)}>
                <option value="">{t("chooseServiceArea")}</option>
                {areas?.map(value => <option key={value} value={value}>{t(`serviceArea.${value}`)}</option>)}
              </select>
              <span className="ps-select-chevron" aria-hidden="true"><Icon name="down" size={18} /></span>
            </div>
            <button disabled={areaBusy || !areas || !area || area === me.pickupServiceArea}>{t(areaBusy ? "savingLocation" : "savePickupServiceArea")}</button>
            {areaError && <div role="alert" className="callout error">{t(areaError.code || "server_error")}
              {!areas && <button type="button" className="quiet" onClick={() => setAreaAttempt(n => n + 1)}>{t("retryLocation")}</button>}
            </div>}
          </form>
          {!areas && !areaError && <p role="status" className="ps-note">{t("loadingServiceAreas")}</p>}
          {areas?.length === 0 && <p role="status" className="callout attention">{t("noServiceAreas")}</p>}
          {areaDone && !areaPending && <p role="status" className="ps-saved-note">{t("storeAreaSaved")} · {t(`serviceArea.${me.pickupServiceArea}`)}</p>}
        </Step>
        <Step n={2} done={!!saved} title={t("storeEntranceTitle")}>
          {areaPending && <p className="callout attention" role="status">{t("storeSaveAreaFirst")}</p>}
          {!areaPending && editing ? (
            <>
              <LocationPicker
                value={saved}
                center={serviceAreaCenter(me.pickupServiceArea)}
                centerZoom={14}
                purpose="pickup"
                canEdit
                title="pickupLocation"
                showTitle={false}
                confirmKey="saveStoreLocation"
                searchPath="/maps/search"
                reversePath="/maps/reverse"
                onConfirm={save}
              />
              {saved && (
                <button type="button" className="quiet" onClick={() => setEditing(false)}>
                  {t("close")}
                </button>
              )}
            </>
          ) : saved && !areaPending ? (
            <div className="ps-saved">
              <span className="ps-saved-icon" aria-hidden="true"><Icon name="pin" size={22} /></span>
              <div><strong>{t("storeLocationConfirmed")}</strong>
                <p dir="auto">{saved.address || t("storeEntranceSaved")}</p>
                <a href={`https://www.openstreetmap.org/?mlat=${saved.lat}&mlon=${saved.lng}#map=18/${saved.lat}/${saved.lng}`}
                  target="_blank" rel="noopener noreferrer">{t("viewStoreOnMap")}</a>
              </div>
              <button type="button" className="quiet" onClick={() => setEditing(true)}>
                <Icon name="pencil" size={16} />{t("editStoreLocation")}
              </button>
            </div>
          ) : null}
        </Step>
      </div>
    </div>
  );
}
