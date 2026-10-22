import { useEffect, useState } from "react";
import { api, newRequestId } from "../api.js";
import { Field, Money, Notice, useAction, useLanguage } from "./UI.jsx";

const failedStatuses = ["delivery_failed", "returning", "returned"];

// Amounts are never typed: the server derives what each record must equal and
// rejects anything else, so the button records exactly the amount shown.
function FinanceAction({ order, name, onSaved }) {
  const { t } = useLanguage(), action = useAction();
  const storageKey = `waselha.finance.${order._id}.${name}`;
  const [draft, setDraft] = useState(() => {
    try { const saved = JSON.parse(localStorage.getItem(storageKey)); if (saved?.requestId) return saved; } catch {}
    return { requestId: newRequestId(), note: "", type: "", reference: "" };
  });
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(draft)); } catch {} }, [storageKey, draft]);
  const resolve = name === "resolve-adjustment", payout = name === "driver-payout";
  const adjustment = order.collectionAdjustment, due = order.financeDue ?? {};
  const dueAmount = { "cash-handover": due.cashHandoverAgorot, "driver-payout": due.driverPayoutAgorot,
    "store-settlement": due.storeSettlementAgorot }[name];
  const types = adjustment?.type === "overage" ? ["refund_customer", "credit_store", "platform_revenue"]
    : ["driver_pays", "store_absorbs", "platform_absorbs"];
  function submit(e) {
    e.preventDefault();
    action.run(async () => {
      const saved = await api(`/admin/orders/${order._id}/finance/${name}`, { method: "POST", body: {
        requestId: draft.requestId,
        ...(resolve ? { resolutionNote: draft.note, resolutionType: draft.type, reference: draft.reference, amountAgorot: adjustment.amountAgorot }
          : payout ? {} : { amountAgorot: dueAmount, note: draft.note }),
      } });
      try { localStorage.removeItem(storageKey); } catch {}
      onSaved(saved);
    });
  }
  return <form noValidate onSubmit={submit}>
    <h3>{t(`financeAction.${name}`)}</h3>
    <Notice action={action} />
    <fieldset disabled={action.busy}>
      {resolve ? <>
        <p>{t(adjustment.type)}: <Money value={adjustment.amountAgorot} /></p>
        <Field label="resolutionType"><select value={draft.type} onChange={e => setDraft({ ...draft, type: e.target.value })}>
          <option value="">{t("chooseResolution")}</option>
          {types.map(type => <option key={type} value={type}>{t(`resolution.${type}`)}</option>)}
        </select></Field>
        <Field label="resolutionReference" value={draft.reference} maxLength={120}
          onChange={e => setDraft({ ...draft, reference: e.target.value })} />
        <Field label="resolutionNote" value={draft.note} maxLength={300}
          onChange={e => setDraft({ ...draft, note: e.target.value })} />
      </> : <>
        <p>{t("dueAmount")}: <Money value={dueAmount} />
          {name === "store-settlement" && due.storeSettlementDirection && <> · {t(`direction.${due.storeSettlementDirection}`)}</>}</p>
        {!payout && <Field label="note" value={draft.note} maxLength={300} onChange={e => setDraft({ ...draft, note: e.target.value })} />}
      </>}
      <button disabled={action.busy || (resolve && (!draft.type || !draft.reference.trim() || !draft.note.trim()))}>{t("recordCompletion")}</button>
    </fieldset>
  </form>;
}

// A wrong record is reopened (its amount and reason stay in the history) and
// then recorded again; it is never edited in place.
function ReverseAction({ order, record, name, onSaved }) {
  const { t } = useLanguage(), action = useAction();
  const [draft, setDraft] = useState({ requestId: newRequestId(), reason: "" });
  return <form noValidate onSubmit={e => {
    e.preventDefault();
    action.run(async () => {
      onSaved(await api(`/admin/orders/${order._id}/finance/reverse-record`, { method: "POST",
        body: { requestId: draft.requestId, record: name, reason: draft.reason } }));
      setDraft({ requestId: newRequestId(), reason: "" });
    });
  }}>
    <Notice action={action} />
    <fieldset disabled={action.busy}>
      <Field label="reverseReason" value={draft.reason} maxLength={300} onChange={e => setDraft({ ...draft, reason: e.target.value })} />
      <button className="quiet" disabled={action.busy || !draft.reason.trim()}>{t("reverseRecord")}</button>
    </fieldset>
  </form>;
}

export default function OrderFinance({ order, admin = false, onSaved }) {
  const { t } = useLanguage(), action = useAction();
  const [payer, setPayer] = useState(order.deliveryFeePaidBy ?? "");
  useEffect(() => { setPayer(order.deliveryFeePaidBy ?? ""); }, [order._id, order.deliveryFeePaidBy]);
  const failed = failedStatuses.includes(order.status);
  const records = failed ? [["cashHandover", "cash-handover"]]
    : [["cashHandover", "cash-handover"], ...(admin ? [["driverPayout", "driver-payout"]] : []), ["storeSettlement", "store-settlement"]];
  const adjustmentOpen = order.collectionAdjustment?.status === "open";
  return <section className="order-finance">
    <h2>{t("finance")}</h2>
    <Notice action={action} />
    <dl className="details">
      <div><dt>{t("deliveryFeePaidBy")}</dt><dd>{order.deliveryFeePaidBy ? t(`feePayer.${order.deliveryFeePaidBy}`) : t("financeUnknown")}</dd></div>
      <div><dt>{t("storeDeliveryFeeLiability")}</dt><dd><Money value={order.storeDeliveryFeeLiabilityAgorot} /></dd></div>
    </dl>
    {admin && order.canEdit && <form onSubmit={e => {
      e.preventDefault(); action.run(async () => onSaved(await api(`/admin/orders/${order._id}/finance-terms`, {
        method: "PATCH", body: { deliveryFeePaidBy: payer, observed: order.confirmationSnapshot },
      })));
    }}>
      <Field label="deliveryFeePaidBy"><select value={payer} disabled={action.busy} onChange={e => setPayer(e.target.value)}>
        <option value="">{t("chooseFeePayer")}</option>
        {["customer", "store"].map(p => <option key={p} value={p}>{t(`feePayer.${p}`)}</option>)}
      </select></Field>
      <button disabled={action.busy || !payer || payer === order.deliveryFeePaidBy}>{t("save")}</button>
    </form>}
    {order.financeLegacy ? <p className="callout attention">{t("legacyFinanceUnknown")}</p> : <>
      {order.collectionAdjustment && <div className="callout attention">
        <strong>{t(order.collectionAdjustment.type)}: <Money value={order.collectionAdjustment.amountAgorot} /></strong>
        <p>{t("financialAdjustment")} · {t(`financeStatus.${order.collectionAdjustment.status}`)}
          {order.collectionAdjustment.resolutionType && <> · {t(`resolution.${order.collectionAdjustment.resolutionType}`)}</>}</p>
        {admin && order.collectionAdjustment.resolutionNote && <p>{order.collectionAdjustment.resolutionNote}</p>}
      </div>}
      {records.filter(([key]) => order[key]).map(([key, name]) => <div key={key}>
        <p><strong>{t(key)}</strong> · {t(`financeStatus.${order[key].status}`)} · <Money value={order[key].amountAgorot ?? (order[key].status === "pending" ? order.financeDue?.[`${key}Agorot`] : undefined)} />
          {admin && key === "storeSettlement" && order[key].direction && <> · {t(`direction.${order[key].direction}`)}</>}</p>
        {admin && order[key].status === "pending" && !(adjustmentOpen && name !== "driver-payout") &&
          <FinanceAction order={order} name={name} onSaved={onSaved} />}
        {admin && order[key].status === "completed" && <ReverseAction order={order} name={name} onSaved={onSaved} />}
      </div>)}
      {admin && adjustmentOpen && <FinanceAction order={order} name="resolve-adjustment" onSaved={onSaved} />}
      {(order.status === "delivered" || (failed && order.cashHandover)) && <p className={`callout ${order.financeComplete ? "success" : "attention"}`}>
        {t(order.financeComplete ? "financeCompleted" : "financePending")}
      </p>}
    </>}
  </section>;
}
