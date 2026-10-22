import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, parseMoney } from "../api.js";
import { ChoiceGroup, Money } from "../components/UI.jsx";
import {
  Dialog,
  Empty,
  ErrorState,
  PageTitle,
  Skeleton,
  useCopy,
  useWorkspace,
} from "./components.jsx";
import {
  dateTime,
  maskedPhone,
  normalizePhone,
  operationalState,
  orderNumber,
  validPhone,
} from "./model.js";

const operationId = () => {
  const values = new Uint8Array(12);
  crypto.getRandomValues(values);
  return Array.from(values, (x) => x.toString(16).padStart(2, "0")).join("");
};
const emptyForm = () => ({
  customerPhone: "",
  recipientName: "",
  goodsAmountAgorot: "",
  parcelSize: "small",
  deliveryFeePaidBy: "customer",
  parcelReady: true,
  parcelDescription: "",
  area: "",
  serviceArea: "",
});
const fromOrder = (o) => ({
  ...(o.workflowVersion === 3 ? { goodsPaymentStatus: o.goodsPaymentStatus ?? "unpaid" } : {}),
  customerPhone: o.customerPhone || "",
  recipientName: o.recipientName || "",
  goodsAmountAgorot: o.goodsAmountKnown === false ? "" : ((o.goodsAmountAgorot || 0) / 100).toFixed(2),
  parcelSize: o.parcelSize || "",
  deliveryFeePaidBy: o.deliveryFeePaidBy || "",
  parcelReady: !!o.parcelReady,
  parcelDescription: o.parcelDescription || "",
  area: o.area || "",
  serviceArea: o.serviceArea || "",
  finalAddress: o.finalAddress || "",
  deliveryInstructions: o.deliveryInstructions || "",
  ...(o.priceSource === "manual"
    ? {
        deliveryFeeAgorot:
          o.deliveryFeeAgorot == null ? "" : (o.deliveryFeeAgorot / 100).toFixed(2),
      }
    : {}),
});
function readDrafts(key) {
  try {
    return (JSON.parse(localStorage.getItem(key)) || []).filter((d) => d?.form && d?.id);
  } catch {
    return [];
  }
}

export default function OrderEditor({ editing = false }) {
  const { id } = useParams(),
    { user, orders, error: lookupError, update, refresh, me } = useWorkspace(),
    { c, t, language } = useCopy();
  const navigate = useNavigate(),
    location = useLocation(),
    key = `waselha.drafts.v1.${user._id}`;
  const [order, setOrder] = useState(() => (editing ? orders?.find((o) => o._id === id) : null)),
    [loadError, setLoadError] = useState(null);
  const [drafts, setDrafts] = useState(() => readDrafts(key)),
    [recovery, setRecovery] = useState(
      () => !editing && !location.state?.fresh && readDrafts(key).length > 0,
    );
  const [activeId, setActiveId] = useState(() => operationId()),
    [form, setForm] = useState(() => (editing && order ? fromOrder(order) : emptyForm()));
  const [dirty, setDirty] = useState(false),
    [errors, setErrors] = useState({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  const [supportedAreas, setAreas] = useState(null),
    [areasError, setAreasError] = useState(null),
    [duplicate, setDuplicate] = useState(null),
    [unknown, setUnknown] = useState(false),
    [conflict, setConflict] = useState(null),
    [deleting, setDeleting] = useState(false);
  const observed = useRef(order?.confirmationSnapshot),
    locked = useRef(false),
    pendingPayload = useRef(null),
    nameEdited = useRef(false),
    firstField = useRef(),
    formRef = useRef();
  const initialLoaded = useRef(!!order);
  async function loadOrder() {
    setLoadError(null);
    try {
      const o = await api(`/orders/${id}`);
      setOrder(o);
      if (!initialLoaded.current) {
        setForm(fromOrder(o));
        observed.current = o.confirmationSnapshot;
        initialLoaded.current = true;
      }
    } catch (e) {
      setLoadError(e);
    }
  }
  function loadAreas() {
    setAreasError(null);
    api("/orders/service-areas").then(setAreas, setAreasError);
  }
  useEffect(() => {
    loadAreas();
    if (editing) loadOrder();
    else firstField.current?.focus();
  }, [id, editing]);
  useEffect(() => {
    if (supportedAreas?.length === 1)
      setForm((f) => (f.serviceArea ? f : { ...f, serviceArea: supportedAreas[0] }));
  }, [supportedAreas]);
  function persist(next) {
    setDrafts(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {}
  }
  useEffect(() => {
    if (editing || !dirty || recovery) return;
    const draft = {
      id: activeId,
      form,
      updatedAt: new Date().toISOString(),
      pendingPayload: pendingPayload.current,
      unknown,
    };
    const current = readDrafts(key);
    const next = [draft, ...current.filter((d) => d.id !== activeId)].slice(0, 8);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {}
  }, [form, dirty, activeId, unknown, recovery, editing, key]);
  useEffect(() => {
    if (editing || !unknown || busy || recovery) return;
    let cancelled = false;
    api(`/orders/${activeId}`).then(
      (saved) => {
        if (cancelled) return;
        update(saved);
        setDirty(false);
        persist(readDrafts(key).filter((draft) => draft.id !== activeId));
        navigate(`/store/orders/${saved._id}/created`, { replace: true });
      },
      (e) => {
        if (!cancelled && e.status !== 404) setError(e);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [editing, unknown, busy, recovery, activeId, key, update, navigate]);
  function recover(draft) {
    setActiveId(draft.id);
    setForm(draft.form);
    setDirty(true);
    setUnknown(!!draft.unknown);
    pendingPayload.current = draft.pendingPayload || null;
    nameEdited.current = !!draft.form.recipientName;
    setRecovery(false);
    requestAnimationFrame(() => firstField.current?.focus());
  }
  const phone = normalizePhone(form.customerPhone),
    match =
      validPhone(form.customerPhone) &&
      orders?.find((o) => normalizePhone(o.customerPhone) === phone && o.recipientName);
  useEffect(() => {
    if (!editing && !recovery && match && !nameEdited.current && !unknown)
      setForm((f) => ({ ...f, recipientName: match.recipientName }));
  }, [phone, match?.recipientName, editing, unknown, recovery]);
  function change(field, value) {
    if (busy || unknown) return;
    if (field === "recipientName") nameEdited.current = true;
    if (field === "customerPhone" && !editing) {
      nameEdited.current = false;
      setForm((f) => ({ ...f, [field]: value, recipientName: "" }));
    } else setForm((f) => ({ ...f, [field]: value }));
    setDirty(true);
    setErrors((e) => ({ ...e, [field]: undefined }));
  }
  function validate(values = form) {
    const out = {};
    const quick = editing && [2, 3].includes(order?.workflowVersion);
    if ((!quick || values.customerPhone) && !validPhone(values.customerPhone)) out.customerPhone = "invalidPhone";
    if (!quick && !values.recipientName.trim()) out.recipientName = "required";
    try {
      if (!quick || values.goodsAmountAgorot.trim()) parseMoney(values.goodsAmountAgorot);
    } catch {
      out.goodsAmountAgorot = "invalidMoney";
    }
    if (editing && order?.priceSource === "manual") {
      try {
        parseMoney(values.deliveryFeeAgorot, true);
      } catch {
        out.deliveryFeeAgorot = "invalidMoney";
      }
    }
    if (!values.serviceArea) out.serviceArea = "required";
    if (!values.deliveryFeePaidBy) out.deliveryFeePaidBy = "required";
    if (!quick && !values.parcelSize) out.parcelSize = "required";
    return out;
  }
  function blur(field) {
    setErrors((e) => ({ ...e, [field]: validate()[field] }));
  }
  const labels = {
    customerPhone: "phone",
    recipientName: "name",
    goodsAmountAgorot: "goods",
    parcelDescription: "description",
    area: "area",
    parcelSize: "size",
    deliveryFeePaidBy: "payer",
    deliveryFeeAgorot: "fare",
    finalAddress: "destination",
    deliveryInstructions: null,
  };
  function input(field, extra = {}) {
    const issue = errors[field],
      label = labels[field] ? c(labels[field]) : t(field);
    return (
      <label className="mw-field" key={field} htmlFor={`editor-${field}`}>
        <span>{label}</span>
        <input
          id={`editor-${field}`}
          ref={field === "customerPhone" ? firstField : undefined}
          value={form[field] || ""}
          onChange={(e) => change(field, e.target.value)}
          onBlur={() => blur(field)}
          maxLength={2000}
          aria-invalid={!!issue}
          aria-describedby={issue ? `error-${field}` : undefined}
          {...extra}
        />
        {issue && (
          <small id={`error-${field}`} className="mw-field-error">
            {c(issue)}
          </small>
        )}
      </label>
    );
  }
  function payload() {
    const result = {
      ...form,
      customerPhone: normalizePhone(form.customerPhone),
      ...(editing && [2, 3].includes(order?.workflowVersion) && !form.goodsAmountAgorot.trim()
        ? {} : { goodsAmountAgorot: parseMoney(form.goodsAmountAgorot) }),
      ...(editing && order?.priceSource === "manual"
        ? { deliveryFeeAgorot: parseMoney(form.deliveryFeeAgorot, true) }
        : {}),
      ...(editing ? { observed: observed.current } : { operationId: activeId }),
    };
    if (!result.parcelSize) delete result.parcelSize;
    if (editing && [2, 3].includes(order?.workflowVersion) && !form.goodsAmountAgorot.trim()) delete result.goodsAmountAgorot;
    return result;
  }
  async function save(allowDuplicate = false) {
    if (locked.current) return;
    const issues = validate();
    setErrors(issues);
    if (Object.keys(issues).length) {
      requestAnimationFrame(() => formRef.current?.querySelector('[aria-invalid="true"]')?.focus());
      return;
    }
    if (!editing && !allowDuplicate && !unknown) {
      const candidate = orders?.find(
        (o) =>
          normalizePhone(o.customerPhone) === phone &&
          Math.abs((o.goodsAmountAgorot || 0) - parseMoney(form.goodsAmountAgorot)) <= 100 &&
          Date.now() - new Date(o.createdAt).getTime() < 10 * 60000 &&
          o._id !== activeId,
      );
      if (candidate) {
        setDuplicate(candidate);
        return;
      }
    }
    locked.current = true;
    setBusy(true);
    setError(null);
    setDuplicate(null);
    try {
      let result;
      if (!editing && unknown) {
        try {
          result = await api(`/orders/${activeId}`);
        } catch (e) {
          if (e.status !== 404) throw e;
        }
      }
      if (!result) {
        const body = pendingPayload.current || payload();
        pendingPayload.current = body;
        if (!editing) {
          setDirty(true);
          persist([
            {
              id: activeId,
              form,
              updatedAt: new Date().toISOString(),
              pendingPayload: body,
              unknown: true,
            },
            ...readDrafts(key).filter((d) => d.id !== activeId),
          ]);
        }
        result = await api(editing ? `/orders/${id}` : "/orders", {
          method: editing ? "PATCH" : "POST",
          body,
        });
      }
      update(result);
      setDirty(false);
      setUnknown(false);
      if (!editing) persist(readDrafts(key).filter((d) => d.id !== activeId));
      navigate(editing ? `/store/orders/${id}` : `/store/orders/${result._id}/created`, {
        replace: true,
        state: { from: location.state?.from || "/store" },
      });
      refresh();
    } catch (e) {
      setError(e);
      if (["network_error", "request_timeout"].includes(e.code) || e.status >= 500)
        setUnknown(true);
      else {
        setUnknown(false);
        pendingPayload.current = null;
        if (!editing)
          persist([
            {
              id: activeId,
              form,
              updatedAt: new Date().toISOString(),
              pendingPayload: null,
              unknown: false,
            },
            ...readDrafts(key).filter((d) => d.id !== activeId),
          ]);
      }
      if (editing && e.status === 409) {
        try {
          setConflict(await api(`/orders/${id}`));
        } catch {}
      }
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  if (editing && [401, 403].includes(loadError?.status))
    return (
      <Empty title={c("forbidden")}>
        <Link to="/store/orders">{c("back")}</Link>
      </Empty>
    );
  if (editing && !order)
    return loadError ? <ErrorState error={loadError} retry={loadOrder} /> : <Skeleton />;
  if (editing && !order.canEdit)
    return (
      <>
        <PageTitle title={c("edit")} />
        <p className="callout">{c("editBlocked")}</p>
        <Link to={`/store/orders/${id}`}>{c("openOrder")}</Link>
      </>
    );
  if (recovery)
    return (
      <>
        <PageTitle title={c("newOrder")} />
        <section className="mw-card mw-draft">
          <h2>{c("draftTitle")}</h2>
          {drafts.some((draft) => draft.unknown) && (
            <p className="callout attention">{c("unknownCreate")}</p>
          )}
          {drafts.map((draft) => (
            <div className="mw-draft-row" key={draft.id}>
              <strong>
                <bdi>{draft.form.recipientName || c("unnamed")}</bdi> ·{" "}
                <bdi dir="ltr">{maskedPhone(draft.form.customerPhone)}</bdi>
              </strong>
              <p>
                <Money
                  value={(() => {
                    try {
                      return parseMoney(draft.form.goodsAmountAgorot);
                    } catch {
                      return null;
                    }
                  })()}
                />{" "}
                · {dateTime(draft.updatedAt, language)}
              </p>
              <button onClick={() => recover(draft)}>
                {c(draft.unknown ? "checkResult" : "draftContinue")}
              </button>
            </div>
          ))}
          <div className="mw-actions">
            <button
              className="quiet"
              disabled={drafts.some((draft) => draft.unknown)}
              onClick={() => {
                setRecovery(false);
                setForm(emptyForm());
                setActiveId(operationId());
              }}
            >
              {c("draftNew")}
            </button>
            <button
              className="mw-text-button danger-text"
              disabled={drafts.some((draft) => draft.unknown)}
              onClick={() => setDeleting(true)}
            >
              {c("draftDelete")}
            </button>
          </div>
          <p className="mw-muted">{c("draftKept")}</p>
        </section>
        {deleting && (
          <Dialog title={c("deleteDraftTitle")} onClose={() => setDeleting(false)}>
            <button
              className="danger"
              onClick={() => {
                persist([]);
                setDeleting(false);
                setRecovery(false);
              }}
            >
              {c("draftDelete")}
            </button>
          </Dialog>
        )}
      </>
    );
  const goods = (() => {
    try {
      return parseMoney(form.goodsAmountAgorot);
    } catch {
      return null;
    }
  })();
  return (
    <>
      <Link
        className="mw-back"
        to={editing ? `/store/orders/${id}` : location.state?.from || "/store"}
      >
        {c("back")} <span aria-hidden="true">›</span>
      </Link>
      <PageTitle
        title={c(editing ? "edit" : "newOrder")}
        eyebrow={editing ? `#${orderNumber(order)} · ${order.recipientName}` : undefined}
      />
      {unknown && (
        <p className="callout attention" role="status">
          {c(editing ? "unknownMutation" : "unknownCreate")}
        </p>
      )}
      {error && !unknown && (
        <div role="alert" className="callout error">
          {t(error.code || "server_error")}
        </div>
      )}
      {conflict && (
        <section className="callout attention" role="alert">
          <h2>{c("conflict")}</h2>
          <dl className="mw-facts">
            {["customerPhone", "recipientName", "goodsAmountAgorot", "parcelSize"].map((k) => (
              <div key={k}>
                <dt>
                  {c(labels[k])} · {c("latestValue")}
                </dt>
                <dd>
                  {k === "goodsAmountAgorot" ? (
                    <Money value={conflict[k]} />
                  ) : k === "parcelSize" ? (
                    (conflict[k] ? t(`size.${conflict[k]}`) : c("notSet"))
                  ) : (
                    <bdi>{conflict[k] || "—"}</bdi>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          {conflict.canEdit ? (
            <button
              className="quiet"
              onClick={() => {
                observed.current = conflict.confirmationSnapshot;
                setOrder(conflict);
                setConflict(null);
                pendingPayload.current = null;
              }}
            >
              {c("acceptLatest")}
            </button>
          ) : (
            <p>{c("editBlocked")}</p>
          )}
        </section>
      )}
      <form
        className="mw-editor"
        ref={formRef}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <section className="mw-card">
          {Object.values(errors).some(Boolean) && (
            <div className="callout error" role="alert">
              <strong>{c("errors")}</strong>
              <ul>
                {Object.entries(errors)
                  .filter(([, v]) => v)
                  .map(([k, v]) => (
                    <li key={k}>
                      <a
                        href={`#editor-${k}`}
                        onClick={(e) => {
                          e.preventDefault();
                          document.getElementById(`editor-${k}`)?.focus();
                        }}
                      >
                        {labels[k] ? c(labels[k]) : t(k)}: {c(v)}
                      </a>
                    </li>
                  ))}
              </ul>
            </div>
          )}
          <fieldset disabled={busy || unknown}>
            {input("customerPhone", {
              type: "tel",
              inputMode: "tel",
              autoComplete: "tel",
              dir: "ltr",
            })}
            {!editing && validPhone(form.customerPhone) && (
              <div className="mw-lookup">
                {!orders ? (
                  <p>
                    {c(lookupError ? "lookupFailed" : "lookupPending")}
                    {lookupError && (
                      <button type="button" className="mw-text-button" onClick={refresh}>
                        {c("retry")}
                      </button>
                    )}
                  </p>
                ) : match ? (
                  <>
                    <strong>
                      {c("returningCustomer")} · <bdi>{match.recipientName}</bdi>
                    </strong>
                    <p>
                      {c("lastOrder")}: {dateTime(match.createdAt, language)}
                    </p>
                    <button
                      type="button"
                      className="mw-text-button"
                      onClick={() => {
                        nameEdited.current = true;
                        document.getElementById("editor-recipientName")?.focus();
                      }}
                    >
                      {c("correctIdentity")}
                    </button>
                  </>
                ) : (
                  <p>{c("newCustomer")}</p>
                )}
              </div>
            )}
            {input("recipientName", { autoComplete: "name", dir: "auto" })}
            {editing && [2, 3].includes(order?.workflowVersion) && order.customerConfirmed && (
              <p className="callout" role="note">{t("goodsEditVoidsConfirmation")}</p>
            )}
            {input("goodsAmountAgorot", { inputMode: "decimal", dir: "ltr", placeholder: "0.00" })}
            <p className="mw-muted">
              {c("collection")}: <Money value={goods} />
            </p>
            <p className="mw-hint">{c("collectionPolicy")}</p>
            <ChoiceGroup
              id="editor-parcelSize"
              legend={c("size")}
              name="size"
              value={form.parcelSize}
              options={["small", "medium", "large"]}
              label={(size) => t(`size.${size}`)}
              onChange={(size) => change("parcelSize", size)}
              invalid={!!errors.parcelSize}
              error={errors.parcelSize && c("required")}
            />
            <details className="mw-disclosure">
              <summary>{c("sizeHelp")}</summary>
              <p>{c("sizeHint")}</p>
            </details>
            <ChoiceGroup
              id="editor-deliveryFeePaidBy"
              legend={c("payer")}
              name="payer"
              value={form.deliveryFeePaidBy}
              options={["customer", "store"]}
              label={(payer) => c(payer)}
              isDisabled={(payer) => order?.workflowVersion === 2 && payer === "store"}
              onChange={(payer) => change("deliveryFeePaidBy", payer)}
              invalid={!!errors.deliveryFeePaidBy}
              error={errors.deliveryFeePaidBy && c("required")}
            />
            {order?.workflowVersion === 3 && <label className="mw-field"><span>{t("goodsPaymentStatus")}</span>
              <select aria-label={t("goodsPaymentStatus")} value={form.goodsPaymentStatus ?? "unpaid"} onChange={e => change("goodsPaymentStatus", e.target.value)}>
                <option value="unpaid">{t("goodsUnpaid")}</option><option value="prepaid">{t("goodsPrepaid")}</option>
              </select></label>}
            {order?.workflowVersion !== 2 && (
              <ChoiceGroup
                legend={c("readiness")}
                name="ready"
                value={form.parcelReady}
                options={[true, false]}
                label={(ready) => c(ready ? "ready" : "notReady")}
                onChange={(ready) => change("parcelReady", ready)}
              />
            )}
            {input("parcelDescription", { dir: "auto" })}
            <label className="mw-field" htmlFor="editor-serviceArea">
              <span>{t("serviceArea")}</span>
              <select
                id="editor-serviceArea"
                value={form.serviceArea}
                disabled={!!order?.activeAssignment || !supportedAreas}
                onChange={(e) => change("serviceArea", e.target.value)}
                aria-invalid={!!errors.serviceArea}
              >
                <option value="">{t("chooseServiceArea")}</option>
                {supportedAreas?.map((a) => (
                  <option key={a} value={a}>
                    {t(`serviceArea.${a}`)}
                  </option>
                ))}
              </select>
              {errors.serviceArea && <small className="mw-field-error">{c("required")}</small>}
            </label>
            {areasError && (
              <p className="mw-field-error" role="alert">
                {t(areasError.code)}{" "}
                <button type="button" className="mw-text-button" onClick={loadAreas}>
                  {c("retry")}
                </button>
              </p>
            )}
            {input("area", { dir: "auto" })}
            {editing && (
              <>
                {input("finalAddress", { dir: "auto" })}
                {input("deliveryInstructions", { dir: "auto" })}
                {order.priceSource === "manual" &&
                  input("deliveryFeeAgorot", { inputMode: "decimal", dir: "ltr" })}
              </>
            )}
          </fieldset>
          {editing && <p className="callout">{c("editImpact")}</p>}
          {!editing && !me.pickupLocation && (
            <p className="callout error">
              {t("pickupLocationMissing")} <Link to="/store/settings">{c("settings")}</Link>
            </p>
          )}
          {!editing && <p className="mw-hint">{c("draftSaved")}</p>}
        </section>
        <aside className="mw-editor-summary mw-card">
          <h2>{c("summary")}</h2>
          <strong>
            <bdi>{form.recipientName || c("unnamed")}</bdi>
          </strong>
          <p dir="ltr">{form.customerPhone || "—"}</p>
          <dl className="mw-facts">
            <div>
              <dt>{c("goods")}</dt>
              <dd>
                <Money value={goods} />
              </dd>
            </div>
            <div>
              <dt>{c("collection")}</dt>
              <dd>
                <Money value={goods} />
              </dd>
            </div>
            <div>
              <dt>{c("size")}</dt>
              <dd>{form.parcelSize ? t(`size.${form.parcelSize}`) : c("notSet")}</dd>
            </div>
            <div>
              <dt>{c("payer")}</dt>
              <dd>{c(form.deliveryFeePaidBy || "notSet")}</dd>
            </div>
          </dl>
          <p className="mw-muted">{c("fareAfterLocation")}</p>
          <div className="mw-form-action">
            <button
              disabled={
                busy ||
                !!conflict ||
                (!unknown && ((!editing && !me.pickupLocation) || !supportedAreas))
              }
            >
              {c(busy ? "creating" : unknown ? "checkResult" : editing ? "save" : "create")}
            </button>
          </div>
        </aside>
      </form>
      {duplicate && (
        <Dialog title={c("duplicateTitle")} onClose={() => setDuplicate(null)}>
          <p>{c("duplicateBody")}</p>
          <strong>
            <bdi>#{orderNumber(duplicate)}</bdi> · <bdi>{duplicate.recipientName}</bdi>
          </strong>
          <p>
            {c("collection")}: <Money value={duplicate.goodsAmountAgorot} />
          </p>
          <p>
            {c(operationalState(duplicate).title)} · {dateTime(duplicate.createdAt, language)}
          </p>
          <div className="mw-stack">
            <Link
              className="button-link"
              to={`/store/orders/${duplicate._id}`}
              state={{ from: "/store/new" }}
            >
              {c("openOrder")}
            </Link>
            <button className="quiet" onClick={() => save(true)}>
              {c("createAnyway")}
            </button>
            <button className="mw-text-button" onClick={() => setDuplicate(null)}>
              {c("returnEdit")}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
