// Explicit live failover test. Uses the isolated test profile, never the user's profile.
// Injects an unreachable Chrome route; does not call the production rotate/check commands.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {inspectRuntime} from './chrome-runtime.mjs';
import {createRequire} from 'node:module';
import {BLOCKED} from '../extension/controller.js';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=path.resolve(import.meta.dirname,'..');
const cc=process.env.TEST_COUNTRY || 'NO';
const manifest=JSON.parse(await fs.readFile(path.join(root,'extension/manifest.json')));
const id=crypto.createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
const report={at:new Date().toISOString(),country:cc,result:'INCONCLUSIVE',events:[],profile:'fresh-disposable'};
await fs.mkdir(path.join(root,'.runtime'),{recursive:true});
const temp=await fs.mkdtemp(path.join(root,'.runtime/failover-live-'));
let browser,popup,command,worker;
try {
 const quote=s=>"'"+s.replaceAll("'","'\"'\"'")+"'";
 const launcher=path.join(temp,'host');
 await fs.writeFile(launcher,'#!/bin/sh\nexec '+quote(path.join(root,'.venv/bin/python'))+' -I -B '+quote(path.join(root,'native/host.py'))+'\n',{mode:0o700});
 const profile=path.join(temp,'profile');
 const registration=path.join(profile,'NativeMessagingHosts');
 await fs.mkdir(registration,{recursive:true});
 await fs.writeFile(path.join(registration,'local.country_proxy.json'),JSON.stringify({name:'local.country_proxy',description:'Country Proxy isolated live test',path:launcher,type:'stdio',allowed_origins:[`chrome-extension://${id}/`]}),{mode:0o600});
 browser=await chromium.launchPersistentContext(profile,{
 headless:true,channel:'chromium',ignoreDefaultArgs:['--disable-extensions'],
 args:[`--disable-extensions-except=${root}/extension`,`--load-extension=${root}/extension`,'--disable-quic'],
 viewport:{width:640,height:650}
});
 worker=browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker',{timeout:20000});
 report.runtime=await inspectRuntime(browser,root);
 popup=await browser.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);
 command=(action,extra={})=>popup.evaluate(m=>chrome.runtime.sendMessage(m),{action,...extra});
 await command('disconnect');await command('settings',{countries:[cc]});
 await popup.evaluate(()=>{
   window.testEvents=[];
   chrome.storage.onChanged.addListener((changes,area)=>{
     if(area==='local' && changes.status) window.testEvents.push(changes.status.newValue);
   });
 });
 const state=()=>popup.evaluate(async()=>await chrome.storage.local.get(['status','enabled','selected']));
 const wait=async(predicate,ms)=>{
   const until=Date.now()+ms;let last='';
   while(Date.now()<until){
     const s=await state();
     assert.equal(s.selected,cc);assert.equal(s.enabled,true);
     if(s.status?.country) assert.equal(s.status.country,cc);
     if(s.status?.phase!==last){last=s.status?.phase;console.log(cc,last,s.status?.proxy?.host || '',s.status?.total || '');}
     if(predicate(s.status))return s.status;
     await new Promise(r=>setTimeout(r,500));
   }
   return null;
 };
 await command('connect',{country:cc});
 report.initial=await wait(s=>s?.phase==='connected',240000);
 if(!report.initial) throw Error('No verified baseline proxy');
 const tracePage=await browser.newPage();
 async function trace(){
   await tracePage.goto('https://www.cloudflare.com/cdn-cgi/trace?t='+Date.now(),{timeout:55000,waitUntil:'domcontentloaded'});
   const data=Object.fromEntries((await tracePage.locator('body').innerText()).trim().split('\n').map(x=>x.split('=')));
   assert.equal(data.loc,cc);return {country:data.loc,exitIp:data.ip};
 }
 report.before=await trace();
 await worker.evaluate(()=>{
   self.testProxyErrors=[];self.testProxyRoutes=[];
   chrome.proxy.onProxyError.addListener(e=>self.testProxyErrors.push({at:Date.now(),error:e.error,fatal:e.fatal}));
   chrome.proxy.settings.onChange.addListener(e=>self.testProxyRoutes.push({at:Date.now(),value:e.value}));
 });
 await worker.evaluate(value=>chrome.proxy.settings.set({value,scope:'regular'}),BLOCKED);
 report.injectedAt=Date.now();
 try {await tracePage.goto('https://example.com/?failover='+Date.now(),{timeout:15000});report.blockedRequest=false;}
 catch {report.blockedRequest=true;}
 assert.equal(report.blockedRequest,true,'injected route must not fall back to direct');
 // Stop before the old address's cooldown expires: reconnecting A is not A -> B.
 report.next=await wait(s=>s?.phase==='connected' && s.proxy?.host!==report.initial.proxy.host,165000);
 report.proxyErrors=await worker.evaluate(()=>self.testProxyErrors);
 report.routes=await worker.evaluate(()=>self.testProxyRoutes);
 report.finalState=await state();
 report.finalRoute=await worker.evaluate(()=>chrome.proxy.settings.get({incognito:false}));
 report.events=await popup.evaluate(()=>window.testEvents);
 const post=report.events.filter(e=>e.updatedAt>=report.injectedAt);
 report.automaticSearch=post.some(e=>['replacing','searching','checking','slow','empty'].includes(e.phase));
 assert.ok(report.proxyErrors.length,'must observe a real Chromium proxy error');
 assert.ok(report.automaticSearch,'must automatically start replacement');
 for(const e of post) if(e.country) assert.equal(e.country,cc);
 if(report.next){
   report.after=await trace();assert.notEqual(report.after.exitIp,report.before.exitIp);
   report.secondsToReplacement=+( (report.next.updatedAt-report.injectedAt)/1000 ).toFixed(1);
   for(const route of report.routes)assert.equal(route.value.mode,'fixed_servers');
   assert.ok(report.proxyErrors.every(e=>e.fatal));
   report.result='PASS';
 } else {
   report.finalState=await state();
   report.finalRoute=await worker.evaluate(()=>chrome.proxy.settings.get({incognito:false}));
   assert.equal(report.finalRoute.value.rules.proxyForHttps.host,'127.0.0.1');
   report.result='PARTIAL_NO_ALTERNATE';
 }
 await popup.screenshot({path:path.join(root,'.runtime/failover-latest.png')});
} catch(error) {
 report.error=error.message;
 if(popup)report.events=await popup.evaluate(()=>window.testEvents || []).catch(()=>[]);
 if(worker)report.diagnostics=await worker.evaluate(async()=>({errors:self.testProxyErrors,routes:self.testProxyRoutes,state:await chrome.storage.local.get(['selected','enabled','status']),route:await chrome.proxy.settings.get({incognito:false})})).catch(()=>null);
} finally {
 if(command)await command('disconnect').catch(()=>{});
 await fs.writeFile(path.join(root,'.runtime/failover-latest.json'),JSON.stringify(report,null,2)+'\n');
 if(browser)await browser.close();
 await fs.rm(temp,{recursive:true,force:true});
}
console.log(JSON.stringify({result:report.result,initial:report.initial?.proxy,next:report.next?.proxy,error:report.error,automaticSearch:report.automaticSearch,proxyErrors:report.proxyErrors},null,2));
if(report.result!=='PASS')process.exitCode=2;
