// Reproducible audit orchestration. Runs existing project scripts on audit-only services.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const out = path.join(root, '.verification/audit-2026-10-18', process.env.AUDIT_LOG_SUBDIR || '.');
await mkdir(out, { recursive: true });
const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const env = { ...process.env, NODE_ENV: 'test', TZ: 'Asia/Jerusalem',
  MONGODB_URI: 'mongodb://127.0.0.1:27118/waselha_audit_default_test',
  REDIS_URL: 'redis://127.0.0.1:6398', REDIS_TEST_URL: 'redis://127.0.0.1:6398',
  JWT_SECRET: 'audit-only-local-secret-2026-10-18', PUBLIC_BASE_URL: 'http://127.0.0.1:3108',
  PUSH_ENABLED: 'false', GOOGLE_ROUTES_ENABLED: 'false', GOOGLE_ROUTES_API_KEY: '',
  EXPO_PUSH_ACCESS_TOKEN: '', ROUTING_BASE_URL: '', MAPS_GEOCODER_URL: 'http://127.0.0.1:1',
  QUICK_DELIVERY_ENABLED: 'true', UNIFIED_DELIVERY_ENABLED: 'true',
  PYTHONIOENCODING: 'utf-8', NO_COLOR: '1',
  EXPO_NO_DOTENV: '1', EXPO_PUBLIC_API_URL: 'http://127.0.0.1:3108/api',
  GOOGLE_MAPS_ANDROID_API_KEY: 'audit-placeholder-no-network', GOOGLE_MAPS_IOS_API_KEY: 'audit-placeholder-no-network',
};
for (const name of ['SECURITY', 'WORKFLOW', 'PRIVACY', 'OFFERS', 'REALTIME', 'ROUTES', 'TRACKING', 'BACKGROUND', 'UI_FINANCE', 'TRACKING_UI'])
  env[`${name}_TEST_URI`] = `mongodb://127.0.0.1:27118/waselha_audit_${name.toLowerCase()}_test`;
const suites = [
  ['web', 'build'], ['web', 'test'], ['driver-app', 'test'],
  ...['test:workflow-v3','test:workflow','test:quick-delivery','test:dispatch-gate',
    'test:privacy','test:security','test:location','test:pricing-unit','test:finance',
    'test:eligibility','test:timeouts','test:route-pricing','test:audit','test:backup',
    'test:release-config','test:offers','test:push','test:routes','test:realtime',
    'test:tracking','test:background','test:ui-v3','test:tracking-ui','test:ui-finance']
    .map(s => ['backend', s]),
  ['driver-app', 'test:background-config'], ['driver-app', 'test:ui'],
  ['backend', 'test:proxy-privacy'],
  ['backend', 'documented-driver-current', ['--test','--test-concurrency=1','backend/test/delivery-verification.js','backend/test/quick-delivery.js','backend/test/privacy.js']],
  ['driver-app', 'export:android', null, ['--output-dir','../.verification/audit-2026-10-18/android']],
  ['driver-app', 'export:ios', null, ['--output-dir','../.verification/audit-2026-10-18/ios']],
];
const filters = process.argv.slice(2);
let failed = false;
let results = JSON.parse(await readFile(path.join(out, 'runs.json'), 'utf8').catch(() => '[]'));
if (!filters.length) {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const hashes = {};
  for (const file of files) {
    try { hashes[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex'); } catch {}
  }
  await writeFile(path.join(out, 'baseline-hashes.json'), JSON.stringify(hashes, null, 2));
}
for (const [pkg, script, raw, extra = []] of suites) {
  const id = `${pkg}-${script.replaceAll(':','-')}`;
  if (filters.length && !filters.includes(id)) continue;
  const args = ['--prefix', pkg, 'run', script, ...(extra.length ? ['--', ...extra] : [])];
  const command = raw ? `node ${raw.join(' ')}` : `npm.cmd ${args.join(' ')}`;
  const started = new Date().toISOString();
  process.stdout.write(`START ${id} ${started}\n`);
  const child = spawn(process.execPath, raw || [npm, ...args], { cwd: root, env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  let output = '';
  child.stdout.on('data', c => { output += c; });
  child.stderr.on('data', c => { output += c; });
  const code = await new Promise(resolve => { child.once('error', e => { output += e.message; resolve(-1); }); child.once('exit', resolve); });
  const finished = new Date().toISOString();
  if (code !== 0) failed = true;
  const counts = {};
  for (const field of ['tests','suites','pass','fail','cancelled','skipped','todo']) {
    const match = output.match(new RegExp(`(?:# |ℹ )${field} (\\d+)`));
    if (match) counts[field] = Number(match[1]);
  }
  const logfile = `${id}-${results.filter(r => r.id === id).length + 1}.log`;
  await writeFile(path.join(out, logfile), `Command: ${command}\nStarted UTC: ${started}\nFinished UTC: ${finished}\nTimezone: Asia/Jerusalem\nExit: ${code}\n\n${output}`);
  results.push({ id, command, started, finished, code, counts, logfile });
  await writeFile(path.join(out, 'runs.json'), JSON.stringify(results, null, 2));
  process.stdout.write(`END ${id} exit=${code} ${JSON.stringify(counts)} log=${logfile}\n`);
}
process.exitCode = failed ? 1 : 0;
