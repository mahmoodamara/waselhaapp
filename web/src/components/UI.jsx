import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { translate } from "../translations.js";
import { money } from "../api.js";
import { groupRequirements, ownerOrder } from "../requirementOwners.js";
import { orderNumber } from "../merchant/model.js";
const ownerLabels = {
  store: "ownerStore",
  customer: "ownerCustomer",
  driver: "ownerDriver",
  system: "ownerSystem",
};
const LanguageContext = createContext();
export function LanguageProvider({ children }) {
  const [language, setLanguage] = useState(
    localStorage.getItem("waselha.language") === "he" ? "he" : "ar",
  );
  useEffect(() => {
    localStorage.setItem("waselha.language", language);
    document.documentElement.lang = language;
    document.documentElement.dir = "rtl";
  }, [language]);
  return (
    <LanguageContext
      value={{
        language,
        setLanguage,
        t: (key) => translate(language, key),
      }}
    >
      {children}
    </LanguageContext>
  );
}
export const useLanguage = () => useContext(LanguageContext);
// `customer` is the public customer page: the logo is not a link into the store
// portal and the internal "prototype" badge is not shown.
export function Header({ user, logout, customer = false }) {
  const { language, setLanguage, t } = useLanguage();
  const brand = (
    <>
      <span className="brand-mark">و</span>
      <span>
        {t("brand")}
        <small>{t("subtitle")}</small>
      </span>
    </>
  );
  return (
    <header className="header">
      {customer ? (
        <div className="brand">{brand}</div>
      ) : (
        <a className="brand" href={user?.role === "admin" ? "/admin" : "/store"}>
          {brand}
        </a>
      )}
      <div className="header-actions">
        {!customer && <span className="prototype">{t("prototype")}</span>}
        <button
          className="quiet"
          onClick={() => setLanguage(language === "ar" ? "he" : "ar")}
        >
          العربية / עברית
        </button>
        {user && (
          <>
            <span>{user.name}</span>
            <button className="quiet" onClick={logout}>
              {t("logout")}
            </button>
          </>
        )}
      </div>
    </header>
  );
}
export function useAction() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(null),
    [success, setSuccess] = useState("");
  const lock = useRef(false);
  const run = async (fn) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setSuccess("");
    try {
      return await fn();
    } catch (e) {
      setError(e);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return { busy, error, success, setSuccess, run };
}
// Brings a new result into view: the notice sits next to the action that caused
// it, and on a small screen the button can still be far from the top.
function useReveal(trigger) {
  const ref = useRef(null);
  useEffect(() => {
    if (!trigger) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    ref.current?.scrollIntoView?.({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
  }, [trigger]);
  return ref;
}
// `reveal={false}` for results nobody just asked for (background refresh failures).
export function Notice({ action, reveal = true }) {
  const { t } = useLanguage();
  const errorRef = useReveal(reveal && action.error),
    successRef = useReveal(reveal && action.success);
  return (
    <>
      {action.error && (
        <div className="callout error" role="alert" ref={errorRef}>
          {t(action.error.code || action.error.message)}
          {action.error.missingRequirements?.length > 0 && (
            <ul>
              {action.error.missingRequirements.map((k) => (
                <li key={k}>{t(k)}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {action.success && (
        <div className="callout success" role="status" ref={successRef}>
          {t(action.success)}
        </div>
      )}
    </>
  );
}
// One numbered step of a short flow (customer page, store setup): a title, an
// optional one-line status (`tone`: "success" or "attention") and the step's content.
export function StepCard({ number, done, title, status, tone, children }) {
  return (
    <section className="panel step-card">
      <div className="step-head">
        <span className={`step-number ${done ? "done" : ""}`} aria-hidden="true">
          {done ? "✓" : number}
        </span>
        <h2>{title}</h2>
      </div>
      {status && (
        <p className={`step-status ${tone || ""}`} role="status">
          {status}
        </p>
      )}
      {children}
    </section>
  );
}
// Pick one of a few options (vehicle, parcel size, who pays) with big tap targets.
// `invalid` makes the group focusable so a form's error summary can jump to it.
export function ChoiceGroup({ legend, name, value, options, label, onChange, disabled, isDisabled, id, invalid, error }) {
  return (
    <fieldset
      className="choice-group"
      role="radiogroup"
      id={id}
      tabIndex={invalid ? -1 : undefined}
      aria-invalid={invalid || undefined}
    >
      <legend>{legend}</legend>
      {options.map((option) => (
        <label key={String(option)} className={value === option ? "selected" : ""}>
          <input
            type="radio"
            name={name}
            value={String(option)}
            checked={value === option}
            disabled={disabled || isDisabled?.(option)}
            onChange={() => onChange(option)}
          />
          <span>{label(option)}</span>
        </label>
      ))}
      {error && <small className="field-error">{error}</small>}
    </fieldset>
  );
}
export function Status({ status, driverSearchStatus }) {
  const { t } = useLanguage();
  const key = status !== "searching_driver" ? `status.${status}`
    : driverSearchStatus === "no_driver" ? "noDriverFound" : driverSearchStatus === "waiting" ? "status.waiting_customer" : `status.${status}`;
  return <span className={`status ${status}`}>{t(key)}</span>;
}
export function Field({ label, children, ...props }) {
  const { t } = useLanguage();
  return (
    <label className="field">
      <span>{t(label)}</span>
      {children || <input {...props} />}
    </label>
  );
}
export function Money({ value }) {
  return (
    <span className="money" dir="ltr">
      {money(value)}
    </span>
  );
}
export function RoutePrice({ order }) {
  const { t } = useLanguage();
  const pending = order.priceStatus !== "final";
  const key = order.priceSource === "manual" ? "legacyManualPrice"
    : !pending ? "priceFinal" : order.routeError ? "routing_unavailable"
    : !order.destinationLocation?.confirmedAt ? "priceWaitingLocation" : "pricePending";
  return (
    <div className={`callout ${pending ? "attention" : "success"}`} role="status">
      <strong>{t(key)}</strong>
      {pending && order.estimatedDeliveryFeeAgorot != null && <p>
        {t("deliveryEstimate")}: <Money value={order.estimatedDeliveryFeeAgorot} /><br />{t("estimateNotice")}
      </p>}
      {order.priceSource === "route" && !pending && (
        <>
          <p>{t("routeDistance")}: <span dir="ltr">{order.routeDistanceMeters} {t("meters")}</span></p>
          {order.routeDistanceMeters === 0 && <p>{t("routeZeroDistance")}</p>}
          <small>{t("routeDataAttribution")}: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" dir="ltr">© OpenStreetMap contributors</a></small>
        </>
      )}
    </div>
  );
}
export function Missing({ order, actions }) {
  const { t } = useLanguage();
  if (!order.canEdit || !order.missingRequirements?.length) return null;
  const groups = groupRequirements(order.missingRequirements, order.workflowVersion);
  return (
    <div className="callout attention">
      <strong>{t("missing")}</strong>
      {ownerOrder
        .filter((owner) => groups[owner].length)
        .map((owner) => (
          <div className="missing-group" key={owner}>
            <span className="missing-owner">{t(ownerLabels[owner])}</span>
            <ul>
              {groups[owner].map((k) => (
                <li key={k}>{t(k)}</li>
              ))}
            </ul>
            {owner === "store" &&
              groups.store.includes("customer_details_required") && (
                <p className="muted">{t("customerCanFill")}</p>
              )}
            {owner === "store" && actions?.onEditStore && (
              <div className="actions">
                <button
                  type="button"
                  className="quiet"
                  onClick={actions.onEditStore}
                >
                  {t("edit")}
                </button>
                {actions.onConfirmStore &&
                  groups.store.includes("store_confirmation_required") && (
                    <button
                      type="button"
                      disabled={actions.confirmDisabled}
                      onClick={actions.onConfirmStore}
                    >
                      {t("confirmDetails")}
                    </button>
                  )}
              </div>
            )}
            {owner === "store" &&
              actions?.onConfirmStore &&
              actions.confirmBlocked &&
              groups.store.includes("store_confirmation_required") && (
                <p className="muted">{t("confirmAfterOthers")}</p>
              )}
            {owner === "customer" && actions?.onCopyLink && (
              <button
                type="button"
                className="quiet"
                onClick={actions.onCopyLink}
              >
                {t("copy")}
              </button>
            )}
          </div>
        ))}
    </div>
  );
}
export const minutesSince = (date) =>
  Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 60000));
// Only events whose reason is a translatable code show it; others keep it internal.
const reasonKey = { collection_adjustment_opened: (r) => r, driver_withdrawn: (r) => `withdrawal.${r}`, driver_issue_reported: (r) => `issue.${r}`,
  collection_adjustment_resolved: (r) => `resolution.${r}` };
export function Operations({ order }) {
  const { t, language } = useLanguage();
  const date = (at) => new Date(at).toLocaleString(language === "ar" ? "ar" : "he");
  return <>
    <dl className="details">
      {["searchDeadlineAt", "storeArrivalDeadlineAt", "arrivedStoreAt", "arrivedCustomerAt"]
        .filter((key) => order[key] && (key !== "storeArrivalDeadlineAt" || order.activeAssignment))
        .map((key) => <div key={key}><dt>{t(key)}</dt><dd>{date(order[key])}</dd></div>)}
    </dl>
    {!!order.events?.length && <details>
      <summary>{t("operationalHistory")}</summary>
      <ul>{order.events.map((event, index) => <li key={index}>
        {t(`event.${event.type}`)} · {date(event.at)}
        {event.reason && reasonKey[event.type] && <> · {t(reasonKey[event.type](event.reason))}</>}
        {event.note && <> · {event.note}</>}
      </li>)}</ul>
    </details>}
  </>;
}
export function Details({ order, actions }) {
  const { t } = useLanguage();
  const pairs = [
    ["storeName", order.storeName],
    ["pickupAddress", order.pickupAddress],
    ["area", order.workflowVersion === 2 ? t(`serviceArea.${order.serviceArea}`) : order.area],
    ["serviceArea", order.serviceArea ? t(`serviceArea.${order.serviceArea}`) : t("unclassifiedServiceArea")],
    ["customerPhone", order.customerPhone],
    ["recipientName", order.recipientName],
    ["finalAddress", order.finalAddress || order.preliminaryAddress],
    [
      "deliveryLocation",
      t(
        order.destinationLocation?.confirmedAt
          ? "locationConfirmed"
          : "locationNotConfirmed",
      ),
    ],
    ["deliveryInstructions", order.deliveryInstructions],
    ["parcelDescription", order.parcelDescription],
    ["parcelReady", order.workflowVersion === 2 ? t(order.collectedAt ? "ready" : "quickHandover") : t(order.parcelReady ? "ready" : "notReady")],
    ["driver", order.assignedDriver?.name || t("unassigned")],
    ["parcelHolder", t(`holder.${order.parcelHolder}`)],
  ];
  return (
    <>
      <dl className="details">
        {pairs.map(([k, v]) => (
          <div key={k}>
            <dt>{t(k)}</dt>
            <dd dir={k === "customerPhone" ? "ltr" : "auto"}>{v || "—"}</dd>
          </div>
        ))}
      </dl>
      <RoutePrice order={order} />
      <div className="money-grid">
        {[
          ["goods", order.goodsAmountAgorot],
          ["deliveryFee", order.deliveryFeeAgorot],
          ["expectedCash", order.expectedCustomerCashAgorot],
          ["commission", order.platformCommissionAgorot],
          ["quotedEarnings", order.driverEarningsAgorot],
          ["actualCash", order.actualCashCollectedAgorot],
          // signed (actual − expected); only shown when there is a difference
          ...(order.cashDifferenceAgorot
            ? [["cashDifference", order.cashDifferenceAgorot]]
            : []),
        ].map(([k, v]) => (
          <div key={k}>
            <small>{t(k)}</small>
            <strong>
              {k === "goods" && order.goodsAmountKnown === false ? t("goodsUnknown") : <Money value={v} />}
            </strong>
          </div>
        ))}
      </div>
      <div className="confirmations">
        {(order.workflowVersion === 2 ? ["customerConfirmed"] : ["customerConfirmed", "storeConfirmed", "driverConfirmed"]).map((k) => (
          <span key={k} className={order[k] ? "confirmed" : ""}>
            {t(k)}: {t(order[k] ? "yes" : "no")}
          </span>
        ))}
      </div>
      {order.failureReason && (
        <p className="callout error">
          {t("failureReason")}: {order.failureReason}
        </p>
      )}
      {order.cancellationReason && (
        <p className="callout attention">
          {t("cancellationReason")}: {order.cancellationReason === "store_cancelled" ? t("storeCancelledReason") : order.cancellationReason}
        </p>
      )}
      <Operations order={order} />
      <Missing order={order} actions={actions} />
    </>
  );
}
export function OrderTable({ orders, onOpen }) {
  const { t, language } = useLanguage();
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {[
              "order",
              "storeName",
              "area",
              "customerPhone",
              "status",
              "driver",
              "deliveryFee",
              "date",
              "waiting",
              "open",
            ].map((k) => (
              <th key={k}>{t(k)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o._id}>
              <td>
                <code>{orderNumber(o)}</code>
              </td>
              <td>{o.storeName}</td>
              <td>{o.workflowVersion === 2 ? t(`serviceArea.${o.serviceArea}`) : o.area || "—"}</td>
              <td dir="ltr">{o.customerPhone || "—"}</td>
              <td>
                <Status status={o.status} driverSearchStatus={o.driverSearchStatus} />
              </td>
              <td>{o.assignedDriver?.name || t("unassigned")}</td>
              <td>
                <Money value={o.deliveryFeeAgorot} />
              </td>
              <td>
                {new Date(o.createdAt).toLocaleDateString(
                  language === "ar" ? "ar" : "he",
                )}
              </td>
              <td
                className={
                  o.status === "searching_driver" &&
                  o.driverSearchStatus === "no_driver"
                    ? "negative"
                    : ""
                }
              >
                {o.status === "searching_driver" && o.driverSearchStatus === "searching"
                  ? `${minutesSince(o.searchStartedAt || o.createdAt)} ${t("minutesShort")}`
                  : "—"}
              </td>
              <td>
                <button className="quiet" onClick={() => onOpen(o)}>
                  {t("open")}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!orders.length && <p className="empty">{t("empty")}</p>}
    </div>
  );
}
