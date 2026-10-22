import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Check, ChevronRight, Info, Lock, MapPin, Phone, RefreshCw, Store, Truck } from "lucide-react";
import { api, money } from "../api.js";
import { Money, Notice, RoutePrice, Status, useAction, useLanguage } from "../components/UI.jsx";
import CustomerLocation from "../components/CustomerLocation.jsx";
import CustomerMap from "../components/CustomerMap.jsx";
import CustomerTrackingStatus from "../components/CustomerTrackingStatus.jsx";
import CustomerCheckout from "../components/CustomerCheckout.jsx";
import { useCustomerTracking } from "../useCustomerTracking.js";
import { orderNumber } from "../merchant/model.js";
import "./customer.css";
import { isUnifiedOrder, isQuickWorkflow } from "../../../shared/workflow.js";

// What the customer sees while waiting, by order status. `step` is how far the trip has got:
// 0 = confirmed/waiting for pickup, 2 = on the way, 3 = at the door.
const progress = {
  searching_driver: { title: "trackSearching", body: "trackSearchingBody", step: 0 },
  driver_assigned: { title: "trackAssigned", body: "trackAssignedBody", step: 0 },
  driver_at_store: { title: "trackAtStore", body: "trackAtStoreBody", step: 0 },
  collected: { title: "trackOnTheWay", body: "trackOnTheWayBody", step: 2 },
  driver_at_destination: { title: "trackArrived", body: "trackArrivedBody", step: 3 },
};
const stages = ["stageConfirmed", "stagePickedUp", "stageOnTheWay", "stageDelivery"];

export default function Customer() {
  const { token } = useParams(), { t, language, setLanguage } = useLanguage(), action = useAction();
  const [order, setOrder] = useState(null), [form, setForm] = useState(null);
  const [locationBusy, setLocationBusy] = useState(false), [locationDirty, setLocationDirty] = useState(false);
  const [refreshError, setRefreshError] = useState(null);
  const [step, setStep] = useState(1), [editing, setEditing] = useState(false);
  // "Ready now" or "later", chosen in the same step as the total (one confirmation).
  const [when, setWhen] = useState("now");
  const version = useRef(0), writing = useRef(false), reading = useRef(null), initialized = useRef(false), confirmedBefore = useRef(false);
  const heading = useRef(null), shownView = useRef(null);
  const orderRef = useRef(null);
  const confirmationAttempt = useRef(null);
  const tracking = useCustomerTracking(token, order?.status, event => {
    if (![...Object.keys(progress), "delivered", "cancelled", "delivery_failed", "returning", "returned"].includes(event.status) ||
      (orderRef.current && event.orderId !== orderRef.current.publicReference)) return;
    // Apply authoritative Socket status immediately. An older in-flight REST
    // read cannot restore a delivery code or a pre-delivery screen afterwards.
    if (orderRef.current && orderRef.current.status !== event.status) {
      version.current++; reading.current = null;
      const current = orderRef.current;
      const next = ["delivered", "cancelled", "returned"].includes(event.status)
        ? { publicReference: current.publicReference, storeName: current.storeName, status: event.status, canEdit: false }
        : { ...current, status: event.status, canEdit: ["searching_driver", "driver_assigned", "driver_at_store"].includes(event.status) };
      orderRef.current = next; setOrder(next);
    }
    if (!writing.current) void read().catch(() => {});
  });
  const quick = isQuickWorkflow(order), unified = isUnifiedOrder(order);
  // The server names this only while no driver has the order yet (gated quick orders).
  const askWhen = !!order?.dispatchState;
  const later = order?.dispatchState === "customer_later";
  const findingDriver = ["searching", "no_driver"].includes(order?.dispatchState);
  const shown = (locationBusy || locationDirty) && order?.priceSource === "route"
    ? { ...order, priceStatus: "pending", routeError: null, routeDistanceMeters: null,
      deliveryFeeAgorot: null, expectedCustomerCashAgorot: null, customerConfirmed: false } : order;
  function receive(o, replaceForm = false) {
    orderRef.current = o;
    setOrder(o);
    if (!initialized.current || replaceForm) {
      // A person who already saved a place opens the page on their details.
      if (!initialized.current) setStep(o.destinationLocation?.confirmedAt ? 2 : 1);
      initialized.current = true;
      setForm({ customerPhone: o.customerPhone ?? "",
        finalAddress: o.finalAddress || o.preliminaryAddress || "", deliveryInstructions: o.deliveryInstructions ?? "" });
      setWhen(o.customerConfirmed && o.customerAvailable === false ? "later" : "now");
    }
    setRefreshError(null);
  }
  function invalid(error) {
    if (error.code === "not_found") { orderRef.current = null; setOrder(null); setForm(null); }
  }
  function read() {
    if (reading.current) return reading.current;
    const revision = ++version.current;
    const job = (async () => {
    try {
      const o = await api(`/customer/${token}`);
      if (revision === version.current) receive(o);
    } catch (error) {
      if (revision !== version.current) return;
      invalid(error);
      setRefreshError(error);
      throw error;
    }
    })();
    reading.current = job;
    const clear = () => { if (reading.current === job) reading.current = null; };
    void job.then(clear, clear);
    return job;
  }
  useEffect(() => {
    initialized.current = false;
    orderRef.current = null;
    setOrder(null); setForm(null); setLocationDirty(false); setStep(1); setEditing(false);
    action.run(read);
    // Poll one read at a time and preserve all text being typed.
    let disposed = false, timer;
    async function poll() {
      if (!writing.current) await read().catch(() => {});
      if (!disposed) timer = setTimeout(poll, 30000);
    }
    timer = setTimeout(poll, 30000);
    return () => { disposed = true; clearTimeout(timer); version.current++; reading.current = null; };
  }, [token]);
  async function write(path, body) {
    if (writing.current) return;
    writing.current = true;
    const revision = ++version.current;
    try {
      if (path === "confirm" && unified) {
        const signature = JSON.stringify(body);
        if (confirmationAttempt.current?.signature !== signature)
          confirmationAttempt.current = { signature, requestId: crypto.randomUUID() };
        body = { ...body, requestId: confirmationAttempt.current.requestId };
      }
      const o = await api(`/customer/${token}/${path}`, { method: "POST", body });
      if (revision === version.current) receive(o, path !== "location");
      return o;
    } catch (error) {
      invalid(error);
      if (["stale_details", "state_conflict", "editing_blocked", "request_timeout", "network_error"].includes(error.code))
        await read().catch(() => {});
      throw error;
    } finally { writing.current = false; }
  }
  async function confirmLocation(body) {
    setLocationBusy(true);
    try { await write("location", body); if (!unified) setStep(2); }
    finally { setLocationBusy(false); }
  }
  function submit(event, saveOnly = false, available = when === "now") {
    event.preventDefault();
    if (locationBusy || writing.current) return;
    if (!saveOnly && (locationDirty || order.priceStatus !== "final" || (quick && !order.goodsAmountKnown))) return;
    action.run(async () => {
      await write(saveOnly ? "details" : "confirm", { ...form, ...(!saveOnly && askWhen ? { available } : {}),
        observed: order.confirmationSnapshot });
      if (!saveOnly) setEditing(false);
      action.setSuccess(saveOnly ? "customerDetailsSaved" : "saved");
    });
  }
  // "I am ready now" after "later", or "not now" while a driver is being found. The
  // total is not confirmed again: any change to it already asked for a new confirmation.
  function setAvailable(available) {
    if (writing.current) return;
    action.run(async () => { await write("availability", { available }); action.setSuccess("saved"); });
  }
  const hasContact = !quick || !!form?.customerPhone.trim();
  const formChanged = form && order && Object.keys(form).some(key => form[key] !== (order[key] ?? ""));
  const canConfirm = hasContact && !action.busy && !locationBusy && !locationDirty &&
    order?.priceStatus === "final" && shown?.expectedCustomerCashAgorot != null &&
    (!quick || (order.goodsAmountKnown && !!order.destinationLocation?.confirmedAt));
  // Quick orders: one action. Until the total is final it only saves the details
  // (so nothing typed is lost); once final it confirms details, location and total at once.
  const totalReady = quick && canConfirm;
  // The button names the total as soon as it is known, even before the contact fields are filled.
  const totalKnown = quick && order?.goodsAmountKnown && order?.priceStatus === "final" && shown?.expectedCustomerCashAgorot != null
    && !!order?.destinationLocation?.confirmedAt && !locationDirty;
  if (order?.customerConfirmed) confirmedBefore.current = true;
  const totalChanged = totalReady && !order.customerConfirmed && confirmedBefore.current;
  const confirmedNow = !!order?.customerConfirmed && !formChanged && !locationBusy && !locationDirty;
  const notice = <Notice reveal={!refreshError || !!action.error} action={(action.error || refreshError)?.code === "not_found"
    ? { ...action, error: { code: "customer_link_invalid" } }
    : { ...action, error: action.error || refreshError }} />;

  const place = order?.destinationLocation;
  const progressing = progress[order?.status], atDoor = order?.status === "driver_at_destination";
  const view = !order || !form ? "loading"
    : !order.confirmationSnapshot ? "closed"
    // The server shows the code only when the driver needs it: at the door, or (quick orders) once the parcel is collected.
    : order.deliveryCode && ["collected", "driver_at_destination"].includes(order.status) ? "arrived"
    : !order.canEdit || (confirmedNow && !editing) ? "track"
    // Once a driver has accepted, the place is final.
    : !unified && step === 1 && order.canChangeLocation !== false ? "location" : "details";
  // Moving to another screen puts focus on its title so a screen reader starts there.
  useEffect(() => {
    if (shownView.current && shownView.current !== view && view !== "loading") heading.current?.focus({ preventScroll: true });
    shownView.current = view;
  }, [view]);

  const storeName = order?.storeName || t("brand");
  const pill = order && <p className="cu-pill"><Store size={16} aria-hidden="true" />
    <span>{`${storeName} · #${orderNumber(order)}`}</span></p>;
  const langButton = <button type="button" className="cu-chip" onClick={() => setLanguage(language === "ar" ? "he" : "ar")}>العربية / עברית</button>;
  const tools = <div className="cu-tools">
    {langButton}
    <button type="button" className="cu-chip icon" aria-label={t("refresh")} disabled={action.busy || locationBusy}
      onClick={() => { tracking.refresh(); action.run(read); }}><RefreshCw size={16} aria-hidden="true" /></button>
  </div>;
  const callStore = order?.storePhone && <a className="cu-link" href={`tel:${order.storePhone.replace(/[^\d+]/g, "")}`}>
    <Phone size={16} aria-hidden="true" />{t("callStore")}</a>;
  const cash = order && shown && <div className="cu-cash">
    <span><small>{t(atDoor ? "amountDue" : "amountAtReceipt")}</small><small>{t(atDoor ? "payCashToDriver" : "cashToDriver")}</small></span>
    <strong><Money value={shown.expectedCustomerCashAgorot} /></strong>
  </div>;
  const waitingStore = order?.dispatchState === "waiting_store";
  const noDriver = order?.dispatchState === "no_driver";
  const trackTitle = later ? "trackLater" : waitingStore ? "waitingStore" : noDriver ? "noDriverNow" : progressing?.title;
  const trackBody = later ? "trackLaterBody" : waitingStore ? "customerWaitingStoreBody" : noDriver ? "customerNoDriverBody" : progressing?.body;

  if (view === "loading")
    return <div className="cu cu-page" aria-busy={action.busy}>
      <div className="cu-tools">{langButton}</div>
      {notice}
      <p className="cu-muted" role="status">{action.busy ? t("loading") : ""}</p>
    </div>;

  if (view === "closed")
    return <div className="cu cu-page">
      <div className="cu-tools">{langButton}</div>
      <h1 tabIndex={-1} ref={heading}>{storeName}</h1>
      <div className="cu-card"><p><Status status={order.status} /></p><p className="callout attention">{t("readOnly")}</p>
        {unified && order.status === "delivered" && <dl className="cu-summary"><div><dt>{t("actualCash")}</dt><dd><Money value={order.actualCashCollectedAgorot} /></dd></div></dl>}
      </div>
    </div>;

  if (view === "location")
    return <div className="cu">
      <CustomerLocation key={token} value={place} center={order.mapCenter} disabled={action.busy || locationBusy}
        storeName={storeName} searchPath={`/customer/${token}/maps/search`} reversePath={`/customer/${token}/maps/reverse`}
        onConfirm={confirmLocation} onContinue={() => setStep(2)} onError={invalid} onPendingChange={setLocationDirty}
        tools={<div className="cu-tools">{langButton}</div>} headingRef={heading}
        notice={refreshError && notice} />
    </div>;

  if (view === "track")
    return <div className="cu">
      <div className="cu-stage cu-track-stage">
        <header className="cu-track-top">{pill}{tools}</header>
        <CustomerMap point={place} center={order.mapCenter} interactive={false} driverLocation={tracking.location}>
        </CustomerMap>
        <section className="cu-sheet" aria-labelledby="cu-title">
          <h1 id="cu-title" tabIndex={-1} ref={heading}>{trackTitle ? t(trackTitle) : t(`status.${order.status}`)}</h1>
          {trackBody && <p className="cu-sub">{t(trackBody)}</p>}
          {["collected", "driver_at_destination"].includes(order.status) && <CustomerTrackingStatus tracking={tracking} />}
          {progressing && !later && <ol className="cu-stages" aria-label={t("tripProgress")}>
            {stages.map((stage, index) => <li key={stage} className={index <= progressing.step ? "on" : ""}
              aria-current={index === progressing.step ? "step" : undefined}>{t(stage)}</li>)}
          </ol>}
          {place?.address && <div className="cu-address"><span className="cu-icon"><MapPin size={20} aria-hidden="true" /></span>
            <span className="cu-address-text"><small>{t("deliveryLocation")}</small><strong dir="auto">{place.address}</strong></span></div>}
          {cash}
          {(action.error || refreshError) && notice}
          {later && <button type="button" className="cu-primary" disabled={action.busy} onClick={() => setAvailable(true)}>{t("readyNow")}</button>}
          <div className="cu-track-actions">{callStore}
          {order.canEdit && order.canChangeLocation !== false && <button type="button" className="cu-soft" onClick={() => { setStep(2); setEditing(true); }}>{t("editMyDetails")}</button>}
          {findingDriver && <button type="button" className="cu-link" disabled={action.busy} onClick={() => setAvailable(false)}>{t("notReadyNow")}</button>}
          </div>
          {!atDoor && <p className="cu-foot"><Lock size={15} aria-hidden="true" />{t(quick ? "codeAppearsAfterPickup" : "codeAppearsOnArrival")}</p>}
        </section>
      </div>
    </div>;

  if (view === "arrived")
    return <div className="cu cu-page">
      {pill}
      {tools}
      <header className="cu-arrived">
        <span className="cu-badge">{atDoor ? <Check size={24} aria-hidden="true" /> : <Truck size={24} aria-hidden="true" />}</span>
        <div><h1 tabIndex={-1} ref={heading}>{t(progressing.title)}</h1><p className="cu-sub">{t(progressing.body)}</p></div>
      </header>
      <div className="cu-arrived-map"><CustomerMap point={place} center={order.mapCenter} interactive={false} driverLocation={tracking.location} /></div>
      <CustomerTrackingStatus tracking={tracking} />
      <section className="cu-card cu-code" aria-labelledby="cu-code-title">
        <h2 id="cu-code-title">{t("deliveryCodeTitle")}</h2>
        <p className="cu-digits" dir="ltr" style={{ "--digits": order.deliveryCode.length }} role="img" aria-label={order.deliveryCode.split("").join(" ")}>
          {order.deliveryCode.split("").map((digit, index) => <span key={index} aria-hidden="true">{digit}</span>)}
        </p>
        <p className="cu-muted">{t("giveCodeToDriver")}</p>
      </section>
      {cash}
      {notice}
      {callStore}
      <p className="cu-foot"><Lock size={15} aria-hidden="true" />{t("keepCodePrivate")}</p>
    </div>;

  // Step 2: the person's details and the total, then one confirmation.
  const distance = shown.priceSource === "route" && shown.priceStatus === "final" && shown.routeDistanceMeters != null
    ? t("feeByDistance").replace("{km}", new Intl.NumberFormat(language === "he" ? "he-IL" : "ar-IL", { maximumFractionDigits: 1 })
      .format(shown.routeDistanceMeters / 1000)) : "";
  const locked = !order.canEdit || action.busy || locationBusy;
  const placeLocked = locked || order.canChangeLocation === false;
  const set = key => event => setForm({ ...form, [key]: event.target.value });
  if (unified) return <CustomerCheckout order={order} shown={shown} form={form} set={set}
    storeName={storeName} headingRef={heading} langButton={langButton} locked={locked} canConfirm={canConfirm}
    when={when} onWhenChange={setWhen} askWhen={askWhen} notice={notice} totalChanged={totalChanged} callStore={callStore}
    onSubmit={event => submit(event, false, when === "now")}
    onRetryPrice={() => action.run(() => confirmLocation(place))} retryDisabled={action.busy || locationBusy || locationDirty}
    location={order.canChangeLocation !== false ? <CustomerLocation key={token} value={place} center={order.mapCenter}
      disabled={action.busy} embedded compact storeName={storeName}
      searchPath={`/customer/${token}/maps/search`} reversePath={`/customer/${token}/maps/reverse`}
      onConfirm={confirmLocation} onContinue={() => {}} onError={invalid} onPendingChange={setLocationDirty} />
      : <div className="cu-place"><MapPin size={20} aria-hidden="true" /><strong>{place?.address || t("pinOnMap")}</strong></div>} />;
  return <div className={`cu cu-page details${unified ? " unified" : ""}`}>
    {unified && order.canChangeLocation !== false && <CustomerLocation key={token} value={place} center={order.mapCenter}
      disabled={action.busy} embedded storeName={storeName} searchPath={`/customer/${token}/maps/search`} reversePath={`/customer/${token}/maps/reverse`}
      onConfirm={confirmLocation} onContinue={() => {}} onError={invalid} onPendingChange={setLocationDirty} />}
    <form onSubmit={event => submit(event, !unified && quick && !totalKnown, unified ? true : when === "now")}>
      <header className="cu-head">
        <div>
          <h1 tabIndex={-1} ref={heading}>{t("stepDetailsTitle")}</h1>
          <p className="cu-sub">{t("orderFromStore").replace("{store}", storeName)} · <bdi dir="ltr">#{orderNumber(order)}</bdi></p>
        </div>
        {langButton}
        {!unified && <button type="button" className="cu-back" aria-label={t("back")} disabled={placeLocked} onClick={() => setStep(1)}>
          <ChevronRight size={22} aria-hidden="true" /></button>}
      </header>
      {!unified && <><div className="cu-progress" aria-hidden="true"><i className="on" /><i className="on" /></div>
      <p className="cu-step">{t("stepOfTwo").replace("{n}", "2")}</p></>}

      <div className="cu-place">
        <span className="cu-thumb" aria-hidden="true"><i /></span>
        <span className="cu-address-text"><small>{t("deliveryLocation")}</small>
          <strong dir="auto">{place?.address || t("pinOnMap")}</strong></span>
        {!unified && order.canChangeLocation !== false &&
          <button type="button" className="cu-link" disabled={placeLocked} onClick={() => setStep(1)}>{t("edit")}</button>}
      </div>

      {quick ? <label className="cu-field"><span>{t("customerPhone")}</span>
        <input required type="tel" inputMode="tel" maxLength={30} dir="ltr" autoComplete="tel" value={form.customerPhone} disabled={locked}
          onChange={set("customerPhone")} /></label>
        : <label className="cu-field"><span>{t("finalAddress")}</span>
          <textarea required rows={2} maxLength={2000} dir="auto" value={form.finalAddress} disabled={locked} onChange={set("finalAddress")} /></label>}
      <label className="cu-field"><span>{t("deliveryInstructions")} <small>({t("optional")})</small></span>
        <textarea rows={3} maxLength={2000} dir="auto" value={form.deliveryInstructions} disabled={locked} onChange={set("deliveryInstructions")} /></label>

      <section className="cu-card" aria-labelledby="cu-summary">
        <h2 id="cu-summary">{t("amountSummary")}</h2>
        <dl className="cu-summary">
          <div><dt>{t("goods")}</dt><dd>{quick && !order.goodsAmountKnown ? t("goodsUnknown") : <Money value={order.goodsAmountAgorot} />}</dd></div>
          {unified && <div><dt>{t("goodsPaymentStatus")}</dt><dd>{t(order.goodsPaymentStatus === "prepaid" ? "goodsPrepaid" : "goodsUnpaid")}</dd></div>}
          <div><dt>{t("deliveryFee")}{distance && <small>{distance}</small>}</dt>
            <dd>{shown.deliveryFeePaidBy === "store" ? t("deliveryPaidByStore") : <Money value={shown.deliveryFeeAgorot} />}</dd></div>
          <div className="cu-total"><dt>{t("totalToPay")}</dt><dd aria-live="polite"><Money value={shown.expectedCustomerCashAgorot} /></dd></div>
        </dl>
        {shown.priceStatus !== "final" && <RoutePrice order={shown} />}
        {order.canEdit && order.priceSource === "route" && order.priceStatus !== "final" && place?.confirmedAt &&
          <button type="button" className="cu-soft" disabled={action.busy || locationBusy || locationDirty}
            onClick={() => action.run(() => confirmLocation(place))}>{t("retryRoutePrice")}</button>}
        <p className="cu-cashnote"><Info size={16} aria-hidden="true" />{t("payCashOnReceipt")}</p>
      </section>
      {quick && !order.goodsAmountKnown && <p className="cu-muted">{t("waitingInvoice")}</p>}
      {totalChanged && <p className="callout attention" role="status">{t("totalChanged")}</p>}
      {!unified && askWhen && totalKnown && <fieldset className="cu-when" disabled={locked}>
        <legend>{t("whenReceive")}</legend>
        <label className="cu-choice"><input type="radio" name="when" value="now" checked={when === "now"}
          onChange={() => setWhen("now")} /><span>{t("receiveNow")}</span></label>
        <label className="cu-choice"><input type="radio" name="when" value="later" checked={when === "later"}
          onChange={() => setWhen("later")} /><span>{t("receiveLater")}</span></label>
        {when === "later" && <small>{t("receiveLaterHint")}</small>}
      </fieldset>}
      {/* The result of Save/Confirm appears right above the button that caused it. */}
      {notice}
      {order.canEdit ? <div className="cu-bar">
        {unified && cash}
        <button className="cu-primary" onClick={() => { if (unified) setWhen("now"); }} disabled={unified ? !canConfirm : quick ? (totalKnown ? !canConfirm : !hasContact || action.busy || locationBusy) : !canConfirm}>
          {unified ? t("confirmReadyNow") : quick ? (totalKnown ? t("confirmOrderTotal").replace("{amount}", money(shown.expectedCustomerCashAgorot)) : t("saveCustomerDetails"))
            : t("confirmDetails")}</button>
        {unified && <button type="button" className="cu-link" disabled={!canConfirm} onClick={event => { setWhen("later"); submit(event, false, false); }}>{t("confirmForLater")}</button>}
        {(totalKnown || !quick) && <small>{t("confirmConsent")}</small>}
      </div> : <p className="callout attention">{t("readOnly")}</p>}
    </form>
  </div>;
}
