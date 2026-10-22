import { config } from "../config.js";
import { customerPhone, fail, string } from "./validation.js";

export const TEXTME_URL = "https://my.textme.co.il/api";
export const TEXTME_TIMEOUT_MS = 15000;

export function textMeInput({ recipient, message, externalId, dryRun = false }) {
  const phone = customerPhone(recipient);
  // This integration supports the documented local mobile format only. Order storage
  // still accepts its existing broader formats; never strip or invent a country code.
  if (!/^0?5\d{8}$/.test(phone)) fail("sms_unsupported_phone", 422);
  string(message, true, 1005);
  const operationId = string(externalId, true, 120);
  if (!/^[A-Za-z0-9_-]+$/.test(operationId) || typeof dryRun !== "boolean") fail("invalid_input");
  return { recipient: phone, message, externalId: operationId, dryRun };
}

function settings(cfg, dryRun, injectedTransport) {
  if (!cfg.textMeApiToken || !cfg.textMeUsername || !cfg.textMeSource ||
      /[\r\n]/.test(cfg.textMeApiToken) || !/^[A-Za-z0-9]{1,11}$/.test(cfg.textMeSource))
    fail("sms_not_configured", 503);
  if (!dryRun && (!cfg.textMeEnabled || (process.env.NODE_TEST_CONTEXT && !injectedTransport)))
    fail("sms_disabled", 503);
}

const uncertain = code => ({ state: "uncertain", code, shipmentId: null, providerStatus: null });
export function createTextMeClient({ cfg = config, fetchImpl, timeoutMs = TEXTME_TIMEOUT_MS } = {}) {
  const transport = fetchImpl ?? globalThis.fetch;
  return {
    enabled: cfg.textMeEnabled === true,
    // Preflight is also called before claiming a durable operation, so invalid input
    // or missing configuration never consumes its one sending attempt.
    prepare(input) {
      const value = textMeInput(input);
      settings(cfg, value.dryRun, !!fetchImpl);
      return value;
    },
    async send(input) {
      const value = this.prepare(input);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await transport(`${TEXTME_URL}${value.dryRun ? "/test" : ""}`, {
          method: "POST",
          redirect: "error",
          headers: { Authorization: `Bearer ${cfg.textMeApiToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ sms: { user: { username: cfg.textMeUsername }, source: cfg.textMeSource,
            destinations: { phone: { $: { id: value.externalId }, _: value.recipient } }, message: value.message } }),
          signal: controller.signal,
        });
        // HTTP errors can follow acceptance by a gateway. Do not infer rejection.
        if (!response.ok) { await response.body?.cancel(); return uncertain("sms_http_error"); }
        let data;
        try { data = await response.json(); }
        catch { return uncertain(controller.signal.aborted ? "sms_timeout" : "sms_invalid_response"); }
        const status = data?.status;
        const numeric = typeof status === "number" ? status
          : typeof status === "string" && /^-?\d+$/.test(status.trim()) ? Number(status.trim()) : NaN;
        if (!Number.isSafeInteger(numeric)) return uncertain("sms_invalid_response");
        if (numeric !== 0) return { state: "rejected", code: "sms_provider_rejected", shipmentId: null, providerStatus: numeric };
        // Keep provider text/raw responses out of logs and HTTP errors.
        const shipment = data.shipment_id;
        const shipmentId = (typeof shipment === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(shipment)) ? shipment
          : Number.isSafeInteger(shipment) && shipment >= 0 ? String(shipment) : null;
        if (value.dryRun) return { state: "validated", code: "sms_validated", shipmentId: null, providerStatus: 0 };
        if (!shipmentId) return uncertain("sms_incomplete_response");
        return { state: "accepted", code: "sms_accepted", shipmentId, providerStatus: 0 };
      } catch {
        return uncertain(controller.signal.aborted ? "sms_timeout" : "sms_network_error");
      } finally { clearTimeout(timer); }
    },
  };
}
