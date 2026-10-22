// Explicit, opt-in live validation. Never included in the normal fake-provider suites.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

assert.equal(process.env.RUN_LIVE_OSRM, "1", "Explicit RUN_LIVE_OSRM=1 is required");
assert.equal(process.env.ROUTING_BASE_URL, "http://127.0.0.1:5000");
const uri = new URL(process.env.LIVE_OSRM_TEST_URI);
assert.equal(uri.hostname, "127.0.0.1");
assert.ok(uri.pathname.endsWith("_test"), "Dedicated *_test database required");
process.env.MONGODB_URI = uri.href;
process.env.JWT_SECRET = "live-osrm-isolated-test-secret";
process.env.ROUTING_TIMEOUT_MS = "5000";
process.env.MAPS_CONTACT = "";
process.env.PUBLIC_BASE_URL = "http://127.0.0.1:3106";
const output = new URL("../../.verification/step5-live/", import.meta.url);
mkdirSync(output, { recursive: true });
const { translations } = await import("../../web/src/translations.js");
writeFileSync(new URL("translations.json",output),JSON.stringify(translations));
const points = JSON.parse(readFileSync(new URL("../../infra/osrm/pilot-points.json", import.meta.url))).points;
const { getRouteDistance } = await import("../src/services/routing.js");
const report = { runUtc: new Date().toISOString(), endpoint: process.env.ROUTING_BASE_URL, routes: [], checks: {} };
const haversine = (a, b) => {
  const rad = Math.PI / 180, dlat = (b.lat-a.lat)*rad, dlng = (b.lng-a.lng)*rad;
  return 6371000*2*Math.asin(Math.sqrt(Math.sin(dlat/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dlng/2)**2));
};
async function direct(a, b, geometry = false) {
  const response = await fetch(`${process.env.ROUTING_BASE_URL}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=${geometry ? "full" : "false"}&geometries=geojson&steps=false&alternatives=false`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.code, "Ok");
  assert.ok(data.routes[0].distance > 0);
  return data;
}
// Adjacent grid points in both directions: 26 predetermined, varied public routes.
for (let i = 0; i < points.length; i++) {
  for (const [a,b] of [[points[i],points[(i+1)%points.length]],[points[(i+1)%points.length],points[i]]]) {
    const row = { id: `R${String(report.routes.length+1).padStart(2,"0")}`, from: a.id, to: b.id };
    const start = performance.now();
    try {
      const route = await getRouteDistance({ pickup:a, destination:b });
      row.latencyMs = +(performance.now()-start).toFixed(2);
      const data = await direct(a,b,true);
      assert.equal(route.distanceMeters, Math.round(data.routes[0].distance));
      row.distanceMeters = route.distanceMeters;
      row.straightLineMeters = Math.round(haversine(a,b));
      row.detourRatio = +(route.distanceMeters/haversine(a,b)).toFixed(3);
      row.snapMeters = data.waypoints.map(w => +w.distance.toFixed(2));
      row.classification = row.snapMeters.some(m => m > 50) || row.detourRatio > 3 || route.distanceMeters < haversine(a,b)*0.95 ? "problematic" : "plausible";
      row.notes = row.classification === "plausible" ? "Positive connected road route; snap <=50m; distance/straight-line ratio 0.95–3. Road-data plausibility screen, not a driven survey." : "Requires individual snapping/detour review.";
      writeFileSync(new URL(`${row.id}-geometry.json`,output),JSON.stringify(data));
    } catch (error) {
      row.latencyMs = +(performance.now()-start).toFixed(2);
      row.classification = "failed";
      row.notes = error.code || error.message;
    }
    report.routes.push(row);
    console.log(JSON.stringify(row));
  }
}
const latencies = report.routes.map(r=>r.latencyMs).sort((a,b)=>a-b);
report.summary = { total:report.routes.length, plausible:report.routes.filter(r=>r.classification==="plausible").length, problematic:report.routes.filter(r=>r.classification==="problematic").length, failed:report.routes.filter(r=>r.classification==="failed").length, latencyMinMs:latencies[0], latencyMedianMs:(latencies[12]+latencies[13])/2, latencyMaxMs:latencies.at(-1) };
writeFileSync(new URL("routes.json",output), JSON.stringify(report,null,2));
assert.equal(report.summary.failed,0,"Investigate live route failures before proceeding");

const mongoose = (await import("mongoose")).default;
const bcrypt = (await import("bcryptjs")).default;
const models = await import("../src/models/index.js");
const { createApp } = await import("../src/app.js");
let server, paused = false, completed = false;
const docker = process.env.OSRM_DOCKER_EXE;
const container = process.env.OSRM_CONTAINER_ID;
assert.ok(docker && container, "Real provider failure test requires owned OSRM container");
const ownedContainer = execFileSync(docker,["compose","-f",fileURLToPath(new URL("../../infra/osrm/compose.yaml",import.meta.url)),"ps","-q","osrm"],{encoding:"utf8",timeout:20000}).trim();
assert.equal(container,ownedContainer,"Only this project's compose OSRM container may be paused");
const inspection=JSON.parse(execFileSync(docker,["inspect",container],{encoding:"utf8",timeout:20000}))[0];
assert.equal(inspection.State.Running,true);
assert.deepEqual(inspection.NetworkSettings.Ports["5000/tcp"],[{HostIp:"127.0.0.1",HostPort:"5000"}]);
assert.ok(inspection.Config.Cmd.includes("mld"));
const dockerAction = action => execFileSync(docker,[action,container],{timeout:20000,stdio:"pipe"});
const point = p => ({lat:p.lat,lng:p.lng,address:p.label,source:"pin"});
const pickup=point(points[5]), A=point(points[2]), B=point(points[11]), C=point(points[7]);
try {
  await models.connectDatabase();
  assert.equal(await models.User.countDocuments(),0,"Use a fresh dedicated live test DB; existing DBs are never reset here");
  await Promise.all([models.User,models.Order,models.DriverCashRecord,models.CodeAttemptState,models.CodeAttempt].map(m=>m.syncIndexes()));
  const passwordHash = await bcrypt.hash("WaselhaDemo123!",10);
  await models.User.create([{login:"store1",role:"store",name:"Public pilot test store",storeName:"Public pilot test store",pickupAddress:pickup.address,active:true,passwordHash,pickupLocation:{...pickup,confirmedAt:new Date()}},{login:"driver1",role:"driver",name:"Isolated pilot test driver",active:true,passwordHash}]);
  server = createApp().listen(3106,"127.0.0.1");
  await once(server,"listening");
  async function request(path,token,method="GET",body,expected=200) {
    const response=await fetch(`http://127.0.0.1:3106/api${path}`,{method,headers:{"Content-Type":"application/json",...(token?{Authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();
    assert.equal(response.status,expected,`${method} ${path.split("/").slice(0,3).join("/")}: ${response.status}; ${data.code||""}`);
    return data;
  }
  const store=(await request("/auth/login",null,"POST",{login:"store1",password:"WaselhaDemo123!"})).token;
  const driver=(await request("/auth/login",null,"POST",{login:"driver1",password:"WaselhaDemo123!"})).token;
  const create=()=>request("/orders",store,"POST",{area:"Kafr Kanna public pilot",customerPhone:"0500000000",recipientName:"Synthetic test recipient",preliminaryAddress:A.address,finalAddress:A.address,parcelDescription:"Synthetic test parcel",parcelReady:true,goodsAmountAgorot:10000},201);
  const view=o=>request(`/orders/${o._id}`,store);
  const token=o=>o.customerLink.split("/").at(-1);
  const locate=(o,p)=>request(`/customer/${token(o)}/location`,null,"POST",p);
  const assertPrice=async(o,p)=>{
    const expected=Math.round((await direct(pickup,p)).routes[0].distance);
    const v=await view(o), raw=await models.Order.findById(o._id).lean();
    for(const data of [v,raw]) {
      assert.equal(data.priceStatus,"final"); assert.equal(data.routeProvider,"osrm");
      assert.equal(data.routeDistanceMeters,expected); assert.equal(data.deliveryFeeAgorot,expected*2);
      assert.equal(data.platformCommissionAgorot,Math.floor((expected*2+5)/10));
      assert.equal(data.driverEarningsAgorot,data.deliveryFeeAgorot-data.platformCommissionAgorot);
      assert.equal(data.expectedCustomerCashAgorot,10000+expected*2);
      assert.equal(data.pickupLocation.lng,pickup.lng);
    }
    return {distanceMeters:expected,feeAgorot:v.deliveryFeeAgorot,platformAgorot:v.platformCommissionAgorot,driverAgorot:v.driverEarningsAgorot,expectedCashAgorot:v.expectedCustomerCashAgorot};
  };
  const confirmAll=async o=>{
    const c=await request(`/customer/${token(o)}`);
    await request(`/customer/${token(o)}/confirm`,null,"POST",{observed:c.confirmationSnapshot,recipientName:"Synthetic test recipient",finalAddress:"Public road test pin",deliveryInstructions:"Test only"});
    for(const actor of [store,driver]) {
      const v=await request(`/orders/${o._id}`,actor);
      await request(`/orders/${o._id}/confirm`,actor,"POST",{observed:v.confirmationSnapshot});
    }
  };
  const o=await create();
  assert.equal(o.priceStatus,"pending"); assert.equal(o.deliveryFeeAgorot,null);
  await request(`/orders/${o._id}/accept`,driver,"POST",{});
  await request(`/orders/${o._id}/arrive-store`,driver,"POST",{});
  const blocked=await request(`/orders/${o._id}/pickup`,driver,"POST",{code:o.pickupCode},422);
  assert.ok(blocked.missingRequirements.includes("route_price_required"));
  await locate(o,A);
  report.checks.endToEnd=await assertPrice(o,A);
  await confirmAll(o);
  const collected=await request(`/orders/${o._id}/pickup`,driver,"POST",{code:o.pickupCode});
  assert.equal(collected.status,"collected");
  report.checks.endToEnd.status="PASS";
  report.checks.pickupGate="PASS: pending blocked; final price plus all existing requirements permits pickup";
  await request(`/orders/${o._id}/arrive-customer`,driver,"POST",{});
  const delivery=await request(`/customer/${token(o)}`);
  assert.equal((await request(`/orders/${o._id}/deliver`,driver,"POST",{code:delivery.deliveryCode,actualCashCollectedAgorot:report.checks.endToEnd.expectedCashAgorot,observedExpectedAgorot:report.checks.endToEnd.expectedCashAgorot})).status,"delivered");

  const changing=await create();
  await locate(changing,A);
  const old=await view(changing);
  const aPrice=await assertPrice(changing,A);
  await request(`/orders/${changing._id}/accept`,driver,"POST",{});
  await request(`/orders/${changing._id}/arrive-store`,driver,"POST",{});
  await confirmAll(changing);
  await locate(changing,B);
  const bPrice=await assertPrice(changing,B);
  assert.notEqual(aPrice.distanceMeters,bPrice.distanceMeters);
  assert.equal((await view(changing)).customerConfirmed,false);
  await request(`/orders/${changing._id}/confirm`,store,"POST",{observed:old.confirmationSnapshot},409);
  report.checks.destinationChange={status:"PASS",A:aPrice,B:bPrice,staleConfirmation:"409",financialConfirmationReset:true};

  try {
    dockerAction("pause"); paused=true;
    const started=performance.now();
    await locate(changing,C);
    const pending=await view(changing);
    assert.equal(pending.priceStatus,"pending"); assert.equal(pending.routeError,"routing_unavailable");
    assert.equal(pending.destinationLocation.lng,C.lng); assert.ok(pending.destinationLocation.confirmedAt);
    for(const k of ["routeDistanceMeters","routeCalculatedAt","routeProvider","deliveryFeeAgorot","platformCommissionAgorot","driverEarningsAgorot","expectedCustomerCashAgorot"]) assert.equal(pending[k],null,k);
    const gate=await request(`/orders/${changing._id}/pickup`,driver,"POST",{code:changing.pickupCode},422);
    assert.ok(gate.missingRequirements.includes("route_price_required"));
    report.checks.providerFailure={status:"PASS",mode:"Actual owned OSRM container paused; real HTTP timeout",elapsedMs:+(performance.now()-started).toFixed(2),destinationPreserved:true,oldMoneyCleared:true,pickupBlocked:true};
  } finally { if(paused){dockerAction("unpause");paused=false;} }
  await request(`/orders/${changing._id}/recalculate-price`,store,"POST",{});
  report.checks.providerRecovery={status:"PASS",...await assertPrice(changing,C)};
  await confirmAll(changing);
  assert.equal((await request(`/orders/${changing._id}/pickup`,driver,"POST",{code:changing.pickupCode})).status,"collected");
  writeFileSync(new URL("live-result.json",output),JSON.stringify(report,null,2));
  completed=true;
  console.log(JSON.stringify({summary:report.summary,checks:report.checks},null,2));
  if(process.env.LIVE_OSRM_SERVE==="1") {
    writeFileSync(new URL("browser-fixture.json",output),JSON.stringify({store,points,pickup}));
    console.log("LIVE OSRM BROWSER READY 3106");
    await new Promise(resolve=>{process.once("SIGTERM",resolve);process.once("SIGINT",resolve);});
  }
} finally {
  if(paused) dockerAction("unpause");
  if(server) {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  await mongoose.disconnect();
  if(!completed) writeFileSync(new URL("incomplete-result.json",output),JSON.stringify(report,null,2));
}
