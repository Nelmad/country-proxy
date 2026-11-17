// Optional equal-priority country-set acceptance in an owned test profile.
// Real HTTPS/GeoIP, two loopback endpoints with one real egress. No public-pair claim.
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
const sourceQuality=process.env.TEST_SOURCE_QUALITY==='1';
const streaming=sourceQuality || process.env.TEST_STREAMING==='1';
const base=path.join(root,'.runtime/multi-country-20261030');
const quote=s=>"'"+s.replaceAll("'","'\"'\"'")+"'";
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const digest=text=>crypto.createHash('sha256').update(text).digest('hex');
async function bounded(task,ms,label){let timer;try{return await Promise.race([task,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Timed out: '+label)),ms);})]);}finally{clearTimeout(timer);}}
async function waitFor(fn,label,ms=30000){const until=Date.now()+ms;while(Date.now()<until){const value=await fn();if(value)return value;await delay(100);}throw Error('Timed out: '+label);}
async function hashes(){const result={};for(const dir of ['native','extension']){async function walk(at){for(const entry of (await fs.readdir(at,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(entry.name==='__pycache__'||entry.name.endsWith('.pyc'))continue;const p=path.join(at,entry.name);if(entry.isDirectory())await walk(p);else if(entry.isFile())result[path.relative(root,p)]=digest(await fs.readFile(p));}}await walk(path.join(root,dir));}return result;}
async function fixtureProxy(label){
 const sockets=new Set(),connections=[];let closed=false;
 const server=http.createServer((_req,res)=>{res.writeHead(405);res.end();});
 const track=s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('error',()=>{});s.setTimeout(65000,()=>s.destroy());};
 server.on('connection',track);
 server.on('connect',(req,client,head)=>{
  if(!new Set(['www.cloudflare.com:443','www.google.com:443','example.com:443']).has(req.url)){client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');return;}
  const [host,port]=req.url.split(':');const row={target:req.url,at:Date.now(),upstreamBytes:0,clientBytes:0};connections.push(row);
  const upstream=net.connect({host,port:Number(port)});track(upstream);
  client.on('data',chunk=>{row.clientBytes+=chunk.length;});upstream.on('data',chunk=>{row.upstreamBytes+=chunk.length;});
  upstream.on('connect',()=>{if(client.destroyed){upstream.destroy();return;}client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});
  client.on('close',()=>upstream.destroy());upstream.on('close',()=>client.destroy());upstream.on('error',()=>client.destroy());
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 return {label,port:server.address().port,connections,traceBytes:()=>connections.filter(c=>c.target==='www.cloudflare.com:443').reduce((n,c)=>n+c.upstreamBytes,0),
  close:async()=>{if(closed)return;closed=true;const stopped=new Promise(r=>server.close(r));for(const socket of sockets)socket.destroy();await stopped;}};
}
const report={at:new Date().toISOString(),kind:'multi-country-ui-loopback',result:'FAIL',mainChromeTouched:false,provesLiveCrossCountryReplacement:false,provesDifferentPublicIP:false,identityRelaxation:'Fixture accepts distinct loopback ports sharing one host/egress; production distinct-host/egress policy is unchanged.',checks:[],screenshots:[]};
let run,profile,browser,popup,worker,command,servers=[];
const before=await hashes();
try{
 await fs.mkdir(base,{recursive:true});run=await fs.mkdtemp(path.join(base,'run-'));profile=path.join(run,'profile');report.profile=profile;
 const baselineCode=`import asyncio,json,sys\nsys.path.insert(0,${JSON.stringify(path.join(root,'native'))})\nfrom core import curl,TRACE,TARGET,country_code\nasync def main():\n a,b=await asyncio.gather(curl(TRACE,slow=True),curl(TARGET,slow=True))\n if a[0] or b[0] or a[1]!='200' or b[1]!='204':raise RuntimeError('Real HTTPS baseline unavailable')\n fields=dict(x.split('=',1) for x in a[2].splitlines() if '=' in x)\n print(json.dumps({'country':country_code(fields.get('loc'))}))\nasyncio.run(main())`;
 const {country:cc}=JSON.parse((await exec(path.join(root,'.venv/bin/python'),['-I','-B','-c',baselineCode],{timeout:50000})).stdout);report.actualCountry=cc;
 const other=['EE','NO','AT'].filter(code=>code!==cc).slice(0,2),selection=[...other,cc].sort();report.selection=selection;
 servers=await Promise.all(['A','B'].map(fixtureProxy));report.fixturePorts=servers.map(s=>s.port);
 const config=path.join(run,'config.json'),eventsFile=path.join(run,'native-events.jsonl');await fs.writeFile(config,JSON.stringify({ports:servers.map(s=>s.port),streaming,sourceQuality}),{mode:0o600});
 const launcher=path.join(run,'host');await fs.writeFile(launcher,'#!/bin/sh\nexec '+quote(path.join(root,'.venv/bin/python'))+' -I -B '+quote(path.join(root,'tests/multi_country_fixture.py'))+' '+quote(config)+'\n',{mode:0o700});
 const manifest=JSON.parse(await fs.readFile(path.join(root,'extension/manifest.json')));
 const id=crypto.createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
 const registration=path.join(profile,'NativeMessagingHosts');await fs.mkdir(registration,{recursive:true});
 await fs.writeFile(path.join(registration,'local.country_proxy.json'),JSON.stringify({name:'local.country_proxy',description:'Disposable multi-country acceptance',path:launcher,type:'stdio',allowed_origins:[`chrome-extension://${id}/`]}),{mode:0o600});
 const state=()=>bounded(popup.evaluate(()=>chrome.storage.local.get(null)),5000,'state');
 const route=()=>bounded(worker.evaluate(()=>chrome.proxy.settings.get({incognito:false})),5000,'route');
 const records=()=>bounded(worker.evaluate(()=>({statuses:self.multiStatuses,routes:self.multiRoutes})),5000,'records');
 async function inspectPage(page,names){const cdp=await browser.newCDPSession(page),scripts=[];cdp.on('Debugger.scriptParsed',event=>scripts.push(event));try{await cdp.send('Debugger.enable');const result=[];for(const name of names){const script=scripts.find(item=>item.url===`chrome-extension://${id}/${name}`);assert.ok(script,'Missing executed page script '+name);const {scriptSource}=await cdp.send('Debugger.getScriptSource',{scriptId:script.scriptId});const disk=await fs.readFile(path.join(root,'extension',name),'utf8');assert.equal(scriptSource,disk,'Stale executed page script '+name);result.push({name,executedSHA:digest(scriptSource),diskSHA:digest(disk),equal:true});}return result;}finally{await cdp.detach();}}
 async function launch(){
  browser=await chromium.launchPersistentContext(profile,{headless:true,channel:'chromium',ignoreDefaultArgs:['--disable-extensions'],viewport:{width:392,height:600},args:[`--disable-extensions-except=${root}/extension`,`--load-extension=${root}/extension`,'--disable-quic']});
  report.browser=browser.browser().version();worker=browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker',{timeout:20000});
  (report.runtimes ||= []).push(await inspectRuntime(browser,root));popup=await browser.newPage();popup.setDefaultTimeout(5000);await popup.goto(`chrome-extension://${id}/popup.html`);
  command=(action,extra={})=>bounded(popup.evaluate(m=>chrome.runtime.sendMessage(m),{action,...extra}),5000,'command '+action);
  await waitFor(async()=>{const s=await state();return s.status && await popup.locator('#phase').innerText()!=='Загрузка…';},'popup initialized');
  (report.pageRuntimes ||= []).push(await inspectPage(popup,['popup.js','country-catalog.js']));
  await worker.evaluate(()=>{self.multiStatuses=[];self.multiRoutes=[];chrome.storage.onChanged.addListener((c,a)=>{if(a==='local'&&c.status)self.multiStatuses.push(c.status.newValue);});chrome.proxy.settings.onChange.addListener(e=>self.multiRoutes.push({at:Date.now(),value:e.value}));});
 }
 async function assertOff(){const s=await state();assert.equal(s.enabled,false);assert.equal(s.status.phase,'off');assert.notEqual((await route()).levelOfControl,'controlled_by_this_extension');return s;}
 async function openPicker(){if(!await popup.locator('#country-picker').isVisible())await popup.locator('#country').click();await popup.locator('#country-picker').waitFor({state:'visible'});}
 async function screenshot(label){const target=path.join(run,label+'.png');await popup.screenshot({path:target,fullPage:true});report.screenshots.push(target);}
 async function setDraft(countries){await popup.locator('#mode-multiple').click();await openPicker();await popup.locator('#country-search').fill('');for(const code of await popup.locator('input[data-select-country]:checked').evaluateAll(es=>es.map(e=>e.dataset.selectCountry)))if(!countries.includes(code))await popup.locator(`input[data-select-country="${code}"]`).uncheck();for(const code of countries){await popup.locator('#country-search').fill(code);await popup.locator(`input[data-select-country="${code}"]`).check();}await popup.locator('#country-search').fill('');assert.deepEqual((await popup.locator('input[data-select-country]:checked').evaluateAll(es=>es.map(e=>e.dataset.selectCountry))).sort(),[...countries].sort());}
 function assertSelection(s,countries=selection){assert.deepEqual(s.selectedCountries,countries);assert.equal(s.selectionMode,'multiple');assert.equal(s.selected,null);assert.deepEqual(s.status.countries,countries);if(s.status.country)assert.ok(countries.includes(s.status.country));if(s.pool?.countries)assert.deepEqual(s.pool.countries,countries);}
 async function fixtureRoute(server){const r=await route();assert.equal(r.levelOfControl,'controlled_by_this_extension');assert.equal(r.value.mode,'fixed_servers');for(const key of ['proxyForHttp','proxyForHttps'])assert.deepEqual(r.value.rules[key],{scheme:'http',host:'127.0.0.1',port:server.port});assert.equal(r.value.rules.fallbackProxy.host,'127.0.0.1');assert.equal(r.value.rules.fallbackProxy.port,server.port);return r;}
 async function ordinaryHTTPS(server,label){const beforeBytes=server.traceBytes();const page=await browser.newPage();try{await page.goto('https://www.cloudflare.com/cdn-cgi/trace?multi-country='+Date.now(),{timeout:30000,waitUntil:'domcontentloaded'});const fields=Object.fromEntries((await page.locator('body').innerText()).trim().split('\n').filter(x=>x.includes('=')).map(x=>x.split('=')));assert.equal(fields.loc,cc);assert.ok(selection.includes(fields.loc));assert.ok(server.traceBytes()>beforeBytes,'ordinary HTTPS must traverse the selected fixture');return {label,country:fields.loc,exitIp:fields.ip,traceBytesBefore:beforeBytes,traceBytesAfter:server.traceBytes(),route:await fixtureRoute(server)};}finally{await page.close();}}
 async function connected(label,expectedPort=null,ms=80000){return waitFor(async()=>{const s=await state();assertSelection(s);assert.equal(s.enabled,true);if(s.status.phase==='helper'||s.status.phase==='error')throw Error(JSON.stringify(s.status));if(s.status.phase==='connected'&&(!expectedPort||s.status.proxy.port===expectedPort)){assert.equal(s.status.browser.country,cc);assert.equal(s.status.country,cc);return s;}return false;},label,ms);}
 await launch();const fresh=await assertOff();assert.equal(fresh.selected,null);assert.deepEqual(fresh.selectedCountries,[]);assert.equal(fresh.selectionMode,'single');
 await setDraft([...selection].reverse());await assertOff();assert.deepEqual((await state()).selectedCountries,[]);await screenshot('three-country-draft');
 await popup.locator('#selection-cancel').click();await assertOff();assert.deepEqual((await state()).selectedCountries,[]);
 assert.equal((await records()).routes.length,0);assert.equal((await records()).statuses.some(s=>s.phase!=='off'),false);
 await fs.access(eventsFile).then(()=>{throw Error('Native helper started during draft');},e=>{if(e.code!=='ENOENT')throw e;});
 report.checks.push({name:'optional-mode-three-country-draft-and-cancel-have-no-connection-side-effects',result:'PASS'});
 await setDraft([...selection].reverse());await popup.locator('#selection-apply').click();await popup.locator('#country-picker').waitFor({state:'hidden'});const first=await connected('three-country connection');const active=servers.find(s=>s.port===first.status.proxy.port),replacement=servers.find(s=>s!==active);assert.ok(active);assert.ok(replacement);
 report.first=first;report.firstHTTPS=await ordinaryHTTPS(active,'initial-three-country-set');
 if(streaming){
  const native=(await fs.readFile(eventsFile,'utf8')).trim().split('\n').map(JSON.parse);
  const check=native.find(e=>e.event==='checker-start');assert.ok(check,'actual native checker must start');
  const leases=Object.entries(check.streams);assert.equal(leases.length,selection.length);
  for(const [country,lease] of leases){assert.ok(check.pending.includes(lease+':slow'),'slow source still pending for '+country);assert.ok(native.some(e=>e.event==='feed-start'&&e.lease===lease&&e.kind==='slow'&&e.mono<check.mono));}
  const connection=native.find(e=>e.event==='connected'&&e.session===check.session);assert.ok(connection);assert.ok(connection.mono>check.mono);assert.deepEqual(connection.pending,[],'source cancellation must drain before foreground connected');
  for(const [,lease] of leases){const cancel=native.find(e=>e.event==='feed-cancel'&&e.lease===lease&&e.kind==='slow');const dispose=native.find(e=>e.event==='stream-disposed'&&e.lease===lease);assert.ok(cancel&&cancel.mono<connection.mono);assert.ok(dispose&&dispose.mono<connection.mono);assert.deepEqual(dispose.pending,[]);assert.equal(dispose.flights,0);}
  report.streamingEvidence={checker:check,connection,events:native};
  report.checks.push({name:'actual-checker-starts-with-same-country-feed-and-other-country-producer-pending-and-drains-before-connected',result:'PASS'});
  await fs.writeFile(path.join(run,'release-slow'),'initial ordinary Chrome HTTPS succeeded\n',{mode:0o600});
 }
await screenshot('three-country-connected');
 const discovered=(await fs.readFile(eventsFile,'utf8')).trim().split('\n').map(JSON.parse).filter(e=>e.event==='discover').map(e=>e.country);for(const code of selection)assert.ok(discovered.includes(code),'discovery must consult each selected country');report.discoveredCountries=[...new Set(discovered)].sort();
 report.checks.push({name:'apply-three-canonical-equal-country-set-real-https-inside-set',result:'PASS',actualCountry:cc,countries:selection});
 const baselineRoute=await fixtureRoute(active),baseline=await records();await setDraft(other);await assertSelection(await state());assert.deepEqual(await fixtureRoute(active),baselineRoute);await popup.locator('#selection-cancel').click();assertSelection(await state());assert.deepEqual(await fixtureRoute(active),baselineRoute);assert.equal((await records()).routes.length,baseline.routes.length);
 report.checks.push({name:'editing-and-cancelling-active-set-preserves-connection',result:'PASS'});
 report.reserve=await waitFor(async()=>{const s=await state();assertSelection(s);return s.pool?.count>=1&&s.pool.expiresAt>Date.now()?s.pool:false;},'ready loopback reserve',90000);
 async function inspectSourceQuality(expectedChrome) {
  const rows = await Promise.all(selection.map(async country => {
   const response = await command('sourceQuality', {country});
   assert.equal(response.ok, true);
   const q = response.report;
   assert.equal(q.country, country);
   assert.equal(q.windowSeconds, 300);
   assert.equal(q.nativeWorking, 2);
   assert.ok(!q.groups.some(row => row.group === 'fixture-mirror'));
   for (const group of ['fixture-fast', 'fixture-peer']) {
    const row = q.groups.find(row => row.group === group);
    assert.equal(row.nativeWorking, 2);
    assert.ok(Math.abs(row.nativeQualifiedShare - 2/(2*selection.length)) < 1e-8);
    assert.ok(Math.abs(row.browserConfirmedShare - expectedChrome/(2*selection.length)) < 1e-8);
   }
   assert.ok(q.feeds.some(feed => feed.source === 'fixture-mirror' && feed.group === 'fixture-fast' && feed.completed >= 1));
   return q;
  }));
  return rows;
 }
 if (sourceQuality) {
  report.qualityBefore = await inspectSourceQuality(1);
  await popup.locator('#source-quality summary').click();
  await popup.locator('#source-country').selectOption(selection[1]);
  await popup.locator('#source-table').waitFor({state:'visible'});
  assert.ok((await popup.locator('#source-table').innerText()).includes('fixture-fast'));
  await screenshot('source-quality');
  await popup.locator('#source-quality summary').click();
 }
 const eventStart=(await records()).statuses.length,routeStart=(await records()).routes.length;report.failedAt=Date.now();await bounded(active.close(),10000,'kill active proxy');
 // Physical failure only. No rotate/check/reconnect command is sent.
 const second=await connected('automatic replacement after stopped listener',replacement.port,100000);report.secondsToReplacement=+((Date.now()-report.failedAt)/1000).toFixed(1);report.second=second;report.secondHTTPS=await ordinaryHTTPS(replacement,'automatic-replacement');
 if(sourceQuality) {
  report.qualityAfter = await inspectSourceQuality(2);
  report.checks.push({name:'two-unique-endpoints-mirrors-three-country-fractional-native-and-Chrome-votes',result:'PASS'});
 }
 const post=await records(),events=post.statuses.slice(eventStart),routes=post.routes.slice(routeStart);assert.ok(events.some(s=>s.phase==='replacing'));assert.ok(events.some(s=>s.phase==='reserve'));assert.ok(routes.some(r=>r.value.rules?.proxyForHttps?.port===9),'replacement gap must be blocked');for(const s of events){assert.deepEqual(s.countries,selection);if(s.country)assert.ok(selection.includes(s.country));}for(const r of routes)assert.equal(r.value.mode,'fixed_servers');
 report.replacementEvents=events;report.replacementRoutes=routes;await screenshot('three-country-after-replacement');report.checks.push({name:'automatic-fixture-endpoint-replacement-preserves-set-and-blocks-gap',result:'PASS',seconds:report.secondsToReplacement,actualCountry:cc,liveCrossCountry:false});
 report.recordsBeforeRestart=await records();await bounded(browser.close(),10000,'close before persistence restart');browser=null;command=null;await launch();report.restored=await connected('saved multi-country selection automatic restore',replacement.port);report.restoredHTTPS=await ordinaryHTTPS(replacement,'restored-multi-country-set');report.checks.push({name:'actual-profile-restart-restores-set-without-single-country-conversion',result:'PASS'});
 // Real GeoIP is outside this new set, so no fixture may be accepted.
 const wrong=[...other].sort();await setDraft(wrong);await popup.locator('#selection-apply').click();await popup.locator('#country-picker').waitFor({state:'hidden'});
 const wrongStart=(await records()).statuses.length;report.wrongSet=await waitFor(async()=>{const s=await state();assertSelection(s,wrong);assert.notEqual(s.status.phase,'connected');return s.status.phase==='empty'&&s.status.diagnostics?.failures?.country>=1?s:false;},'real GeoIP rejects country outside selected set',70000);const blocked=await route();assert.equal(blocked.value.mode,'fixed_servers');assert.equal(blocked.value.rules.proxyForHttps.port,9);assert.equal((await records()).statuses.slice(wrongStart).some(s=>s.phase==='connected'),false);report.wrongSetRoute=blocked;await screenshot('outside-set-rejected');report.checks.push({name:'real-geography-outside-selected-set-rejected-with-blocked-route',result:'PASS',selectedCountries:wrong,actualCountry:cc});
 if(sourceQuality) {
  const {report:q}=await command('sourceQuality',{country:wrong[0]});
  assert.equal(q.nativeWorking,0);assert.ok(q.groups.every(g=>g.nativeQualifiedShare===0 && g.browserConfirmedShare===0));
 }
 await popup.locator('#disconnect').click();await waitFor(async()=>(await state()).status.phase==='off','final disconnect');await assertOff();report.finalDisconnect=true;report.records=await records();report.result='PASS';
}catch(error){report.error=error.stack||error.message;if(popup&&run){await popup.screenshot({path:path.join(run,'failure.png'),fullPage:true}).catch(()=>{});report.failureScreenshot=path.join(run,'failure.png');}if(worker)report.records=await bounded(worker.evaluate(()=>({statuses:self.multiStatuses,routes:self.multiRoutes})),5000,'failure records').catch(()=>null);}
finally{
 report.connections=servers.map(server=>({label:server.label,port:server.port,connections:server.connections}));if(command)await command('disconnect').catch(()=>{});
 let closed=!browser;if(browser)try{await bounded(browser.close(),10000,'browser close');closed=true;}catch(error){report.result='FAIL';report.cleanupError=error.message;}
 for(const server of servers)try{await bounded(server.close(),10000,'fixture close');}catch(error){report.result='FAIL';report.cleanupError=error.message;}
 report.productUnchanged=JSON.stringify(before)===JSON.stringify(await hashes());if(!report.productUnchanged){report.result='FAIL';report.error=[report.error,'Product sources changed during acceptance'].filter(Boolean).join('; ');}
 if(streaming&&run){
  const native=await fs.readFile(path.join(run,'native-events.jsonl'),'utf8').then(t=>t.trim().split('\n').map(JSON.parse)).catch(()=>[]);report.nativeEvents=native;
  const disposed=new Set();for(const event of native){if(event.lease&&disposed.has(event.lease)&&event.event!=='stream-disposed'){report.result='FAIL';report.error='Activity after stream disposal: '+JSON.stringify(event);}if(event.event==='stream-disposed'){disposed.add(event.lease);if(event.pending.length||event.flights){report.result='FAIL';report.error='Leaked stream ownership: '+JSON.stringify(event);}}}
 }
 if(closed&&profile){await fs.rm(profile,{recursive:true,force:true});report.ownedProfileRemoved=true;}
 if(run){await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2)+'\n');await fs.writeFile(path.join(base,'latest.json'),JSON.stringify({result:report.result,report:path.join(run,'report.json')},null,2)+'\n');}
}
console.log(JSON.stringify({result:report.result,error:report.error,report:run&&path.join(run,'report.json'),actualCountry:report.actualCountry,selection:report.selection,checks:report.checks},null,2));if(report.result!=='PASS')process.exitCode=1;
