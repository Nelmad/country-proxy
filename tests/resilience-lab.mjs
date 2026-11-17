// Opt-in 30-minute acceptance test. Real HTTPS; loopback fixtures share ONE public IP.
// No normal Chrome profile, native registration, manual rotate, or global process kill.
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
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const quote=s=>"'"+s.replaceAll("'","'\"'\"'")+"'";
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const multi=process.env.TEST_MULTI_SOAK==='1';
let selection, outsideSelection, expectedSet;
const allowed=new Set(['www.cloudflare.com:443','www.google.com:443','example.com:443']);
const report={at:new Date().toISOString(),result:'FAIL',kind:'30-minute-controlled-resilience',
  provesDifferentPublicIP:false,productionIntervals:true,upstreamDials:[],droppedDialRecords:0,fallbackSchemeNote:'Chrome may normalize HTTP fallbackProxy to SOCKS4; all routes must retain the same fixed host/port',multiCountry:multi,minimumDurationSeconds:1800,scenarios:[],samples:[],runtime:[],intentionalStops:[]};
let browser,worker,popup,page,a,b,run,configPath,cc,wrong,command,started,monitorError;
let expectedEnabled=false,expectedCountry=null,monitor=null,closing=false,config,transitioning=false,controlSequence=0;
function log(event,extra={}){console.log(JSON.stringify({at:new Date().toISOString(),event,...extra}));}
async function save(){await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2)+'\n');}
async function boundedCleanup(operation, timeoutMs=15000) {
 let timer;
 try {
  return await Promise.race([
   Promise.resolve().then(operation),
   new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Cleanup timed out after '+timeoutMs+'ms')),timeoutMs);})
  ]);
 } finally {clearTimeout(timer);}
}
async function proxy(label){
 const sockets=new Set(),state={label,enabled:true,hits:[],closed:false};
 const server=http.createServer((req,res)=>{res.writeHead(405);res.end();});
 const track=socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});socket.setTimeout(65000,()=>socket.destroy());};
 server.on('connection',track);
 server.on('connect',(req,client,head)=>{
  if(!state.enabled || !allowed.has(req.url)){client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');return;}
  const [host,port]=req.url.split(':');const upstream=net.connect({host,port:Number(port)});track(upstream);
  // Observe the existing CONNECT path without overriding lookup, TLS or socket timers.
  if(report.upstreamDials.length<4096){
   const entry={at:Date.now(),listener:label,target:req.url,lookups:[]};
   report.upstreamDials.push(entry);
   upstream.on('lookup',(error,address,family)=>{
    if(entry.lookups.length<16)entry.lookups.push({at:Date.now(),address,family,error:error?.code});
   });
   upstream.once('connect',()=>{entry.connectedAt=Date.now();entry.peer=upstream.remoteAddress;});
   upstream.once('error',error=>{entry.errorAt=Date.now();entry.error=error.code || error.name;});
   upstream.once('timeout',()=>{entry.timeoutAt=Date.now();});
   upstream.once('close',()=>{entry.closedAt=Date.now();});
  }else report.droppedDialRecords++;

  upstream.on('connect',()=>{state.hits.push({at:Date.now(),target:req.url});client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});
  client.on('error',()=>upstream.destroy());upstream.on('error',()=>client.destroy());client.on('close',()=>upstream.destroy());upstream.on('close',()=>client.destroy());
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});state.port=server.address().port;
 state.fail=()=>{state.enabled=false;for(const s of sockets)s.destroy();};
 state.restore=()=>{state.enabled=true;};
 state.close=async()=>{if(state.closed)return;state.closed=true;state.fail();await new Promise(r=>server.close(r));};return state;
}
async function state(){return popup.evaluate(async()=>({...await chrome.storage.local.get(['status','selected','selectedCountries','selectionMode','enabled','pool']),route:await chrome.proxy.settings.get({incognito:false})}));}
function fixed(value){assert.equal(value.mode,'fixed_servers','enabled profile must never switch to DIRECT/system');const r=value.rules;assert.ok(r);for(const key of ['proxyForHttp','proxyForHttps','fallbackProxy'])assert.ok(r[key],key);assert.deepEqual(r.proxyForHttp,r.proxyForHttps);assert.equal(r.proxyForHttp.host,r.fallbackProxy.host);assert.equal(r.proxyForHttp.port,r.fallbackProxy.port);assert.ok(['http','https','socks4','socks5'].includes(r.fallbackProxy.scheme));assert.ok(r.bypassList.includes('<-loopback>'));}
function checkSelection(s){
 if(multi){
  assert.equal(s.selectionMode,'multiple');assert.equal(s.selected,null);
  assert.deepEqual(s.selectedCountries,expectedSet);assert.deepEqual(s.status.countries,expectedSet);
  if(s.status.country)assert.ok(expectedSet.includes(s.status.country));
 }else{
  assert.equal(s.selected,expectedCountry);if(s.status.country)assert.equal(s.status.country,expectedCountry);
 }
}
async function sample(){if(transitioning)return;const sequence=controlSequence;const s=await state();if(transitioning || sequence!==controlSequence)return;if(expectedEnabled){assert.equal(s.enabled,true);checkSelection(s);fixed(s.route.value);}else {assert.equal(s.enabled,false);}report.samples.push({at:Date.now(),phase:s.status?.phase,enabled:s.enabled,country:s.status?.country,selection:s.selectedCountries,port:s.status?.proxy?.port,mode:s.route.value.mode,routePort:s.route.value.rules?.proxyForHttps?.port});return s;}
async function waitFor(predicate,timeout=90000,label='condition'){
 const until=Date.now()+timeout;while(Date.now()<until){if(monitorError)throw monitorError;const s=await state();if(predicate(s))return s;await delay(250);}throw Error('Timed out: '+label);
}
async function connected(port,timeout=150000){const s=await waitFor(s=>s.status?.phase==='connected' && (!port || s.status.proxy?.port===port),timeout,'connected '+(port||''));checkSelection(s);assert.equal(s.status.country,cc);assert.equal(s.status.browser.country,cc);fixed(s.route.value);return s;}
async function trace(){await page.goto('https://www.cloudflare.com/cdn-cgi/trace?resilience='+Date.now(),{timeout:25000,waitUntil:'domcontentloaded'});const fields=Object.fromEntries((await page.locator('body').innerText()).trim().split('\n').map(x=>x.split('=')));assert.equal(fields.loc,cc);return {ip:fields.ip,country:fields.loc};}
async function start(country=cc){transitioning=true;controlSequence++;try{
 expectedCountry=country;expectedSet=country===cc?selection:outsideSelection;expectedEnabled=true;
 assert.equal((await command('connect',multi?{countries:expectedSet}:{country})).ok,true);
}finally{transitioning=false;}}
async function stop(){transitioning=true;controlSequence++;const window={start:Date.now()};report.intentionalStops.push(window);try{expectedEnabled=false;assert.equal((await command('disconnect')).ok,true);const s=await state();assert.equal(s.status.phase,'off');assert.equal(s.enabled,false);assert.notEqual(s.route.value.mode,'fixed_servers','disconnect must release extension-owned proxy');}finally{window.end=Date.now()+1000;transitioning=false;}}
async function sourceAvailable(available){config.sourcesAvailable=available;await fs.writeFile(configPath+'.tmp',JSON.stringify(config));await fs.rename(configPath+'.tmp',configPath);}
async function at(second){while(Date.now()-started<second*1000){if(monitorError)throw monitorError;await delay(Math.min(1000,second*1000-(Date.now()-started)));}}
async function scenario(name,fn){const entry={name,startedAt:new Date().toISOString(),result:'FAIL'};report.scenarios.push(entry);log('scenario-start',{name});try{Object.assign(entry,await fn());entry.result='PASS';}finally{entry.finishedAt=new Date().toISOString();await save();log('scenario-end',entry);}}
async function failProxy(){const before=await connected();const active=[a,b].find(p=>p.port===before.status.proxy.port),other=active===a?b:a;other.restore();await waitFor(s=>s.pool?.count>=1 && s.pool.expiresAt>Date.now(),90000,'warm reserve');const injectedAt=Date.now();active.fail(); // Idle detection: no tab requests and no rotate/check commands.
 const after=await connected(other.port);const result={from:active.port,to:other.port,secondsToRecovery:+((Date.now()-injectedAt)/1000).toFixed(1),page:await trace(),idleFailure:true};active.restore();return result;}
try{
 const base=path.join(root,'.runtime/acceptance-20261030/soak');await fs.mkdir(base,{recursive:true});run=await fs.mkdtemp(path.join(base,'run-'));report.evidenceDirectory=run;log('evidence',{run});
 const baselineCode=`import asyncio,json,sys\nsys.path.insert(0,${JSON.stringify(path.join(root,'native'))})\nfrom core import curl,TRACE,TARGET,country_code\nasync def main():\n a,b=await asyncio.gather(curl(TRACE,slow=True),curl(TARGET,slow=True))\n if a[0] or b[0] or a[1]!='200' or b[1]!='204':raise RuntimeError('Direct HTTPS baseline unavailable')\n fields=dict(x.split('=',1) for x in a[2].splitlines() if '=' in x)\n print(json.dumps({'country':country_code(fields.get('loc')),'ip':fields.get('ip')}))\nasyncio.run(main())`;
 const baseline=JSON.parse((await exec(path.join(root,'.venv/bin/python'),['-I','-B','-c',baselineCode],{timeout:50000})).stdout);cc=baseline.country;wrong=cc==='NO'?'EE':'NO';report.baseline=baseline;report.country=cc;report.wrongCountry=wrong;
 const peers=['NO','EE','AT'].filter(country=>country!==cc);
 selection=[cc,...peers.slice(0,2)].sort();outsideSelection=peers.slice(0,2).sort();
 report.selection=multi?selection:[cc];report.outsideSelection=multi?outsideSelection:[wrong];
 report.sourceFingerprints={};for(const dir of ['native','extension'])for(const name of (await fs.readdir(path.join(root,dir))).sort()){if(!name.endsWith('.py')&&!name.endsWith('.js'))continue;report.sourceFingerprints[dir+'/'+name]=sha(await fs.readFile(path.join(root,dir,name)));}
 a=await proxy('A');b=await proxy('B');b.enabled=false;configPath=path.join(run,'fixtures.json');config={ports:[a.port,b.port],sourcesAvailable:true};await sourceAvailable(true);
 const launcher=path.join(run,'host');await fs.writeFile(launcher,'#!/bin/sh\nexec '+quote(path.join(root,'.venv/bin/python'))+' -I -B '+quote(path.join(root,'tests/resilience_fixture.py'))+' '+quote(configPath)+'\n',{mode:0o700});
 const manifest=JSON.parse(await fs.readFile(path.join(root,'extension/manifest.json')));const id=sha(Buffer.from(manifest.key,'base64')).slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
 const profile=path.join(run,'profile');await fs.mkdir(path.join(profile,'NativeMessagingHosts'),{recursive:true});await fs.writeFile(path.join(profile,'NativeMessagingHosts/local.country_proxy.json'),JSON.stringify({name:'local.country_proxy',description:'Disposable resilience fixture',path:launcher,type:'stdio',allowed_origins:[`chrome-extension://${id}/`]}),{mode:0o600});
 browser=await chromium.launchPersistentContext(profile,{headless:true,channel:'chromium',ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${root}/extension`,`--load-extension=${root}/extension`,'--disable-quic'],viewport:{width:640,height:650}});
 worker=browser.serviceWorkers()[0]||await browser.waitForEvent('serviceworker',{timeout:20000});report.runtime.push(await inspectRuntime(browser,root));
 popup=await browser.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);page=await browser.newPage();command=(action,extra={})=>popup.evaluate(m=>chrome.runtime.sendMessage(m),{action,...extra});
 await command('disconnect');await command('settings',{countries:[cc,wrong]});await worker.evaluate(()=>{self.resilienceRoutes=[];self.resilienceStates=[];self.resilienceErrors=[];chrome.proxy.settings.onChange.addListener(e=>self.resilienceRoutes.push({at:Date.now(),value:e.value}));chrome.storage.onChanged.addListener((c,a)=>{if(a==='local'&&c.status)self.resilienceStates.push(c.status.newValue);});chrome.proxy.onProxyError.addListener(e=>self.resilienceErrors.push({at:Date.now(),error:e.error,fatal:e.fatal}));});
 await start();await connected(a.port);report.initialPage=await trace();b.restore();started=Date.now();report.startedAt=new Date(started).toISOString();
 monitor=(async()=>{let lastHeartbeat=0;while(!closing){try{await sample();if(Date.now()-lastHeartbeat>30000){lastHeartbeat=Date.now();log('heartbeat',{elapsedSeconds:Math.round((Date.now()-started)/1000),last:report.samples.at(-1)});await save();}}catch(e){monitorError=e;return;}await delay(1000);}})();
 await at(30);await scenario('proxy-A-idle-failure-with-reserve',failProxy);
 await at(270);await scenario('proxy-B-idle-failure-with-reserve',failProxy);
 await at(510);await scenario('native-helper-loss-and-automatic-reconnect',async()=>{
  const ownership=JSON.parse(await fs.readFile(path.join(run,'native-pid.json'),'utf8'));assert.equal(ownership.config,configPath);assert.ok(Number.isInteger(ownership.pid)&&ownership.pid>1);
  const commandline=(await exec('/bin/ps',['-p',String(ownership.pid),'-o','command='])).stdout;assert.ok(commandline.includes(path.join(root,'tests/resilience_fixture.py'))&&commandline.includes(configPath),'PID is not the exact owned fixture');
  const injectedAt=Date.now();process.kill(ownership.pid,'SIGTERM');await waitFor(s=>s.status?.phase==='helper',15000,'helper loss');const blocked=await state();assert.equal(blocked.route.value.rules.proxyForHttps.port,9);
  await connected(null,90000);const replacement=JSON.parse(await fs.readFile(path.join(run,'native-pid.json'),'utf8'));assert.notEqual(replacement.pid,ownership.pid);return {oldPID:ownership.pid,newPID:replacement.pid,secondsToRecovery:+((Date.now()-injectedAt)/1000).toFixed(1),page:await trace()};
 });
 await at(750);await scenario('source-outage-and-automatic-retry',async()=>{await sourceAvailable(false);await stop();await start();const empty=await waitFor(s=>s.status?.phase==='empty',30000,'source outage empty');assert.ok(empty.status.warnings.some(x=>x.includes('недоступны')));assert.equal(empty.route.value.rules.proxyForHttps.port,9);const recoveredAt=Date.now();await sourceAvailable(true);await connected(null,100000);return {warning:empty.status.warnings,secondsToRecovery:+((Date.now()-recoveredAt)/1000).toFixed(1),page:await trace()};});
 await at(990);await scenario('wrong-country-rejected-and-country-change',async()=>{await start(wrong);const empty=await waitFor(s=>s.status?.phase==='empty',60000,'GeoIP country rejection');assert.ok(empty.status.diagnostics?.failures?.country>0);checkSelection(empty);assert.equal(empty.route.value.rules.proxyForHttps.port,9);await start(cc);await connected();return {requestedWrong:report.outsideSelection,actualCountry:cc,rejections:empty.status.diagnostics.failures.country,page:await trace()};});
 await at(1230);await scenario('disconnect-cancels-source-retry-and-stays-off',async()=>{await sourceAvailable(false);await stop();await start();await waitFor(s=>s.status?.phase==='empty',30000,'pending source retry');await stop();await sourceAvailable(true);const until=Date.now()+65000;while(Date.now()<until){const s=await state();assert.equal(s.enabled,false);assert.equal(s.status.phase,'off');assert.notEqual(s.route.value.mode,'fixed_servers');await delay(500);}await start();await connected();return {observedOffSeconds:65,page:await trace()};});
 if(multi){
  await at(1320);await scenario('failed-reserve-removed-and-recovered-while-active-stays-healthy',async()=>{
   const current=await connected(),activePort=current.status.proxy.port;
   const reserve=[a,b].find(p=>p.port!==activePort);
   const healthy=s=>s.status?.phase==='connected' && s.status.proxy.port===activePort;
   await waitFor(s=>healthy(s) && s.pool?.count===1 && s.pool.expiresAt>Date.now(),90000,'one fresh reserve');
   const failedAt=Date.now();reserve.fail();
   await waitFor(s=>healthy(s) && s.pool?.count===0,100000,'reserve removed');
   const restoredAt=Date.now();reserve.restore();
   await waitFor(s=>healthy(s) && s.pool?.count===1 && s.pool.expiresAt>Date.now(),180000,'reserve requalified');
   const samples=report.samples.filter(s=>s.at>=failedAt);
   assert.ok(samples.length && samples.every(s=>s.phase==='connected' && s.routePort===activePort));
   return {activePort,reservePort:reserve.port,removedSeconds:(restoredAt-failedAt)/1000,requalifiedSeconds:(Date.now()-restoredAt)/1000,page:await trace()};
  });
 }
 await at(1500);await scenario('third-idle-proxy-failure-after-recovery',failProxy);
 await at(1800);report.finalPage=await trace();await connected();report.runtime.push(await inspectRuntime(browser,root));
 for(const [name,digest] of Object.entries(report.sourceFingerprints))assert.equal(sha(await fs.readFile(path.join(root,name))),digest,'Production source changed during soak: '+name);
 const events=await worker.evaluate(()=>({routes:self.resilienceRoutes,states:self.resilienceStates,errors:self.resilienceErrors}));report.events=events;for(const route of events.routes.filter(r=>r.at>=started)){if(route.value.mode==='fixed_servers')fixed(route.value);else assert.ok(report.intentionalStops.some(w=>route.at>=w.start&&route.at<=w.end),'Non-fixed route outside explicit disconnect');}assert.ok(events.states.some(s=>s.phase==='helper'));assert.ok(events.states.some(s=>s.phase==='reserve'));assert.ok(events.states.some(s=>s.phase==='empty'));assert.ok(events.errors.every(e=>e.fatal),'nonfatal proxy error/direct fallback observed');
 report.durationSeconds=+( (Date.now()-started)/1000 ).toFixed(1);assert.ok(report.durationSeconds>=1800);assert.equal(report.scenarios.filter(s=>s.result==='PASS').length,multi?8:7);if(monitorError)throw monitorError;report.result='PASS';
}catch(error){report.error={message:error.message,stack:error.stack};if(worker)report.events=await worker.evaluate(()=>({routes:self.resilienceRoutes,states:self.resilienceStates,errors:self.resilienceErrors})).catch(()=>null);log('failure',report.error);
}finally{
 closing=true;
 const cleanup={errors:[],browserClosed:!browser,profileRemoved:!run};
 const attempt=async(stage,operation)=>{
  try {await boundedCleanup(operation);return true;}
  catch(error){cleanup.errors.push({stage,message:error.message});return false;}
 };
 if(command)await attempt('disconnect',()=>command('disconnect'));
 if(browser)cleanup.browserClosed=await attempt('browser.close',()=>browser.close());
 await Promise.all([a,b].filter(Boolean).map(p=>attempt('proxy-'+p.label,()=>p.close())));
 if(monitor)await attempt('monitor',()=>monitor);
 // Keep the owned profile for diagnosis if browser closure was not confirmed.
 if(run && cleanup.browserClosed)cleanup.profileRemoved=await attempt('profile.remove',()=>fs.rm(path.join(run,'profile'),{recursive:true,force:true}));
 report.cleanup=cleanup;report.cleanedDisposableProfile=cleanup.profileRemoved;
 if(cleanup.errors.length){report.result='FAIL';report.error??={message:'Cleanup failed: '+cleanup.errors.map(e=>e.stage+': '+e.message).join('; ')};}
 report.finishedAt=new Date().toISOString();report.connections={A:a?.hits.length,B:b?.hits.length};
 if(run)await save();
}
log('result',{result:report.result,run,scenarios:report.scenarios.map(s=>({name:s.name,result:s.result})),durationSeconds:report.durationSeconds,error:report.error?.message});
if(report.result!=='PASS')process.exitCode=1;
