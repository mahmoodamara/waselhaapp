import { createContext, useContext, useEffect, useRef, useState } from "react";
import {
  Bell,
  BellRing,
  Bike,
  Car,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleHelp,
  Clock,
  Copy,
  MessageCircle,
  Globe,
  House,
  Info,
  Link2,
  LogOut,
  MapPin,
  MapPinCheck,
  Moon,
  Phone,
  Ellipsis,
  Navigation,
  Package,
  PackageCheck,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SearchX,
  Send,
  SlidersHorizontal,
  Store,
  Sun,
  Sunrise,
  TriangleAlert,
  Truck,
  Undo2,
  User,
  Wallet,
  X,
  Zap,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { Money, useLanguage } from "../components/UI.jsx";
import { ageParts } from "./home.js";
import {
  dateTime,
  maskedPhone,
  merchantTasks,
  operationalState,
  orderNumber,
  relativeTime,
} from "./model.js";

export const WorkspaceContext = createContext(null);
export const useWorkspace = () => useContext(WorkspaceContext);
export const useCopy = () => {
  const { t, ...rest } = useLanguage();
  const c = (key) => t(`m.${key}`);
  // Copy with {placeholders}: f("showMore", { n: 3 }).
  const f = (key, values) =>
    Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, value), c(key));
  // "منذ 14 د"
  const age = (from) => {
    const { unit, n } = ageParts(from);
    return f(unit, { n });
  };
  return { ...rest, t, c, f, age };
};
// One icon set (Lucide) for the whole store workspace. Names are what the screens
// ask for; the shape behind a name can change without touching them. All of the
// interface is right-to-left, so "arrow" and "chevron" point left (forward).
const icons = {
  home: House,
  orders: Package,
  box: Package,
  packageCheck: PackageCheck,
  plus: Plus,
  bell: Bell,
  bellRing: BellRing,
  money: Wallet,
  search: Search,
  searchX: SearchX,
  arrow: ChevronLeft,
  chevron: ChevronLeft,
  back: ChevronRight,
  down: ChevronDown,
  bike: Bike,
  car: Car,
  info: Info,
  zap: Zap,
  close: X,
  check: Check,
  checkCircle: CircleCheck,
  clock: Clock,
  user: User,
  pin: MapPin,
  pinCheck: MapPinCheck,
  truck: Truck,
  navigation: Navigation,
  refresh: RefreshCw,
  link: Link2,
  send: Send,
  warning: TriangleAlert,
  pencil: Pencil,
  sliders: SlidersHorizontal,
  store: Store,
  help: CircleHelp,
  globe: Globe,
  logout: LogOut,
  undo: Undo2,
  sunrise: Sunrise,
  sun: Sun,
  moon: Moon,
  copy: Copy,
  chat: MessageCircle,
  phone: Phone,
  more: Ellipsis,
};
export function Icon({ name, size = 20 }) {
  const Shape = icons[name] || Package;
  return <Shape size={size} strokeWidth={1.75} aria-hidden="true" />;
}
export function PageTitle({ title, children, eyebrow }) {
  return (
    <div className="mw-title">
      <div>
        {eyebrow && <p className="mw-eyebrow">{eyebrow}</p>}
        <h1 tabIndex={-1}>{title}</h1>
      </div>
      <div className="mw-actions">{children}</div>
    </div>
  );
}
export function Empty({ title, body, children, icon = "orders" }) {
  return (
    <div className="mw-empty">
      <span className="mw-empty-icon">
        <Icon name={icon} size={28} />
      </span>
      <h2>{title}</h2>
      {body && <p>{body}</p>}
      {children}
    </div>
  );
}
export function Skeleton() {
  const { c } = useCopy();
  return (
    <div className="mw-skeleton" role="status" aria-label={c("loading")}>
      <div />
      <div />
      <div />
      <div />
    </div>
  );
}
export function ErrorState({ error, retry }) {
  const { c, t } = useCopy();
  return (
    <div className="mw-error" role="alert">
      <h2>{c("loadFailed")}</h2>
      <p>{t(error?.code || "network_error")}</p>
      <button onClick={retry}>{c("retry")}</button>
    </div>
  );
}
export function Dialog({ title, children, onClose }) {
  const ref = useRef(),
    { c } = useCopy();
  useEffect(() => {
    const element = ref.current;
    element.showModal();
    return () => element.close();
  }, []);
  return (
    <dialog
      className="mw-dialog"
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-labelledby="merchant-dialog-title"
    >
      <div className="mw-section-title">
        <h2 id="merchant-dialog-title">{title}</h2>
        <button className="mw-icon-button quiet" onClick={onClose} aria-label={c("close")}>
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function CopyButton({ text, label = "copyNumber" }) {
  const { c } = useCopy(),
    [state, setState] = useState(""),
    input = useRef();
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("copyFallback");
      requestAnimationFrame(() => {
        input.current?.focus();
        input.current?.select();
      });
    }
  }
  return (
    <span className="mw-copy">
      <button className="mw-text-button" onClick={copy}>
        {c(state === "copied" ? "copied" : label)}
      </button>
      {state === "copyFallback" && (
        <label>
          {c(state)}
          <input ref={input} value={text} readOnly dir="ltr" />
        </label>
      )}
    </span>
  );
}
// A button text with a shorter form that replaces it on a phone (see home.css).
export function ButtonText({ label, short }) {
  const { c } = useCopy();
  if (!short) return c(label);
  return (
    <>
      <span className="mh-long">{c(label)}</span>
      <span className="mh-short">{c(short)}</span>
    </>
  );
}
export function TaskButton({ task, onOpen, className = "", arrow = true, short, ...rest }) {
  const { c } = useCopy(),
    { act, mutation } = useWorkspace();
  const inline = ["retry", "fare", "confirm"].includes(task.kind) || (task.kind === "ready" && task.order.workflowVersion === 3),
    busy = mutation?.orderId === task.order._id;
  return (
    <button
      className={className}
      disabled={!!mutation?.busy}
      onClick={() => (inline ? act(task) : onOpen(task))}
      {...rest}
    >
      {busy && mutation.busy ? c("saving") : <ButtonText label={task.action} short={short} />}
      {arrow && <Icon name="arrow" size={16} />}
    </button>
  );
}
// Opens the notifications dialog on a computer and the full page on a phone.
export function NotificationBell({ className = "" }) {
  const { c } = useCopy(),
    { taskCount, openNotifications } = useWorkspace(),
    navigate = useNavigate();
  return (
    <button
      className={`mw-bell quiet ${className}`}
      aria-label={`${c("notifications")} · ${taskCount} ${c("tasks")}`}
      onClick={() => {
        if (matchMedia("(max-width: 760px)").matches) navigate("/store/notifications");
        else openNotifications();
      }}
    >
      <Icon name="bell" />
      {taskCount > 0 && <span className="mw-badge">{taskCount}</span>}
    </button>
  );
}
export function OrderRow({ order: o, onOpenTask, search = false, from }) {
  const { c, t, language } = useCopy(),
    s = operationalState(o),
    task = merchantTasks(o)[0];
  return (
    <article className="mw-order-row">
      <Link
        className="mw-row-main"
        to={`/store/orders/${o._id}`}
        state={{ from: from || location.pathname + location.search }}
      >
        <span className="mw-row-identity">
          <strong>
            <bdi>#{orderNumber(o)}</bdi>
          </strong>
          <bdi>{o.recipientName || c("unnamed")}</bdi>
          {o.serviceArea && <span className="mw-row-area"><Icon name="pin" size={13} />{t(`serviceArea.${o.serviceArea}`)}</span>}
          {search && (
            <small>
              <bdi dir="ltr">{maskedPhone(o.customerPhone)}</bdi> ·{" "}
              {dateTime(o.createdAt, language)} · <Money value={o.goodsAmountAgorot} />
            </small>
          )}
        </span>
        <span className="mw-row-status">
          <span className={`mw-status ${task ? "attention" : s.tone}`}>
            <span className="mw-dot" />
            {c(s.title)}
          </span>
          {o.assignedDriver?.name && (
            <small>
              <bdi>{o.assignedDriver.name}</bdi>
            </small>
          )}
        </span>
        <time className="mw-muted" dateTime={s.at} title={dateTime(s.at, language)}>
          {relativeTime(s.at, language)}
        </time>
        <Icon name="arrow" size={17} />
      </Link>
      {task && (
        <div className="mw-row-action">
          <TaskButton task={task} onOpen={onOpenTask} className="quiet" />
        </div>
      )}
    </article>
  );
}
export function MoneyBreakdown({ order: o, full = false }) {
  const { c, t } = useCopy();
  const items = [
    ["goods", o.goodsAmountAgorot],
    ["collection", o.goodsAmountAgorot],
    ["fare", o.deliveryFeeAgorot],
    ["expected", o.expectedCustomerCashAgorot],
    ["actual", o.actualCashCollectedAgorot],
    ["net", o.storeNetDueAgorot],
  ];
  return (
    <>
      <dl className="mw-facts">
        {items
          .filter(([key]) => full || ["expected", "actual", "net"].includes(key))
          .map(([key, value]) => (
            <div key={key}>
              <dt>{c(key)}</dt>
              <dd>
                {o.goodsAmountKnown === false && ["goods", "collection"].includes(key)
                  ? t("goodsUnknown") : <Money value={value} />}
              </dd>
            </div>
          ))}
        <div>
          <dt>{c("payer")}</dt>
          <dd>{o.deliveryFeePaidBy ? t(`feePayer.${o.deliveryFeePaidBy}`) : c("notSet")}</dd>
        </div>
        <div>
          <dt>{c("settlementState")}</dt>
          <dd>
            {o.storeSettlement ? t(`financeStatus.${o.storeSettlement.status}`) : c("notSet")}
          </dd>
        </div>
      </dl>
      {o.storeNetDirection === "collect_from_store" && <p>{c("payable")}</p>}
      {o.collectionAdjustment && (
        <div className="callout attention">
          <strong>
            {c("difference")}: <Money value={o.collectionAdjustment.amountAgorot} />
          </strong>
          <p>{t(`financeStatus.${o.collectionAdjustment.status}`)}</p>
          {o.collectionAdjustment.status === "open" && <p>{c("reviewAdmin")}</p>}
        </div>
      )}
      {o.financeLegacy && <p className="callout">{t("legacyFinanceUnknown")}</p>}
    </>
  );
}
