import { useEffect, useRef, useState } from "react";
import { api, parseMoney } from "../api.js";
import { statusList } from "../translations.js";
import CodeAttempts from "../components/CodeAttempts.jsx";
import OrderFinance from "../components/OrderFinance.jsx";
import { Dialog } from "../merchant/components.jsx";
import { orderNumber } from "../merchant/model.js";
import AdminDataRequests from './AdminDataRequests.jsx';
import {
  Details,
  Field,
  Money,
  Notice,
  OrderTable,
  Status,
  useAction,
  useLanguage,
} from "../components/UI.jsx";
function AccountForm({ account, onSaved, onClose, supportedAreas }) {
  const { t } = useLanguage(),
    action = useAction();
  const [form, setForm] = useState({
    role: "store",
    login: "",
    name: "",
    phone: "",
    storeName: "",
    pickupAddress: "",
    active: true,
    // A new driver starts with the only area there is: without an area (and a vehicle) they receive no offers.
    serviceAreas: !account && supportedAreas.length === 1 ? [...supportedAreas] : [],
    ...account,
    vehicleType: account?.vehicleType ?? "",
    password: "",
  });
  function submit(e) {
    e.preventDefault();
    action.run(async () => {
      await api(
        account ? `/admin/accounts/${account._id}` : "/admin/accounts",
        {
          method: account ? "PATCH" : "POST",
          body: {
            login: form.login,
            name: form.name,
            phone: form.phone,
            role: form.role,
            storeName: form.storeName,
            pickupAddress: form.pickupAddress,
            password: form.password,
            active: form.active,
            ...(form.role === "driver" ? { serviceAreas: form.serviceAreas } : {}),
            ...(form.role === "driver" && (account || form.vehicleType)
              ? { vehicleType: form.vehicleType || null } : {}),
          },
        },
      );
      onSaved();
    });
  }
  return (
    <section className="panel">
      <div className="section-title">
        <h2>{t(account ? "editAccount" : "addAccount")}</h2>
        <button className="quiet" onClick={onClose}>
          {t("close")}
        </button>
      </div>
      <Notice action={action} />
      <form noValidate onSubmit={submit}>
        <div className="form-grid">
          <Field label="role">
            <select
              disabled={!!account}
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
            >
              {["store", "driver"].map((r) => (
                <option key={r} value={r}>
                  {t(`role.${r}`)}
                </option>
              ))}
            </select>
          </Field>
          {[
            "login",
            "name",
            "phone",
            ...(form.role === "store" ? ["storeName", "pickupAddress"] : []),
          ].map((k) => (
            <Field
              key={k}
              label={k === "login" ? "loginName" : k}
              required={k !== "phone"}
              disabled={k === "login" && !!account}
              value={form[k]}
              dir={["login", "phone"].includes(k) ? "ltr" : "auto"}
              onChange={(e) => setForm({ ...form, [k]: e.target.value })}
            />
          ))}
          <Field
            label="password"
            type="password"
            autoComplete="new-password"
            required={!account}
            minLength={6}
            value={form.password}
            placeholder={account ? t("passwordOptional") : ""}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
          {account && (
            <label className="check">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => setForm({ ...form, active: e.target.checked })}
              />
              {t("active")}
            </label>
          )}
          {form.role === "driver" && <fieldset>
            <legend>{t("driverServiceAreas")}</legend>
            {supportedAreas.map((code) => <label className="check" key={code}>
              <input type="checkbox" checked={form.serviceAreas.includes(code)} disabled={action.busy}
                onChange={(e) => setForm({ ...form, serviceAreas: e.target.checked ? [...form.serviceAreas, code] : form.serviceAreas.filter((area) => area !== code) })} />
              {t(`serviceArea.${code}`)}
            </label>)}
            {!form.serviceAreas.length && <p className="callout attention">{t("noServiceAreas")}</p>}
            <label className="field"><span>{t("vehicleType")}</span>
              <select value={form.vehicleType} disabled={action.busy} onChange={(e) => setForm({ ...form, vehicleType: e.target.value })}>
                <option value="">{t("noVehicleType")}</option>
                {["motorcycle", "car"].map((value) => <option key={value} value={value}>{t(`vehicle.${value}`)}</option>)}
              </select>
            </label>
            {!form.vehicleType && <p className="callout attention">{t("noVehicleHint")}</p>}
            <p className="muted">{t("availability")}: {t(account?.availableForOrders === true ? "availableForOrders" : "unavailableForOrders")}</p>
          </fieldset>}
        </div>
        <button disabled={action.busy || !supportedAreas.length}>{t("save")}</button>
      </form>
    </section>
  );
}
function Finance() {
  const { t } = useLanguage();
  const [data, setData] = useState(null), [orders, setOrders] = useState([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const action = { busy, error };
  const refreshVersion = useRef(0), mounted = useRef(false), loading = useRef(false);
  const load = async () => {
    // Invalidate the pending snapshot even when a read is already running.
    // Its loop then performs a trailing read for the latest payment.
    refreshVersion.current++;
    if (loading.current) return;
    loading.current = true;
    setBusy(true); setError(null);
    try {
      let version;
      do {
        version = refreshVersion.current;
        try {
          const [summary, delivered] = await Promise.all([api("/admin/finance"), api("/orders?status=delivered")]);
          if (mounted.current && version === refreshVersion.current) {
            setData(summary); setOrders(delivered);
          }
        } catch (error) {
          if (mounted.current && version === refreshVersion.current) throw error;
        }
      } while (mounted.current && version !== refreshVersion.current);
    } catch (error) {
      if (mounted.current) setError(error);
    } finally {
      // Release in this same task, with no promise handoff that could drop a
      // refresh arriving after the loop completed but before unlock.
      loading.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    load();
    return () => { mounted.current = false; refreshVersion.current++; };
  }, []);
  const update = saved => setOrders(current => current.map(o => o._id === saved._id ? saved : o));
  async function moreCashRecords(driver) {
    if (historyBusy || busy || !driver.nextRecordsCursor) return;
    const version = refreshVersion.current, cursor = driver.nextRecordsCursor;
    setHistoryBusy(true);
    try {
      const page = await api(`/admin/accounts/${driver.driverId}/cash-records?cursor=${encodeURIComponent(cursor)}`);
      if (mounted.current && version === refreshVersion.current) setData(previous => ({ ...previous,
        drivers: previous.drivers.map(item => String(item.driverId) === String(driver.driverId) && item.nextRecordsCursor === cursor
          ? { ...item, records:[...item.records,...page.items], nextRecordsCursor:page.nextCursor } : item) }));
    } catch(e) { if (mounted.current) setError(e); } finally { if (mounted.current) setHistoryBusy(false); }
  }
  return <>
    <div className="section-title"><h2>{t("finance")}</h2><button className="quiet" disabled={action.busy} onClick={load}>{t("refresh")}</button></div>
    <Notice action={action} />
    <p className="callout attention">{t("manualFinanceHint")}</p>
    {!data ? <p className="muted">{t(action.busy ? "loading" : "empty")}</p> : <>
      <div className="money-grid totals">{[["deliveryFees", "deliveryFeesAgorot"], ["commission", "commissionAgorot"],
        ["earned", "driverEarningsAgorot"], ["collectedCash", "cashCollectedAgorot"], ["driverShortagePaid", "driverShortagePaidAgorot"], ["handedOver", "cashHandedOverAgorot"],
        ["paid", "paymentsAgorot"], ["cashHeld", "cashHeldAgorot"], ["unpaid", "unpaidEarningsAgorot"]].map(([label,key]) => <div key={key}><small>{t(label)}</small><strong><Money value={data[key]} /></strong></div>)}</div>
      <section className="panel"><div className="table-wrap"><table>
        <thead><tr>{["driver", "earned", "paid", "unpaid", "collectedCash", "driverShortagePaid", "handedOver", "cashHeld"].map(key => <th key={key}>{t(key)}</th>)}</tr></thead>
        <tbody>{data.drivers.map(d => <tr key={d.driverId}><td>{d.driver.name}</td>
          {["earningsAgorot", "paymentsAgorot", "unpaidEarningsAgorot", "cashCollectedAgorot", "driverShortagePaidAgorot", "cashHandedOverAgorot", "cashHeldAgorot"].map(key => <td key={key}><Money value={d[key]} /></td>)}
        </tr>)}</tbody>
      </table></div></section>
      {data.drivers.some(d => d.records.length) && <section className="panel"><h2>{t("recordHistory")}</h2><div className="table-wrap"><table>
        <thead><tr>{["driver", "recordType", "amount", "note"].map(key => <th key={key}>{t(key)}</th>)}</tr></thead>
        <tbody>{data.drivers.flatMap(d => d.records.map(r => <tr key={r._id}><td>{d.driver.name}</td><td>{t(r.type)}</td><td><Money value={r.amountAgorot} /></td><td>{r.note}</td></tr>))}</tbody>
      </table></div>{data.drivers.filter(driver => driver.nextRecordsCursor).map(driver => <button key={driver.driverId} disabled={busy || historyBusy} onClick={() => moreCashRecords(driver)}>{t('loadMore')} · {driver.driver.name}</button>)}</section>}
      {!orders.length && <p className="muted">{t("empty")}</p>}
      {orders.map(o => <section className="panel" key={o._id}>
        <h3>{t("order")} · {orderNumber(o)}</h3>
        <div className="money-grid">{[["expectedCash",o.expectedCustomerCashAgorot],["actualCash",o.actualCashCollectedAgorot],
          ["cashDifference",o.cashDifferenceAgorot],["quotedEarnings",o.driverEarningsAgorot],["commission",o.platformCommissionAgorot]].map(([key,value]) =>
          <div key={key}><small>{t(key)}</small><strong><Money value={value} /></strong></div>)}</div>
        <OrderFinance order={o} admin onSaved={saved => { update(saved); load(); }} />
      </section>)}
    </>}
  </>;
}
export default function Admin() {
  const { t } = useLanguage(),
    action = useAction();
  const [tab, setTab] = useState("orders"),
    [orders, setOrders] = useState([]),
    [accounts, setAccounts] = useState([]),
    [supportedAreas, setSupportedAreas] = useState([]),
    [selected, setSelected] = useState(null),
    [editing, setEditing] = useState(null),
    [adding, setAdding] = useState(false),
    [filter, setFilter] = useState(""),
    [driverId, setDriverId] = useState(""),
    [reason, setReason] = useState(""),
    [stuck, setStuck] = useState([]),
    [custody, setCustody] = useState(false),
    [keptCash, setKeptCash] = useState(""),
    [confirm, setConfirm] = useState(null);
  const load = () =>
    action.run(async () => {
      const [os, as, areas, stuckOrders] = await Promise.all([
        api(`/orders${filter ? `?status=${filter}` : ""}`),
        api("/admin/accounts"),
        api("/orders/service-areas"),
        api("/admin/ops/stuck"),
      ]);
      setStuck(stuckOrders);
      setOrders(os);
      setAccounts(as);
      setSupportedAreas(areas);
      if (selected) setSelected(await api(`/orders/${selected._id}`));
    });
  useEffect(() => {
    load();
  }, [filter]);
  const openOrder = (order) => {
    setSelected(order);
    setDriverId("");
    setReason("");
    setCustody(false);
    setKeptCash("");
  };
  const openStuck = (id) =>
    action.run(async () => {
      openOrder(await api(`/orders/${id}`));
    });
  const mutate = (suffix, body = {}) =>
    action.run(async () => {
      setSelected(
        await api(`/admin/orders/${selected._id}/${suffix}`, {
          method: "POST",
          body: typeof body === "function" ? body() : body, // evaluated inside the action so input errors are reported
        }),
      );
      setOrders(await api(`/orders${filter ? `?status=${filter}` : ""}`));
      action.setSuccess("saved");
    });
  return (
    <>
      <div className="page-title">
        <div>
          <p className="eyebrow">{t("adminPortal")}</p>
          <h1>{t(tab)}</h1>
        </div>
        <button className="quiet" disabled={action.busy} onClick={load}>
          {t("refresh")}
        </button>
      </div>
      <nav className="tabs">
        {["orders", "accounts", "finance", "dataRequests"].map((k) => (
          <button
            key={k}
            className={tab === k ? "selected" : ""}
            aria-pressed={tab === k}
            onClick={() => {
              setTab(k);
              setSelected(null);
            }}
          >
            {t(k)}
          </button>
        ))}
      </nav>
      {!selected && <Notice action={action} />}
      {tab === 'dataRequests' ? <AdminDataRequests /> : tab === "finance" ? (
        <Finance />
      ) : tab === "accounts" ? (
        <>
          <div className="section-title">
            <h2>{t("accounts")}</h2>
            <button
              onClick={() => {
                setAdding(true);
                setEditing(null);
              }}
            >
              {t("addAccount")}
            </button>
          </div>
          {(adding || editing) && (
            <AccountForm
              key={editing?._id || "new"}
              account={editing}
              supportedAreas={supportedAreas}
              onClose={() => {
                setAdding(false);
                setEditing(null);
              }}
              onSaved={() => {
                setAdding(false);
                setEditing(null);
                load();
              }}
            />
          )}
          <section className="panel">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {[
                      "name",
                      "loginName",
                      "role",
                      "phone",
                      "active",
                      "availability",
                      "driverServiceAreas",
                      "edit",
                    ].map((k) => (
                      <th key={k}>{t(k)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => (
                    <tr key={a._id}>
                      <td>{a.name}</td>
                      <td dir="ltr">{a.login}</td>
                      <td>{t(`role.${a.role}`)}</td>
                      <td dir="ltr">{a.phone || "—"}</td>
                      <td>{t(a.active ? "yes" : "no")}</td>
                      <td>{a.role === "driver" ? t(a.availableForOrders === true ? "availableForOrders" : "unavailableForOrders") : "—"}</td>
                      <td>{a.role === "driver" ? a.serviceAreas?.length ? a.serviceAreas.map((code) => t(`serviceArea.${code}`)).join("، ") : t("noServiceAreas") : "—"}{a.role === "driver" ? ` · ${a.vehicleType ? t(`vehicle.${a.vehicleType}`) : t("noVehicleType")}` : ""}</td>
                      <td>
                        <button
                          className="quiet"
                          onClick={() => {
                            setEditing(a);
                            setAdding(false);
                          }}
                        >
                          {t("edit")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : selected ? (
        <section className="panel">
          <div className="section-title">
            <button className="quiet" onClick={() => setSelected(null)}>
              {t("back")}
            </button>
            <Status status={selected.status} driverSearchStatus={selected.driverSearchStatus} />
          </div>
          <Details order={selected} />
          <OrderFinance key={selected._id} order={selected} admin onSaved={saved => { setSelected(saved); setOrders(current => current.map(o => o._id === saved._id ? saved : o)); }} />
          <CodeAttempts orderId={selected._id} />
          {/* Results of the actions below appear here, next to their buttons. */}
          <Notice action={action} />
          {selected.canEdit && selected.priceSource === "route" && selected.priceStatus !== "final" &&
            selected.pickupLocation && selected.destinationLocation?.confirmedAt && (
              <button className="quiet" disabled={action.busy} onClick={() => action.run(async () => {
                const order = await api(`/orders/${selected._id}/recalculate-price`, { method: "POST", body: {} });
                setSelected(order);
                setOrders(await api(`/orders${filter ? `?status=${filter}` : ""}`));
                action.setSuccess("saved");
              })}>{t("retryRoutePrice")}</button>
            )}
          {selected.canEdit && (
            <>
              <div className="actions">
                <Field label="driver">
                  <select
                    value={driverId}
                    onChange={(e) => setDriverId(e.target.value)}
                  >
                    <option value="">{t("selectDriver")}</option>
                    {accounts
                      .filter((a) => a.role === "driver" && a.active)
                      .map((a) => (
                        <option key={a._id} value={a._id}>
                          {a.name}
                        </option>
                      ))}
                  </select>
                </Field>
                {/* An order waiting for its customer is not offered to anyone, the admin included. */}
                <button
                  disabled={action.busy || !driverId || selected.driverSearchStatus === "waiting" || selected.workflowVersion === 3}
                  onClick={() => mutate("assign", { driverId })}
                >
                  {t("assign")}
                </button>
                  {selected.workflowVersion === 3 && <p className="muted">{t("driver_acceptance_required")}</p>}
              </div>
              <div className="actions">
                <Field
                  label="reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <button
                  className="danger"
                  disabled={action.busy || !reason.trim()}
                  onClick={() => setConfirm("cancel")}
                >
                  {t("cancelOrder")}
                </button>
              </div>
            </>
          )}
          {["collected", "driver_at_destination"].includes(selected.status) && (
            <form
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                mutate("recover", () => ({ reason, custodyConfirmed: custody, actualCashCollectedAgorot: parseMoney(keptCash || "0") }));
              }}
            >
              <h3>{t("recoverOrder")}</h3>
              <p>{t("recoverHint")}</p>
              <Field label="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
              <Field label="cashKeptAgorot" value={keptCash} inputMode="decimal" dir="ltr" onChange={(e) => setKeptCash(e.target.value)} />
              <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <input type="checkbox" style={{ width: "auto", minHeight: 0 }} checked={custody} onChange={(e) => setCustody(e.target.checked)} />
                <span>{t("custodyConfirmed")}</span>
              </label>
              <button className="danger" disabled={action.busy || !custody || !reason.trim()}>{t("recoverOrder")}</button>
            </form>
          )}
          {selected.status === "delivery_failed" && (
            <button
              disabled={action.busy}
              onClick={() => setConfirm("return")}
            >
              {t("authorizeReturn")}
            </button>
          )}
          {confirm && (
            <Dialog title={t(confirm === "cancel" ? "cancelOrder" : "authorizeReturn")} onClose={() => setConfirm(null)}>
              <p>{t(confirm === "cancel" ? "confirmCancelOrder" : "confirmAuthorizeReturn")}</p>
              {confirm === "cancel" && <p><bdi>{reason}</bdi></p>}
              <div className="actions">
                <button
                  className={confirm === "cancel" ? "danger" : undefined}
                  disabled={action.busy}
                  onClick={async () => {
                    const kind = confirm;
                    setConfirm(null);
                    await (kind === "cancel" ? mutate("cancel", { reason }) : mutate("authorize-return"));
                  }}
                >
                  {t(confirm === "cancel" ? "cancelOrder" : "authorizeReturn")}
                </button>
                <button className="quiet" onClick={() => setConfirm(null)}>
                  {t("back")}
                </button>
              </div>
            </Dialog>
          )}
        </section>
      ) : (
        <section className="panel">
          <div className="section-title">
            <h2>{t("orders")}</h2>
            <Field label="status">
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="">{t("all")}</option>
                {statusList.map((s) => (
                  <option key={s} value={s}>
                    {t(`status.${s}`)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {stuck.length > 0 && (
            <div className="callout error" role="alert">
              <strong>{t("stuckOrders")}</strong>
              <ul>
                {stuck.map((o) => (
                  <li key={o._id}>
                    <button className="quiet" disabled={action.busy} onClick={() => openStuck(o._id)}>
                      {o.storeName} · {t(`status.${o.status}`)} · {t(`stuck.${o.reason}`)}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <OrderTable
            orders={orders}
            onOpen={openOrder}
          />
        </section>
      )}
    </>
  );
}
