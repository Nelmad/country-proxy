// Network acceptance for cancellation of a genuinely pending browser CONNECT.
// All registrations/profiles are disposable; HTTPS/GeoIP and production controller are real.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {inspectRuntime} from './chrome-runtime.mjs';
const exec=promisify(execFile);
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=path.resolve(import.meta.dirname,'..');
const base=path.join(root,'.runtime/acceptance-20261030/control-cancel');
const quote=s=>"'"+s.replaceAll("'","'\"'\"'")+"'";
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function bounded(task,ms,label){let timer;try{return await Promise.race([task,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Timed out: '+label)),ms);})]);}finally{clearTimeout(timer);}}
async function exists(p){try{await fs.access(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function waitFor(fn,label,ms=30000){const until=Date.now()+ms;while(Date.now()<until){const result=await fn();if(result)return result;await delay(150);}throw Error('Timed out: '+label);}
async function hashes(){const result={};for(const dir of ['native','extension']){async function walk(at){for(const entry of (await fs.readdir(at,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(entry.name==='__pycache__'||entry.name.endsWith('.pyc'))continue;const p=path.join(at,entry.name);if(entry.isDirectory())await walk(p);else if(entry.isFile())result[path.relative(root,p)]=crypto.createHash('sha256').update(await fs.readFile(p)).digest('hex');}}await walk(path.join(root,dir));}return result;}
async function proxy(holdFile){
 const sockets=new Set(),pending=[],hits=[],held=[],released=[];let serial=0;
 const server=http.createServer((_req,res)=>{res.writeHead(405);res.end();});
 const track=s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('error',()=>{});s.setTimeout(65000,()=>s.destroy());};
 const forward=({req,client,head,id})=>{
  if(client.destroyed){released.push({id,closedBeforeRelease:true});return;}
  const [host,port]=req.url.split(':');const upstream=net.connect({host,port:Number(port)});track(upstream);
  upstream.on('connect',()=>{hits.push({id,target:req.url,at:Date.now()});if(client.destroyed){upstream.destroy();return;}client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});
  client.on('close',()=>upstream.destroy());upstream.on('close',()=>client.destroy());upstream.on('error',()=>client.destroy());
  released.push({id,closedBeforeRelease:false});
 };
 server.on('connection',track);
 server.on('connect',(req,client,head)=>{void (async()=>{
  if(!new Set(['www.cloudflare.com:443','www.google.com:443','example.com:443']).has(req.url)){client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');return;}
  const request={req,client,head,id:++serial};
  if(await exists(holdFile)){held.push({id:request.id,target:req.url,at:Date.now()});pending.push(request);}
  else forward(request);
 })().catch(()=>client.destroy());});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 return {port:server.address().port,hits,held,released,
  resetConnections:()=>{for(const socket of sockets)socket.destroy();},
  release:async()=>{await fs.rm(holdFile,{force:true});for(const item of pending.splice(0))forward(item);},
  close:async()=>{const closed=new Promise(r=>server.close(r));for(const s of sockets)s.destroy();await closed;}
 };
}
const report={at:new Date().toISOString(),kind:'in-flight-browser-probe-cancellation',result:'FAIL',mainChromeTouched:false,publicProxyPair:false,scenarios:[]};
let run,profile,browser,popup,worker,server,command;
const before=await hashes();
try{
 await fs.mkdir(base,{recursive:true});run=await fs.mkdtemp(path.join(base,'run-'));profile=path.join(run,'profile');
 report.profile=profile;
 const baselineCode=`import asyncio,json,sys\nsys.path.insert(0,${JSON.stringify(path.join(root,'native'))})\nfrom core import curl,TRACE,TARGET,country_code\nasync def main():\n a,b=await asyncio.gather(curl(TRACE,slow=True),curl(TARGET,slow=True))\n if a[0] or b[0] or a[1]!='200' or b[1]!='204':raise RuntimeError('Real HTTPS baseline unavailable')\n fields=dict(x.split('=',1) for x in a[2].splitlines() if '=' in x)\n print(json.dumps({'country':country_code(fields.get('loc'))}))\nasyncio.run(main())`;
 const {country:cc}=JSON.parse((await exec(path.join(root,'.venv/bin/python'),['-I','-B','-c',baselineCode],{timeout:50000})).stdout);
 const wrong=cc==='NO'?'EE':'NO';report.country=cc;report.otherCountry=wrong;
 const arm=path.join(run,'arm'),hold=path.join(run,'hold'),eventsFile=path.join(run,'native-events.jsonl');
 server=await proxy(hold);report.fixturePort=server.port;
 const config=path.join(run,'config.json');await fs.writeFile(config,JSON.stringify({port:server.port,arm,hold,events:eventsFile}));
 const launcher=path.join(run,'host');await fs.writeFile(launcher,'#!/bin/sh\nexec '+quote(path.join(root,'.venv/bin/python'))+' -I -B '+quote(path.join(root,'tests/control_cancel_fixture.py'))+' '+quote(config)+'\n',{mode:0o700});
 const manifest=JSON.parse(await fs.readFile(path.join(root,'extension/manifest.json')));
 const id=crypto.createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
 const registration=path.join(profile,'NativeMessagingHosts');await fs.mkdir(registration,{recursive:true});
 await fs.writeFile(path.join(registration,'local.country_proxy.json'),JSON.stringify({name:'local.country_proxy',description:'Disposable cancellation acceptance',path:launcher,type:'stdio',allowed_origins:[`chrome-extension://${id}/`]}),{mode:0o600});
 browser=await chromium.launchPersistentContext(profile,{headless:true,channel:'chromium',ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${root}/extension`,`--load-extension=${root}/extension`,'--disable-quic']});
 report.browser=browser.browser().version();
 worker=browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker',{timeout:20000});
 report.runtime=await inspectRuntime(browser,root);
 popup=await browser.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);
 command=(action,extra={})=>bounded(popup.evaluate(m=>chrome.runtime.sendMessage(m),{action,...extra}),5000,'command '+action);
 const state=()=>bounded(popup.evaluate(()=>chrome.storage.local.get(['status','selected','enabled'])),5000,'state');
 const route=()=>bounded(worker.evaluate(()=>chrome.proxy.settings.get({incognito:false})),5000,'route');
 await command('disconnect');await command('settings',{countries:[cc,wrong]});
 await worker.evaluate(()=>{self.cancelEvents=[];self.cancelRoutes=[];chrome.storage.onChanged.addListener((c,a)=>{if(a==='local' && c.status)self.cancelEvents.push(c.status.newValue);});chrome.proxy.settings.onChange.addListener(e=>self.cancelRoutes.push({at:Date.now(),value:e.value}));});
 const records=()=>worker.evaluate(()=>({events:self.cancelEvents,routes:self.cancelRoutes}));
 async function heldProbe(label){
  const eventStart=(await records()).events.length,heldStart=server.held.length;
  // A cancelled request may leave a reusable Chrome tunnel after release.
  // Close only this fixture's sockets while disabled so each case needs CONNECT.
  server.resetConnections();await delay(150);
  await fs.rm(hold,{force:true});await fs.writeFile(arm,'arm after real native success\n');
  assert.equal((await command('connect',{country:cc})).ok,true);
  const verifying=await waitFor(async()=>{const s=await state();return s.status?.phase==='verifying' && ['www.cloudflare.com:443','www.google.com:443'].every(target=>server.held.slice(heldStart).some(h=>h.target===target))?s:false;},'actual held browser CONNECT',30000);
  assert.equal(verifying.enabled,true);assert.equal(verifying.selected,cc);
  const current=await route();assert.equal(current.value.mode,'fixed_servers');assert.equal(current.value.rules.proxyForHttps.port,server.port);
  const nativeEvents=(await fs.readFile(eventsFile,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(nativeEvents.at(-1).country,cc);assert.equal(nativeEvents.at(-1).armed,true);assert.equal(nativeEvents.at(-1).proxy.country,cc);
  assert.ok(!(await records()).events.slice(eventStart).some(e=>e.phase==='connected'),'browser must still be pending');
  return {label,verifying,held:server.held.slice(heldStart),nativeSuccess:nativeEvents.at(-1),routeBeforeCancel:current,eventStart};
 }
 const disconnected=await heldProbe('disconnect-during-verification');report.scenarios.push(disconnected);
 const offEventStart=(await records()).events.length,offRouteStart=(await records()).routes.length;
 const stopStarted=Date.now();assert.equal((await command('disconnect')).ok,true);disconnected.commandMs=Date.now()-stopStarted;
 assert.equal((await state()).status.phase,'off');assert.equal((await state()).enabled,false);
 await server.release();disconnected.releasedAt=Date.now();
 const offUntil=Date.now()+5000;while(Date.now()<offUntil){const s=await state();assert.equal(s.enabled,false);assert.equal(s.status.phase,'off');assert.notEqual((await route()).levelOfControl,'controlled_by_this_extension');await delay(150);}
 disconnected.after=await state();disconnected.routeAfter=await route();
 disconnected.eventsAfterRelease=(await records()).events.slice(offEventStart);disconnected.routesAfterRelease=(await records()).routes.slice(offRouteStart);
 assert.ok(!disconnected.eventsAfterRelease.some(e=>e.phase==='connected'));assert.ok(!disconnected.routesAfterRelease.some(r=>r.value.rules?.proxyForHttps?.port===server.port));disconnected.result='PASS';
 const changed=await heldProbe('change-country-during-verification');report.scenarios.push(changed);
 const changeEventStart=(await records()).events.length,changeRouteStart=(await records()).routes.length;
 const changeStarted=Date.now();assert.equal((await command('connect',{country:wrong})).ok,true);changed.commandMs=Date.now()-changeStarted;
 assert.equal((await state()).selected,wrong);assert.equal((await state()).enabled,true);
 await server.release();changed.releasedAt=Date.now();
 changed.rejected=await waitFor(async()=>{const s=await state();assert.equal(s.selected,wrong);assert.equal(s.enabled,true);if(s.status?.country)assert.equal(s.status.country,wrong);assert.notEqual(s.status?.phase,'connected');return s.status?.phase==='empty' && s.status?.diagnostics?.failures?.country>=1?s:false;},'real GeoIP rejects wrong country',45000);
 const changeUntil=Date.now()+5000;while(Date.now()<changeUntil){const s=await state();assert.equal(s.selected,wrong);assert.notEqual(s.status?.phase,'connected');const r=await route();assert.equal(r.value.mode,'fixed_servers');assert.equal(r.value.rules.proxyForHttps.port,9);await delay(150);}
 changed.after=await state();changed.routeAfter=await route();changed.eventsAfterRelease=(await records()).events.slice(changeEventStart);changed.routesAfterRelease=(await records()).routes.slice(changeRouteStart);
 assert.ok(changed.eventsAfterRelease.every(e=>e.phase!=='connected' && (!e.country || e.country===wrong)));assert.ok(changed.routesAfterRelease.every(r=>r.value.mode==='fixed_servers' && r.value.rules.proxyForHttps.port===9));changed.result='PASS';
 await fs.rm(arm,{force:true});await server.release();assert.equal((await command('connect',{country:cc})).ok,true);
 report.reconnected=await waitFor(async()=>{const s=await state();return s.status?.phase==='connected'?s:false;},'reconnect actual country',60000);
 assert.equal(report.reconnected.selected,cc);assert.equal(report.reconnected.status.browser.country,cc);
 report.reconnectedRoute=await route();assert.equal(report.reconnectedRoute.value.rules.proxyForHttps.port,server.port);
 const page=await browser.newPage();await page.goto('https://www.cloudflare.com/cdn-cgi/trace?control-cancel='+Date.now(),{timeout:30000,waitUntil:'domcontentloaded'});
 const fields=Object.fromEntries((await page.locator('body').innerText()).trim().split('\n').filter(x=>x.includes('=')).map(x=>x.split('=')));assert.equal(fields.loc,cc);
 report.finalHTTPS={country:fields.loc,exitIp:fields.ip};await page.close();
 await command('disconnect');assert.equal((await state()).status.phase,'off');assert.notEqual((await route()).levelOfControl,'controlled_by_this_extension');report.finalDisconnect=true;
 report.records=await records();report.result='PASS';
}catch(error){report.error=error.stack || error.message;if(worker)report.records=await worker.evaluate(()=>({events:self.cancelEvents,routes:self.cancelRoutes})).catch(()=>null);}
finally{
 report.connections={hits:server?.hits,held:server?.held,released:server?.released};
 if(command)await command('disconnect').catch(()=>{});
 let closed=!browser;
 if(browser)try{await bounded(browser.close(),10000,'browser close');closed=true;}catch(error){report.result='FAIL';report.cleanupError=error.message;}
 if(server)try{await bounded(server.close(),10000,'fixture listener close');}catch(error){report.result='FAIL';report.cleanupError=error.message;}
 report.productUnchanged=JSON.stringify(before)===JSON.stringify(await hashes());if(!report.productUnchanged){report.result='FAIL';report.error='Product sources changed during acceptance';}
 if(closed && profile){await fs.rm(profile,{recursive:true,force:true});report.ownedProfileRemoved=true;}
 if(run){await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2)+'\n');await fs.writeFile(path.join(base,'latest.json'),JSON.stringify({result:report.result,report:path.join(run,'report.json')},null,2)+'\n');}
}
console.log(JSON.stringify({result:report.result,error:report.error,report:run && path.join(run,'report.json'),country:report.country,otherCountry:report.otherCountry,scenarios:report.scenarios.map(s=>({label:s.label,result:s.result,commandMs:s.commandMs,held:s.held.length}))},null,2));
if(report.result!=='PASS')process.exitCode=1;
