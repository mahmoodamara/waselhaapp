import { Lock, Phone, Store } from "lucide-react";
import { Money, useLanguage } from "./UI.jsx";
import { orderNumber } from "../merchant/model.js";

// One mobile checkout: location, visible price breakdown, then the single consent.
// Optional delivery notes/contact edits never obstruct the main path.
export default function CustomerCheckout({ order, shown, form, set, storeName, headingRef, langButton, locked,
  canConfirm, when, onWhenChange, askWhen, notice, totalChanged, callStore, onSubmit,
  onRetryPrice, retryDisabled, location }) {
  const { t } = useLanguage();
  return <div className="cu cu-checkout">
    <header className="cu-checkout-head">
      <span className="cu-checkout-brand"><Store size={20} aria-hidden="true" /><span>
        <strong>{storeName}</strong><small>#{orderNumber(order)}</small>
      </span></span>
      {langButton}
    </header>
    <h1 className="cu-checkout-title" tabIndex={-1} ref={headingRef}>{t("customerConfirmHeading")}</h1>
    {location}
    <form onSubmit={onSubmit} className="cu-checkout-form">
      <section className="cu-checkout-price" aria-label={t("amountSummary")}>
        <div><small>{t("goods")}</small><strong>{order.goodsAmountKnown ? <Money value={order.goodsAmountAgorot} /> : t("goodsUnknown")}</strong>
          {order.goodsPaymentStatus === "prepaid" && <span className="cu-paid">{t("goodsPrepaid")}</span>}</div>
        <div><small>{t("deliveryFee")}</small><strong>{shown.deliveryFeePaidBy === "store" ? t("deliveryPaidByStore") : <Money value={shown.deliveryFeeAgorot} />}</strong></div>
      </section>
      {shown.priceStatus !== "final" && <div className="cu-checkout-pricing" role="status">
        <p>{t(shown.routeError ? "routing_unavailable" : !shown.destinationLocation?.confirmedAt ? "customerChooseLocationPrice" : "pricePending")}</p>
        {order.destinationLocation?.confirmedAt && <button type="button" className="cu-link" disabled={retryDisabled}
          onClick={onRetryPrice}>{t("retryRoutePrice")}</button>}
      </div>}
      {askWhen && <fieldset className="cu-checkout-when" disabled={locked}>
        <legend>{t("whenReceive")}</legend>
        {["now", "later"].map(value => <label key={value} className={when === value ? "selected" : ""}>
          <input type="radio" name="when" value={value} checked={when === value} onChange={() => onWhenChange(value)} />
          <span>{t(value === "now" ? "receiveNow" : "receiveLater")}</span>
        </label>)}
      </fieldset>}
      <details className="cu-checkout-extra">
        <summary>{t("customerOptionalDetails")}</summary>
        <div className="cu-checkout-extra-body">
          <label className="cu-field"><span>{t("customerPhone")}</span>
            <input type="tel" inputMode="tel" autoComplete="tel" dir="ltr" maxLength={30} value={form.customerPhone} disabled={locked} onChange={set("customerPhone")} /></label>
          <label className="cu-field"><span>{t("finalAddress")} <small>({t("optional")})</small></span>
            <input autoComplete="street-address" maxLength={2000} dir="auto" value={form.finalAddress} disabled={locked} onChange={set("finalAddress")} /></label>
          <label className="cu-field"><span>{t("deliveryInstructions")} <small>({t("optional")})</small></span>
            <textarea rows={2} maxLength={2000} dir="auto" value={form.deliveryInstructions} disabled={locked} onChange={set("deliveryInstructions")} /></label>
          {callStore}
        </div>
      </details>
      {totalChanged && <p className="callout attention" role="status">{t("totalChanged")}</p>}
      {!order.goodsAmountKnown && <p className="cu-muted">{t("waitingInvoice")}</p>}
      {notice}
      <footer className="cu-checkout-bar">
        <div className="cu-checkout-total"><span><small>{t("amountAtReceipt")}</small><span><Phone size={13} aria-hidden="true" /><bdi dir="ltr">{form.customerPhone}</bdi></span></span>
          <strong aria-live="polite"><Money value={shown.expectedCustomerCashAgorot} /></strong></div>
        <button className="cu-primary" disabled={!canConfirm}>{t(when === "later" ? "confirmForLater" : "confirmReadyNow")}</button>
        <small className="cu-checkout-consent"><Lock size={12} aria-hidden="true" />{t("confirmConsent")}</small>
      </footer>
    </form>
  </div>;
}
