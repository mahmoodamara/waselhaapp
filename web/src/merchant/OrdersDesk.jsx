import { useEffect, useState } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { Money } from "../components/UI.jsx";
import { Empty, ErrorState, Icon, Skeleton, useCopy, useWorkspace } from "./components.jsx";
import OrderDetails from "./OrderDetails.jsx";
import { merchantTasks, operationalState, orderNumber, searchOrders, terminal } from "./model.js";
import "./ordersDesk.css";

// True on a screen wide enough for the list and one order side by side.
export function useWideScreen(min = 1000) {
  const query = `(min-width: ${min}px)`;
  const [wide, setWide] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return;
    const change = () => setWide(list.matches);
    change();
    list.addEventListener("change", change);
    return () => list.removeEventListener("change", change);
  }, [query]);
  return wide;
}

const tabs = [
  ["all", "odAll"],
  ["active", "odActive"],
  ["finished", "odFinished"],
];

// Green when the trip is moving, amber when the store has something to do, grey while waiting.
export function chipTone(order, state, task) {
  if (task || state.tone === "attention") return "attention";
  if (state.tone === "success" || (order.activeAssignment && !terminal.has(order.status))) return "ok";
  return "";
}

function Row({ order: o, selected, from }) {
  const { c, t, age } = useCopy(),
    s = operationalState(o),
    task = merchantTasks(o)[0];
  const area = [2, 3].includes(o.workflowVersion) && o.serviceArea ? t(`serviceArea.${o.serviceArea}`) : o.area;
  return (
    <Link className={`od-row ${selected ? "selected" : ""}`} to={`/store/orders/${o._id}`} state={from}
      aria-current={selected ? "true" : undefined}>
      <span className="od-row-main">
        <strong>
          <bdi>#{orderNumber(o)}</bdi>
          {area && <span> {area}</span>}
        </strong>
        <span className="od-row-meta">
          {o.createdAt && <time dateTime={o.createdAt}>{age(o.createdAt)}</time>}
          <span className={`od-chip small ${chipTone(o, s, task)}`}>{c(s.title)}</span>
        </span>
      </span>
      <span className="od-row-amount"><Money value={o.expectedCustomerCashAgorot ?? o.goodsAmountAgorot} /></span>
    </Link>
  );
}

// The orders page on a wide screen: the list on one side, the chosen order on the other.
export default function OrdersDesk() {
  const { orders, error, refresh } = useWorkspace(),
    { c } = useCopy(),
    { id } = useParams(),
    [params, setParams] = useSearchParams(),
    [query, setQuery] = useState("");
  const tab = tabs.some(([key]) => key === params.get("tab")) ? params.get("tab") : "active";
  const searching = !!query.trim();
  const shown = !orders ? [] : searching
    ? searchOrders(orders, query)
    : orders.filter((o) => tab === "all" || (tab === "finished" ? terminal.has(o.status) : !terminal.has(o.status)));
  const from = { from: "/store/orders" };
  // Opening the page shows the first order rather than an empty panel.
  if (!id && shown.length) return <Navigate replace to={`/store/orders/${shown[0]._id}${params.toString() ? `?${params}` : ""}`} />;
  return (
    <div className="od-desk">
      <header className="od-desk-head">
        <h1 tabIndex={-1}>{c("orders")}</h1>
        <div className="od-search">
          <Icon name="search" size={18} />
          <label className="mw-sr-only" htmlFor="od-search">{c("searchHint")}</label>
          <input id="od-search" type="search" value={query} placeholder={c("searchHint")} autoComplete="off"
            onChange={(event) => setQuery(event.target.value)} />
        </div>
        <div className="mw-tabs" role="group" aria-label={c("orders")}>
          {tabs.map(([key, label]) => (
            <button key={key} aria-pressed={!searching && tab === key} onClick={() => { setQuery(""); setParams({ tab: key }); }}>
              {c(label)}
            </button>
          ))}
        </div>
      </header>
      <div className="od-desk-body">
        <section className="od-list" aria-label={c("orders")}>
          {!orders ? (
            error ? <ErrorState error={error} retry={refresh} /> : <Skeleton />
          ) : shown.length ? (
            shown.map((o) => <Row key={o._id} order={o} selected={o._id === id} from={from} />)
          ) : (
            <Empty title={c(searching ? "noResults" : "noTabOrders")} body={c("noResultsBody")} icon="search" />
          )}
        </section>
        <div className="od-pane">
          {id ? <OrderDetails embedded key={id} /> : orders && <p className="od-muted">{c("odPickOrder")}</p>}
        </div>
      </div>
    </div>
  );
}
