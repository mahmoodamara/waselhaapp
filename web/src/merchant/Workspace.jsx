import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useLanguage } from "../components/UI.jsx";
import PickupLocation from "../components/PickupLocation.jsx";
import {
  Dialog,
  Empty,
  Icon,
  NotificationBell,
  PageTitle,
  WorkspaceContext,
  useCopy,
} from "./components.jsx";
import useWorkspaceData from "./useWorkspaceData.js";
import { allTasks, dateTime } from "./model.js";
import Account from "./Account.jsx";
import Home from "./Home.jsx";
import { NotificationContent, Orders } from "./Lists.jsx";
import OrderEditor from "./OrderEditor.jsx";
import QuickRequest from "./QuickRequest.jsx";
import OrderDetails, { Created, OrderSubpage } from "./OrderDetails.jsx";
import OrdersDesk, { useWideScreen } from "./OrdersDesk.jsx";
import { SettlementDetails, Settlements } from "./Settlements.jsx";
import "./workspace.css";

export default function Workspace({ user, logout }) {
  const data = useWorkspaceData(),
    { c, t, language } = useCopy(),
    { setLanguage } = useLanguage(),
    navigate = useNavigate(),
    location = useLocation(),
    wide = useWideScreen();
  const [me, setMe] = useState(user),
    [notifications, setNotifications] = useState(false),
    [keyboard, setKeyboard] = useState(false);
  const mainRef = useRef(),
    accountRef = useRef(),
    scrollPositions = useRef(new Map()),
    activePath = useRef(location.pathname),
    homeTaskOrder = useRef([]),
    focused = /\/new$|\/edit$|\/review$|\/created$/.test(location.pathname),
    count = allTasks(data.orders || []).length;
  useEffect(() => {
    const saveScroll = () => scrollPositions.current.set(activePath.current, window.scrollY);
    window.addEventListener("scroll", saveScroll, { passive: true });
    return () => window.removeEventListener("scroll", saveScroll);
  }, []);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const changed = () =>
      setKeyboard(
        window.innerHeight - viewport.height > 140 &&
          /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || ""),
      );
    viewport.addEventListener("resize", changed);
    document.addEventListener("focusout", changed);
    return () => {
      viewport.removeEventListener("resize", changed);
      document.removeEventListener("focusout", changed);
    };
  }, []);
  useLayoutEffect(() => {
    activePath.current = location.pathname;
    if (!location.pathname.endsWith("/orders"))
      window.scrollTo(
        0,
        location.state?.restoreScroll ?? scrollPositions.current.get(location.pathname) ?? 0,
      );
    const frame = requestAnimationFrame(() => mainRef.current?.focus({ preventScroll: true }));
    setNotifications(false);
    if (accountRef.current) accountRef.current.open = false;
    return () => cancelAnimationFrame(frame);
  }, [location.pathname]);
  function openTask(task, source) {
    navigate(
      `/store/orders/${task.order._id}${["edit", "ready"].includes(task.kind) ? "/edit" : ""}`,
      { state: { from: source || location.pathname + location.search, task: task.kind } },
    );
  }
  const context = {
    ...data,
    user,
    me,
    setMe,
    openTask,
    homeTaskOrder,
    logout,
    taskCount: count,
    openNotifications: () => setNotifications(true),
  };
  // Settings, settlements and help belong to the account tab on a phone.
  const accountSection = /\/store\/(account|settings|settlements|help|notifications)/.test(
    location.pathname,
  );
  const area = me.pickupServiceArea ? t(`serviceArea.${me.pickupServiceArea}`) : "";
  const nav = (
    <>
      <NavLink to="/store" end>
        <Icon name="home" />
        <span>{c("home")}</span>
      </NavLink>
      <NavLink to="/store/orders" className={/^\/store\/new/.test(location.pathname) ? "active" : undefined}>
        <Icon name="box" />
        <span>{c("orders")}</span>
        {count > 0 && <span className="mw-nav-count" aria-label={`${count} ${c("tasks")}`}>{count}</span>}
      </NavLink>
      {data.permissions?.viewSettlements && (
        <NavLink to="/store/settlements">
          <Icon name="money" />
          <span>{c("settlements")}</span>
        </NavLink>
      )}
      <NavLink to="/store/settings">
        <Icon name="sliders" />
        <span>{c("settings")}</span>
      </NavLink>
    </>
  );
  const denied =
    [401, 403].includes(data.error?.status) || [401, 403].includes(data.permissionError?.status);
  return (
    <WorkspaceContext value={context}>
      <div
        className={`merchant-workspace ${focused ? "focused-flow" : ""} ${keyboard ? "keyboard-open" : ""}`}
      >
        <a className="mw-skip" href="#merchant-content">
          {c("skip")}
        </a>
        {!data.online ? (
          <div className="mw-connection" role="status">
            {c("offline")}
            {data.updatedAt && (
              <span>
                {c("lastUpdate")}: {dateTime(data.updatedAt, language)}
              </span>
            )}
          </div>
        ) : (
          data.error &&
          data.orders &&
          !denied && (
            <div className="mw-connection" role="status">
              <span>
                {c("cached")} {c("lastUpdate")}: {dateTime(data.updatedAt, language)}
              </span>
              <button className="mw-text-button" onClick={data.refresh}>
                {c("retry")}
              </button>
            </div>
          )
        )}
        <aside className="mw-sidebar">
          <div className="mw-sidebar-top">
            <Link className="mw-brand" to="/store">
              <span className="brand-mark">و</span>
              <span>{c("dashboard")}</span>
            </Link>
            <NotificationBell />
          </div>
          <Link className="button-link mw-side-create" to="/store/new">
            <Icon name="plus" size={18} />
            {c("odNewDelivery")}
          </Link>
          <nav aria-label={c("workspace")}>{nav}</nav>
          <details className="mw-account" ref={accountRef}>
            <summary aria-label={c("account")}>
              <span className="mw-store-icon">
                <Icon name="store" />
              </span>
              <span className="mw-store-name">
                <strong>
                  <bdi>{me.storeName || me.name}</bdi>
                </strong>
                {(area || me.storeName) && <small>{area || <bdi>{me.name}</bdi>}</small>}
              </span>
            </summary>
            <div className="mw-account-menu">
              <Link to="/store/help">{c("help")}</Link>
              <button
                onClick={() => setLanguage(language === "ar" ? "he" : "ar")}
                lang={language === "ar" ? "he" : "ar"}
              >
                {language === "ar" ? "עברית" : "العربية"}
              </button>
              <button onClick={logout}>
                {t("logout")}
              </button>
            </div>
          </details>
        </aside>
        <main className="mw-main" id="merchant-content" tabIndex={-1} ref={mainRef}>
          {data.mutation?.error && (
            <div className="mw-mutation-error callout error" role="alert">
              <p>
                {data.mutation.unknown
                  ? c("unknownMutation")
                  : t(data.mutation.error.code || "server_error")}
              </p>
              <button
                className="mw-text-button"
                onClick={async () => {
                  await data.refresh();
                  data.setMutation(null);
                }}
              >
                {c("refresh")}
              </button>
            </div>
          )}
          {data.refreshing && data.orders && (
            <span className="mw-refreshing" role="status">
              {c("updating")}
            </span>
          )}
          {denied ? (
            <Empty title={c("forbidden")}>
              <button onClick={logout}>{t("logout")}</button>
            </Empty>
          ) : (
            <Routes>
              <Route index element={<Home />} />
              <Route path="orders" element={wide ? <OrdersDesk /> : <Orders />} />
              <Route path="new" element={data.permissions?.quickDeliveryEnabled === false
                ? <OrderEditor key={location.key} /> : <QuickRequest key={location.key} />} />
              <Route path="new/full" element={<OrderEditor key={location.key} />} />
              <Route path="orders/:id" element={wide ? <OrdersDesk /> : <OrderDetails key={location.pathname} />} />
              <Route path="orders/:id/created" element={<Created />} />
              <Route
                path="orders/:id/edit"
                element={<OrderEditor editing key={location.pathname} />}
              />
              {["history", "finance", "review", "help"].map((kind) => (
                <Route
                  key={kind}
                  path={`orders/:id/${kind}`}
                  element={<OrderSubpage kind={kind} key={location.pathname} />}
                />
              ))}
              <Route
                path="notifications"
                element={
                  <>
                    <Link className="mw-back" to="/store">
                      {c("back")}
                    </Link>
                    <section className="mw-card">
                      <NotificationContent />
                    </section>
                  </>
                }
              />
              <Route path="account" element={<Account />} />
              <Route path="settlements" element={<Settlements />} />
              <Route
                path="settlements/:id"
                element={<SettlementDetails key={location.pathname} />}
              />
              <Route
                path="settings"
                element={<PickupLocation me={me} onSaved={setMe} />}
              />
              <Route
                path="help"
                element={
                  <>
                    <PageTitle title={c("help")} />
                    <section className="mw-card">
                      <p>{c("helpOther")}</p>
                      <p className="mw-hint">{c("noSupportChannel")}</p>
                      <Link to="/store/orders">{c("orders")}</Link>
                    </section>
                  </>
                }
              />
              <Route path="*" element={<Navigate to="/store" replace />} />
            </Routes>
          )}
        </main>
        {!focused && (
          <nav className="mw-bottom-nav" aria-label={c("workspace")}>
            <NavLink to="/store" end>
              <Icon name="home" />
              <span>{c("home")}</span>
            </NavLink>
            <NavLink to="/store/orders">
              <Icon name="box" />
              <span>{c("orders")}</span>
            </NavLink>
            <NavLink to="/store/account" className={accountSection ? "active" : ""}>
              <Icon name="user" />
              <span>{c("myAccount")}</span>
            </NavLink>
          </nav>
        )}
        {notifications && (
          <Dialog title={c("notifications")} onClose={() => setNotifications(false)}>
            <NotificationContent onClose={() => setNotifications(false)} />
          </Dialog>
        )}
      </div>
    </WorkspaceContext>
  );
}
