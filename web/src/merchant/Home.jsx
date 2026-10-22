import { useState } from "react";
import { Link } from "react-router-dom";
import {
  ButtonText,
  Empty,
  ErrorState,
  Icon,
  NotificationBell,
  Skeleton,
  TaskButton,
  useCopy,
  useWorkspace,
} from "./components.jsx";
import {
  STAGE_COUNT,
  countKey,
  customerState,
  driverStage,
  greetingIcon,
  greetingKey,
  homeActions,
  homeStats,
} from "./home.js";
import { orderNumber, terminal } from "./model.js";
import "./home.css";

const VISIBLE_ACTIONS = 6;
const VISIBLE_ROWS = 8;

// Where the order is going: the delivery area when known, else the recipient.
function useAreaLabel() {
  const { t } = useCopy();
  return (o) => (o.serviceArea ? t(`serviceArea.${o.serviceArea}`) : o.recipientName);
}

function summary(stats, { c, f, language }) {
  if (!stats.active) return "";
  const active = f(countKey("active", stats.active, language), { n: stats.active });
  if (!stats.needsAction) return `${c("homeNone")} ${f("haveActive", { active })}`;
  const needs = f(countKey("needs", stats.needsAction, language), { n: stats.needsAction });
  return `${needs} ${c("ofTotal")} ${active}.`;
}

function StatsStrip({ stats }) {
  const { c } = useCopy();
  const cells = [
    ["statNeeds", null, stats.needsAction, "bellRing", true],
    ["statSearching", "statSearchingShort", stats.searching, "search"],
    ["statOnTheWay", "statOnTheWayShort", stats.onTheWay, "truck"],
    ["statAtStore", "statAtStoreShort", stats.atStore, "store"],
  ];
  return (
    <dl className="mh-stats">
      {cells.map(([label, short, value, icon, attention]) => (
        <div key={label} className={attention && value > 0 ? "attention" : ""}>
          <dt>
            <span className="mh-stat-icon" aria-hidden="true">
              <Icon name={icon} size={20} />
            </span>
            <span className="mh-stat-label">
              {short ? (
                <>
                  <span className="mh-long">{c(label)}</span>
                  <span className="mh-short">{c(short)}</span>
                </>
              ) : (
                c(label)
              )}
            </span>
          </dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ActionButton({ action }) {
  const { c } = useCopy(),
    { openTask } = useWorkspace(),
    o = action.order,
    // Several cards can offer the same button; the order number tells them apart.
    label = `${c(action.button)} #${orderNumber(o)}`;
  if (action.task)
    return (
      <TaskButton
        task={action.task}
        onOpen={openTask}
        className="mh-action-button"
        arrow={false}
        short={action.short}
        aria-label={label}
      />
    );
  return (
    <Link
      className="mh-action-button"
      to={`/store/orders/${o._id}`}
      state={{ from: "/store" }}
      aria-label={label}
    >
      <ButtonText label={action.button} short={action.short} />
    </Link>
  );
}

function ActionCard({ action }) {
  const { c, age } = useCopy(),
    area = useAreaLabel()(action.order);
  return (
    <li className="mh-action">
      <span className={`mh-action-icon ${action.tone}`} aria-hidden="true">
        <Icon name={action.icon} size={22} />
      </span>
      <div className="mh-action-text">
        <h3>{c(action.situation)}</h3>
        <p>
          <span className="mh-meta-main">
            <bdi>#{orderNumber(action.order)}</bdi>
            {area && (
              <>
                {" · "}
                <bdi>{area}</bdi>
              </>
            )}
          </span>
          {action.since && <span className="mh-meta-age">{age(action.since)}</span>}
        </p>
      </div>
      <ActionButton action={action} />
    </li>
  );
}

function ActiveRow({ order: o, action }) {
  const { c, age } = useCopy(),
    area = useAreaLabel()(o),
    stage = driverStage(o),
    customer = customerState(o);
  return (
    <li className="mh-row">
      <Link className="mh-row-link" to={`/store/orders/${o._id}`} state={{ from: "/store" }}>
        <span className="mh-order">
          <strong>
            <bdi>#{orderNumber(o)}</bdi>
          </strong>
          {area && (
            <span className="mh-area">
              <bdi>{area}</bdi>
            </span>
          )}
          <time className="mh-age" dateTime={o.createdAt}>
            {age(o.createdAt)}
          </time>
        </span>
        <span className="mh-driver">
          <span className="mh-steps" aria-hidden="true">
            {Array.from({ length: STAGE_COUNT }, (_, i) => (
              <i key={i} className={i < stage.step ? "on" : ""} />
            ))}
          </span>
          <span className={`mh-stage ${stage.icon === "searchX" ? "attention" : ""}`}>
            <Icon name={stage.icon} size={16} />
            <span>
              {c(stage.label)}
              {stage.since && ` ${age(stage.since)}`}
            </span>
          </span>
        </span>
        <span className={`mh-customer ${customer.kind}`}>
          <Icon name={customer.icon} size={16} />
          <span>
            <span className="mh-who">{c("colCustomer")} </span>
            {c(customer.label)}
            {customer.since && ` ${age(customer.since)}`}
          </span>
        </span>
        <span className={`mh-next ${action ? "" : "none"}`}>
          {action ? c(action.step) : c("noAction")}
        </span>
        <Icon name="chevron" size={18} />
      </Link>
    </li>
  );
}

export default function Home() {
  const { orders, error, refresh, me, homeTaskOrder: orderRef } = useWorkspace(),
    copy = useCopy(),
    { c, language } = copy,
    [showAll, setShowAll] = useState(false),
    greeting = greetingKey();
  const loaded = !!orders?.length;
  // Preserve card positions across polling updates; new actions append until the
  // page is revisited. Resolved actions disappear immediately, never keep old buttons.
  const actions = loaded ? homeActions(orders) : [];
  actions.forEach((action) => {
    if (!orderRef.current.includes(action.id)) orderRef.current.push(action.id);
  });
  actions.sort((a, b) => orderRef.current.indexOf(a.id) - orderRef.current.indexOf(b.id));
  const stats = loaded ? homeStats(orders, actions) : null,
    actionOf = new Map(actions.map((action) => [action.order._id, action])),
    rows = loaded
      ? [
          ...actions.map((action) => action.order),
          ...orders.filter((o) => !terminal.has(o.status) && !actionOf.has(o._id)),
        ]
      : [],
    shown = showAll ? actions : actions.slice(0, VISIBLE_ACTIONS);
  return (
    <div className="mh-home">
      <header className="mh-head">
        <div className="mh-hello">
          <span className="mh-hello-icon" aria-hidden="true">
            <Icon name={greetingIcon[greeting]} size={26} />
          </span>
          <div>
            <h1 tabIndex={-1}>
              <span className="mh-greet">{c(greeting)}</span>
              <span className="mh-comma">{language === "he" ? ", " : "، "}</span>
              <span className="mh-store">
                <bdi>{me.storeName || me.name}</bdi>
              </span>
            </h1>
            {stats && <p className="mh-summary">{summary(stats, copy)}</p>}
          </div>
        </div>
        <NotificationBell className="mh-bell" />
        {orders?.length !== 0 && (
          <Link className="button-link mh-create" to="/store/new">
            <Icon name="plus" />
            {c("newDelivery")}
          </Link>
        )}
      </header>
      {!orders ? (
        error ? (
          <ErrorState error={error} retry={refresh} />
        ) : (
          <Skeleton />
        )
      ) : !orders.length ? (
        <Empty title={c("firstTitle")} body={c("firstBody")}>
          <Link to="/store/new" className="button-link">
            {c("firstAction")}
          </Link>
        </Empty>
      ) : (
        <>
          <StatsStrip stats={stats} />
          <section className="mh-section" aria-labelledby="needs-title">
            <h2 id="needs-title">
              <Icon name="bellRing" size={20} />
              {c("needsYouTitle")}
            </h2>
            {actions.length ? (
              <>
                <ul className="mh-actions">
                  {shown.map((action) => (
                    <ActionCard key={action.id} action={action} />
                  ))}
                </ul>
                {actions.length > VISIBLE_ACTIONS && (
                  <button
                    className="mh-more quiet"
                    aria-expanded={showAll}
                    onClick={() => setShowAll(!showAll)}
                  >
                    {showAll
                      ? c("showLess")
                      : copy.f("showMore", { n: actions.length - VISIBLE_ACTIONS })}
                  </button>
                )}
              </>
            ) : (
              <p className="mh-none">
                <Icon name="check" />
                {c("noTasks")}
              </p>
            )}
          </section>
          <section className="mh-section mh-active" aria-labelledby="active-title">
            <div className="mh-active-head">
              <h2 id="active-title">
                <Icon name="truck" size={20} />
                {c("activeOrders")}
              </h2>
              <Link to="/store/orders">
                {c("viewAllOrders")}
                <Icon name="chevron" size={16} />
              </Link>
            </div>
            {rows.length ? (
              <>
                <div className="mh-columns" aria-hidden="true">
                  <span>{c("colOrder")}</span>
                  <span>{c("colDriver")}</span>
                  <span>{c("colCustomer")}</span>
                  <span>{c("colNext")}</span>
                </div>
                <ul className="mh-rows">
                  {rows.slice(0, VISIBLE_ROWS).map((o) => (
                    <ActiveRow key={o._id} order={o} action={actionOf.get(o._id)} />
                  ))}
                </ul>
              </>
            ) : (
              <div className="mw-small-empty">
                <p>{c("noActive")}</p>
                <Link to="/store/orders?tab=finished">{c("previous")}</Link>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
