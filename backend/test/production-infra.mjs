// Configuration/operational unit checks; no daemon, database or real secrets needed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const compose = ['compose', '--project-directory', root, '-f', 'docker-compose.production.yml'];
const env = { ...process.env, REDIS_PASSWORD: 'a'.repeat(64), OSRM_DATA_DIR: '/opt/waselha/osrm-data', OSRM_RELEASE: 'test-release' };
test('production compose restricts ports, persists Redis and serves immutable MLD data', () => {
  const result = spawnSync('docker', [...compose, 'config', '--format', 'json'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const { services, networks, volumes } = JSON.parse(result.stdout);
  for (const [name, port] of [['redis', 6379], ['osrm', 5000]]) {
    const service = services[name];
    assert.deepEqual(service.ports.map(p => [p.host_ip, String(p.published), p.target]), [['127.0.0.1', String(port), port]]);
    assert.equal(service.restart, 'unless-stopped');
    assert.equal(service.read_only, true);
    assert.deepEqual(service.cap_drop, ['ALL']);
    assert.ok(service.user && service.user !== '0');
    assert.ok(service.healthcheck.test.length);
    assert.ok(service.security_opt.includes('no-new-privileges:true'));
    assert.equal(service.privileged, undefined);
    assert.equal(service.network_mode, undefined);
  }
  assert.equal(networks.services.driver, 'bridge');
  assert.equal(networks.services.driver_opts['com.docker.network.bridge.host_binding_ipv4'], '127.0.0.1');
  assert.ok(volumes.redis_data);
  assert.ok(services.redis.volumes.some(v => v.type === 'volume' && v.target === '/data'));
  assert.ok(services.osrm.volumes.some(v => v.target === '/data' && v.read_only && v.source.endsWith('/releases/test-release')));
  assert.deepEqual(services.osrm.command.slice(0, 3), ['osrm-routed', '--algorithm', 'mld']);
  assert.match(services.redis.image, /redis:7\.4\.11-alpine@sha256:/);
  assert.ok(!JSON.stringify(services.redis.command).includes(env.REDIS_PASSWORD));
});
test('production compose refuses missing deployment inputs', () => {
  for (const key of ['REDIS_PASSWORD', 'OSRM_DATA_DIR', 'OSRM_RELEASE']) {
    const result = spawnSync('docker', [...compose, 'config', '--quiet'], { cwd: root, env: { ...env, [key]: '' }, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(key));
    assert.ok(!result.stderr.includes(env.REDIS_PASSWORD));
  }
});
test('development compose remains without production authentication or storage requirements', () => {
  const result = spawnSync('docker', ['compose', '-f', 'infra/redis/compose.yaml', 'config', '--format', 'json'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const redis = JSON.parse(result.stdout).services.redis;
  assert.ok(redis.command.includes('no'));
  assert.equal(redis.environment?.REDIS_PASSWORD, undefined);
});
test('production scripts are checked out with Linux line endings', () => {
  for (const file of ['scripts/setup-osrm.sh', 'infra/osrm/healthcheck.sh', 'infra/redis/start-production.sh']) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    assert.ok(!source.includes('\r'), file);
  }
});
const bash = process.env.BASH_EXE || (process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe') : 'bash');
test('Redis refuses missing, weak and unsafe passwords without disclosing them', () => {
  for (const password of ['', 'a'.repeat(32), 'synthetic-password-should-never-be-printed', 'a'.repeat(63) + '"']) {
    const result = spawnSync(bash, ['infra/redis/start-production.sh'], { cwd: root, env: { ...process.env, REDIS_PASSWORD: password }, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /64 random hexadecimal characters/);
    if (password) assert.ok(!`${result.stdout}${result.stderr}`.includes(password));
  }
});
test('OSRM setup refuses missing data and unsafe release paths before invoking Docker', () => {
  const result = spawnSync(bash, ['scripts/setup-osrm.sh', '/missing.osm.pbf', '../active'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /nonempty .osm.pbf/);
});
test('production routing accepts host loopback without relaxing remote HTTP validation', () => {
  for (const [url, allowed] of [
    ['http://127.0.0.1:5000', true], ['https://routing.waselhe.app', true],
    ['http://osrm:5000', false], ['http://remote.example.com:5000', false],
    ['http://127.0.0.1:5000?token=bad', false], ['http://user:bad@127.0.0.1:5000', false],
  ]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', 'import "./src/config.js"'], {
      cwd: new URL('../', import.meta.url), encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'production', ROUTING_BASE_URL: url, REALTIME_ALLOWED_ORIGINS: '' },
    });
    assert.equal(result.status, allowed ? 0 : 1, url);
    if (!allowed) assert.match(result.stderr, /ROUTING_BASE_URL/);
  }
});
