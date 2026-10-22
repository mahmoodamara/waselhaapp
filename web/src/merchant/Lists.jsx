import { useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import {
  Empty,
  ErrorState,
  Icon,
  OrderRow,
  Skeleton,
  useCopy,
  useWorkspace,
} from "./components.jsx";
import {
  allTasks,
  dateTime,
  merchantTasks,
  orderNumber,
  searchOrders,
  terminal,
} from "./model.js";
import "./orders.css";

export function Orders() {
  const { orders, error, refresh, user, openTask } = useWorkspace(),
    { c } = useCopy(),
    [params, setParams] = useSearchParams(),
    location = useLocation();
  const key = `waselha.list.v1.${user._id}`;
  const saved = useRef(
    (() => {
      try {
        return JSON.parse(sessionStorage.getItem(key)) || {};
      } catch {
        return {};
      }
    })(),
  );
  const [query, setQuery] = useState(saved.current.query || ""),
    input = useRef(),
    previousScroll = useRef(saved.current.previousScroll || 0),
    initialized = useRef(false);
  const tab = ["active", "finished", "all"].includes(params.get("tab"))
    ? params.get("tab")
    : saved.current.tab || "active";
  const filter = ["needsYou", "waitingCustomerFilter", "withDriver"].includes(params.get("filter"))
    ? params.get("filter")
    : params.has("tab")
      ? ""
      : saved.current.filter || "";
  const searching = !!query.trim();
  function persist(q = query) {
    try {
      sessionStorage.setItem(
        key,
        JSON.stringify({
          query: q,
          tab,
          filter,
          scroll: window.scrollY,
          previousScroll: previousScroll.current,
        }),
      );
    } catch {}
  }
  useLayoutEffect(() => {
    if (!orders || initialized.current) return;
    initialized.current = true;
    if (location.state?.focusSearch) input.current?.focus();
    else window.scrollTo(0, saved.current.scroll || 0);
  }, [orders, location.state]);
  useLayoutEffect(() => {
    const onScroll = () => persist();
    window.addEventListener("scroll", onScroll, { passive: true });
    persist();
    return () => {
      persist();
      window.removeEventListener("scroll", onScroll);
    };
  }, [query, tab, filter]);
  function setQueryValue(value) {
    if (!query && value) previousScroll.current = window.scrollY;
    setQuery(value);
    persist(value);
    if (!value) requestAnimationFrame(() => window.scrollTo(0, previousScroll.current));
  }
  function select(nextTab, nextFilter) {
    setParams({ tab: nextTab, ...(nextFilter ? { filter: nextFilter } : {}) });
    saved.current = { ...saved.current, tab: nextTab, filter: nextFilter };
  }
  const tasks = allTasks(orders || []),
    count = new Set(tasks.map((task) => task.order._id)).size;
  const totals = { active: 0, finished: 0, all: orders?.length || 0 };
  for (const order of orders || []) totals[terminal.has(order.status) ? "finished" : "active"]++;
  const result = searching
    ? searchOrders(orders || [], query)
    : (orders || []).filter(
        (o) =>
          (tab === "all" ||
            (tab === "finished" ? terminal.has(o.status) : !terminal.has(o.status))) &&
          (!filter ||
            (filter === "needsYou" && merchantTasks(o).length) ||
            (filter === "waitingCustomerFilter" && o.canEdit && !o.customerConfirmed) ||
            (filter === "withDriver" && o.activeAssignment)),
      );
  return (
    <div className="mo-orders">
      <header className="mo-head">
        <div>
          <h1 tabIndex={-1}>{c("orders")}</h1>
          <p>{c("ordersSubtitle")}</p>
        </div>
        <Link className="button-link mo-create" to="/store/new">
          <Icon name="plus" size={18} />
          {c("newDelivery")}
        </Link>
      </header>
      <section className="mo-tools" aria-label={c("search")}>
        <div className="mw-search">
          <Icon name="search" size={18} />
          <label className="mw-sr-only" htmlFor="order-search">
            {c("searchHint")}
          </label>
          <input
            id="order-search"
            ref={input}
            value={query}
            onChange={(e) => setQueryValue(e.target.value)}
            placeholder={c("searchHint")}
            autoComplete="off"
            type="search"
          />
          {query && (
            <button
              className="mw-icon-button quiet"
              aria-label={c("clearSearch")}
              onClick={() => {
                setQueryValue("");
                input.current?.focus();
              }}
            >
              <Icon name="close" size={17} />
            </button>
          )}
        </div>
        {searching ? (
          <p className="mw-search-context">
            {c("searchAll")} · <bdi>«{query}»</bdi>
          </p>
        ) : (
          <>
            <div className="mw-tabs" role="group" aria-label={c("orders")}>
              {["active", "finished", "all"].map((value) => (
                <button
                  key={value}
                  aria-pressed={tab === value}
                  aria-label={c(value)}
                  onClick={() => select(value, filter)}
                >
                  {c(value)}
                  {orders && <span className="mo-tab-count" aria-hidden="true">{totals[value]}</span>}
                </button>
              ))}
            </div>
            <div className="mw-filters" role="group" aria-label={c("applied")}>
              {["needsYou", "waitingCustomerFilter", "withDriver"].map((value) => (
                <button
                  key={value}
                  className="quiet"
                  aria-pressed={filter === value}
                  onClick={() => select(tab, filter === value ? "" : value)}
                >
                  <Icon name={value === "needsYou" ? "bellRing" : value === "withDriver" ? "truck" : "user"} size={16} />
                  {c(value)}
                  {value === "needsYou" && <span className="mw-count">{count}</span>}
                </button>
              ))}
            </div>
          </>
        )}
      </section>
      {!orders ? (
        error ? (
          <ErrorState error={error} retry={refresh} />
        ) : (
          <Skeleton />
        )
      ) : (
        <>
          <div className="mw-section-title mw-results-count" role="status" aria-live="polite" aria-atomic="true">
            <p>
              {filter && !searching && (
                <>
                  {c("applied")}: {c(filter)} ·{" "}
                </>
              )}
              {result.length} {c("results")}
            </p>
            {filter && !searching && (
              <button className="mw-text-button" onClick={() => select(tab, "")}>
                {c("clearFilters")}
              </button>
            )}
          </div>
          <section className="mw-card mw-list-card" aria-label={c("orders")}>
            {result.length > 0 && <div className="mo-columns" aria-hidden="true">
              <div><span>{c("order")}</span><span>{c("orderStatus")}</span><span>{c("lastUpdate")}</span><span /></div>
              <span>{c("next")}</span>
            </div>}
            {result.length ? (
              result.map((o) => (
                <OrderRow
                  key={o._id}
                  order={o}
                  onOpenTask={openTask}
                  search={searching}
                  from={location.pathname + location.search}
                />
              ))
            ) : (
              <Empty
                title={c(searching ? "noResults" : "noTabOrders")}
                body={c("noResultsBody")}
                icon="search"
              />
            )}
          </section>
        </>
      )}
    </div>
  );
}

export function NotificationContent({ onClose }) {
  const { orders, error, refresh, user, openTask } = useWorkspace(),
    { c, t, language } = useCopy();
  const key = `waselha.notifications.v1.${user._id}`,
    [readIds, setReadIds] = useState(() => {
      try {
        return JSON.parse(sessionStorage.getItem(key)) || [];
      } catch {
        return [];
      }
    });
  const tasks = allTasks(orders || []),
    events = (orders || [])
      .flatMap((order) =>
        (order.events || [])
          .filter(
            (event) => !["financial_terms_captured", "driver_search_started"].includes(event.type),
          )
          .map((event) => ({ order, event, id: `${order._id}:${event.type}:${event.at}` })),
      )
      .sort((a, b) => b.event.at.localeCompare(a.event.at))
      .slice(0, 60);
  function mark(ids) {
    const next = [...new Set([...readIds, ...ids])].slice(-200);
    setReadIds(next);
    try {
      sessionStorage.setItem(key, JSON.stringify(next));
    } catch {}
  }
  if (!orders) return error ? <ErrorState error={error} retry={refresh} /> : <Skeleton />;
  return (
    <>
      {/* In the dialog the title and close button come from Dialog; only the full page draws its own. */}
      {!onClose && (
        <div className="mw-section-title">
          <h2>{c("notifications")}</h2>
        </div>
      )}
      <p className="mw-hint">{c("taskStillOpen")}</p>
      <h3>{c("requiredNow")}</h3>
      <p className="mw-muted">
        {tasks.length} {c("tasks")} {c("inOrders")}{" "}
        {new Set(tasks.map((task) => task.order._id)).size} {c("orderCount")}
      </p>
      {tasks.length ? (
        tasks.map((task) => (
          <button
            key={task.id}
            className="mw-notification"
            onClick={() => {
              openTask(task, "/store/notifications");
              onClose?.();
            }}
          >
            <span className="mw-dot attention" />
            <span>
              <strong>{c(task.title)}</strong>
              <small>
                <bdi>#{orderNumber(task.order)}</bdi> ·{" "}
                <bdi>{task.order.assignedDriver?.name || task.order.recipientName}</bdi>
              </small>
            </span>
            <Icon name="arrow" />
          </button>
        ))
      ) : (
        <p className="mw-small-empty">{c("noTasks")}</p>
      )}
      <div className="mw-section-title">
        <h3>{c("updates")}</h3>
        {events.length > 0 && (
          <button className="mw-text-button" onClick={() => mark(events.map((e) => e.id))}>
            {c("markRead")}
          </button>
        )}
      </div>
      {events.length ? (
        events.map(({ order, event, id }) => (
          <Link
            className={`mw-notification ${readIds.includes(id) ? "read" : ""}`}
            key={id}
            to={`/store/orders/${order._id}/history`}
            state={{ from: "/store/notifications" }}
            onClick={() => {
              mark([id]);
              onClose?.();
            }}
          >
            <span className="mw-dot" />
            <span>
              <strong>{t(`event.${event.type}`)}</strong>
              <small>
                <bdi>#{orderNumber(order)}</bdi> · {dateTime(event.at, language)}
              </small>
              <small>{c(readIds.includes(id) ? "read" : "unread")}</small>
            </span>
            <Icon name="arrow" />
          </Link>
        ))
      ) : (
        <p className="mw-small-empty">{c("noUpdates")}</p>
      )}
    </>
  );
}
