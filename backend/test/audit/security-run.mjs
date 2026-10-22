// Local-only follow-up audit. No application/config/dependency mutations.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const out = path.join(root, '.verification/security-audit-2026-10-18');
await mkdir(out, { recursive: true });
const mode = process.argv[2] || 'existing';
const env = { ...process.env, NODE_ENV:'test', TZ:'Asia/Jerusalem', NO_COLOR:'1',
 MONGODB_URI:'mongodb://127.0.0.1:27118/waselha_security_default_test',
 REDIS_URL:'redis://127.0.0.1:6398', REDIS_TEST_URL:'redis://127.0.0.1:6398',
 JWT_SECRET:'audit-only-local-session-secret', TEXTME_ENABLED:'false', TEXTME_API_TOKEN:'', TEXTME_USERNAME:'', TEXTME_SOURCE:'',
 PUSH_ENABLED:'false', GOOGLE_ROUTES_ENABLED:'false', GOOGLE_ROUTES_API_KEY:'', EXPO_PUSH_ACCESS_TOKEN:'',
 MAPS_GEOCODER_URL:'http://127.0.0.1:1', PUBLIC_BASE_URL:'http://127.0.0.1:3108',
 QUICK_DELIVERY_ENABLED:'true', UNIFIED_DELIVERY_ENABLED:'true', TRUST_PROXY:'false', SECURITY_CAPTURE_LOGS:'true',
 EXPO_NO_DOTENV:'1', PYTHONIOENCODING:'utf-8', AUDIT_LOG_SUBDIR:'../../security-audit-2026-10-18/existing' };
for(const name of ['SECURITY','WORKFLOW','PRIVACY','OFFERS','REALTIME','ROUTES','TRACKING','BACKGROUND','UI_FINANCE','TRACKING_UI','SMS','SMS_UI'])
 env[`${name}_TEST_URI`] = `mongodb://127.0.0.1:27118/waselha_security_${mode === 'new' ? 'new_' : ''}${name.toLowerCase()}_test`;
env.SECURITY_BROWSER_TEST_URI='mongodb://127.0.0.1:27118/waselha_security_browser_test';
export function redact(s) { return s.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[REDACTED_JWT]')
 .replace(/\b0(?:50|52|54|58)[ -]?\d{3}[ -]?\d{4}\b/g,'[REDACTED_FIXTURE_PHONE]')
 .replace(/\b[a-f0-9]{48}\b/gi,'[REDACTED_LINK]').replace(/WaselhaDemo123!|OtherStore123!|access-security-test-secret|audit-only-local-session-secret/g,'[REDACTED_FIXTURE_CREDENTIAL]')
 .replace(/(password\s*[:=]\s*)[^\s,]+/gi,'$1[REDACTED]').replace(/(license[^\r\n]*?)([A-Z0-9]{5}-){2,}[A-Z0-9-]+/gi,'$1[REDACTED]'); }
const manifestPath=path.join(out,'runs.json');
let results=JSON.parse(await readFile(manifestPath,'utf8').catch(()=> '[]'));
let failed=false;
async function run(id,args,cwd=root) {
 const started=new Date().toISOString(); console.log(`START ${id} ${started}`);
 const child=spawn(process.execPath,args,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 let output=''; child.stdout.on('data',c=>output+=c); child.stderr.on('data',c=>output+=c);
 const code=await new Promise(resolve=>{child.once('error',()=>resolve(-1));child.once('exit',resolve);});
 if(code!==0)failed=true;
 const finished=new Date().toISOString(), counts={};
 for(const f of ['tests','suites','pass','fail','cancelled','skipped','todo']) { const m=output.match(new RegExp(`(?:# |ℹ )${f} (\\d+)`)); if(m) counts[f]=+m[1]; }
 results=JSON.parse(await readFile(manifestPath,'utf8').catch(()=> '[]'));
 const logfile=`${id}-${results.filter(r=>r.id===id).length+1}.log`;
 const command=`node ${args.map(a=>a.includes(' ')?JSON.stringify(a):a).join(' ')}`;
 await writeFile(path.join(out,logfile),redact(`Command: ${command}\nStarted UTC: ${started}\nFinished UTC: ${finished}\nTimezone: Asia/Jerusalem\nExit: ${code}\n${output}`));
 results.push({id,command,started,finished,code,counts,logfile}); await writeFile(manifestPath,JSON.stringify(results,null,2));
 console.log(`END ${id} exit=${code} ${JSON.stringify(counts)} log=${logfile}`); return code;
}
if(mode==='baseline') {
 const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
 const hashes={}; for(const f of files) try {hashes[f]=createHash('sha256').update(await readFile(path.join(root,f))).digest('hex');}catch{}
 await writeFile(path.join(out,'baseline-hashes.json'),JSON.stringify(hashes,null,2));
 await writeFile(path.join(out,'baseline-status.txt'),execFileSync('git',['status','--short'],{cwd:root,encoding:'utf8'}));
 console.log('Baseline recorded');
} else if(mode==='existing') {
 const suites=['auth-security','customer-links','privacy','delivery-verification','audit-fixes','release-config','log-redaction','realtime-origins','realtime-validation','realtime-integration','customer-tracking','background-location','finance','driver-eligibility','location','workflow-v3','dispatch-gate','nearby-offers','order-sms','textme','customer-simple'];
 await run('existing-backend',['--test','--test-concurrency=1',...suites.map(f=>`backend/test/${f}.js`)]);
 await run('existing-web',['--test',...execFileSync('git',['ls-files','--cached','--others','--exclude-standard','web/test'],{cwd:root,encoding:'utf8'}).trim().split(/\r?\n/).filter(f=>f.endsWith('.test.js'))]);
 const npm=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
 await run('existing-driver',[npm,'--prefix','driver-app','run','test']);
} else if(mode==='new') {
 await run('security-http',['--test','--test-concurrency=1','backend/test/audit/security-http.mjs']);
 await run('security-socket',['--test','--test-concurrency=1','backend/test/audit/security-socket.mjs']);
 await run('security-release',['--test','backend/test/audit/security-release.mjs']);
 await run('security-controls',['--test','backend/test/audit/security-controls.mjs']);
} else if(mode==='sms') {
 await run('existing-sms',['--test','--test-concurrency=1','backend/test/order-sms.js']);
} else if(mode==='browser') {
 const npm=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
 await run('web-build',[npm,'--prefix','web','run','build']);
 await run('security-browser',['backend/test/audit/security-ui.mjs']);
} else if(mode==='supplemental') {
 await run('existing-workflow',['backend/test/workflow.js']);
} else if(mode==='deps') {
 const npm=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
 for(const pkg of ['backend','web','driver-app']) await run(`npm-audit-${pkg}`,['--use-system-ca',npm,'audit','--json','--ignore-scripts','--package-lock-only','--no-fund','--fetch-retries=0','--fetch-timeout=20000'],path.join(root,pkg));
} else throw new Error('Unknown audit mode');
process.exitCode=failed?1:0;
