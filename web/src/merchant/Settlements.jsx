import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import { Money } from "../components/UI.jsx";
import { Empty, ErrorState, PageTitle, Skeleton, useCopy, useWorkspace } from "./components.jsx";
import { dateTime, orderNumber } from "./model.js";

export function Settlements() {
  const { permissions, permissionError, loadPermissions } = useWorkspace(),
    { c, t, language } = useCopy(),
    [params, setParams] = useSearchParams(),
    location = useLocation();
  const currentPeriod = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
  }).format(new Date());
  const period = /^\d{4}-(0[1-9]|1[0-2])$/.test(params.get("period") || "")
    ? params.get("period")
    : currentPeriod;
  const [data, setData] = useState(null),
    [error, setError] = useState(null),
    [busy, setBusy] = useState(false),
    [lastUpdate, setLastUpdate] = useState(null),
    sequence = useRef(0),
    lock = useRef(false);
  async function load(more = false) {
    if (more && lock.current) return;
    const version = ++sequence.current;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await api(
        `/store/settlements?period=${period}${more && data?.nextCursor ? `&cursor=${data.nextCursor}` : ""}`,
      );
      if (version === sequence.current) {
        setData((current) =>
          more ? { ...result, records: [...current.records, ...result.records] } : result,
        );
        setLastUpdate(new Date());
      }
    } catch (e) {
      if (version === sequence.current) setError(e);
    } finally {
      if (version === sequence.current) {
        setBusy(false);
        lock.current = false;
      }
    }
  }
  useEffect(() => {
    setData(null);
    if (permissions?.viewSettlements) load();
    return () => {
      sequence.current++;
      lock.current = false;
    };
  }, [period, permissions?.viewSettlements]);
  useEffect(() => {
    if (data && location.state?.restoreScroll)
      requestAnimationFrame(() => window.scrollTo(0, location.state.restoreScroll));
  }, [!!data]);
  if (permissionError) return <ErrorState error={permissionError} retry={loadPermissions} />;
  if (!permissions) return <Skeleton />;
  if (!permissions.viewSettlements || [401, 403].includes(error?.status))
    return (
      <Empty title={c("forbidden")}>
        <Link to="/store">{c("home")}</Link>
      </Empty>
    );
  return (
    <>
      <PageTitle title={c("settlements")}>
        <label className="mw-period">
          {c("period")}
          <input
            type="month"
            value={period}
            onChange={(e) => e.target.value && setParams({ period: e.target.value })}
          />
        </label>
        <button className="quiet" disabled={busy} onClick={() => load()}>
          {c(busy ? "updating" : "refresh")}
        </button>
      </PageTitle>
      {!data ? (
        error ? (
          <ErrorState error={error} retry={() => load()} />
        ) : (
          <Skeleton />
        )
      ) : (
        <>
          {error && (
            <p className="callout attention">
              {c("cached")} · {dateTime(lastUpdate, language)}{" "}
              <button className="mw-text-button" onClick={() => load()}>
                {c("retry")}
              </button>
            </p>
          )}
          <div className="mw-settlement-totals">
            <section className="mw-card mw-due">
              <p className="mw-eyebrow">{c("due")}</p>
              <strong className="mw-large-money">
                <Money value={data.dueAgorot} />
              </strong>
              <p>{c("dueHint")}</p>
              {data.payableAgorot > 0 && (
                <p>
                  {c("payable")}: <Money value={data.payableAgorot} />
                </p>
              )}
            </section>
            <section className="mw-card">
              <h2>{c("inTransfer")}</h2>
              <strong className="mw-large-money">
                <Money value={data.inTransferAgorot} />
              </strong>
              <p className="mw-muted">{c("transferUnsupported")}</p>
            </section>
            <section className="mw-card">
              <h2>{c("recorded")}</h2>
              <strong className="mw-large-money">
                <Money value={data.recordedAgorot} />
              </strong>
            </section>
          </div>
          {data.unresolvedCount > 0 && (
            <p className="callout attention">
              {data.unresolvedCount} {c("unresolved")}
            </p>
          )}
          {data.legacyCount > 0 && (
            <p className="callout">
              {data.legacyCount} · {t("legacyFinanceUnknown")}
            </p>
          )}
          <section className="mw-card">
            <h2>{c("previousSettlements")}</h2>
            {data.records.length ? (
              data.records.map((record) => (
                <Link
                  className="mw-settlement-row"
                  key={record._id}
                  to={`/store/settlements/${record._id}`}
                  state={{ from: location.pathname + location.search, scroll: window.scrollY }}
                >
                  <span>
                    <strong>{dateTime(record.completedAt, language)}</strong>
                    <small>
                      <bdi>{record.reference}</bdi> · <bdi>{record.recipientName}</bdi>
                    </small>
                  </span>
                  <strong>
                    <Money value={record.amountAgorot} />
                  </strong>
                  <span className="mw-status success">
                    {c(record.direction === "collect_from_store" ? "payable" : "recordedStatus")}
                  </span>
                </Link>
              ))
            ) : (
              <Empty title={c("noSettlements")} icon="money" />
            )}
            {data.nextCursor && (
              <button className="quiet" disabled={busy} onClick={() => load(true)}>
                {c(busy ? "loading" : "more")}
              </button>
            )}
          </section>
          <p className="mw-hint">{c("manualSettlement")}</p>
        </>
      )}
    </>
  );
}

export function SettlementDetails() {
  const { id } = useParams(),
    { permissions, permissionError, loadPermissions } = useWorkspace(),
    { c, language } = useCopy(),
    location = useLocation();
  const [data, setData] = useState(null),
    [error, setError] = useState(null),
    [showOrders, setShowOrders] = useState(false);
  async function load() {
    setError(null);
    try {
      setData(await api(`/store/settlements/${id}`));
    } catch (e) {
      setError(e);
    }
  }
  useEffect(() => {
    if (permissions?.viewSettlements) load();
  }, [id, permissions?.viewSettlements]);
  if (permissionError) return <ErrorState error={permissionError} retry={loadPermissions} />;
  if (!permissions) return <Skeleton />;
  if (!permissions.viewSettlements || [401, 403].includes(error?.status))
    return <Empty title={c("forbidden")} />;
  if (!data) return error ? <ErrorState error={error} retry={load} /> : <Skeleton />;
  const { order: o } = data;
  return (
    <>
      <Link
        className="mw-back"
        to={location.state?.from || "/store/settlements"}
        state={{ restoreScroll: location.state?.scroll }}
      >
        {c("settlements")} <span aria-hidden="true">›</span>
      </Link>
      <PageTitle
        title={`${c("settlement")} ${dateTime(o.storeSettlement.completedAt, language)}`}
        eyebrow={data.reference}
      />
      <section className="mw-card">
        <span className="mw-status success">{c("recordedStatus")}</span>
        <h2>{c(data.direction === "collect_from_store" ? "payable" : "net")}</h2>
        <strong className="mw-large-money">
          <Money value={data.netAgorot} />
        </strong>
        <h2>{c("calculation")}</h2>
        <dl className="mw-facts">
          <div>
            <dt>{c("goods")}</dt>
            <dd>
              <Money value={data.goodsAgorot} />
            </dd>
          </div>
          <div>
            <dt>
              {c("fare")} · {c("store")}
            </dt>
            <dd>
              <Money
                value={data.deliveryLiabilityAgorot == null ? null : -data.deliveryLiabilityAgorot}
              />
            </dd>
          </div>
          <div>
            <dt>{c("adjustments")}</dt>
            <dd>
              <Money value={data.adjustmentAgorot} />
            </dd>
          </div>
          <div className="mw-total">
            <dt>{c("net")}</dt>
            <dd>
              <Money
                value={data.direction === "collect_from_store" ? -data.netAgorot : data.netAgorot}
              />
            </dd>
          </div>
        </dl>
        <h2>{c("includedOrders")} · 1</h2>
        <button
          className="mw-text-button"
          onClick={() => setShowOrders((v) => !v)}
          aria-expanded={showOrders}
        >
          {c("viewAll")}
        </button>
        {showOrders && (
          <Link
            className="mw-settlement-row"
            to={`/store/orders/${o._id}`}
            state={{ from: location.pathname }}
          >
            <bdi>#{orderNumber(o)}</bdi>
            <bdi>{o.recipientName}</bdi>
            <Money value={o.goodsAmountAgorot} />
          </Link>
        )}
        <details className="mw-disclosure">
          <summary>{c("adjustments")}</summary>
          {data.adjustmentAgorot ? (
            <Money value={data.adjustmentAgorot} />
          ) : (
            <p>{c("noAdjustments")}</p>
          )}
        </details>
        <p>
          {c("reference")}: <bdi>{data.reference}</bdi>
        </p>
        <p className="mw-hint">{c("manualSettlement")}</p>
        <Link to={`/store/orders/${o._id}/help`} state={{ from: location.pathname }}>
          {c("help")}
        </Link>
      </section>
    </>
  );
}
