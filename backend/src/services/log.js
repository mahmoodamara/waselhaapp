// One JSON object per line on stdout/stderr, so a log shipper or `grep` can use
// it. Never pass secrets, customer links/tokens, codes or phone numbers here.
// Free-form exception text can contain Mongo values or provider response bodies.
// Keep event/code/requestId diagnostics, never serialize those raw messages.
const privateField = /password|authorization|cookie|token|credential|secret|latitude|longitude|redisUrl|apiKey|polyline|goog|phone|address|recipient|customerData|requestBody|pickupCode|deliveryCode|destinationLocation|pickupLocation|^otp$|^body$|^error$|^message$|^stack$|^lat$|^lng$|^gps$/i;
function redact(value, key = "") {
  if (privateField.test(key)) return "[REDACTED]";
  if (typeof value === "string")
    return value.replace(/(\/(?:api\/)?customer\/)[^\s/?#"'\\]+/gi, "$1[REDACTED]");
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === "object" && !(value instanceof Date))
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  return value;
}
export function log(level, event, fields = {}) {
  const line = JSON.stringify(redact({ time: new Date().toISOString(), level, event, ...fields }));
  (level === "error" ? console.error : console.log)(line);
}
