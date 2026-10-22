import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { Money, RoutePrice } from "../components/UI.jsx";
import LocationPicker from "../components/LocationPicker.jsx";
import CustomerLinkSms from "./CustomerLinkSms.jsx";
import {
  CopyButton,
  Dialog,
  Empty,
  ErrorState,
  Icon,
  MoneyBreakdown,
  PageTitle,
  Skeleton,
  TaskButton,
  useCopy,
  useWorkspace,
} from "./components.jsx";
import { dateTime, merchantTasks, operationalState, orderNumber, terminal } from "./model.js";
import "./orderDetails.css";

export function useOrder() {
  const { id } = useParams(),
    { orders, update } = useWorkspace();
  const [localOrder, setLocalOrder] = useState(null),
    [error, setError] = useState(null),
    [freshAt, setFreshAt] = useState(null),
    mounted = useRef(true);
  const cached = orders?.find((o) => o._id === id),
    order = cached || localOrder;
  async function load() {
    setError(null);
    try {
      const result = await api(`/orders/${id}`);
      if (mounted.current) {
        setLocalOrder(result);
        update(result);
        setFreshAt(new Date());
      }
      return result;
    } catch (e) {
      if (mounted.current) setError(e);
      return null;
    }
  }
  useEffect(() => {
    mounted.current = true;
    load();
    return () => {
      mounted.current = false;
    };
  }, [id]);
  return { order, error, freshAt, load };
}
export function CustomerLink({ order: o }) {
  const { c, t } = useCopy(),
    { mutate, mutation } = useWorkspace(),
    [replace, setReplace] = useState(false);
  if (!o.customerLink) return null;
  return (
    <section className="mw-customer-link">
      <h3>{c("link")}</h3>
      <p className="mw-muted">{c("smsAutomatic")}</p>
      <div className="mw-actions">
        <CopyButton text={o.customerLink} label="copyLink" />
        {!terminal.has(o.status) && <CustomerLinkSms order={o} />}
        {o.canEdit && (
          <button
            className="mw-text-button"
            disabled={mutation?.busy}
            onClick={() => setReplace(true)}
          >
            {c("replaceLink")}
          </button>
        )}
      </div>
      {replace && (
        <Dialog title={c("replaceLink")} onClose={() => setReplace(false)}>
          <p>{c("replaceImpact")}</p>
          <button
            disabled={mutation?.busy}
            onClick={async () => {
              if (await mutate(o, "customer-link/reissue")) setReplace(false);
            }}
          >
            {c(mutation?.busy ? "saving" : "replaceLink")}
          </button>
        </Dialog>
      )}
    </section>
  );
}

// The "..." menu: the less common things a store can do with an order.
function OrderMenu({ order: o, state, onCorrectPickup, onCancel }) {
  const { c } = useCopy(),
    [open, setOpen] = useState(false),
    box = useRef(null),
    trigger = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (event) => {
      if (event.type === "keydown" && event.key !== "Escape") return;
      if (event.type === "pointerdown" && box.current?.contains(event.target)) return;
      setOpen(false);
      if (event.type === "keydown") trigger.current?.focus();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const from = { from: state };
  return (
    <div className="od-menu" ref={box}>
      <button type="button" className="od-round" ref={trigger} aria-label={c("odMore")} aria-haspopup="menu"
        aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="more" />
      </button>
      {open && (
        <div className="od-menu-list" role="menu" onClick={() => setOpen(false)}>
          {o.canEdit && <Link role="menuitem" to={`/store/orders/${o._id}/edit`} state={from}>{c("edit")}</Link>}
          {o.canEdit && <button role="menuitem" type="button" onClick={onCorrectPickup}>{c("correctPickup")}</button>}
          <Link role="menuitem" to={`/store/orders/${o._id}/finance`}>{c("moneyDetails")}</Link>
          <Link role="menuitem" to={`/store/orders/${o._id}/history`} state={from}>{c("history")}</Link>
          <Link role="menuitem" to={`/store/orders/${o._id}/help`} state={from}>{c("orderHelp")}</Link>
          {onCancel && <button role="menuitem" type="button" className="danger-text" onClick={onCancel}>{c("cancel")}</button>}
        </div>
      )}
    </div>
  );
}

// The trip as a vertical timeline: what happened, when, and what is next.
function Timeline({ order: o, language }) {
  const { c } = useCopy();
  const atDoor = ["driver_at_destination", "delivered"].includes(o.status) || !!o.arrivedCustomerAt;
  const steps = [
    ["odStepCreated", true, o.createdAt],
    ["odStepDriver", !!o.acceptedAt || o.activeAssignment || !!o.collectedAt, o.acceptedAt],
    ["odStepAtStore", !!o.arrivedStoreAt || !!o.collectedAt, o.arrivedStoreAt],
    ["odStepPicked", !!o.collectedAt, o.collectedAt],
    ["odStepOnWay", atDoor, null],
    ["odStepDelivered", o.status === "delivered", o.deliveredAt],
  ];
  const current = steps.findIndex(([, done]) => !done);
  return (
    <section className="od-card" aria-labelledby="od-track">
      <h2 id="od-track">{c("odTrack")}</h2>
      <ol className="od-timeline">
        {steps.map(([label, done, at], index) => (
          <li key={label} className={done ? "done" : index === current ? "current" : ""}
            aria-current={index === current ? "step" : undefined}>
            <span className="od-dot" aria-hidden="true">{done && <Icon name="check" size={13} />}</span>
            <span className="od-step">{c(label)}</span>
            {done && at && <time dateTime={at}>{dateTime(at, language, true)}</time>}
          </li>
        ))}
      </ol>
    </section>
  );
}

// The wide layout shows the trip to the store and on as four bars; the phone shows the full timeline.
function Stages({ order: o }) {
  const { c } = useCopy();
  const steps = [
    ["odStageDriver", !!o.activeAssignment || !!o.collectedAt || o.status === "delivered"],
    ["odStageToStore", !!o.arrivedStoreAt || !!o.collectedAt],
    ["odStageAtStore", !!o.collectedAt],
    ["odStageToCustomer", o.status === "delivered"],
  ];
  const current = steps.findIndex(([, done]) => !done);
  return (
    <ol className="od-stages" aria-label={c("odTrack")}>
      {steps.map(([label, done], index) => (
        <li key={label} className={done || index === current ? "on" : ""} aria-current={index === current ? "step" : undefined}>
          {c(label)}
        </li>
      ))}
    </ol>
  );
}

// Copies a link and says so; the same quiet button style as "resend".
function CopyLink({ text }) {
  const { c } = useCopy(),
    [done, setDone] = useState(false);
  return (
    <button type="button" className="od-banner-btn soft" onClick={async () => {
      try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 2000); } catch {}
    }}>
      {c(done ? "copied" : "copyLink")}
    </button>
  );
}

// `embedded`: shown next to the orders list on a wide screen instead of as a page of its own.
export default function OrderDetails({ embedded = false }) {
  const { order: o, error, freshAt, load } = useOrder(),
    { c, t, f, language, age } = useCopy(),
    { openTask, mutate, mutation, updatedAt } = useWorkspace();
  const location = useLocation(),
    [revealed, setRevealed] = useState(null),
    [revealError, setRevealError] = useState(null),
    [revealing, setRevealing] = useState(false),
    [cancel, setCancel] = useState(false),
    [reason, setReason] = useState(""),
    [returning, setReturning] = useState(false),
    [returnChecked, setReturnChecked] = useState(false),
    [editingPickup, setEditingPickup] = useState(false);
  const pickupRef = useRef(),
    revealLock = useRef(false),
    initialFocus = useRef(false);
  const tasks = o ? merchantTasks(o) : [],
    task = tasks[0],
    s = o && operationalState(o);
  const assignmentKey = o && `${o._id}:${o.driverId}:${o.acceptedAt}`;
  const codeVisible =
    !!o &&
    o.workflowVersion !== 3 &&
    (o.workflowVersion === 2 || revealed === assignmentKey) &&
    (o.status === "driver_at_store" || (o.workflowVersion === 2 && o.status === "driver_assigned")) &&
    o.activeAssignment &&
    !o.missingRequirements?.length;
  useEffect(() => {
    if (codeVisible) pickupRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [codeVisible]);
  useEffect(() => {
    if (!revealed || !o) return;
    if (revealed !== assignmentKey) {
      setRevealed(null);
      setRevealError("driverChanged");
    } else if (o.status !== "driver_at_store" || o.missingRequirements?.length) {
      setRevealed(null);
      setRevealError(null);
    }
  }, [assignmentKey, o?.status, o?.missingRequirements?.length, revealed]);
  useEffect(() => {
    if (o && !initialFocus.current && freshAt) {
      initialFocus.current = true;
      if (location.state?.task === "pickup" && o.workflowVersion !== 2) reveal();
    }
  }, [o, freshAt]);
  async function reveal() {
    if (revealLock.current || !o) return;
    revealLock.current = true;
    setRevealing(true);
    setRevealError(null);
    const key = assignmentKey;
    const current = await load();
    if (!current) setRevealError("codeFailed");
    else if (`${current._id}:${current.driverId}:${current.acceptedAt}` !== key) {
      setRevealed(null);
      setRevealError("driverChanged");
    } else if (
      current.status !== "driver_at_store" ||
      !current.activeAssignment ||
      current.missingRequirements?.length ||
      !current.pickupCode
    ) {
      setRevealed(null);
      setRevealError("codeUnavailable");
    } else setRevealed(key);
    setRevealing(false);
    revealLock.current = false;
  }
  function act(task) {
    if (task.kind === "pickup") reveal();
    else if (task.kind === "return") setReturning(true);
    else openTask(task);
  }
  if (error?.status === 403 || error?.status === 401)
    return (
      <Empty title={c("forbidden")}>
        <Link to="/store/orders">{c("back")}</Link>
      </Empty>
    );
  if (!o) return error ? <ErrorState error={error} retry={load} /> : <Skeleton />;
  const canCancel = o.status === "searching_driver" && !o.activeAssignment && !o.collectedAt;
  const back = location.state?.from || "/store/orders";
  const area = o.workflowVersion === 2 && o.serviceArea ? t(`serviceArea.${o.serviceArea}`) : o.area;
  const place = o.destinationLocation?.address || o.finalAddress;
  const km = o.routeDistanceMeters > 0 ? `${(o.routeDistanceMeters / 1000).toFixed(1)} ${c("odKm")}` : null;
  const tone = task ? "action" : s.tone === "success" ? "success" : "neutral";
  const driver = o.assignedDriver;
  const customerDone = !!o.customerConfirmed;
  const waitingForCustomer = o.canEdit && !customerDone && !!o.customerLink && !terminal.has(o.status);
  const fareReady = o.priceStatus === "final" && o.deliveryFeeAgorot != null;
  const primaryClass = embedded ? "od-banner-btn" : "od-primary";
  const primary = task && !codeVisible && (
    ["pickup", "return"].includes(task.kind) ? (
      <button className={primaryClass} disabled={revealing || mutation?.busy} onClick={() => act(task)}>
        {c(revealing ? "loading" : task.action)}
      </button>
    ) : (
      <TaskButton className={primaryClass} task={task} onOpen={act} arrow={false} />
    )
  );
  const chipTone = task || s.tone === "attention" ? "attention" : s.tone === "success" || (o.activeAssignment && !terminal.has(o.status)) ? "ok" : "";
  const stateTitle = c(codeVisible ? "waitingPickup" : s.title);
  const stateCard = (
    <section className="od-card od-state" aria-labelledby="order-state">
      <p className={`od-label ${tone}`}>
        <i aria-hidden="true" />
        {c(tone === "action" ? "odNeedsAction" : tone === "success" ? "odDone" : "odInProgress")}
      </p>
      <h2 id="order-state">{stateTitle}</h2>
      <p>{c(codeVisible ? "pickupRevealed" : s.body)}</p>
      {o.failureReason && <p>{o.failureReason}</p>}
      {o.cancellationReason && (
        <p>
          {c("cancelReason")}:{" "}
          {o.cancellationReason === "store_cancelled" ? t("storeCancelledReason") : o.cancellationReason}
        </p>
      )}
    </section>
  );
  const codeCard = codeVisible && (
    <section className="od-card od-code" ref={pickupRef} aria-labelledby="od-code-title">
      <h2 id="od-code-title">{c("odPickupCode")}</h2>
      <strong className="od-code-digits" dir="ltr">{o.pickupCode}</strong>
      <p>{c("codeInstruction")}</p>
    </section>
  );
  const driverCard = (driver || embedded) && (
    <section className={`od-card od-person ${embedded ? "stacked" : ""}`} aria-label={c("odDriverRole")}>
      {embedded && <h2>{c("odDriverRole")}</h2>}
      {driver ? (
        <>
          <span className="od-avatar" aria-hidden="true">{(driver.name || "").trim().charAt(0)}</span>
          <div>
            <strong><bdi>{driver.name}</bdi></strong>
            <small>{[c("odDriverRole"), driver.vehicleType && t(`vehicle.${driver.vehicleType}`)].filter(Boolean).join(" · ")}</small>
          </div>
          {driver.phone && (
            <a className="od-round soft" href={`tel:${driver.phone}`} aria-label={c("odCallDriver")}><Icon name="phone" /></a>
          )}
        </>
      ) : (
        <p className="od-muted">{c("odNoDriver")}</p>
      )}
    </section>
  );
  const waiting = <span className="od-waiting">{c("odWaitingCustomer")}</span>;
  const customerCard = (
    <section className="od-card" aria-labelledby="od-customer">
      <div className="od-card-head">
        <h2 id="od-customer">{c("odCustomer")}</h2>
        <span className={`od-badge ${customerDone ? "ok" : ""}`}>
          {customerDone && <Icon name="check" size={13} />}
          {c(customerDone ? "odCustomerDone" : "odCustomerWaiting")}
        </span>
      </div>
      <dl className="od-rows">
        <div><dt>{c("odName")}</dt><dd>{o.recipientName ? <bdi>{o.recipientName}</bdi> : waiting}</dd></div>
        <div>
          <dt>{c("odPhone")}</dt>
          <dd>{o.customerPhone ? <a href={`tel:${o.customerPhone}`} dir="ltr">{o.customerPhone}</a> : waiting}</dd>
        </div>
        <div>
          <dt>{c("odPlace")}</dt>
          <dd>
            {place ? <><bdi>{place}</bdi>{km && ` · ${km}`}</> : area ? <bdi>{`${area} ${c("odApprox")}`}</bdi> : waiting}
          </dd>
        </div>
        {o.deliveryInstructions && <div><dt>{c("odInstructions")}</dt><dd><bdi>{o.deliveryInstructions}</bdi></dd></div>}
      </dl>
      {!embedded && waitingForCustomer && <CustomerLink order={o} />}
    </section>
  );
  const amountsCard = (
    <section className="od-card" aria-label={c(embedded ? "odAmount" : "finance")}>
      {embedded && <h2>{c("odAmount")}</h2>}
      <dl className="od-rows amounts">
        <div>
          <dt>{c("odGoods")}</dt>
          <dd>{o.goodsAmountKnown === false ? t("goodsUnknown") : <Money value={o.goodsAmountAgorot} />}</dd>
        </div>
        <div>
          <dt>{c("odFare")}{o.deliveryFeePaidBy === "store" && <small>{c("odStorePays")}</small>}</dt>
          <dd>{fareReady ? <Money value={o.deliveryFeeAgorot} /> : <span className="od-waiting">{c("odFareLater")}</span>}</dd>
        </div>
        {fareReady && o.expectedCustomerCashAgorot != null && (
          <div className="total">
            <dt>{c("odTotal")}</dt>
            <dd><Money value={o.expectedCustomerCashAgorot} /></dd>
          </div>
        )}
      </dl>
      {o.priceStatus !== "final" && o.routeError && <RoutePrice order={o} />}
      {o.collectionAdjustment && <Link to={`/store/orders/${o._id}/review`}>{c("financialReview")}</Link>}
    </section>
  );
  const parcelCard = (o.parcelSize || o.parcelDescription || (o.canEdit && o.missingRequirements?.length > 0)) && (
    <details className="od-card od-more">
      <summary>{c("odParcel")}</summary>
      <dl className="od-rows">
        <div><dt>{c("size")}</dt><dd>{o.parcelSize ? t(`size.${o.parcelSize}`) : c("notSet")}</dd></div>
        {o.workflowVersion !== 2 && <div><dt>{c("readiness")}</dt><dd>{c(o.parcelReady ? "ready" : "notReady")}</dd></div>}
        {o.parcelDescription && <div><dt>{c("description")}</dt><dd><bdi>{o.parcelDescription}</bdi></dd></div>}
        <div><dt>{c("origin")}</dt><dd><bdi>{o.pickupLocation?.address || o.pickupAddress || c("notSet")}</bdi></dd></div>
      </dl>
      {o.canEdit && o.missingRequirements?.length > 0 && (
        <ul>{o.missingRequirements.map((k) => <li key={k}>{t(k)}</li>)}</ul>
      )}
    </details>
  );
  const pickupEditor = o.canEdit && editingPickup && (
    <section className="od-card">
      <p className="mw-hint">{c("correctPickupImpact")}</p>
      <LocationPicker
        key={o._id}
        title="pickupLocation"
        value={o.pickupLocation}
        center={o.pickupLocation}
        canEdit={!mutation?.busy}
        searchPath="/maps/search"
        reversePath="/maps/reverse"
        onConfirm={async (body) => {
          const saved = await mutate(o, "pickup-location", { ...body, observed: o.confirmationSnapshot }, true);
          if (!saved) throw Object.assign(new Error("state_conflict"), { code: "state_conflict" });
          setEditingPickup(false);
        }}
      />
      <button className="quiet" onClick={() => setEditingPickup(false)}>{c("close")}</button>
    </section>
  );
  const notices = (
    <>
      {location.state?.task && !tasks.some((t) => t.kind === location.state.task) && (
        <p className="callout">{c("taskResolved")}</p>
      )}
      {error && (
        <div className="callout attention" role="status">
          <p>{c("cached")} {dateTime(freshAt || updatedAt, language)}</p>
          <button className="quiet" onClick={load}>{c("retry")}</button>
        </div>
      )}
      {revealError && (
        <div className="callout error" role="alert">
          <p>{c(revealError)}</p>
          <button className="quiet" onClick={reveal} disabled={revealing}>{c("retry")}</button>
          <Link to={`/store/orders/${o._id}/help`}>{c("help")}</Link>
        </div>
      )}
    </>
  );
  const menu = (
    <OrderMenu order={o} state={location.pathname} onCorrectPickup={() => setEditingPickup(true)}
      onCancel={embedded && !terminal.has(o.status) ? () => setCancel(true) : undefined} />
  );
  const subtitle = [area, o.createdAt && age(o.createdAt)].filter(Boolean).join(" · ");
  const body = embedded ? (
    <div className="od od-wide">
      <header className="od-head">
        <div className="od-title">
          <h1 tabIndex={-1}>{`${c("order")} #${orderNumber(o)}`}</h1>
          <p>{subtitle}</p>
        </div>
        <span className={`od-chip ${chipTone}`}>{stateTitle}</span>
        {menu}
      </header>
      {notices}
      {o.workflowVersion === 3 && o.dispatchMissing?.length > 0 && <p className="callout" role="status">{[...new Set(o.dispatchMissing)].map(t).join(" · ")}</p>}
      <Stages order={o} />
      {task && !codeVisible && (
        <div className="od-banner">
          <span className="od-banner-icon" aria-hidden="true"><Icon name="warning" /></span>
          <div><strong>{c(task.title)}</strong><p>{c(task.body)}</p></div>
          {primary}
        </div>
      )}
      {waitingForCustomer && (
        <div className="od-banner od-customer-banner">
          <span className="od-banner-icon" aria-hidden="true"><Icon name="warning" /></span>
          <div>
            <strong>
              {o.destinationLocation?.confirmedAt
                ? c("odCustomerNoConfirm")
                : f("odCustomerNoPlace", { age: age(o.createdAt) })}
            </strong>
            <p>{c("odCustomerHint")}</p>
          </div>
          <CopyLink text={o.customerLink} />
          {embedded && <CustomerLinkSms order={o} className="od-banner-btn soft" />}
        </div>
      )}
      {(o.failureReason || o.cancellationReason || terminal.has(o.status)) && (
        <p className="od-note">
          {c(s.body)} {o.failureReason}{" "}
          {o.cancellationReason && (o.cancellationReason === "store_cancelled" ? t("storeCancelledReason") : o.cancellationReason)}
        </p>
      )}
      {codeCard}
      <div className="od-pair">{driverCard}{customerCard}</div>
      {amountsCard}
      {parcelCard}
      {pickupEditor}
    </div>
  ) : (
    <div className="od">
      <header className="od-head">
        <Link className="od-round" to={back} aria-label={c("back")}><Icon name="back" /></Link>
        <div className="od-title">
          <h1 tabIndex={-1}>{`${c("order")} #${orderNumber(o)}`}</h1>
          <p>{subtitle}</p>
        </div>
        {menu}
      </header>
      {notices}
      {stateCard}
      {codeCard}
      <Timeline order={o} language={language} />
      {driver && driverCard}
      {customerCard}
      {amountsCard}
      {parcelCard}
      {pickupEditor}
      {(primary || !terminal.has(o.status)) && (
        <div className="od-bar">
          {primary}
          {!terminal.has(o.status) && (
            <button className="od-cancel" onClick={() => setCancel(true)}>{c("cancel")}</button>
          )}
        </div>
      )}
    </div>
  );
  return (
    <>
      {body}
      {cancel && (
        <Dialog
          title={`${c("cancelTitle")} #${orderNumber(o)}`}
          onClose={() => !mutation?.busy && setCancel(false)}
        >
          <p>
            <bdi>{o.recipientName}</bdi>
          </p>
          <h3>{c("currentState")}</h3>
          <p>
            {c(s.title)} · <bdi>{o.assignedDriver?.name}</bdi>
          </p>
          {canCancel ? (
            <>
              <p>{c("cancelImpact")}</p>
              <h3>{c("financialImpact")}</h3>
              <p>{c("noCancelFee")}</p>
              <label className="mw-field">
                <span>{c("cancelReason")}</span>
                <textarea
                  value={reason}
                  maxLength={300}
                  onChange={(e) => setReason(e.target.value)}
                  disabled={mutation?.busy}
                />
              </label>
              <button
                className="danger"
                disabled={mutation?.busy || !reason.trim()}
                onClick={async () => {
                  if (await mutate(o, "cancel", { reason })) setCancel(false);
                  else await load();
                }}
              >
                {c(mutation?.busy ? "saving" : "cancel")}
              </button>
            </>
          ) : (
            <>
              <p className="callout">{c("cancelBlocked")}</p>
              <Link to={`/store/orders/${o._id}/help`} onClick={() => setCancel(false)}>
                {c("orderHelp")}
              </Link>
            </>
          )}
        </Dialog>
      )}
      {returning && (
        <Dialog title={c("returnAction")} onClose={() => !mutation?.busy && setReturning(false)}>
          <p>{c("returningBody")}</p>
          <label className="mw-check">
            <input
              type="checkbox"
              checked={returnChecked}
              onChange={(e) => setReturnChecked(e.target.checked)}
            />
            {c("returnConfirm")}
          </label>
          <button
            disabled={!returnChecked || mutation?.busy}
            onClick={async () => {
              if (await mutate(o, "confirm-return")) setReturning(false);
            }}
          >
            {c(mutation?.busy ? "saving" : "returnAction")}
          </button>
        </Dialog>
      )}
    </>
  );
}

export function Created() {
  const { order: o, error, load } = useOrder(),
    { c, t } = useCopy(),
    navigate = useNavigate(),
    [copied, setCopied] = useState(false);
  const orderId = o?._id;
  useEffect(() => {
    if (!orderId) return;
    const timer = setTimeout(() => navigate(`/store/orders/${orderId}`, { replace: true }), 5000);
    return () => clearTimeout(timer);
  }, [orderId, navigate]);
  if (!o) return error ? <ErrorState error={error} retry={load} /> : <Skeleton />;
  const quick = [2, 3].includes(o.workflowVersion);
  async function copy() {
    try {
      await navigator.clipboard.writeText(o.customerLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }
  return (
    <section className="oc" aria-labelledby="oc-title">
      <div className="oc-body">
        <span className="oc-mark" aria-hidden="true"><Icon name="check" size={44} /></span>
        <h1 id="oc-title" tabIndex={-1}>{c("odCreatedOk")}</h1>
        <p className="oc-hint">{c("createdRedirect")}</p>
        <p className="oc-label">{c("odOrderNumber")}</p>
        <p className="oc-number"><bdi dir="ltr">#{orderNumber(o)}</bdi></p>
        <p className="oc-status" role="status">
          <i aria-hidden="true" />
          {o.driverSearchStatus === "waiting" ? c("odWaitingCustomer")
            : o.status === "searching_driver" ? t("searchingNow") : t(`status.${o.status}`)}
        </p>
        {quick ? (
          <p className="oc-hint">{t("quickShareFirst")}</p>
        ) : (
          <p className="oc-hint"><bdi>{o.recipientName}</bdi> · <bdi dir="ltr">{o.customerPhone}</bdi></p>
        )}
      </div>
      {o.customerLink && (
        <div className="oc-actions">
          <CustomerLinkSms order={o} />
          <button type="button" className="oc-copy" onClick={copy}>
            <Icon name="copy" size={16} />
            {c(copied ? "copied" : "copyLink")}
          </button>
          <Link className="button-link quiet oc-open" to={`/store/orders/${o._id}`}>{c("openOrder")}</Link>
        </div>
      )}
      {!o.customerLink && (
        <div className="oc-actions">
          <Link className="button-link quiet oc-open" to={`/store/orders/${o._id}`}>{c("openOrder")}</Link>
        </div>
      )}
    </section>
  );
}

export function OrderSubpage({ kind }) {
  const { order: o, error, load } = useOrder(),
    { c, t, language } = useCopy(),
    location = useLocation();
  const [count, setCount] = useState(15),
    [issue, setIssue] = useState("issuePickup");
  if (!o) return error ? <ErrorState error={error} retry={load} /> : <Skeleton />;
  if ([401, 403].includes(error?.status)) return <Empty title={c("forbidden")} />;
  const title = {
      history: "history",
      help: "orderHelp",
      finance: "moneyDetails",
      review: "financialReview",
    }[kind],
    events = [...(o.events || [])].sort((a, b) => b.at.localeCompare(a.at));
  const context = `${c("order")} #${orderNumber(o)}\n${c(operationalState(o).title)}\n${c("issue")}: ${c(issue)}`;
  return (
    <>
      <Link className="mw-back" to={location.state?.from || `/store/orders/${o._id}`}>
        {c("back")} <span aria-hidden="true">›</span>
      </Link>
      <PageTitle title={`${c(title)} #${orderNumber(o)}`} eyebrow={o.recipientName} />
      {error && (
        <p className="callout attention">
          {c("cached")}{" "}
          <button className="mw-text-button" onClick={load}>
            {c("retry")}
          </button>
        </p>
      )}
      {kind === "history" && (
        <section className="mw-card">
          {events.length ? (
            <ol className="mw-history">
              {events.slice(0, count).map((event, index) => (
                <li key={`${event.type}-${event.at}-${index}`}>
                  <time>{dateTime(event.at, language)}</time>
                  <div>
                    <strong>{t(`event.${event.type}`)}</strong>
                    {event.actorType && <small>{c(event.actorType)}</small>}
                    {event.note && <p dir="auto">{event.note}</p>}
                    {event.reason && (
                      <p>
                        {event.type === "driver_withdrawn"
                          ? t(`withdrawal.${event.reason}`)
                          : event.type === "driver_issue_reported"
                            ? t(`issue.${event.reason}`)
                            : event.reason}
                      </p>
                    )}
                    {event.amountAgorot != null && (
                      <p>
                        <Money value={event.amountAgorot} />
                      </p>
                    )}
                    {event.changes && (
                      <p className="mw-muted">
                        {event.changes
                          .map((change) =>
                            change.field === "parcelSize" ? c("size") : t(change.field),
                          )
                          .join(" · ")}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p>{c("historyEmpty")}</p>
          )}
          {events.length > count && (
            <button className="quiet" onClick={() => setCount((n) => n + 15)}>
              {c("olderEvents")}
            </button>
          )}
        </section>
      )}
      {kind === "finance" && (
        <section className="mw-card">
          <MoneyBreakdown order={o} full />
          <p className="mw-hint">{c("collectionPolicy")}</p>
        </section>
      )}
      {kind === "review" && (
        <section className="mw-card">
          <dl className="mw-facts">
            <div>
              <dt>{c("expected")}</dt>
              <dd>
                <Money value={o.expectedCustomerCashAgorot} />
              </dd>
            </div>
            <div>
              <dt>{c("actual")}</dt>
              <dd>
                <Money value={o.actualCashCollectedAgorot} />
              </dd>
            </div>
            <div>
              <dt>{c("difference")}</dt>
              <dd>
                <Money
                  value={o.cashDifferenceAgorot == null ? null : Math.abs(o.cashDifferenceAgorot)}
                />
              </dd>
            </div>
          </dl>
          <p className="callout">{c("reviewAdmin")}</p>
          <p>{c("noFinancePermission")}</p>
          <Link to={`/store/orders/${o._id}/finance`}>{c("moneyDetails")}</Link>
        </section>
      )}
      {kind === "help" && (
        <section className="mw-card">
          <h2>{c("currentState")}</h2>
          <p>{c(operationalState(o).title)}</p>
          <h2>{c("issue")}</h2>
          <div className="mw-help-issues">
            {["issuePickup", "issueLink", "issueMoney", "issueOther"].map((key) => (
              <button
                key={key}
                className="quiet"
                aria-pressed={issue === key}
                onClick={() => setIssue(key)}
              >
                {c(key)}
              </button>
            ))}
          </div>
          <div className="callout">
            <p>
              {c(
                {
                  issuePickup: "helpPickup",
                  issueLink: "helpLink",
                  issueMoney: "helpMoney",
                  issueOther: "helpOther",
                }[issue],
              )}
            </p>
          </div>
          <div className="mw-actions">
            <button className="quiet" onClick={load}>
              {c("refresh")}
            </button>
            {o.assignedDriver?.phone && (
              <a href={`tel:${o.assignedDriver.phone}`}>{c("contactDriver")}</a>
            )}
            <CopyButton text={context} label="supportContext" />
          </div>
          {issue === "issueLink" && <CustomerLink order={o} />}
          <p className="mw-hint">{c("noSupportChannel")}</p>
        </section>
      )}
    </>
  );
}
