export const terminal = new Set(["delivered", "cancelled", "returned"]);
export const orderNumber = (o) => o.publicReference ?? o._id.slice(-6).toUpperCase();
export const digits = (v) =>
  String(v ?? "").replace(/[٠-٩۰-۹]/g, (c) =>
    String(c.charCodeAt(0) >= 1776 ? c.charCodeAt(0) - 1776 : c.charCodeAt(0) - 1632),
  );
export function normalizePhone(v) {
  let p = digits(v).replace(/\D/g, "");
  if (p.startsWith("00972")) p = p.slice(2);
  if (p.startsWith("972")) p = `0${p.slice(3)}`;
  return p;
}
export const validPhone = (v) =>
  /^(0\d{8,9})$/.test(normalizePhone(v)) ||
  /^\+?[1-9]\d{7,14}$/.test(digits(v).replace(/[\s()-]/g, ""));
export const maskedPhone = (v) => {
  const p = normalizePhone(v);
  return p ? `${p.slice(0, 3)} ••• ${p.slice(-4)}` : "—";
};
export const dateTime = (v, language, timeOnly = false) =>
  !v
    ? "—"
    : new Intl.DateTimeFormat(language === "he" ? "he-IL" : "ar-IL", {
        timeZone: "Asia/Jerusalem",
        ...(timeOnly ? {} : { day: "numeric", month: "short" }),
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(v));
export function relativeTime(v, language) {
  if (!v) return "—";
  const minutes = Math.round((new Date(v).getTime() - Date.now()) / 60000);
  return new Intl.RelativeTimeFormat(language === "he" ? "he" : "ar", { numeric: "auto" }).format(
    Math.abs(minutes) < 60 ? minutes : Math.round(minutes / 60),
    Math.abs(minutes) < 60 ? "minute" : "hour",
  );
}
export function operationalState(o) {
  const base = {
    at: o.updatedAt || o.createdAt,
    responsibility: "system",
    next: "searchNext",
    tone: "neutral",
  };
  if (o.workflowVersion === 3 && o.dispatchState === "waiting_store")
    return { ...base, title: "waitingStore", body: "waitingStoreBody", responsibility: "store", next: "markParcelReady", tone: "attention" };
  if (o.status === "delivered")
    return {
      ...base,
      title: "deliveredTitle",
      body: "deliveredBody",
      responsibility: null,
      next: "noOperationalTask",
      tone: "success",
      at: o.deliveredAt,
    };
  if (o.status === "cancelled")
    return {
      ...base,
      title: "cancelledTitle",
      body: "cancelledBody",
      responsibility: null,
      next: "noOperationalTask",
      at: o.cancelledAt,
    };
  if (o.status === "returned")
    return {
      ...base,
      title: "returnedTitle",
      body: "returnedBody",
      responsibility: null,
      next: "noOperationalTask",
      at: o.returnedAt,
    };
  if (o.status === "delivery_failed")
    return {
      ...base,
      title: "failureTitle",
      body: "failureBody",
      responsibility: "admin",
      next: "failureBody",
      tone: "attention",
      at: o.failedAt,
    };
  if (o.status === "returning")
    return {
      ...base,
      title: "returningTitle",
      body: "returningBody",
      responsibility: "driver",
      next: "returningBody",
      at: o.returnAuthorizedAt,
    };
  if (["collected", "driver_at_destination"].includes(o.status))
    return {
      ...base,
      title: o.status === "collected" ? "delivering" : "atDestination",
      body: o.status === "collected" ? "deliveringBody" : "atDestinationBody",
      responsibility: "driver",
      next: "atDestinationBody",
      at: o.arrivedCustomerAt || o.collectedAt,
    };
  if ([2, 3].includes(o.workflowVersion) && ["driver_assigned", "driver_at_store"].includes(o.status))
    return { ...base, title: o.missingRequirements?.length ? "driverWaiting" : "pickupTask",
      body: "quickFollowBody", responsibility: "driver", next: "pickupNext", at: o.acceptedAt };
  if (o.status === "driver_at_store") {
    const missing = o.missingRequirements || [];
    const blocked = missing.length > 0;
    const fareBlocked =
      o.parcelReady &&
      o.destinationLocation?.confirmedAt &&
      missing.includes("route_price_required") &&
      !o.routeError &&
      !merchantTasks(o).length;
    const customerBlocked =
      o.parcelReady &&
      !merchantTasks(o).length &&
      (!o.customerConfirmed || !o.destinationLocation?.confirmedAt);
    const driverBlocked =
      o.parcelReady &&
      o.storeConfirmed &&
      missing.length > 0 &&
      missing.every((k) => k === "driver_confirmation_required");
    return {
      ...base,
      title: !o.parcelReady ? "arrivedNotReady" : blocked ? "driverWaiting" : "pickupTask",
      body: !o.parcelReady
        ? "arrivedNotReadyBody"
        : fareBlocked
          ? "fareBody"
          : customerBlocked
            ? "customerConfirmationBody"
            : driverBlocked
              ? "driverConfirmBody"
              : blocked
                ? "completeBody"
                : "pickupBody",
      responsibility: fareBlocked
        ? "system"
        : customerBlocked
          ? "customer"
          : driverBlocked
            ? "driver"
            : "store",
      next: "pickupNext",
      at: o.arrivedStoreAt,
    };
  }
  if (o.status === "driver_assigned")
    return {
      ...base,
      title: "enRoute",
      body: "enRouteBody",
      responsibility: "driver",
      next: "pickupNext",
      at: o.acceptedAt,
    };
  if (o.driverSearchStatus === "no_driver")
    return {
      ...base,
      title: "retrySearchTask",
      body: "retrySearchBody",
      responsibility: "store",
      next: "searchNext",
      tone: "attention",
      at: o.searchDeadlineAt,
    };
  const previous = o.events?.at(-1);
  // Only a released order that is searching again; an unready one waits for the customer.
  if (
    (!o.dispatchState || o.dispatchState === "searching") &&
    ["driver_withdrawn", "driver_assignment_timed_out", "driver_assignment_revoked"].includes(
      previous?.type,
    )
  )
    return { ...base, title: "reassigned", body: "reassignedBody", at: o.searchStartedAt };
  if (!o.destinationLocation?.confirmedAt)
    return {
      ...base,
      title: "waitingCustomer",
      body: "waitingBody",
      responsibility: "customer",
      next: "customerNext",
      at: o.createdAt,
    };
  if (o.priceStatus !== "final")
    return {
      ...base,
      title: o.routeError ? "fareRetry" : "farePending",
      body: o.routeError ? "fareFailedBody" : "fareBody",
      responsibility: o.routeError ? "store" : "system",
      next: "customerConfirmationBody",
      tone: o.routeError ? "attention" : "neutral",
    };
  if (!o.customerConfirmed)
    return {
      ...base,
      title: "customerConfirmation",
      body: "customerConfirmationBody",
      responsibility: "customer",
      next: "searchNext",
    };
  // Quick orders: the total is confirmed, but drivers are searched only once the
  // customer can receive the parcel now.
  if (o.dispatchState === "customer_later")
    return {
      ...base,
      title: "customerLater",
      body: "customerLaterBody",
      responsibility: "customer",
      next: "customerLaterNext",
      at: o.customerAvailabilityUpdatedAt || o.updatedAt,
    };
  if (o.dispatchState === "customer_ready")
    return { ...base, title: "customerReady", body: "customerReadyBody", at: o.customerAvailabilityUpdatedAt || o.updatedAt };
  return { ...base, title: "searching", body: "searchingBody", at: o.searchStartedAt };
}
// Required outcomes stay open until server evidence resolves them. Showing a
// pickup code never changes a task's state or the notification badge.
export function merchantTasks(o) {
  if (terminal.has(o.status)) return [];
  const tasks = [],
    add = (kind, title, action, rank, body) =>
      tasks.push({
        id: `${o._id}:${kind}`,
        order: o,
        kind,
        title,
        action,
        rank,
        body,
        taskState: "open",
      });
  if (o.status === "returning") add("return", "returningTitle", "returnAction", 1, "returningBody");
  if (!o.canEdit) return tasks;
  const missing = o.missingRequirements ?? [];
  if (o.status === "searching_driver" && o.driverSearchStatus === "no_driver" && o.serviceArea)
    add("retry", "retrySearchTask", "retrySearchTask", 3, "retrySearchBody");
  if (o.routeError && o.priceStatus !== "final" && o.destinationLocation?.confirmedAt)
    add("fare", "fareRetry", "retry", 4, "fareFailedBody");
  // A quick order created before goods became mandatory: only the store can record them.
  if (o.workflowVersion === 2 && o.goodsAmountKnown === false) add("edit", "goodsTask", "edit", 2, "goodsTaskBody");
  if (o.workflowVersion === 3 && !o.parcelReady && o.status === "searching_driver")
    add("ready", "waitingStore", "markParcelReady", 0, "waitingStoreBody");
  if ([2, 3].includes(o.workflowVersion)) return tasks.sort((a, b) => a.rank - b.rank);
  if (
    missing.some((k) =>
      ["parcel_details_required", "fee_payer_required", "service_area_required"].includes(k),
    ) ||
    !o.serviceArea ||
    !o.customerPhone ||
    !o.recipientName ||
    (o.priceSource === "manual" && missing.includes("fee_required"))
  )
    add("edit", "completeTask", "edit", 2, "completeBody");
  if (!o.parcelReady)
    add("ready", "readyTask", "readyAction", o.status === "driver_at_store" ? 0 : 5, "readyBody");
  const confirmable = [
    "driver_required",
    "parcel_not_ready",
    "store_confirmation_required",
    "driver_confirmation_required",
  ];
  if (!o.storeConfirmed && !missing.some((k) => !confirmable.includes(k)))
    add("confirm", "confirmTask", "confirmAction", 2, "confirmBody");
  if (o.status === "driver_at_store" && o.activeAssignment && o.parcelReady && !missing.length)
    add("pickup", "pickupTask", "pickupAction", 0, "pickupBody");
  return tasks.sort((a, b) => a.rank - b.rank);
}
export const allTasks = (orders) =>
  orders
    .flatMap(merchantTasks)
    .sort(
      (a, b) =>
        a.rank - b.rank || String(a.order.createdAt).localeCompare(String(b.order.createdAt)),
    );
export function searchOrders(orders, query) {
  const q = digits(query).trim().toLocaleLowerCase(),
    phone = normalizePhone(q);
  if (!q) return orders;
  return orders
    .map((o) => {
      const name = (o.recipientName ?? "").toLocaleLowerCase(),
        number = o._id.toLowerCase();
      const rank = number.endsWith(q.replace(/^#/, ""))
        ? 0
        : phone && normalizePhone(o.customerPhone).includes(phone)
          ? 1
          : name === q
            ? 2
            : name.includes(q)
              ? 3
              : 99;
      return { o, rank };
    })
    .filter((r) => r.rank < 99)
    .sort((a, b) => a.rank - b.rank)
    .map((r) => r.o);
}
