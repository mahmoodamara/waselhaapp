import { merchantTasks, operationalState, terminal } from "./model.js";

// Pure rules behind the store home page: where each order stands, what the
// store itself has to do, and the numbers in the summary strip.

export const STAGE_COUNT = 4;
// The customer's link is sent when the order is created. After this long without
// a location the store is asked to send it again.
export const LINK_GRACE_MINUTES = 10;

export const minutesBetween = (from, now = Date.now()) =>
  Math.max(0, Math.floor((now - new Date(from).getTime()) / 60000));

// The driver's progress as one of four steps: finding a driver, on the way to the
// store, at the store, and on the way to the customer.
export function driverStage(o) {
  switch (o.status) {
    case "searching_driver":
      if (["waiting_customer", "customer_later", "customer_ready"].includes(o.dispatchState))
        return { step: 0, label: "stageWaitingCustomer", icon: "clock" };
      return o.driverSearchStatus === "no_driver"
        ? { step: 1, label: "stageNoDriver", icon: "searchX", since: o.searchDeadlineAt }
        : { step: 1, label: "stageSearching", icon: "search" };
    case "driver_assigned":
      return { step: 2, label: "stageToStore", icon: "navigation" };
    case "driver_at_store":
      return { step: 3, label: "stageAtStore", icon: "store" };
    case "collected":
      return { step: 4, label: "stageToCustomer", icon: "truck" };
    case "driver_at_destination":
      return { step: 4, label: "stageAtCustomer", icon: "pinCheck" };
    case "returning":
      return { step: 4, label: "returningTitle", icon: "undo" };
    case "delivery_failed":
      return { step: 4, label: "failureTitle", icon: "warning" };
    default:
      return { step: 0, label: "stageSearching", icon: "search" };
  }
}

// What the customer has done with the link: done, still being waited for, or
// overdue (long enough that the store should send the link again).
export function customerState(o, now = Date.now()) {
  if (!o.destinationLocation?.confirmedAt)
    return minutesBetween(o.createdAt, now) >= LINK_GRACE_MINUTES
      ? { kind: "overdue", label: "customerOverdue", icon: "warning", since: o.createdAt }
      : { kind: "waiting", label: "customerWaiting", icon: "clock" };
  if (!o.customerConfirmed) return { kind: "waiting", label: "customerConfirming", icon: "clock" };
  if (o.dispatchState === "customer_later") return { kind: "waiting", label: "customerLaterShort", icon: "clock" };
  return { kind: "done", label: "customerDone", icon: "checkCircle" };
}

// The icon of an action card, and whether it is a problem (attention) or the normal next step.
const actionLook = {
  retry: { icon: "searchX", tone: "attention" },
  fare: { icon: "refresh", tone: "attention" },
  edit: { icon: "pencil", tone: "normal" },
  ready: { icon: "packageCheck", tone: "normal" },
  confirm: { icon: "checkCircle", tone: "normal" },
  pickup: { icon: "packageCheck", tone: "normal" },
  return: { icon: "undo", tone: "attention" },
  handover: { icon: "packageCheck", tone: "normal" },
  resend: { icon: "send", tone: "attention" },
};

// The single thing the store should do next for an order, or null. Tasks the
// server tracks come first; the two nudges below are not tasks (they never
// change the notification badge) but are what the store can do to move on.
export function homeAction(o, now = Date.now()) {
  if (terminal.has(o.status)) return null;
  const task = merchantTasks(o)[0];
  if (task)
    return {
      id: task.id,
      kind: task.kind,
      order: o,
      task,
      rank: task.rank,
      ...actionLook[task.kind],
      situation: task.kind === "retry" ? "situationNoDriver" : task.title,
      step: task.title,
      button: task.action,
      short: task.kind === "retry" ? "retryShort" : null,
      since: operationalState(o).at,
    };
  if ([2, 3].includes(o.workflowVersion) && o.status === "driver_at_store" && !o.missingRequirements?.length)
    return {
      id: `${o._id}:handover`,
      kind: "handover",
      order: o,
      rank: -1,
      ...actionLook.handover,
      situation: "situationHandover",
      step: "pickupTask",
      button: "handoverAction",
      short: "handoverShort",
      since: o.arrivedStoreAt,
    };
  if (customerState(o, now).kind === "overdue")
    return {
      id: `${o._id}:resend`,
      kind: "resend",
      order: o,
      rank: 6,
      ...actionLook.resend,
      situation: "situationNoLocation",
      step: "resendStep",
      button: "resendAction",
      short: "resendShort",
      since: o.createdAt,
    };
  return null;
}

export const homeActions = (orders, now = Date.now()) =>
  orders
    .map((o) => homeAction(o, now))
    .filter(Boolean)
    .sort(
      (a, b) =>
        a.rank - b.rank || String(a.order.createdAt).localeCompare(String(b.order.createdAt)),
    );

export function homeStats(orders, actions) {
  const active = orders.filter((o) => !terminal.has(o.status)),
    count = (statuses) => active.filter((o) => statuses.includes(o.status)).length;
  return {
    active: active.length,
    needsAction: actions.length,
    searching: active.filter((o) => o.status === "searching_driver" && o.driverSearchStatus !== "waiting").length,
    onTheWay: count(["driver_assigned", "collected", "driver_at_destination"]),
    atStore: count(["driver_at_store"]),
  };
}

// "منذ 14 د": the parts of an age, formatted by the caller with the copy of the
// current language. Under a minute reads as one minute.
export function ageParts(from, now = Date.now()) {
  const minutes = Math.max(1, minutesBetween(from, now));
  if (minutes < 60) return { unit: "ageMinutes", n: minutes };
  if (minutes < 60 * 24) return { unit: "ageHours", n: Math.floor(minutes / 60) };
  return { unit: "ageDays", n: Math.floor(minutes / (60 * 24)) };
}

// Arabic and Hebrew need different words for one, two and many. Keys look like
// needsOne, needsTwo, needsFew, needsMany, needsOther.
export function countKey(prefix, n, language) {
  const category = new Intl.PluralRules(language === "he" ? "he" : "ar").select(n);
  const suffix = { one: "One", two: "Two", few: "Few", many: "Many" }[category] ?? "Other";
  return `${prefix}${suffix}`;
}

export const greetingIcon = { greetMorning: "sunrise", greetAfternoon: "sun", greetEvening: "moon" };

export function greetingKey(now = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Jerusalem",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(now),
  );
  return hour < 12 ? "greetMorning" : hour < 17 ? "greetAfternoon" : "greetEvening";
}
