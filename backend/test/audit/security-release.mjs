import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
const cwd=new URL('../../',import.meta.url);
test('S46 production startup refuses missing JWT before any connection',()=>{
 const env={...process.env,NODE_ENV:'production',JWT_SECRET:'',MONGODB_URI:'mongodb://127.0.0.1:1/waselha_unreachable_test',REALTIME_ALLOWED_ORIGINS:''};
 const r=spawnSync(process.execPath,['src/server.js'],{cwd,env,encoding:'utf8',timeout:5000});assert.equal(r.status,1);assert.match(r.stderr,/JWT_SECRET/);assert.doesNotMatch(r.stderr,/ECONNREFUSED/);
});
test('S46 production origin wildcard is rejected before any connection',()=>{
 const r=spawnSync(process.execPath,['--input-type=module','-e','await import("./src/config.js")'],{cwd,env:{...process.env,NODE_ENV:'production',REALTIME_ALLOWED_ORIGINS:'*'},encoding:'utf8',timeout:5000});assert.equal(r.status,1);assert.match(r.stderr,/explicit HTTP|explicit origins/);
});
test('S33 production-mode parse/oversize errors return codes without stack/path',()=>{
 const code=`import {createServer} from 'node:http';import {createApp} from './src/app.js';const s=createServer(createApp({textMe:{enabled:false}}));await new Promise(r=>s.listen(0,'127.0.0.1',r));try{for(const body of ['{',JSON.stringify({x:'x'.repeat(110000)})]){const r=await fetch('http://127.0.0.1:'+s.address().port+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body});const x=await r.json();if(![400,413].includes(r.status)||Object.keys(x).join(',')!=='code')process.exitCode=2;}}finally{s.closeAllConnections();await new Promise(r=>s.close(r));}`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd,env:{...process.env,NODE_ENV:'production',REALTIME_ALLOWED_ORIGINS:''},encoding:'utf8',timeout:10000});assert.equal(r.status,0,'production HTTP errors must be sanitized');
});
