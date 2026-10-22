// Opt-in integration test of the production compose on alternate loopback ports.
// Owns a unique compose project, volume and empty MongoDB *_test database only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createServer } from 'node:net';

assert.equal(process.env.RUN_PRODUCTION_INFRA_TEST, '1', 'Explicit RUN_PRODUCTION_INFRA_TEST=1 required');
assert.ok(process.env.LIVE_INFRA_OSRM_DATA_DIR && process.env.OSRM_RELEASE, 'Prepare a test OSRM release first');
const mongo = new URL(process.env.LIVE_INFRA_MONGODB_URI || 'mongodb://127.0.0.1:27017/');
assert.equal(mongo.hostname, '127.0.0.1', 'Only a local test database is permitted');
const id = randomUUID().replaceAll('-', '');
mongo.pathname = `/waselha_infra_${id}_test`;
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = new URL(`../../.verification/production-infra/${id}/`, import.meta.url);
await mkdir(output, { recursive: true });
const override = new URL('ports.yaml', output);
await writeFile(override, 'services:\n  redis:\n    ports: !override ["127.0.0.1:16379:6379"]\n  osrm:\n    ports: !override ["127.0.0.1:15000:5000"]\n');
const secret = randomBytes(32).toString('hex');
const env = { ...process.env, REDIS_PASSWORD: secret, OSRM_DATA_DIR: process.env.LIVE_INFRA_OSRM_DATA_DIR };
const args = ['compose', '--project-directory', root, '-p', `waselha-infra-test-${id}`, '-f', 'docker-compose.production.yml', '-f', fileURLToPath(override)];
async function docker(extra, compose = true) {
  const child = spawn('docker', [...(compose ? args : []), ...extra], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const [code] = await once(child, 'exit');
  // Never include raw Docker output in errors: inspect/config contain credentials.
  assert.equal(code, 0, `Docker ${extra[0]} failed (details withheld to protect environment credentials)`);
  return stdout;
}
async function eventually(check, timeout = 30000) {
  const until = Date.now() + timeout;
  do { try { if (await check()) return; } catch {} await new Promise(r => setTimeout(r, 200)); } while (Date.now() < until);
  throw new Error('Dependency failed to recover before deadline');
}
// Refuse to interfere with occupied ports; do not stop existing local services.
for (const port of [16379, 15000]) {
  const probe = createServer().listen(port, '127.0.0.1');
  await once(probe, 'listening'); await new Promise(r => probe.close(r));
}
Object.assign(process.env, {
  NODE_ENV: 'test', MONGODB_URI: mongo.href, JWT_SECRET: randomBytes(32).toString('hex'),
  REDIS_URL: `redis://:${secret}@127.0.0.1:16379`, ROUTING_BASE_URL: 'http://127.0.0.1:15000',
  ROUTING_TIMEOUT_MS: '1000', PUBLIC_BASE_URL: 'http://127.0.0.1:3109',
  TEXTME_ENABLED: 'false', TEXTME_API_TOKEN: '', PUSH_ENABLED: 'false', GOOGLE_ROUTES_ENABLED: 'false',
  GOOGLE_ROUTES_API_KEY: '', REALTIME_ALLOWED_ORIGINS: '', UNIFIED_DELIVERY_ENABLED: 'true',
});
const report = { at: new Date().toISOString(), scope: 'local isolated production compose; not deployment evidence', checks: {} };
let connection, app, db, unauth;
try {
  await docker(['up', '-d', '--wait', '--wait-timeout', '120']);
  const { createClient } = await import('redis');
  unauth = createClient({ url: 'redis://127.0.0.1:16379', disableOfflineQueue: true, socket: { reconnectStrategy: false } });
  unauth.on('error', () => {});
  // node-redis negotiates RESP with HELLO during connect; auth is required there.
  await assert.rejects(unauth.connect(), /NOAUTH/);
  if (unauth.isOpen) unauth.destroy();
  assert.match(await docker(['exec', '-T', 'redis', 'redis-cli', 'ping']), /NOAUTH/);
  const wrong = createClient({ url: 'redis://:wrong@127.0.0.1:16379', socket: { reconnectStrategy: false } });
  wrong.on('error', () => {});
  await assert.rejects(wrong.connect(), /WRONGPASS/);
  if (wrong.isOpen) wrong.destroy();
  report.checks.authentication = 'PASS: unauthenticated and incorrect password rejected';
  const { connectLocationStore } = await import('../src/services/locationStore.js');
  connection = await connectLocationStore();
  assert.equal(await connection.client.ping(), 'PONG');
  await connection.client.set('infra:persistence', id);
  await connection.client.set('infra:expired', 'ephemeral', { EX: 1 });
  report.checks.backendRedis = 'PASS: production connection factory';
  for (const [name, port] of [['redis', '6379'], ['osrm', '5000']]) {
    const container = (await docker(['ps', '-q', name])).trim();
    const inspection = JSON.parse(await docker(['inspect', container], false))[0];
    const published = inspection.HostConfig.PortBindings[`${port}/tcp`];
    assert.deepEqual(published.map(p => p.HostIp), ['127.0.0.1']);
    assert.deepEqual(inspection.NetworkSettings.Ports[`${port}/tcp`].map(p => p.HostIp), ['127.0.0.1']);
    assert.equal(inspection.HostConfig.RestartPolicy.Name, 'unless-stopped');
    assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
    assert.equal(inspection.State.Health.Status, 'healthy');
    assert.ok(!inspection.Config.Cmd.join(' ').includes(secret));
  }
  report.checks.runtimeSecurity = 'PASS: loopback bindings, non-root read-only containers, restart policies and healthchecks';
  const { getRouteDistance, routingHealth } = await import('../src/services/routing.js');
  const points = JSON.parse(await readFile(new URL('../../infra/osrm/pilot-points.json', import.meta.url), 'utf8')).points;
  async function routes() {
    for (const [a, b] of [[0, 5], [5, 2], [2, 11]]) {
      const pickup = points[a], destination = points[b];
      const response = await fetch(`${process.env.ROUTING_BASE_URL}/route/v1/driving/${pickup.lng},${pickup.lat};${destination.lng},${destination.lat}?overview=false`, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.code, 'Ok');
      assert.ok(data.routes[0].distance > 0 && data.routes[0].duration > 0);
      const backend = await getRouteDistance({ pickup, destination });
      assert.equal(backend.distanceMeters, Math.round(data.routes[0].distance));
    }
  }
  await routes();
  report.checks.backendRouting = 'PASS: three public road pairs via direct OSRM and backend adapter';
  const models = await import('../src/models/index.js');
  db = (await import('mongoose')).default;
  await models.connectDatabase();
  assert.equal(await models.User.countDocuments(), 0);
  await models.Order.init();
  const { createApp } = await import('../src/app.js');
  app = createApp({ locationStore: connection.store, redis: connection.client }).listen(0, '127.0.0.1');
  await once(app, 'listening');
  const base = `http://127.0.0.1:${app.address().port}`;
  const ready = async () => (await fetch(`${base}/api/ready`)).json();
  assert.equal((await ready()).redis, true);
  assert.equal((await ready()).routing, 'ok');
  // One synthetic order through real application HTTP and the live OSRM graph.
  const bcrypt = (await import('bcryptjs')).default;
  const point = p => ({ lat: p.lat, lng: p.lng, address: p.label, source: 'pin' });
  await models.User.create({ login: 'infra-store', role: 'store', active: true, name: 'Isolated test', storeName: 'Isolated test', pickupServiceArea: 'kafr-kanna', pickupAddress: 'Public road', pickupLocation: { ...point(points[5]), confirmedAt: new Date() }, passwordHash: await bcrypt.hash(randomBytes(32).toString('hex'), 10) });
  const user = await models.User.findOne({ login: 'infra-store' });
  const jwt = (await import('jsonwebtoken')).default;
  const token = jwt.sign({ ver: user.authVersion ?? 0 }, process.env.JWT_SECRET, { subject: String(user._id), expiresIn: '5m' });
  const request = async (path, body, expected, auth = false) => {
    const response = await fetch(`${base}/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-waselha-workflow': '3', ...(auth ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const data = await response.json();
    assert.equal(response.status, expected, `Test HTTP status; error code: ${data.code || 'none'}`);
    return data;
  };
  const order = await request('/orders', { workflowVersion: 3, storeAuthorization: true, customerPhone: '0500000000', vehicleType: 'car', parcelSize: 'medium', parcelReady: true, goodsAmountAgorot: 10000, goodsPaymentStatus: 'unpaid', deliveryFeePaidBy: 'customer' }, 201, true);
  const priced = await request(`/customer/${order.customerLink.split('/').at(-1)}/location`, point(points[2]), 200);
  assert.equal(priced.priceStatus, 'final');
  const savedOrder = await models.Order.findById(order._id).lean();
  assert.equal(savedOrder.routeProvider, 'osrm');
  assert.equal(savedOrder.routeDistanceMeters, (await getRouteDistance({ pickup: points[5], destination: points[2] })).distanceMeters);
  report.checks.applicationRoute = 'PASS: isolated order priced through real HTTP and OSRM';
  await docker(['stop', 'redis']);
  await eventually(() => !connection.client.isReady);
  const unavailable = await ready();
  assert.equal(unavailable.redis, false); assert.equal(unavailable.ok, false);
  await docker(['start', 'redis']);
  await eventually(async () => connection.client.isReady && await connection.client.ping() === 'PONG');
  assert.equal(await connection.client.get('infra:persistence'), id);
  assert.equal(await connection.client.get('infra:expired'), null);
  assert.equal((await ready()).redis, true);
  await docker(['restart', 'redis']);
  await eventually(async () => connection.client.isReady && await connection.client.get('infra:persistence') === id);
  report.checks.redisRecovery = 'PASS: same backend connection recovers after stop/start and restart; AOF persists; expired state stays expired';
  await docker(['stop', 'osrm']);
  assert.equal(await routingHealth(Date.now() + 60000), 'unreachable');
  await assert.rejects(getRouteDistance({ pickup: points[5], destination: points[2] }));
  await docker(['start', 'osrm']);
  await eventually(async () => { await getRouteDistance({ pickup: points[5], destination: points[2] }); return true; });
  assert.equal(await routingHealth(Date.now() + 120000), 'ok');
  await docker(['restart', 'osrm']);
  await eventually(async () => { await routes(); return true; });
  report.checks.osrmRecovery = 'PASS: backend adapter and routing health recover without backend restart';
  await docker(['down']);
  await docker(['up', '-d', '--wait', '--wait-timeout', '120']);
  await eventually(async () => connection.client.isReady && await connection.client.get('infra:persistence') === id);
  await routes();
  assert.equal((await ready()).redis, true);
  report.checks.recreation = 'PASS: down/up preserves Redis AOF and OSRM release; same backend remains running';
  const logs = await docker(['logs', '--no-color', 'redis', 'osrm']);
  assert.ok(!logs.includes(secret), 'Generated credential must not occur in service logs');
  console.log(JSON.stringify(report, null, 2));
  await writeFile(new URL('results.json', output), JSON.stringify(report, null, 2));
} finally {
  if (app) { app.closeAllConnections(); await new Promise(r => app.close(r)); }
  connection?.close();
  if (connection?.client.isOpen) connection.client.destroy();
  if (unauth?.isOpen) unauth.destroy();
  if (db?.connection.readyState === 1) { await db.connection.dropDatabase(); await db.disconnect(); }
  // This generated project and its disposable volume belong only to this test.
  await docker(['down', '--volumes']);
}
