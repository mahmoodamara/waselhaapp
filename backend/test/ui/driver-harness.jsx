import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import Current from "../../../driver-app/screens/Current.js";
import Available from "../../../driver-app/screens/Available.js";
import { translations } from "../../../driver-app/translations.js";
import { DriverLanguage } from "../../../driver-app/screens/driverDesign.js";
const params = new URLSearchParams(location.search);
const language = params.get("language") === "he" ? 1 : 0;
document.documentElement.lang = language ? "he" : "ar";
const token = sessionStorage.getItem("driverToken");
const t = (key) => translations[key]?.[language] || `MISSING:${key}`;
async function request(path, body) {
  const response = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
  if (!response.ok) { const data = await response.json(); throw Object.assign(new Error(data.code), data); }
  return response.json();
}
function Harness() {
  const [current, setCurrent] = useState(null), [offers, setOffers] = useState([]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const reload = async () => { const [c,a] = await Promise.all([request("/driver/orders/current"),request("/driver/orders/available")]); setCurrent(c); setOffers(a); };
  useEffect(() => { reload().catch(e => setError(e.message)); }, []);
  const run = async (id, action, body = {}) => {
    setBusy(true); setError("");
    try { await request(`/orders/${id}/${action}`, typeof body === "function" ? body() : body); await reload(); }
    catch(e) { setError(e.message); } finally { setBusy(false); }
  };
  return <DriverLanguage.Provider value={language ? "he" : "ar"}><main style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, direction: "ltr", fontFamily: "sans-serif", background: "#f4f7f2" }}>
    {error && <p role="alert">{error}</p>}
    {params.get("screen") === "available" ? <Available orders={offers} current={current} busy={busy} t={t} accept={(id) => run(id,"accept")} />
      : <Current order={current} busy={busy} t={t} action={(action,body) => run(current._id,action,body)} verifyDeliveryCode={code => request(`/orders/${current._id}/verify-delivery-code`, { code })} />}
  </main></DriverLanguage.Provider>;
}
createRoot(document.getElementById("root")).render(<Harness />);
