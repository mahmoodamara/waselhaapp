import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useCopy } from "./components.jsx";

// Reading status never sends. Poll only an existing in-flight attempt; mounting,
// reloading or changing orders cannot create a new charge.
export default function CustomerLinkSms({ order }) {
  return <SmsStatus key={`${order._id}:${order.customerLink}`} orderId={order._id} />;
}

function SmsStatus({ orderId }) {
  const { c } = useCopy();
  const [state, setState] = useState(null), [error, setError] = useState(false);
  useEffect(() => {
    let active = true, timer;
    async function read() {
      try {
        const result = await api(`/orders/${orderId}/customer-link/sms`);
        if (!active) return;
        setState(result.state); setError(false);
        if (result.state === "pending") timer = setTimeout(read, 3000);
      } catch { if (active) setError(true); }
    }
    read();
    return () => { active = false; clearTimeout(timer); };
  }, [orderId]);
  return <span className="mw-sms-action" role="status" aria-live="polite">
    {c(error ? "smsStatusError" : state ? `sms_${state}` : "smsLoading")}
  </span>;
}
