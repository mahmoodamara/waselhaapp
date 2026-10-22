// Integration check: real graph/image, Render-like resource limits, no credentials.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const docker = process.env.DOCKER_BIN || 'docker';
const image = process.env.OSRM_RENDER_TEST_IMAGE || 'waselha-osrm-render:test';
const name = 'waselha-osrm-check-' + randomUUID().slice(0, 8);
const output = path.resolve(root, process.env.OSRM_RENDER_EVIDENCE || '.verification/osrm-render-2026-10-22');
const dc = (...args) => execFileSync(docker, args, { encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const pairs = [
  '35.3357268,32.7486911;35.3437821,32.7356136',
  '35.3268524,32.7370844;35.3357268,32.7486911',
  '35.3437821,32.7356136;35.3508228,32.7475921',
];
const routePath = coordinates => '/route/v1/driving/' + coordinates + '?overview=false&steps=false&alternatives=false';
const result = { at: new Date().toISOString(), image, limits: { memoryMiB: 512, cpus: 0.1, swapMiB: 0 }, checks: {} };
let created = false;
try {
  const invalid = spawnSync(docker, ['run', '--rm', '--network', 'none', '-e', 'PORT=invalid', image], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /PORT must be an integer/);
  result.checks.invalidPortRejected = true;
  dc('run', '-d', '--name', name, '--memory', '512m', '--memory-swap', '512m', '--cpus', '0.1',
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '-p', '127.0.0.1::10000', image);
  created = true;
  const binding = dc('port', name, '10000/tcp');
  assert.match(binding, /^127\.0\.0\.1:\d+$/);
  const origin = 'http://' + binding;
  const coldStart = Date.now();
  let ready = false;
  while (Date.now() - coldStart < 120000) {
    const state = JSON.parse(dc('inspect', '--format', '{{json .State}}', name));
    assert.equal(state.Running, true, 'Routing image must remain running');
    assert.equal(state.OOMKilled, false);
    try {
      const response = await fetch(origin + routePath(pairs[0]), { signal: AbortSignal.timeout(3000) });
      if (response.ok && (await response.json()).code === 'Ok') { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(ready, true, 'Image must serve a real route within 120 seconds under the memory/CPU cap');
  result.coldStartMs = Date.now() - coldStart;
  result.checks.coldStart = true;
  const routes = [];
  for (const pair of pairs) {
    const response = await fetch(origin + routePath(pair), { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.code, 'Ok');
    assert.ok(body.routes[0].distance > 0 && body.routes[0].duration > 0);
    routes.push({ distanceMeters: body.routes[0].distance, durationSeconds: body.routes[0].duration });
  }
  result.checks.realRoutes = routes;
  const timings = [];
  for (let i = 0; i < 12; i++) {
    const start = performance.now();
    const response = await fetch(origin + routePath(pairs[i % pairs.length]), { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    timings.push(Math.round(performance.now() - start));
  }
  const parallelStart = performance.now();
  await Promise.all(Array.from({ length: 4 }, async (_, i) => {
    const response = await fetch(origin + routePath(pairs[i % pairs.length]), { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }));
  result.fourRequestsMs = Math.round(performance.now() - parallelStart);
  result.sequentialTimingsMs = timings;
  const tooMany = await fetch(origin + routePath(pairs[0] + ';35.3508228,32.7475921;35.3268524,32.7370844'), { signal: AbortSignal.timeout(5000) });
  assert.equal(tooMany.status, 400);
  result.checks.oversizedRouteRejected = true;
  const invalidRoute = await fetch(origin + '/route/v1/driving/not-coordinates', { signal: AbortSignal.timeout(5000) });
  assert.equal(invalidRoute.status, 400);
  result.checks.invalidRouteRejected = true;
  dc('exec', name, 'bash', '/opt/waselha/healthcheck-render.sh');
  result.checks.actualHealthcheck = true;
  const backend = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import {getRouteDistance} from './backend/src/services/routing.js';
    const result = await getRouteDistance({pickup:{lat:32.7486911,lng:35.3357268},destination:{lat:32.7356136,lng:35.3437821}});
    if(result.provider !== 'osrm' || !Number.isSafeInteger(result.distanceMeters) || result.distanceMeters <= 0) process.exitCode = 1;
    console.log(JSON.stringify(result));
  `], { cwd: root, env: { ...process.env, NODE_ENV: 'production', ROUTING_BASE_URL: origin }, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(backend.status, 0, 'Existing backend routing adapter must accept the real response');
  result.checks.backendAdapter = JSON.parse(backend.stdout.trim());
  result.memoryCurrentBytes = Number(dc('exec', name, 'cat', '/sys/fs/cgroup/memory.current'));
  result.memoryPeakBytes = Number(dc('exec', name, 'cat', '/sys/fs/cgroup/memory.peak'));
  assert.ok(result.memoryPeakBytes <= 512 * 1024 * 1024);
  const user = dc('inspect', '--format', '{{.Config.User}}', name);
  assert.equal(user, '65534:65534');
  result.checks.nonRoot = true;
  const logRead = spawnSync(docker, ['logs', name], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(logRead.status, 0);
  const logs = logRead.stdout + logRead.stderr;
  assert.ok(!pairs.some(pair => logs.includes(pair)) && !logs.includes('GET /route/'));
  result.checks.noRequestCoordinatesInLogs = true;
  dc('stop', '--time', '10', name);
  const finalState = JSON.parse(dc('inspect', '--format', '{{json .State}}', name));
  assert.equal(finalState.OOMKilled, false);
  assert.ok([0, 143].includes(finalState.ExitCode));
  result.checks.shutdown = true;
  result.status = 'PASS';
} catch (error) {
  result.status = 'FAIL';
  result.failure = error.message.slice(0, 700);
  process.exitCode = 1;
} finally {
  if (created) {
    if (result.status === 'FAIL') {
      const logs = spawnSync(docker, ['logs', '--tail', '12', name], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
      result.failureLogs = (logs.stdout + logs.stderr).slice(0, 2000);
    }
    const state = spawnSync(docker, ['inspect', '--format', '{{json .State}}', name], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (state.status === 0) result.finalState = JSON.parse(state.stdout);
    spawnSync(docker, ['rm', '-f', name], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  }
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, 'runtime-verification.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
