import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { safeFailure } from './diagnose-render.mjs';

test('provider errors expose classification without raw credentials or personal data', () => {
  const privateText = 'mongodb://private-user:private-password@private-host/private-db phone=0501234567';
  const error = Object.assign(new Error('Authentication failed ' + privateText), { code: 18 });
  assert.deepEqual(safeFailure(error), { reason: 'authentication', codes: [18] });
  assert.ok(!JSON.stringify(safeFailure(error)).includes('private-'));
});

test('nested DNS error retains its useful code but drops private host and message', () => {
  const cause = Object.assign(new Error('getaddrinfo ENOTFOUND private-host'), { code: 'ENOTFOUND' });
  assert.deepEqual(safeFailure(new Error('provider failed', { cause })), { reason: 'dns', codes: ['ENOTFOUND'] });
});

test('unrecognized provider codes and messages cannot enter diagnostic output', () => {
  const error = Object.assign(new Error('private-password'), { code: 'private-token' });
  assert.deepEqual(safeFailure(error), { reason: 'unknown', codes: [] });
});

test('MongoDB topology errors retain a nested TCP failure without server addresses', () => {
  const tcp = Object.assign(new Error('connect ECONNREFUSED private-host'), { code: 'ECONNREFUSED' });
  const selection = Object.assign(new Error('Server selection timed out'), {
    name: 'MongoServerSelectionError',
    reason: { servers: new Map([['private-host:27017', { error: new Error('private-db', { cause: tcp }) }]]) },
  });
  assert.deepEqual(safeFailure(selection), { reason: 'network', codes: ['ECONNREFUSED'] });
});

test('MongoDB topology TLS alert is classified without exposing OpenSSL text or hostnames', () => {
  const tls = Object.assign(new Error('private-host: SSL routines alert'), { code: 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR' });
  const selection = Object.assign(new Error('Server selection timed out'), {
    name: 'MongooseServerSelectionError',
    reason: { servers: new Map([['private-host:27017', { error: new Error('private-db', { cause: tls }) }]]) },
  });
  assert.deepEqual(safeFailure(selection), { reason: 'tls', codes: ['ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR'] });
});

test('a cyclic topology without lower-level details still identifies server selection', () => {
  const error = Object.assign(new Error('private-cluster'), { name: 'MongoServerSelectionError' });
  error.reason = { servers: new Map([['private-host:27017', { error }]]) };
  assert.deepEqual(safeFailure(error), { reason: 'server_selection', codes: [] });
});

test('diagnostics refuse development mode before loading a local environment or contacting dependencies', () => {
  for (const args of [[], ['--start']]) {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./diagnose-render.mjs', import.meta.url)), ...args], {
    env: { ...process.env, NODE_ENV: 'development', MONGODB_URI: 'private-fixture', REDIS_URL: 'private-fixture',
      JWT_SECRET: 'private-fixture', PUBLIC_BASE_URL: 'private-fixture', ROUTING_BASE_URL: 'private-fixture' },
    encoding: 'utf8', windowsHide: true, timeout: 5000,
  });
  assert.equal(child.status, 1);
  const events = child.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.phase), ['environment', 'config']);
  assert.equal(events[0].present.JWT_SECRET, true);
  assert.ok(!child.stdout.includes('private-fixture'));
  assert.ok(!child.stdout.includes('"phase":"mongo"'));
  }
});
