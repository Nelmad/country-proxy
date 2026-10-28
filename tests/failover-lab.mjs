// Explicit network integration test. Two loopback CONNECT proxies, real TLS origins.
// Proves automatic endpoint replacement; both fixtures share one real external IP.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import assert from 'node:assert/strict';
import {inspectRuntime} from './chrome-runtime.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {BLOCKED} from '../extension/controller.js';
const exec=promisify(execFile);
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=path.resolve(import.meta.dirname,'..');
const report={at:new Date().toISOString(),kind:'controlled-loopback-endpoints',result:'FAIL',provesDifferentPublicIP:false};
const allowed=new Set(['www.cloudflare.com:443','www.google.com:443','example.com:443']);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const quote=s=>"'"+s.replaceAll("'","'\"'\"'")+"'";
async function proxy(label,enabled){
 const sockets=new Set();const hits=[];
 const state={enabled,hits,closed:false};
 const server=http.createServer((req,res)=>{res.writeHead(405);res.end();});
 const track=socket=>{
   sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
   socket.on('error',()=>{});socket.setTimeout(65000,()=>socket.destroy());
 };
 server.on('connection',track);
 server.on('connect',(req,client,head)=>{
   if(!state.enabled || !allowed.has(req.url)){
     client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');return;
   }
   const [host,port]=req.url.split(':');
   const upstream=net.connect({host,port:Number(port)});track(upstream);
   upstream.on('connect',()=>{
     hits.push({at:Date.now(),target:req.url});
     client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
     if(head.length)upstream.write(head);
     client.pipe(upstream);upstream.pipe(client);
   });
   client.on('error',()=>upstream.destroy());upstream.on('error',()=>client.destroy());
   client.on('close',()=>upstream.destroy());upstream.on('close',()=>client.destroy());
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 state.port=server.address().port;state.label=label;
 state.stop=async()=>{
   if(state.closed)return;
   state.closed=true;state.enabled=false;
   const closing=new Promise(r=>server.close(r));
   for(const socket of sockets)socket.destroy();await closing;
 };
 return state;
}
const savedProfile=process.env.TEST_SAVED_PROFILE==='1';
const routeFailure=process.env.TEST_FAILURE==='route';
const restart=process.env.TEST_RESTART==='1';
const warmReserve=process.env.TEST_RESERVE==='1';
report.warmReserve=warmReserve;
report.savedProfile=savedProfile;report.failure=routeFailure?'browser-route':'closed-listener';report.restart=restart;
let browser,command,worker,popup,a,b,temp,registrationFile,registrationBackup,originalState;
try {
 await fs.mkdir(path.join(root,'.runtime'),{recursive:true});
 temp=await fs.mkdtemp(path.join(root,'.runtime/failover-lab-'));
 // Determine the actual country of this test machine, never fabricate loc=NO.
 const baselineCode=`import asyncio,json,sys
sys.path.insert(0,${JSON.stringify(path.join(root,'native'))})
from core import curl,TRACE,TARGET,country_code
async def main():
 a,b=await asyncio.gather(curl(TRACE,slow=True),curl(TARGET,slow=True))
 if a[0] or b[0] or a[1]!='200' or b[1]!='204':raise RuntimeError('Direct HTTPS baseline unavailable')
 fields=dict(x.split('=',1) for x in a[2].splitlines() if '=' in x)
 print(json.dumps({'country':country_code(fields.get('loc'))}))
asyncio.run(main())`;
 const baseline=JSON.parse((await exec(path.join(root,'.venv/bin/python'),['-I','-B','-c',baselineCode],{timeout:50000})).stdout);
 const cc=baseline.country;report.country=cc;
 a=await proxy('A',true);b=await proxy('B',false);
 const config=path.join(temp,'fixtures.json');
 await fs.writeFile(config,JSON.stringify({country:cc,ports:[a.port,b.port]})+'\n',{mode:0o600});
 const launcher=path.join(temp,'host');
 await fs.writeFile(launcher,'#!/bin/sh\nexec '+quote(path.join(root,'.venv/bin/python'))+' -I -B '+quote(path.join(root,'tests/fixture_host.py'))+' '+quote(config)+'\n',{mode:0o700});
 const manifest=JSON.parse(await fs.readFile(path.join(root,'extension/manifest.json')));
 const id=crypto.createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
 const profile=savedProfile?path.join(root,'.runtime/chrome-test'):path.join(temp,'profile');const registration=path.join(profile,'NativeMessagingHosts');
 await fs.mkdir(registration,{recursive:true});
 registrationFile=path.join(registration,'local.country_proxy.json');
 if(savedProfile)registrationBackup=await fs.readFile(registrationFile);
 await fs.writeFile(registrationFile,JSON.stringify({name:'local.country_proxy',description:'Country Proxy test fixtures',path:launcher,type:'stdio',allowed_origins:[`chrome-extension://${id}/`]}),{mode:0o600});
 const launch=()=>chromium.launchPersistentContext(profile,{
   headless:true,channel:'chromium',ignoreDefaultArgs:['--disable-extensions'],
   args:[`--disable-extensions-except=${root}/extension`,`--load-extension=${root}/extension`,'--disable-quic'],
   viewport:{width:640,height:650}
 });
 browser=await launch();
 worker=browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker',{timeout:20000});
 report.runtimeBefore=await inspectRuntime(browser,root,{verify:false});
 if(savedProfile && report.runtimeBefore.scripts.some(s=>!s.equal)){
   await worker.evaluate(()=>chrome.runtime.reload()).catch(()=>{});
   await browser.close();browser=await launch();
   worker=browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker',{timeout:20000});
 }
 report.runtime=await inspectRuntime(browser,root);
 popup=await browser.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);
 command=(action,extra={})=>popup.evaluate(m=>chrome.runtime.sendMessage(m),{action,...extra});
 if(savedProfile)originalState=await popup.evaluate(()=>chrome.storage.local.get(['countries','selected','enabled','status']));
 await command('disconnect');await command('settings',{countries:[cc]});
 const listen=()=>worker.evaluate(()=>{
   self.labErrors=[];self.labRoutes=[];self.labStates=[];
   chrome.proxy.onProxyError.addListener(e=>self.labErrors.push({at:Date.now(),error:e.error,fatal:e.fatal}));
   chrome.proxy.settings.onChange.addListener(e=>self.labRoutes.push({at:Date.now(),value:e.value}));
   chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local' && changes.status)self.labStates.push(changes.status.newValue);});
 });
 await listen();
 const state=()=>popup.evaluate(async()=>await chrome.storage.local.get(['status','enabled','selected']));
 async function connected(port,timeout){
   const until=Date.now()+timeout;let phase='';
   while(Date.now()<until){
     const s=await state();assert.equal(s.selected,cc);assert.equal(s.enabled,true);
     if(s.status?.country)assert.equal(s.status.country,cc);
     if(s.status?.phase!==phase){phase=s.status?.phase;console.log(phase,s.status?.proxy?.port || '');}
     if(phase==='connected' && s.status.proxy.port===port)return s.status;
     if(phase==='helper' || phase==='error')throw Error(JSON.stringify(s.status));
     await delay(200);
   }
   throw Error('Timed out waiting for fixture port '+port);
 }
 let page=await browser.newPage();
 async function trace(){
   await page.goto('https://www.cloudflare.com/cdn-cgi/trace?lab='+Date.now(),{timeout:20000,waitUntil:'domcontentloaded'});
   const fields=Object.fromEntries((await page.locator('body').innerText()).trim().split('\n').map(x=>x.split('=')));
   assert.equal(fields.loc,cc);return fields.ip;
 }
 assert.equal((await command('connect',{country:cc})).ok,true);
 let first=await connected(a.port,60000);
 if(restart){
   await browser.close();browser=await launch();
   worker=browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker',{timeout:20000});
   report.runtimeAfterRestart=await inspectRuntime(browser,root);
   popup=await browser.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);
   await listen();page=await browser.newPage();
   first=await connected(a.port,60000);report.restoredAutomatically=true;
 }
 report.initialEndpoint={host:first.proxy.host,port:first.proxy.port};
 const beforeIP=await trace();report.initialPage=true;
 if(warmReserve){
   b.enabled=true;const until=Date.now()+90000;
   while(Date.now()<until){
     report.poolBefore=await popup.evaluate(()=>chrome.storage.local.get('pool'));
     if(report.poolBefore.pool?.count===1 && report.poolBefore.pool.expiresAt>Date.now())break;
     await delay(200);
   }
   assert.equal(report.poolBefore.pool?.count,1,'one native-verified reserve must be ready before failure');
   report.reserveReady=true;
   await popup.screenshot({path:path.join(root,'.runtime/reserve-ready.png')});
 }
 report.injectedAt=Date.now();
 if(routeFailure){
   report.upstreamStillRunning=!a.closed;
   await worker.evaluate(value=>chrome.proxy.settings.set({value,scope:'regular'}),BLOCKED);
 } else await a.stop();
 try {await page.goto('https://example.com/?lab-failure='+Date.now(),{timeout:10000});report.failedRequest=false;}
 catch {report.failedRequest=true;}
 assert.equal(report.failedRequest,true,'dead endpoint must not allow a direct request');
 b.enabled=true; // Never send a manual rotate/check command.
 const second=await connected(b.port,150000);
 report.replacementEndpoint={host:second.proxy.host,port:second.proxy.port};
 report.sameExternalExit=(await trace())===beforeIP;report.replacementPage=true;
 const events=await worker.evaluate(()=>({states:self.labStates,errors:self.labErrors,routes:self.labRoutes}));
 const post=events.states.filter(s=>s.updatedAt>=report.injectedAt);
 assert.ok(post.some(s=>s.phase==='replacing'));
 assert.ok(post.some(s=>s.phase===(warmReserve?'reserve':'searching')));
 if(warmReserve){
   const promoted=post.findIndex(s=>s.phase==='connected' && s.proxy?.port===b.port);
   assert.ok(promoted>=0);assert.ok(!post.slice(0,promoted).some(s=>s.phase==='searching'),'ready reserve must precede a full search');
 }
 let replacing=false;
 for(const s of post){
   if(s.country)assert.equal(s.country,cc);
   if(s.phase==='replacing')replacing=true;
   if(replacing)assert.notEqual(s.phase,'confirming','old health warning after replacement started');
 }
 const routes=events.routes.filter(r=>r.at>=report.injectedAt);
 assert.ok(routes.some(r=>r.value.rules?.proxyForHttps?.port===9),'replacement gap must block');
 for(const r of routes)assert.equal(r.value.mode,'fixed_servers');
 const errors=events.errors.filter(e=>e.at>=report.injectedAt);
 assert.ok(errors.length);assert.ok(errors.every(e=>e.fatal),'no nonfatal/direct fallback');
 for(const target of ['www.cloudflare.com:443','www.google.com:443'])assert.ok(b.hits.some(h=>h.target===target));
 report.phases=[...new Set(post.map(s=>s.phase))];report.errors=errors;report.routes=routes;
 report.secondsToReplacement=+( (Date.now()-report.injectedAt)/1000 ).toFixed(1);
 report.result='PASS';
 await popup.screenshot({path:path.join(root,'.runtime/failover-lab-latest.png')});
} catch(error){
 report.error=error.message;
 if(worker)report.diagnostics=await worker.evaluate(()=>({states:self.labStates,errors:self.labErrors,routes:self.labRoutes})).catch(()=>null);
} finally {
 report.connections={A:a?.hits.length,B:b?.hits.length};
 if(command)await command('disconnect').catch(()=>{});
 if(popup && originalState)await popup.evaluate(state=>chrome.storage.local.set(state),originalState).catch(()=>{});
 if(browser)await browser.close();
 if(a)await a.stop();if(b)await b.stop();
 if(registrationBackup)await fs.writeFile(registrationFile,registrationBackup);
 await fs.writeFile(path.join(root,'.runtime/failover-lab-latest.json'),JSON.stringify(report,null,2)+'\n');
 // Only this run's private, disposable profile/registration are removed.
 if(temp)await fs.rm(temp,{recursive:true,force:true});
}
console.log(JSON.stringify(report,null,2));
if(report.result!=='PASS')process.exitCode=1;
