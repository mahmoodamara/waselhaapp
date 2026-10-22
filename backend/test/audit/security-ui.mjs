import {fork,spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const fixture=fork(fileURLToPath(new URL('./security-ui-server.mjs',import.meta.url)),[],{cwd:root,windowsHide:true,stdio:['ignore','inherit','inherit','ipc']});
try {
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Browser fixture timeout')),15000);fixture.on('message',m=>{if(m==='ready'){clearTimeout(timer);resolve();}});fixture.once('exit',()=>{clearTimeout(timer);reject(new Error('Browser fixture exited'));});});
 const browser=spawn('python',['backend/test/audit/security-xss.py'],{cwd:root,windowsHide:true,stdio:'inherit'});const [code]=await once(browser,'exit');process.exitCode=code??1;
}finally{if(fixture.connected){const done=once(fixture,'exit');fixture.send('shutdown');await done;}}
