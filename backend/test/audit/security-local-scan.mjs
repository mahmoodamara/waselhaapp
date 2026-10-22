// Local signature scan only. Findings never include matched values.
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const out=path.join(root,'.verification/security-audit-2026-10-18');
const git=args=>execFileSync('git',args,{cwd:root,maxBuffer:150*1024*1024});
const signatures=[['private-key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],['google-api-key',/AIza[0-9A-Za-z_-]{35}/],['AWS-access-key',/(?:AKIA|ASIA)[A-Z0-9]{16}/],['github-token',/(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})/],['OpenAI-key',/sk-(?:proj-)?[A-Za-z0-9_-]{35,}/],['JWT-literal',/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/],['credentialed-database-URI',/mongodb(?:\+srv)?:\/\/[^\s/"']+:[^\s/@"']+@/]];
const findings=[];let tracked=0,blobs=0;
function scan(text,file,scope){for(const [type,re]of signatures)if(re.test(text)){const fixture=/test|\.example$|README|docs\//i.test(file);findings.push({file,type,scope,classification:fixture?'fixture/documentation candidate; value not disclosed':'potential secret; offline signature match, validity not checked'});}}
for(const file of git(['ls-files','-z']).toString().split('\0').filter(Boolean)){try{scan(await readFile(path.join(root,file),'utf8'),file,'tracked working tree');tracked++;}catch{}}
const objects=git(['rev-list','--objects','--all']).toString().trim().split(/\r?\n/).map(line=>{const space=line.indexOf(' ');return {oid:space<0?line:line.slice(0,space),file:space<0?'(commit/tree)':line.slice(space+1)};});
const byOid=new Map(objects.map(x=>[x.oid,x.file]));
const buffer=execFileSync('git',['cat-file','--batch'],{cwd:root,input:objects.map(x=>x.oid).join('\n')+'\n',maxBuffer:150*1024*1024});
let pos=0;
while(pos<buffer.length){const end=buffer.indexOf(10,pos);if(end<0)break;const [oid,type,sizeText]=buffer.subarray(pos,end).toString().split(' '),size=Number(sizeText);pos=end+1;if(!Number.isFinite(size))break;const content=buffer.subarray(pos,pos+size);pos+=size+1;if(type==='blob'){blobs++;scan(content.toString('utf8'),byOid.get(oid),'reachable git history blob');}}
const result={started:new Date().toISOString(),timezone:'Asia/Jerusalem',commands:['git ls-files -z','git rev-list --objects --all','git cat-file --batch','git rev-list --all --count'],trackedFilesScanned:tracked,historyBlobsScanned:blobs,commits:Number(git(['rev-list','--all','--count']).toString()),signatures:signatures.map(([name])=>name),findings,limitation:'Local signatures cannot prove absence of arbitrary passwords, encoded secrets, unreachable objects or provider validity; no network credential validation.'};
await writeFile(path.join(out,'secret-scan.json'),JSON.stringify(result,null,2));
// Recover original TLS failure evidence from npm's own retained debug logs.
const cache='C:/Users/admin/AppData/Local/npm-cache/_logs';
const tls=[];
for(const file of (await readdir(cache)).filter(f=>f.startsWith('2026-10-18T13_30_')&&f.endsWith('-debug-0.log'))){const s=await readFile(path.join(cache,file),'utf8');if(!s.includes('unable to verify the first certificate'))continue;const lines=s.split(/\r?\n/).filter(l=>/verbose (title|argv|cwd|exit|code)|warn audit request|error audit endpoint/.test(l));const logfile='initial-tls-'+file;await writeFile(path.join(out,logfile),lines.join('\n')+'\n');tls.push({source:path.join(cache,file),logfile,exit:1,evidence:'Original npm debug log selected metadata; raw wrapper stdout was overwritten by a wrapper manifest race. No test result inferred.'});}
await writeFile(path.join(out,'initial-tls-attempts.json'),JSON.stringify(tls,null,2));
console.log(JSON.stringify({trackedFilesScanned:tracked,historyBlobsScanned:blobs,commits:result.commits,findings:findings.length,recoveredTlsAttempts:tls.length}));
