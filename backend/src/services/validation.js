import mongoose from "mongoose";
export function fail(code, status = 400, extra = {}) {
  throw Object.assign(new Error(code), { status, code, ...extra });
}
export function id(value) {
  if (!mongoose.isObjectIdOrHexString(value)) fail("invalid_input");
  return value;
}
export function string(value, required = false, max = 2000) {
  if (typeof value !== "string" || value.length > max) fail("invalid_input");
  const result = value.trim();
  if (required && !result) fail("required_fields");
  return result;
}
// Shared order/SMS normalization: punctuation and Arabic digits only; no country-code guessing.
export function customerPhone(value) {
  const phone = string(value, true, 30).replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 1632))
    .replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 1776)).replace(/[\s()-]/g, "");
  if (!/^(?:0\d{8,9}|\+?[1-9]\d{7,14})$/.test(phone)) fail("invalid_phone", 422);
  return phone;
}
