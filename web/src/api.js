export async function api(path, options = {}) {
  const token = localStorage.getItem("waselha.token");
  let response, data;
  // A request that hangs would freeze the screen; after the limit the outcome is
  // unknown (the server may have applied it), so the caller is told to re-check.
  const controller = new AbortController();
  // Route pricing can wait up to 30 seconds on the server, plus transport/DB time.
  const timer = setTimeout(() => controller.abort(), 40000);
  try {
    response = await fetch(`/api${path}`, {
      signal: controller.signal,
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    data = await response.json();
  } catch (e) {
    const code = e?.name === "AbortError" ? "request_timeout" : "network_error";
    throw Object.assign(new Error(code), { code });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok)
    throw Object.assign(new Error(data.code), data, {
      status: response.status,
    });
  return data;
}
export function money(amount) {
  return amount === null || amount === undefined
    ? "—"
    : `${(amount / 100).toFixed(2)} ₪`;
}
export function parseMoney(input, nullable = false) {
  const value = String(input)
    .trim()
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 1632))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 1776))
    .replace(/[٫,]/g, ".");
  if (!value && nullable) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(value))
    throw Object.assign(new Error("invalid_amount"), {
      code: "invalid_amount",
    });
  const [whole, fraction = ""] = value.split(".");
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(amount))
    throw Object.assign(new Error("invalid_amount"), {
      code: "invalid_amount",
    });
  return amount;
}
export function newRequestId() {
  return (
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
  );
}
