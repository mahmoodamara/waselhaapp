import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Package } from "lucide-react";
import { api } from "../api.js";
import { Money } from "../components/UI.jsx";
import { Icon, useCopy, useWorkspace } from "./components.jsx";
import { goodsInput, unifiedPayload, quickSizes, quickVehicles, vehicleFor } from "./quickPayload.js";
import "./quickRequest.css";

const newOperationId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), n => n.toString(16).padStart(2, "0")).join("");
const read = key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
const forget = key => { try { localStorage.removeItem(key); } catch {} };
const vehicleCopy = { motorcycle: "qrBike", car: "qrCar" };
const sizeCopy = { small: "qrSmall", medium: "qrMedium", large: "qrLarge" };
const boxSize = { small: 18, medium: 26, large: 34 };

// A numbered step. The number is decoration; the heading names the field.
function Step({ n, id, title, hint, children }) {
  return <div className="qr-step">
    <span className="qr-num" aria-hidden="true">{n}</span>
    <h2 id={id}>{title}</h2>
    {hint && <span className="qr-hint" id={`${id}-hint`}>{hint}</span>}
    <div className="qr-body">{children}</div>
  </div>;
}
// Options drawn as cards but still real radios, named by their title alone.
function Cards({ id, name, kind, value, options, onChange, disabled, isDisabled, title, sub, icon }) {
  return <div className={`qr-cards qr-${kind}`} role="radiogroup" aria-labelledby={id}>
    {options.map(option => <label key={option} className={value === option ? "qr-option selected" : "qr-option"}>
      <input type="radio" name={name} value={option} checked={value === option} aria-labelledby={`${id}-${option}`}
        disabled={disabled || isDisabled?.(option)} onChange={() => onChange(option)} />
      <span className="qr-check" aria-hidden="true"><Icon name="check" size={14} /></span>
      <span className="qr-option-icon" aria-hidden="true">{icon(option)}</span>
      <span className="qr-option-text"><strong id={`${id}-${option}`}>{title(option)}</strong><small>{sub(option)}</small></span>
    </label>)}
  </div>;
}
export default function QuickRequest() {
  const { me, orders, permissions, update } = useWorkspace(), { t, c } = useCopy(), navigate = useNavigate();
  const pendingKey = `waselha.quick-request.${me._id}`, prefsKey = `waselha.quick-request.prefs.${me._id}`;
  // An unconfirmed earlier attempt is restored exactly, so a retry is the same order.
  const [pending] = useState(() => {
    const saved = read(pendingKey);
    return [2, 3].includes(saved?.workflowVersion) && /^[a-f0-9]{24}$/.test(saved.operationId) ? saved : null;
  });
  const prefs = read(prefsKey) || {};
  const [areas, setAreas] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const [area, setArea] = useState(pending?.serviceArea || prefs.area || me.pickupServiceArea || "");
  const [vehicle, setVehicle] = useState(pending?.vehicleType || prefs.vehicle || "motorcycle");
  const [size, setSize] = useState(pending?.parcelSize || prefs.size || "medium");
  // Goods are never remembered between orders: each invoice is different.
  const [goods, setGoods] = useState(pending?.goodsAmountAgorot == null ? "" : (pending.goodsAmountAgorot / 100).toFixed(2));
  const [phone, setPhone] = useState(pending?.customerPhone || ""), [name, setName] = useState(pending?.recipientName || "");
  const [payment, setPayment] = useState(pending?.goodsPaymentStatus || "unpaid"), [parcelReady, setParcelReady] = useState(pending?.parcelReady ?? null);
  const [payer, setPayer] = useState(pending?.deliveryFeePaidBy || prefs.payer || "customer");
  const [notes, setNotes] = useState(pending?.parcelDescription || ""), [reference, setReference] = useState(pending?.merchantOrderReference || "");
  const lock = useRef(false), operation = useRef(pending);
  useEffect(() => {
    let active = true;
    api("/orders/service-areas").then(values => { if (active) { setAreas(values); setArea(current => current || values[0] || ""); } },
      failure => { if (active) setError(failure); });
    return () => { active = false; };
  }, []);
  const chosenVehicle = vehicleFor(vehicle, size), amount = goodsInput(goods), locked = busy || !!operation.current;
  const estimate = permissions?.deliveryEstimatesAgorot?.[area] ?? null;
  const ready = !!me.pickupLocation && !!me.pickupServiceArea;
  const valid = !!operation.current || (!!phone.trim() && typeof parcelReady === "boolean" && !!chosenVehicle && amount !== null && goods.trim() !== "");
  // The first thing the store still has to do; shown instead of a button that is silently off.
  const missing = !phone.trim() ? "enterCustomerPhone" : typeof parcelReady !== "boolean" ? "chooseParcelReadiness" : !chosenVehicle ? "vehicle_type_required"
    : goods.trim() === "" ? "enterGoodsValue" : null;
  // The areas this store sends to most, so a repeat order is one tap.
  const frequent = (() => {
    const counts = {};
    for (const order of orders || []) if (order.serviceArea) counts[order.serviceArea] = (counts[order.serviceArea] || 0) + 1;
    return (areas || []).filter(value => counts[value]).sort((a, b) => counts[b] - counts[a]).slice(0, 5);
  })();
  const storeName = me.storeName || me.name, showMissing = missing && !busy && areas;
  async function submit(event) {
    event.preventDefault();
    if (lock.current || !valid) return;
    lock.current = true; setBusy(true); setError(null);
    // Keep the ID and payload after an unknown outcome, so retry is the same order.
    try {
      operation.current ||= { operationId: newOperationId(), ...unifiedPayload({ phone, name, vehicle, size, goods,
        goodsPaymentStatus: payment, parcelReady, deliveryFeePaidBy: payer, notes, reference }) };
      write(pendingKey, operation.current);
      const order = await api("/orders", { method: "POST", body: operation.current });
      forget(pendingKey);
      write(prefsKey, { vehicle: chosenVehicle, size, payer });
      update(order);
      navigate(`/store/orders/${order._id}/created`, { replace: true });
    } catch (failure) {
      setError(failure);
      if (failure.status && failure.status < 500) { operation.current = null; forget(pendingKey); }
    } finally { lock.current = false; setBusy(false); }
  }
  return <div className="qr">
    <header className="qr-head">
      <Link className="qr-back" to="/store" aria-label={c("back")}><Icon name="back" size={22} /></Link>
      <nav className="qr-crumbs" aria-label={c("newOrder")}>
        <Link to="/store/orders">{c("orders")}</Link><Icon name="chevron" size={14} /><span aria-current="page">{c("newOrder")}</span>
      </nav>
      <h1 tabIndex={-1}>{c("qrTitle")}</h1>
      <p className="qr-sub">{c("qrSubtitle")}</p>
    </header>
    {operation.current && !busy && <p className="callout" role="status">{t("unifiedRequestRecovery")}</p>}
    {!ready && <p className="callout"><Link to="/store/settings">{t("pickupSetupRequired")}</Link></p>}
    {permissions && !permissions.unifiedDeliveryEnabled && <p className="callout" role="status">{t("unified_delivery_disabled")}</p>}
    {error && <p role="alert" className="callout error">{t(error.code || "server_error")}</p>}
    <div className="qr-pickup">
      <span className="qr-pickup-icon" aria-hidden="true"><Icon name="store" size={22} /></span>
      <span className="qr-pickup-text"><small>{c("qrPickup")}</small><strong><bdi>{storeName}</bdi></strong></span>
      {ready && <span className="qr-badge">{c("qrPickupSet")}</span>}
    </div>
    <form className="qr-layout" onSubmit={submit}>
      <div className="qr-main">
        <Step n={1} id="qr-phone" title={t("customerPhone")}>
          <input aria-labelledby="qr-phone" type="tel" inputMode="tel" autoComplete="tel" dir="ltr" maxLength={30}
            value={phone} onChange={e => setPhone(e.target.value)} required={!pending} disabled={locked} />
        </Step>
        <details><summary>{t("additionalDetails")}</summary>
        <label className="mw-field"><span>{t("recipientName")} ({t("optional")})</span><input value={name} maxLength={2000} disabled={locked} onChange={e => setName(e.target.value)} /></label>
        <label className="mw-field"><span>{t("merchantOrderReference")}</span><input value={reference} maxLength={120} disabled={locked} onChange={e => setReference(e.target.value)} /></label>
        <label className="mw-field"><span>{t("parcelDescription")}</span><textarea value={notes} maxLength={2000} disabled={locked} onChange={e => setNotes(e.target.value)} /></label>
        <label className="mw-field"><span>{t("deliveryFeePaidBy")}</span><select aria-label={t("deliveryFeePaidBy")} value={payer} disabled={locked} onChange={e => setPayer(e.target.value)}>{["customer", "store"].map(p => <option key={p} value={p}>{t(`feePayer.${p}`)}</option>)}</select></label>
        {pending?.workflowVersion === 2 && <Step n={2} id="qr-area" title={t("deliveryArea")} hint={t("destinationAreaAutomatic")}>
          <div className="qr-select">
            <span className="qr-select-icon" aria-hidden="true"><Icon name="pin" size={20} /></span>
            <select aria-labelledby="qr-area" aria-describedby="qr-area-hint" value={area} disabled={locked || !areas} required
              onChange={e => setArea(e.target.value)}>
              <option value="">{t("chooseServiceArea")}</option>
              {areas?.map(value => <option key={value} value={value}>{t(`serviceArea.${value}`)}</option>)}
            </select>
            <span className="qr-select-chevron" aria-hidden="true"><Icon name="down" size={18} /></span>
          </div>
          {areas?.length > 1 && frequent.length > 0 && <div className="qr-chips">
            <span>{c("qrFrequent")}</span>
            {frequent.map(value => <button type="button" key={value} className={area === value ? "qr-chip selected" : "qr-chip"}
              aria-pressed={area === value} disabled={locked} onClick={() => setArea(value)}>{t(`serviceArea.${value}`)}</button>)}
          </div>}
        </Step>}
        <Step n="+" id="qr-vehicle" title={t("vehicleType")}>
          <Cards id="qr-vehicle" name="vehicle" kind="vehicle" value={chosenVehicle} options={quickVehicles} onChange={setVehicle}
            disabled={locked} isDisabled={value => size === "large" && value !== "car"}
            title={value => t(`vehicle.${value}`)} sub={value => c(vehicleCopy[value])}
            icon={value => <Icon name={value === "car" ? "car" : "bike"} size={34} />} />
          {size === "large" && <p className="mw-hint">{t("largeNeedsCar")}</p>}
        </Step>
        </details>
        <Step n={2} id="qr-size" title={c("size")}>
          <Cards id="qr-size" name="size" kind="size" value={size} options={quickSizes} onChange={setSize} disabled={locked}
            title={value => t(`size.${value}`)} sub={value => c(sizeCopy[value])}
            icon={value => <Package size={boxSize[value]} strokeWidth={1.5} />} />
        </Step>
        <Step n={3} id="qr-goods" title={t("goodsValueOnly")} hint={c("qrGoodsHint")}>
          <div className="qr-money">
            <input aria-labelledby="qr-goods" aria-describedby="qr-goods-hint" inputMode="decimal" dir="ltr" required placeholder="0.00"
              value={goods} disabled={locked} aria-invalid={goods.trim() !== "" && amount === null}
              onChange={event => setGoods(event.target.value)} />
            <span className="qr-currency" aria-hidden="true">₪ {c("qrShekel")}</span>
          </div>
          {goods.trim() !== "" && amount === null && <p role="alert" className="mw-hint">{c("invalidMoney")}</p>}
          <label className="mw-field"><span>{t("goodsPaymentStatus")}</span><select aria-label={t("goodsPaymentStatus")} value={payment} disabled={locked} onChange={e => setPayment(e.target.value)}>
            <option value="unpaid">{t("goodsUnpaid")}</option><option value="prepaid">{t("goodsPrepaid")}</option>
          </select></label>
        </Step>
        <Step n={4} id="qr-readiness" title={t("readinessPrompt")}><fieldset disabled={locked} aria-labelledby="qr-readiness">
          <label><input type="radio" name="parcelReady" checked={parcelReady === true} onChange={() => setParcelReady(true)} />{t("readyForPickup")}</label>
          <label><input type="radio" name="parcelReady" checked={parcelReady === false} onChange={() => setParcelReady(false)} />{t("beingPrepared")}</label>
        </fieldset></Step>
      </div>
      <aside className="qr-summary" aria-labelledby="qr-summary-title">
        <h2 id="qr-summary-title">{c("qrSummary")}</h2>
        <dl className="qr-rows">
          <div><dt>{c("qrFrom")}</dt><dd><bdi>{storeName}</bdi></dd></div>
          <div><dt>{c("qrTo")}</dt><dd>{t("destinationAreaAutomatic")}</dd></div>
          <div><dt>{c("qrVehicleRow")}</dt><dd>{chosenVehicle ? t(`vehicle.${chosenVehicle}`) : "—"}</dd></div>
          <div><dt>{c("size")}</dt><dd>{t(`size.${size}`)} — {c(sizeCopy[size])}</dd></div>
          <div><dt>{c("qrGoodsRow")}</dt><dd>{goods.trim() !== "" && amount !== null ? <Money value={amount} /> : "—"}</dd></div>
        </dl>
        <p className="qr-note"><Icon name="info" size={20} /><span>{t("unifiedAfterCreate")}</span></p>
        <div className="qr-fee">
          {estimate == null
            ? <><small>{c("qrFee")}</small><strong>{c("qrFeeAuto")}</strong></>
            : <><small>{t("deliveryEstimate")}</small><strong><Money value={estimate} /></strong><span>{t("estimateNotice")}</span></>}
        </div>
        <div className="qr-action mw-form-action">
          <button className="qr-submit" aria-describedby={showMissing ? "quick-missing" : undefined}
            disabled={busy || !areas || !valid || !ready || !permissions?.quickDeliveryEnabled || (!pending && !permissions?.unifiedDeliveryEnabled)}>
            {t(busy ? "loading" : "createAndShare")}<Icon name="zap" size={20} />
          </button>
        </div>
        {showMissing && <p id="quick-missing" className="qr-missing">{t(missing)}</p>}
        <p className="qr-auth">{t("unifiedAuthorization")}</p>
        <div className="qr-next">
          <h3>{c("qrNext")}</h3>
          <ol>{[1, 2, 3].map(n => <li key={n}><span aria-hidden="true">{n}</span>{t(`unifiedNext${n}`)}</li>)}</ol>
        </div>
      </aside>
    </form>
  </div>;
}
