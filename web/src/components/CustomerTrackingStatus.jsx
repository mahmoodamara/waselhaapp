import { useLanguage } from "./UI.jsx";
export default function CustomerTrackingStatus({ tracking }) {
  const { t, language } = useLanguage();
  if (tracking.state === "not_started") return null;
  const key = tracking.error || ({ live: "trackingLive", stale: "trackingStale", unavailable: "trackingUnavailable", ended: "trackingEnded" })[tracking.state];
  return <div className={`cu-tracking ${tracking.state}`}>
    <p role="status">{t(key)}</p>
    {tracking.ageSeconds != null && <p className="cu-muted">{t("trackingLastUpdate").replace("{seconds}",
      new Intl.NumberFormat(language === "he" ? "he-IL" : "ar-IL").format(tracking.ageSeconds))}</p>}
    {tracking.error && <button type="button" className="cu-link" onClick={tracking.refresh}>{t("refresh")}</button>}
  </div>;
}
