// Read-only deployment diagnostics. Never load a developer .env or print URLs,
// credentials, raw provider errors, user records, coordinates or stack traces.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const requireBackend = createRequire(new URL('../backend/package.json', import.meta.url));
const knownCodes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET',
  'ETIMEDOUT', 'ENETUNREACH', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'MODULE_NOT_FOUND']);

export function safeFailure(error) {
  const messages = [];
  const codes = [];
  let current = error;
  for (let depth = 0; current && depth < 5; depth++, current = current.cause) {
    messages.push(String(current.message || ''));
    if (knownCodes.has(current.code) || Number.isSafeInteger(current.code)) codes.push(current.code);
  }
  const text = messages.join(' ');
  let reason = 'unknown';
  if (codes.includes(18) || /WRONGPASS|NOAUTH|Authentication failed/i.test(text)) reason = 'authentication';
  else if (codes.includes(13) || /not authorized|permission denied/i.test(text)) reason = 'authorization';
  else if (codes.some(code => /CERT|TLS|SIGNATURE/.test(String(code))) || /certificate/i.test(text)) reason = 'tls';
  else if (codes.some(code => ['ENOTFOUND', 'EAI_AGAIN'].includes(code))) reason = 'dns';
  else if (error?.name === 'TimeoutError' || /timed? ?out|timeout/i.test(text)) reason = 'timeout';
  else if (codes.some(code => ['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH'].includes(code))) reason = 'network';
  else if (codes.includes('MODULE_NOT_FOUND')) reason = 'missing_dependency';
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
