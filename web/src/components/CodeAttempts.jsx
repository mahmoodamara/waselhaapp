import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Field, Notice, useAction, useLanguage } from "./UI.jsx";

// Admin view of pickup/delivery code attempts for one order: the current lock
// state per driver and the attempt timeline. It shows numbers only and never
// labels an actor as "guessing" - the admin reads the pattern.
export default function CodeAttempts({ orderId }) {
  const { t, language } = useLanguage(),
    action = useAction();
  const [report, setReport] = useState(null),
    [loadError, setLoadError] = useState(null),
    [notes, setNotes] = useState({}),
    [reloads, setReloads] = useState(0);
  useEffect(() => {
    let current = true;
    setReport(null);
    setLoadError(null);
    setNotes({});
    api(`/admin/orders/${orderId}/code-attempts`)
      .then((data) => current && setReport(data))
      .catch((e) => current && setLoadError(e));
    return () => {
      current = false;
    };
  }, [orderId, reloads]);
  const time = (value) =>
    new Date(value).toLocaleString(language === "ar" ? "ar" : "he");
  const rowKey = (s) => `${s.actorId}-${s.type}`;
  const unlock = (s) =>
    action.run(async () => {
      setReport(
        await api(`/admin/orders/${orderId}/unlock-code`, {
          method: "POST",
          body: {
            actorId: s.actorId,
            verificationType: s.type,
            note: notes[rowKey(s)] || "",
          },
        }),
      );
      action.setSuccess("saved");
    });
  return (
    <div className="code-attempts">
      <div className="section-title">
        <h2>{t("codeAttempts")}</h2>
        <button
          className="quiet"
          disabled={action.busy}
          onClick={() => setReloads((n) => n + 1)}
        >
          {t("refresh")}
        </button>
      </div>
      <Notice action={action} />
      {loadError && (
        <p className="callout error" role="alert">
          {t(loadError.code || loadError.message)}
        </p>
      )}
      {report && !report.states.length && (
        <p className="empty">{t("codeNoAttempts")}</p>
      )}
      {report?.states.length > 0 && (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {[
                    "driver",
                    "codeType",
                    "codeAttemptsCount",
                    "codeFailures",
                    "codeBlocked",
                    "codeState",
                    "unlockCode",
                  ].map((k) => (
                    <th key={k}>{t(k)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.states.map((s) => (
                  <tr key={rowKey(s)}>
                    <td>{s.actorName || "—"}</td>
                    <td>{t(`codeType.${s.type}`)}</td>
                    <td>{s.totalAttempts}</td>
                    <td>{s.failures}</td>
                    <td>{s.blockedCount}</td>
                    <td className={s.locked ? "negative" : ""}>
                      {s.manualLock
                        ? t("codeStateNeedsAdmin")
                        : s.locked
                          ? `${t("codeStateLockedUntil")} ${time(s.lockedUntil)}`
                          : t("codeStateOpen")}
                    </td>
                    <td>
                      {s.locked && (
                        <div className="actions">
                          <Field
                            label="unlockNote"
                            maxLength={500}
                            value={notes[rowKey(s)] || ""}
                            onChange={(e) =>
                              setNotes({
                                ...notes,
                                [rowKey(s)]: e.target.value,
                              })
                            }
                          />
                          <button
                            disabled={action.busy}
                            onClick={() => unlock(s)}
                          >
                            {t("unlockCode")}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>{t("codeTimeline")}</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {[
                    "codeTime",
                    "driver",
                    "codeType",
                    "codeAttemptNo",
                    "codeResult",
                    "codeLock",
                    "codeIp",
                    "codeBrowser",
                  ].map((k) => (
                    <th key={k}>{t(k)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.attempts.map((a) => (
                  <tr key={a._id}>
                    <td>{time(a.createdAt)}</td>
                    <td>{a.actorName || "—"}</td>
                    <td>{t(`codeType.${a.verificationType}`)}</td>
                    <td>{a.attemptNumber}</td>
                    <td className={a.result === "wrong_code" ? "negative" : ""}>
                      {t(`codeResult.${a.result}`)}
                      {a.note ? ` — ${a.note}` : ""}
                    </td>
                    <td>{a.lock ? t(`codeLock.${a.lock}`) : "—"}</td>
                    <td dir="ltr">{a.ip || "—"}</td>
                    <td dir="ltr" title={a.userAgent || ""}>
                      {a.userAgent ? a.userAgent.slice(0, 40) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
