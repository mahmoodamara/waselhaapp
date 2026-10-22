import { PushDevice, User } from "../models/index.js";
import { config } from "../config.js";
import { log } from "./log.js";

// Offers reach a driver whose app is closed or in the background through the phone's own push
// channel (FCM on Android, APNs on iPhone), relayed by the free Expo push service. The message
// carries only the store name and the driver's fare: never a customer name, phone or address.
export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
const TOKEN = /^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]{8,}\]$/;
export const validPushToken = value => typeof value === "string" && value.length <= 120 && TOKEN.test(value);
export const pushPlatforms = ["android", "ios"];
export const pushLanguages = ["ar", "he"];

// A ticket only says Expo accepted the message. Whether Google/Apple took it (a wrong or missing FCM key,
// an uninstalled app) shows up later in a receipt, so every accepted ticket is followed up here.
export const RECEIPT_DELAY_MS = 30000;
export const RECEIPT_GIVE_UP_MS = 30 * 60000;
const RECEIPT_CHECK_MS = 30000, RECEIPT_BATCH = 300, PENDING_LIMIT = 1000;

const shekel = agorot => `${Number((agorot / 100).toFixed(2))} ₪`;
// Expo's own error text can quote the recipient's token: never let it reach a log.
const clean = text => String(text ?? "").replace(/Expo(?:nent)?PushToken\[[^\]]*\]/g, "[device]").slice(0, 240);
export function offerMessage(dto, language = "ar", now = Date.now()) {
  const fare = dto.estimatedDriverEarningsAgorot ?? dto.driverEarningsAgorot;
  const he = language === "he";
  const parts = [dto.storeName, Number.isFinite(fare) ? `${he ? "הכנסה" : "أجرة"} ${shekel(fare)}` : null].filter(Boolean);
  const expires = Date.parse(dto.expiresAt ?? "");
  // A stale offer must never arrive after it expired: the push service drops it at its deadline.
  const ttl = Number.isFinite(expires) ? Math.max(1, Math.floor((expires - now) / 1000)) : 30;
  return { title: he ? "הזמנה חדשה" : "طلب جديد", body: parts.join(" · "), sound: "default", priority: "high", channelId: "offers",
    ttl, data: { type: "offer", orderId: dto.orderId } };
}
export function testMessage(language = "ar") {
  const he = language === "he";
  return { title: he ? "בדיקת התראות" : "اختبار الإشعارات", body: he ? "אם ההתראה הזו מופיעה, ההתראות עובדות." : "إذا ظهر هذا الإشعار فالإشعارات تعمل.",
    sound: "default", priority: "high", channelId: "offers", ttl: 120, data: { type: "test" } };
}

async function expoPost(url, payload, settings) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", Accept: "application/json",
        ...(settings.expoPushAccessToken ? { Authorization: `Bearer ${settings.expoPushAccessToken}` } : {}) },
      body: JSON.stringify(payload) });
    // A refused request (bad access token, malformed body) must not look like "nothing to report".
    if (!response.ok) throw Object.assign(new Error("expo_http"), { code: `expo_http_${response.status}` });
    return (await response.json()).data;
  } finally { clearTimeout(timer); }
}
const expoSend = async (messages, settings) => (await expoPost(EXPO_PUSH_URL, messages, settings)) ?? [];
const expoReceipts = async (ids, settings) => (await expoPost(EXPO_RECEIPTS_URL, { ids }, settings)) ?? {};
const failureCode = error => error?.name === "AbortError" ? "timeout" : (error?.code ?? "send_failed");

// `send` and `fetchReceipts` are replaceable so tests never reach the network. A failure is logged and
// swallowed: a missed push must never affect an order or the socket path.
export function createPushNotifier(settings = config, send = expoSend, fetchReceipts = expoReceipts) {
  const pending = []; // accepted tickets whose receipt has not been read yet
  let timer;
  const forget = tokens => tokens.length ? PushDevice.deleteMany({ token: { $in: tokens } }) : null;
  const remember = entry => { pending.push(entry); if (pending.length > PENDING_LIMIT) pending.splice(0, pending.length - PENDING_LIMIT); };

  // Follows up every ticket old enough to have a receipt: logs whether the phone's push channel took it
  // and forgets a token that no longer belongs to an installed app.
  async function checkReceipts(now = Date.now()) {
    const due = pending.filter(entry => now - entry.at >= RECEIPT_DELAY_MS).slice(0, RECEIPT_BATCH);
    if (!due.length) return 0;
    let receipts;
    try { receipts = await fetchReceipts(due.map(entry => entry.id), settings); }
    catch (error) { log("warn", "push_receipts_failed", { code: failureCode(error) }); return 0; }
    const dead = [];
    let settled = 0;
    for (const entry of due) {
      const receipt = receipts?.[entry.id];
      if (!receipt) {
        // Not available yet; give up quietly-but-visibly after a long wait.
        if (now - entry.at > RECEIPT_GIVE_UP_MS) {
          pending.splice(pending.indexOf(entry), 1);
          log("warn", "offer_push_unconfirmed", { orderId: entry.orderId, driverId: entry.driverId });
        }
        continue;
      }
      pending.splice(pending.indexOf(entry), 1); settled++;
      if (receipt.status === "ok") { log("info", "offer_push_receipt", { orderId: entry.orderId, driverId: entry.driverId, status: "ok" }); continue; }
      const expoError = receipt.details?.error ?? "unknown";
      log("error", "offer_push_receipt_error", { orderId: entry.orderId, driverId: entry.driverId, expoError, reason: clean(receipt.message) });
      if (expoError === "DeviceNotRegistered") dead.push(entry.token);
    }
    try { await forget(dead); } catch { /* the next receipt for that token repeats this */ }
    return settled;
  }

  return {
    enabled: settings.pushEnabled === true,
    pending: () => pending.length,
    checkReceipts,
    // Reading receipts runs on a timer only in a real server: tests call checkReceipts themselves.
    start() {
      if (settings.pushEnabled !== true || timer) return;
      timer = setInterval(() => { void checkReceipts().catch(() => {}); }, RECEIPT_CHECK_MS);
      timer.unref();
    },
    close() { clearInterval(timer); timer = undefined; },
    async offer(driverId, dto) {
      if (settings.pushEnabled !== true) return 0;
      try {
        const user = await User.findById(driverId).select('active authVersion role').lean();
        if (!user?.active || user.role !== 'driver') return 0;
        const devices = await PushDevice.find({ userId: driverId, authVersion: user.authVersion ?? 0,
          ...(dto.workflowVersion === 3 ? { supportedWorkflowVersion: 3 } : {}) }).lean();
        if (!devices.length) return 0;
        const messages = devices.map(device => ({ to: device.token, ...offerMessage(dto, device.language) }));
        const tickets = await send(messages, settings);
        const rejected = [], dead = [];
        devices.forEach((device, i) => {
          const ticket = tickets[i];
          if (ticket?.status === "ok" && ticket.id) remember({ id: ticket.id, token: device.token, orderId: dto.orderId, driverId: String(driverId), at: Date.now() });
          else if (ticket?.status === "error") {
            rejected.push(ticket);
            // A token the push service no longer knows belongs to an uninstalled app: forget it.
            if (ticket.details?.error === "DeviceNotRegistered") dead.push(device.token);
            log("warn", "offer_push_rejected", { orderId: dto.orderId, driverId: String(driverId), expoError: ticket.details?.error ?? "unknown", reason: clean(ticket.message) });
          }
        });
        await forget(dead);
        log("info", "offer_push_sent", { orderId: dto.orderId, driverId: String(driverId), devices: devices.length, rejected: rejected.length });
        return devices.length;
      } catch (error) {
        log("warn", "offer_push_failed", { orderId: dto?.orderId, driverId: String(driverId), code: failureCode(error) });
        return 0;
      }
    },
  };
}

// Operations check (npm run push-test): one harmless notification to a driver's phones, then the receipt
// that says whether Google/Apple took it. Returns plain results; never a token.
export async function sendTestPush(driverId, settings = config, send = expoSend, fetchReceipts = expoReceipts, { waitMs = 90000, pollMs = 5000, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const user = await User.findById(driverId).select('active authVersion role').lean();
  if (!user?.active || user.role !== 'driver') return { devices: 0, results: [] };
  const devices = await PushDevice.find({ userId: driverId, authVersion: user.authVersion ?? 0 }).lean();
  if (!devices.length) return { devices: 0, results: [] };
  const tickets = await send(devices.map(device => ({ to: device.token, ...testMessage(device.language) })), settings);
  const results = devices.map((device, i) => ({ platform: device.platform, ticket: tickets[i]?.status ?? "missing",
    ticketError: tickets[i]?.details?.error ?? null, id: tickets[i]?.id ?? null, receipt: null, receiptError: null, reason: clean(tickets[i]?.message) }));
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && results.some(r => r.id && !r.receipt)) {
    await sleep(pollMs);
    const data = await fetchReceipts(results.filter(r => r.id && !r.receipt).map(r => r.id), settings);
    for (const r of results) {
      const receipt = r.id && data?.[r.id];
      if (!receipt) continue;
      r.receipt = receipt.status;
      if (receipt.status !== "ok") { r.receiptError = receipt.details?.error ?? "unknown"; r.reason = clean(receipt.message); }
    }
  }
  return { devices: devices.length, results: results.map(({ id, ...rest }) => rest) };
}
