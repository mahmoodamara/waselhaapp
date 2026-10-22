// Read-only deployment diagnostics. Never load a developer .env or print URLs,
// credentials, raw provider errors, user records, coordinates or stack traces.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const requireBackend = createRequire(new URL('../backend/package.json', import.meta.url));
const knownCodes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET',
  'ETIMEDOUT', 'ENETUNREACH', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'MODULE_NOT_FOUND',
  'ETIMEOUT', 'ENODATA', 'ESERVFAIL', 'EREFUSED', 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR',
  'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE', 'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION',
  'ERR_SSL_UNEXPECTED_EOF_WHILE_READING', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY']);

export function safeFailure(error) {
  const messages = [];
  const codes = [];
  const queue = [error];
  const seen = new Set();
  let selectionFailure = false;
  // MongoDB stores lower-level failures in reason.servers, not just cause.
  // Traverse known error links only; never serialize the topology or map keys.
  for (let index = 0; index < queue.length && index < 32; index++) {
    const current = queue[index];
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    messages.push(String(current.message || ''));
    if (knownCodes.has(current.code) || Number.isSafeInteger(current.code)) codes.push(current.code);
    if (['MongoServerSelectionError', 'MongooseServerSelectionError'].includes(current.name)) selectionFailure = true;
    for (const link of [current.cause, current.reason, current.error]) if (link) queue.push(link);
    if (current.servers instanceof Map) {
      let count = 0;
      for (const server of current.servers.values()) {
        if (++count > 8) break;
        if (server?.error) queue.push(server.error);
      }
    }
    if (current instanceof AggregateError) queue.push(...current.errors.slice(0, 8));
  }
  const text = messages.join(' ');
  let reason = 'unknown';
  if (codes.includes(18) || /WRONGPASS|NOAUTH|Authentication failed/i.test(text)) reason = 'authentication';
  else if (codes.includes(13) || /not authorized|permission denied/i.test(text)) reason = 'authorization';
  else if (codes.some(code => /CERT|TLS|SSL|SIGNATURE/.test(String(code))) || /certificate/i.test(text)) reason = 'tls';
  else if (codes.some(code => ['ENOTFOUND', 'EAI_AGAIN', 'ETIMEOUT', 'ENODATA', 'ESERVFAIL', 'EREFUSED'].includes(code)) || /querySrv|queryTxt|getaddrinfo/i.test(text)) reason = 'dns';
  else if (codes.some(code => ['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH'].includes(code))) reason = 'network';
  else if (codes.includes('ETIMEDOUT') || error?.name === 'TimeoutError' || /timed? ?out|timeout/i.test(text)) reason = 'timeout';
  else if (codes.includes('MODULE_NOT_FOUND')) reason = 'missing_dependency';
  else if (selectionFailure) reason = 'server_selection';
  return { reason, codes: [...new Set(codes)] };
}

const emit = (phase, fields = {}) => console.log(JSON.stringify({
  time: new Date().toISOString(), event: 'render_diagnostic', phase, ...fields,
}));

export async function runDiagnostics() {
  const required = ['NODE_ENV', 'MONGODB_URI', 'REDIS_URL', 'JWT_SECRET', 'PUBLIC_BASE_URL', 'ROUTING_BASE_URL'];
  emit('environment', {
    node: process.version,
    protectedMode: ['production', 'staging'].includes(process.env.NODE_ENV),
    present: Object.fromEntries(required.map(key => [key, Boolean(process.env[key]?.trim())])),
    hostCorrect: (process.env.HOST || '0.0.0.0') === '0.0.0.0',
    portValid: /^[1-9][0-9]{0,4}$/.test(process.env.PORT || '') && Number(process.env.PORT) <= 65535,
    redisTlsConfigured: process.env.REDIS_URL?.startsWith('rediss://') === true,
  });
  // Refuse development-mode fallback, including accidental developer .env use.
  if (!['production', 'staging'].includes(process.env.NODE_ENV)) {
    emit('config', { ok: false, problems: ['NODE_ENV must be production or staging'] });
    return false;
  }
  let config;
  try {
    ({ config } = await import('../backend/src/config.js'));
    const { productionConfigProblems } = await import('../backend/src/services/startupChecks.js');
    const problems = productionConfigProblems(config);
    emit('config', { ok: problems.length === 0, problems });
    if (problems.length) return false;
  } catch (error) {
    emit('config', { ok: false, ...safeFailure(error) });
    return false;
  }
  const probes = {
    async mongo() {
      const { MongoClient } = requireBackend('mongoose').mongo;
      const client = new MongoClient(config.mongoUri, {
        serverSelectionTimeoutMS: 10000, connectTimeoutMS: 5000, socketTimeoutMS: 5000, maxPoolSize: 1,
      });
      try { await client.connect(); await client.db().command({ ping: 1 }); }
      finally { await client.close(); }
    },
    async redis() {
      const { createClient } = requireBackend('redis');
      const client = createClient({ url: config.redisUrl, disableOfflineQueue: true,
        socket: { connectTimeout: 5000, reconnectStrategy: false } });
      client.on('error', () => {});
      try {
        await client.connect();
        if (await client.ping() !== 'PONG') throw new Error('Invalid ping response');
      } finally { if (client.isOpen) client.destroy(); }
    },
    async routing() {
      const { getRouteDistance } = await import('../backend/src/services/routing.js');
      await getRouteDistance({ pickup: { lat: 32.7486911, lng: 35.3357268 },
        destination: { lat: 32.7356136, lng: 35.3437821 } });
    },
  };
  const results = await Promise.all(Object.entries(probes).map(async ([phase, probe]) => {
    const start = Date.now();
    emit(phase, { started: true });
    try { await probe(); emit(phase, { ok: true, elapsedMs: Date.now() - start }); return true; }
    catch (error) {
      emit(phase, { ok: false, elapsedMs: Date.now() - start, ...safeFailure(error) });
      return false;
    }
  }));
  emit('summary', { ok: results.every(Boolean), readOnly: true });
  return results.every(Boolean);
}

async function main() {
  const ok = await runDiagnostics();
  if (!['production', 'staging'].includes(process.env.NODE_ENV)) { process.exitCode = 1; return; }
  if (!process.argv.includes('--start')) { process.exitCode = ok ? 0 : 1; return; }
  // Preserve the application's own startup checks and behavior even if a probe
  // fails transiently. No guard, dependency or authentication fallback is added.
  emit('application_start', { diagnosticPassed: ok });
  try { await import('../backend/src/server.js'); }
  catch (error) { emit('application_start', { ok: false, ...safeFailure(error) }); process.exitCode = 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { emit('diagnostic_failed', { ok: false, ...safeFailure(error) }); process.exitCode = 1; });
}
