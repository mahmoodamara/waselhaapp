import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const out=root+'.verification/security-audit-2026-10-18/'; await mkdir(out,{recursive:true});
const routes=[];
const policies={
 auth:['mixed','auth on me/logout; loginGuard + IP limiter on login','own session'],
 orders:['per-route','router.use(auth); per-route roles','ownedOrder: storeId/driverId + activeAssignment; accept uses assignOrder and candidate eligibility; list storeId; create authenticated store'],
 admin:['admin','router.use(auth, roles(admin))','global administrative privilege; ownedOrder validates ID; actor from req.user'],
 store:['store','router.use(auth, roles(store))','req.user._id scoped settlement and pickup operations'],
 driver:['driver','router.use(auth, roles(driver))','req.user._id for offers/current/summary/push; current active assignment'],
 maps:['store, admin','router.use(auth, roles(store,admin))','no order resource; validated geocoding input'],
 customer:['customer-token (anonymous JWT role)','find: 48 lowercase hex; customerAccessFilter token + expiry; IP limiter','token selects its own order; edits stage/CAS gated; no user JWT'],
 tracking:['tracking-credential','verifyTrackingCredential + trackingOrder; IP limiter','JWT subject binds order + link fingerprint/expiry'],
 backgroundLocation:['driver / background-credential','session: auth + roles(driver); upload: authenticateBackground','driver JWT subject/session + authVersion; Redis active session'],
};
for(const [file,[roles,middleware,ownership]] of Object.entries(policies)) {
 const source=await readFile(root+`backend/src/routes/${file}.js`,'utf8');
 const prefix=file==='backgroundLocation'?'/driver/location/background':`/${file}`;
 for(const m of source.matchAll(/router\.(get|post|put|patch|delete)\("([^"]+)"([^\n]*)/g)) {
  const line=source.slice(0,m.index).split('\n').length, local=m[2];
  const declared=m[3].match(/roles\(([^)]+)\)/)?.[1].replaceAll('"','');
  const isAuth=file==='auth'&&local!=='/login';
  routes.push({method:m[1].toUpperCase(),path:'/api'+prefix+(local==='/'?'':local),roles:declared??(isAuth?'store, driver, admin':file==='auth'?'anonymous':roles),
   protected:!['customer','tracking'].includes(file)&&(file!=='auth'||isAuth),
   middleware:isAuth?'auth':middleware,ownership,file:`backend/src/routes/${file}.js`,line});
 }
 const add=(actions,base,allowed,marker)=>{for(const a of actions) routes.push({method:'POST',path:'/api'+prefix+base.replace('{action}',a),roles:allowed,protected:true,middleware,ownership,file:`backend/src/routes/${file}.js`,line:source.slice(0,source.indexOf(marker)).split('\n').length});};
 if(file==='orders') add(['arrive-store','pickup','arrive-customer','deliver','fail'],'/:id/{action}','driver','for (const action');
 if(file==='admin') {add(['cancel','authorize-return'],'/orders/:id/{action}','admin','for (const action');add(['resolve-adjustment','cash-handover','driver-payout','store-settlement','reverse-record'],'/orders/:id/finance/{action}','admin','for (const action of ["resolve-adjustment"');}
}
for(const [path,line] of [['/api/health',85],['/api/ready',88]]) routes.push({method:'GET',path,roles:'anonymous',protected:false,middleware:'none',ownership:'health/readiness operational metadata',file:'backend/src/app.js',line});
const events=[
 ['default','connect','driver','authenticateDriver(JWT, active, role, ver, expiry)','server joins driver:<JWT sub>, optional :v3','backend/src/realtime/index.js',24],
 ['default','driver:location','driver','locationIngest reauth + bounded rate/payload','JWT sub/session; no caller-selected driver or room','backend/src/realtime/index.js',50],
 ['default','disconnect','driver','server cleanup','release only current Redis session','backend/src/realtime/index.js',42],
 ['/customer-tracking','connect','tracking-credential','30/min transport IP; verifyTrackingCredential + trackingOrder','order subject/link hash; server-selected customer and tracking rooms','backend/src/realtime/customerTracking.js',26],
 ['/customer-tracking','customer:tracking-resync','tracking-credential','discloseTracking revalidates; 1/10 sec viewer + 30/min transport IP','socket claims only; ignores client order selection','backend/src/realtime/customerTracking.js',75],
 ['/customer-tracking','disconnect','tracking-credential','cleanup','own viewer only','backend/src/realtime/customerTracking.js',73],
 ...['driver:session','driver:realtime-error','driver:offer-created','driver:offer-updated','driver:offer-removed','driver:order-changed'].map(e=>['default',e,'server-only','no client handler','JWT-selected driver rooms','shared/realtimeContract.js',3]),
 ...['customer:tracking-snapshot','customer:driver-location','customer:tracking-ended','customer:order-changed','customer:tracking-error'].map(e=>['/customer-tracking',e,'server-only','no client handler','credential-selected order rooms','shared/realtimeContract.js',26]),
];
await writeFile(out+'authorization-map.json',JSON.stringify({routes,events},null,2));
const md='## Authorization map (code review inventory; not a PASS claim)\n\nAll HTTP registrations, including loop-expanded actions, are listed. `/api` fallback returns 404; static web/SPA GET routes (`/`, `/store/*`, `/admin/*`, `/customer/*`) are anonymous shells and grant no API authorization. Engine.IO handshake/upgrade is governed by socket middleware below. No HTTP auth middleware: health, ready, login, customer-token routes, tracking snapshot, and background upload (which authenticates a scoped credential inside the handler). Each is explicitly probed in the new suite.\n\n| Method | Route | Allowed roles/credential | Enforcement | Ownership | Source |\n|---|---|---|---|---|---|\n'+routes.map(r=>`| ${r.method} | ${r.path} | ${r.roles} | ${r.middleware} | ${r.ownership} | ${r.file}:${r.line} |`).join('\n')+'\n\n| Namespace | Event | Role/direction | Enforcement | Room/resource binding | Source |\n|---|---|---|---|---|---|\n'+events.map(e=>'| '+e.map(String).join(' | ')+' |').join('\n')+'\n';
await writeFile(out+'authorization-map.md',md); console.log(JSON.stringify({httpRoutes:routes.length,socketEntries:events.length}));
