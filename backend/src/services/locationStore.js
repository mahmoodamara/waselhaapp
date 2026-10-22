import { createClient } from "redis";
import { config } from "../config.js";
import { log } from "./log.js";
import { REALTIME } from "../../../shared/realtimeContract.js";

// All comparisons and writes execute together in Redis. The session high-water
// marks survive location expiry and are inherited by a newly activated session.
const activate = `
local last = redis.call('HGET', KEYS[1], 'lastMeasuredAt') or '0'
local loc = redis.call('GET', KEYS[3])
if loc then last = tostring(math.max(tonumber(last), cjson.decode(loc).measuredAt)) end
redis.call('HSET', KEYS[1], 'sessionId', ARGV[1], 'lastSequence', '0', 'lastMeasuredAt', last, 'connected', '1', 'transport', 'socket')
redis.call('HDEL', KEYS[1], 'backgroundExpiry')
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[4])
return 1`;
const save = `
local current = redis.call('HGET', KEYS[1], 'sessionId')
if not current then return 'session_expired' end
if current ~= ARGV[1] or redis.call('HGET', KEYS[1], 'connected') ~= '1' then return 'stale_session' end
local point = cjson.decode(ARGV[2])
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
if point.measuredAt < now - tonumber(ARGV[5]) or point.measuredAt > now + tonumber(ARGV[6]) then return 'stale_location' end
if point.sequence <= tonumber(redis.call('HGET', KEYS[1], 'lastSequence') or '0') or point.measuredAt <= tonumber(redis.call('HGET', KEYS[1], 'lastMeasuredAt') or '0') then return 'stale_location' end
-- Use the last accepted position, including across reconnects and live TTL
-- expiry. All checks precede GEO, high-water marks and location writes.
local previous = redis.call('GET', KEYS[5])
if previous then
  local p = cjson.decode(previous)
  local elapsed = math.max(0, point.measuredAt - p.measuredAt) / 1000
  local rad = math.pi / 180
  local dlat = (point.latitude - p.latitude) * rad
  local dlon = (point.longitude - p.longitude) * rad
  local a = math.sin(dlat / 2)^2 + math.cos(p.latitude * rad) * math.cos(point.latitude * rad) * math.sin(dlon / 2)^2
  local distance = 12742000 * math.asin(math.sqrt(math.min(1, math.max(0, a))))
  local allowance = tonumber(ARGV[9]) + math.min(100, p.accuracy or 0) + math.min(100, point.accuracy or 0)
  if distance > allowance + tonumber(ARGV[10]) * elapsed then return 'implausible_location' end
end
point.receivedAt = now
-- GEO never sees a rejected sample. Redis GEO cannot represent polar points;
-- retain their valid latest GPS but exclude them from nearby dispatch.
if math.abs(point.latitude) <= 85.05112878 then
  redis.call('GEOADD', KEYS[3], point.longitude, point.latitude, ARGV[7])
  redis.call('ZADD', KEYS[6], now + tonumber(ARGV[8]) * 1000, ARGV[7])
else redis.call('ZREM', KEYS[3], ARGV[7]); redis.call('ZREM', KEYS[6], ARGV[7]) end
redis.call('HSET', KEYS[1], 'lastSequence', point.sequence, 'lastMeasuredAt', point.measuredAt)
local expiry = redis.call('HGET', KEYS[1], 'backgroundExpiry')
if expiry then redis.call('EXPIREAT', KEYS[1], expiry)
else redis.call('EXPIRE', KEYS[1], ARGV[4]) end
redis.call('SET', KEYS[2], cjson.encode(point), 'EX', ARGV[3])
-- Last known position: outlives the live one so a closed app can still be woken by a push.
redis.call('SET', KEYS[4], cjson.encode(point), 'EX', ARGV[8])
-- Private abuse baseline survives logout; it is never returned to clients.
redis.call('SET', KEYS[5], cjson.encode({latitude=point.latitude, longitude=point.longitude,
  accuracy=point.accuracy, measuredAt=point.measuredAt}), 'EX', math.max(900, tonumber(ARGV[8])))
return 'accepted'`;
const touch = `
local current = redis.call('HGET', KEYS[1], 'sessionId')
if not current then return -1 end
if current ~= ARGV[1] or redis.call('HGET', KEYS[1], 'connected') ~= '1' then return 0 end
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[4])
return 1`;

const takeAction = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {hits, redis.call('PTTL', KEYS[1])}`;

// Compare freshness again inside Redis so lazy cleanup cannot delete a member
// whose new sample arrived after the caller observed an expired location.
const cleanGeo = `
local value = redis.call('GET', KEYS[1])
if value then
  local point = cjson.decode(value)
  if point.receivedAt >= tonumber(ARGV[2]) and point.measuredAt >= tonumber(ARGV[2]) then return 0 end
end
return redis.call('ZREM', KEYS[2], ARGV[1])`;
const release = `
if redis.call('HGET', KEYS[1], 'sessionId') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'connected', '0')
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
return 1`;

// Compare-and-swap: a delayed old phone cannot claim ownership from a newer
// device. Presence remains Socket presence, independent of location freshness.
const handoff = `
if redis.call('HGET', KEYS[1], 'sessionId') ~= ARGV[1] or redis.call('HGET', KEYS[1], 'connected') ~= '1' then return 0 end
local clock = redis.call('TIME')
redis.call('HSET', KEYS[1], 'sessionId', ARGV[2], 'lastSequence', '0', 'transport', 'background_https', 'backgroundExpiry', tonumber(clock[1]) + tonumber(ARGV[3]))
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('SET', KEYS[2], ARGV[4], 'EX', ARGV[5])
return 1`;
const renew = `
if redis.call('HGET', KEYS[1], 'sessionId') ~= ARGV[1] or redis.call('HGET', KEYS[1], 'connected') ~= '1' or redis.call('HGET', KEYS[1], 'transport') ~= 'background_https' then return 0 end
local clock = redis.call('TIME')
if tonumber(redis.call('HGET', KEYS[1], 'backgroundExpiry') or '0') <= tonumber(clock[1]) then return 0 end
redis.call('HSET', KEYS[1], 'backgroundExpiry', ARGV[2])
redis.call('EXPIREAT', KEYS[1], ARGV[2])
return 1`;
const invalidate = `
redis.call('HSET', KEYS[1], 'connected', '0')
redis.call('EXPIRE', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[2], KEYS[3], KEYS[4])
redis.call('ZREM', KEYS[5], ARGV[2])
redis.call('ZREM', KEYS[6], ARGV[2])
return 1`;
const clearLocation = `
redis.call('DEL', KEYS[1], KEYS[2])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('ZREM', KEYS[4], ARGV[1])
return 1`;

// The expiry index and GEO are changed in one Redis operation. A new sample
// cannot be removed by a sweep which observed its predecessor.
const sweepGeo = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local ids = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now, 'LIMIT', 0, ARGV[1])
for _, id in ipairs(ids) do
  redis.call('ZREM', KEYS[1], id)
  redis.call('ZREM', KEYS[2], id)
end
return #ids`;
const migrateGeo = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
for i = 2, #ARGV do
  local id = ARGV[i]
  if not redis.call('ZSCORE', KEYS[2], id) and redis.call('ZSCORE', KEYS[1], id) then
    local ttl = redis.call('PTTL', ARGV[1] .. 'last-known:' .. id)
    if ttl > 0 then redis.call('ZADD', KEYS[2], now + ttl, id)
    else redis.call('ZREM', KEYS[1], id) end
  end
end
return 1`;

export function createLocationStore(client, settings = config, prefix = "driver:") {
  let migrationCursor = '0';
  const sessionTtl = Math.max(settings.locationTtlSeconds, settings.presenceTtlSeconds);
  const geoKey = `${prefix}geo:drivers`;
  const geoExpiryKey = `${prefix}geo:expiry`;
  const keys = id => ({ session: `${prefix}tracking-session:${id}`, location: `${prefix}location:${id}`, lastKnown: `${prefix}last-known:${id}`, presence: `${prefix}presence:${id}`, plausibility: `${prefix}plausibility:${id}` });
  const presence = (sessionId, connected) => JSON.stringify({ sessionId, connected, lastSeenAt: Date.now() });
  const evaluate = async (script, keyList, args) => {
    if (!client.isReady) throw Object.assign(new Error("realtime_unavailable"), { code: "realtime_unavailable" });
    return client.eval(script, { keys: keyList, arguments: args.map(String) });
  };
  return {
    locationFreshMs: settings.locationFreshMs,
    keys,
    geoKey,
    geoExpiryKey,
    clearDriverLocation(id) {
      const k = keys(id);
      return evaluate(clearLocation, [k.location, k.lastKnown, geoKey, geoExpiryKey], [id]);
    },
    renewBackground: (id, sessionId, expiresAt) => evaluate(renew, [keys(id).session], [sessionId, expiresAt]),
    async sweepExpiredGeo(batchSize = 200) {
      const count = await evaluate(sweepGeo, [geoKey, geoExpiryKey], [Math.min(1000, Math.max(1, batchSize))]);
      // Bounded, idempotent migration of pre-expiry GEO entries; restarting the
      // cursor after a process restart is safe and never removes a newer sample.
      const [cursor, entries] = await client.sendCommand(['ZSCAN', geoKey, migrationCursor, 'COUNT', '100']);
      migrationCursor = cursor;
      const ids = entries.filter((_, i) => i % 2 === 0);
      if (ids.length) await evaluate(migrateGeo, [geoKey, geoExpiryKey], [prefix, ...ids]);
      return count;
    },
    async purgeDriver(id) {
      const k = keys(id);
      await evaluate(invalidate, [k.session, k.presence, k.lastKnown, k.location, geoKey, geoExpiryKey], [sessionTtl, id]);
      await client.del([k.session, k.plausibility]);
    },
    async takeActionLimit(action, accountId, max, windowMs) {
      const [hits, remainingMs] = await evaluate(takeAction,
        [`${prefix}action-limit:${action}:${accountId}`], [windowMs]);
      return { allowed: hits <= max, retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)) };
    },
    handoffBackground(id, previousId, sessionId, ttlSeconds) {
      const k = keys(id);
      return evaluate(handoff, [k.session, k.presence], [previousId, sessionId,
        Math.max(sessionTtl, ttlSeconds), presence(sessionId, false), settings.presenceTtlSeconds]);
    },
    invalidateDriver(id) {
      const k = keys(id);
      return evaluate(invalidate, [k.session, k.presence, k.lastKnown, k.location, geoKey, geoExpiryKey], [sessionTtl, id]);
    },
    async nearbyDrivers(pickup, radiusKm) {
      if (!client.isReady) throw new Error("realtime_unavailable");
      if (Math.abs(pickup.lat) > 85.05112878) return [];
      // Limit AFTER business/freshness checks; stale/ineligible members must not
      // crowd out the nearest N eligible drivers. No full-index scan.
      return client.sendCommand(["GEOSEARCH", geoKey, "FROMLONLAT",
        String(pickup.lng), String(pickup.lat), "BYRADIUS", String(radiusKm), "km", "ASC"]);
    },
    removeStaleGeoMember(id) {
      return evaluate(cleanGeo, [keys(id).location, geoKey], [id, Date.now() - settings.locationFreshMs]);
    },
    activateSession(id, sessionId) {
      const k = keys(id);
      return evaluate(activate, [k.session, k.presence, k.location], [sessionId, presence(sessionId, true), sessionTtl, settings.presenceTtlSeconds]);
    },
    saveLocation(id, point) {
      const k = keys(id);
      return evaluate(save, [k.session, k.location, geoKey, k.lastKnown, k.plausibility, geoExpiryKey], [point.sessionId, JSON.stringify(point), settings.locationTtlSeconds, sessionTtl, REALTIME.maxAgeMs, REALTIME.futureSkewMs, id,
        Math.max(settings.pushLocationMaxAgeSeconds ?? 0, settings.locationTtlSeconds),
        250, REALTIME.maxSpeed]);
    },
    touchPresence(id, sessionId) {
      const k = keys(id);
      return evaluate(touch, [k.session, k.presence], [sessionId, presence(sessionId, true), sessionTtl, settings.presenceTtlSeconds]);
    },
    releaseSession(id, sessionId) {
      const k = keys(id);
      return evaluate(release, [k.session, k.presence], [sessionId, presence(sessionId, false), settings.presenceTtlSeconds]);
    },
    async getLatestDriverLocation(id) {
      if (!client.isReady) throw new Error("realtime_unavailable");
      const value = await client.get(keys(id).location);
      if (!value) return { location: null, receivedAt: null, ageMs: null, fresh: false };
      const location = JSON.parse(value), ageMs = Math.max(0, Date.now() - location.receivedAt);
      return { location, receivedAt: location.receivedAt, ageMs,
        fresh: ageMs <= settings.locationFreshMs && Date.now() - location.measuredAt <= settings.locationFreshMs };
    },
    // The last position the phone reported, however old (up to PUSH_LOCATION_MAX_AGE_SECONDS). Only a push
    // wake-up may use it; an offer on screen still needs getLatestDriverLocation(...).fresh.
    async getLastKnownDriverLocation(id) {
      if (!client.isReady) throw new Error("realtime_unavailable");
      const value = await client.get(keys(id).lastKnown);
      if (!value) return { location: null, receivedAt: null, ageMs: null };
      const location = JSON.parse(value);
      return { location, receivedAt: location.receivedAt, ageMs: Math.max(0, Date.now() - location.receivedAt) };
    },
    async getDriverPresence(id) {
      if (!client.isReady) throw new Error("realtime_unavailable");
      const value = await client.get(keys(id).presence);
      return value ? JSON.parse(value) : { connected: false, lastSeenAt: null, sessionId: null };
    },
  };
}
export async function connectLocationStore() {
  if (!config.redisUrl) throw new Error("REDIS_URL is required");
  const client = createClient({ url: config.redisUrl, disableOfflineQueue: true,
    commandsQueueMaxLength: 1000, socket: { connectTimeout: 5000, reconnectStrategy: retries => Math.min(250 * (retries + 1), 3000) } });
  client.on("error", () => log("error", "redis_unavailable", { code: "realtime_unavailable" }));
  // Startup must fail promptly, rather than serving with an in-memory fallback.
  let timer;
  try {
    await Promise.race([client.connect(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Redis startup unavailable")), 6000);
    })]);
  } catch (error) { if (client.isOpen) client.destroy(); throw error; }
  finally { clearTimeout(timer); }
  const store = createLocationStore(client);
  let sweeping = false;
  const sweep = async () => {
    if (sweeping) return;
    sweeping = true;
    try { await store.sweepExpiredGeo(); } catch { log('error', 'geo_cleanup_failed', { code: 'realtime_unavailable' }); }
    finally { sweeping = false; }
  };
  await sweep();
  const sweepTimer = setInterval(() => { void sweep(); }, 10000); sweepTimer.unref();
  return { client, store, close: () => clearInterval(sweepTimer) };
}
