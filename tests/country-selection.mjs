// Country-picker acceptance in an owned profile with real HTTPS/GeoIP through a local fixture.
// This verifies selection and connection behavior, not public proxy coverage for all countries.
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
const base=path.join(root,'.runtime/country-selection-20261030');
const quote=s=>"'"+s.replaceAll("'","'\"'\"'")+"'";
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function bounded(task,ms,label){let timer;try{return await Promise.race([task,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Timed out: '+label)),ms);})]);}finally{clearTimeout(timer);}}
async function waitFor(fn,label,ms=30000){const until=Date.now()+ms;while(Date.now()<until){const value=await fn();if(value)return value;await delay(100);}throw Error('Timed out: '+label);}
async function hashes(){const result={};for(const dir of ['native','extension']){async function walk(at){for(const entry of (await fs.readdir(at,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(entry.name==='__pycache__'||entry.name.endsWith('.pyc'))continue;const p=path.join(at,entry.name);if(entry.isDirectory())await walk(p);else if(entry.isFile())result[path.relative(root,p)]=crypto.createHash('sha256').update(await fs.readFile(p)).digest('hex');}}await walk(path.join(root,dir));}return result;}
async function fixtureProxy(){
 const sockets=new Set(),connections=[];
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
 return {port:server.address().port,connections,traceBytes:()=>connections.filter(c=>c.target==='www.cloudflare.com:443').reduce((n,c)=>n+c.upstreamBytes,0),
  close:async()=>{const closed=new Promise(r=>server.close(r));for(const socket of sockets)socket.destroy();await closed;}};
}
const report={at:new Date().toISOString(),kind:'country-selection-ui',result:'FAIL',mainChromeTouched:false,publicProxyCoverage:false,checks:[],screenshots:[]};
let run,profile,browser,popup,worker,server,eventsFile,command;
const before=await hashes();
try{
 await fs.mkdir(base,{recursive:true});run=await fs.mkdtemp(path.join(base,'run-'));profile=path.join(run,'profile');report.profile=profile;
 const baselineCode=`import asyncio,json,sys\nsys.path.insert(0,${JSON.stringify(path.join(root,'native'))})\nfrom core import curl,TRACE,TARGET,country_code\nasync def main():\n a,b=await asyncio.gather(curl(TRACE,slow=True),curl(TARGET,slow=True))\n if a[0] or b[0] or a[1]!='200' or b[1]!='204':raise RuntimeError('Real HTTPS baseline unavailable')\n fields=dict(x.split('=',1) for x in a[2].splitlines() if '=' in x)\n print(json.dumps({'country':country_code(fields.get('loc'))}))\nasyncio.run(main())`;
 const {country:cc}=JSON.parse((await exec(path.join(root,'.venv/bin/python'),['-I','-B','-c',baselineCode],{timeout:50000})).stdout);report.country=cc;
 const catalog=JSON.parse(await fs.readFile(path.join(root,'extension/countries.json'),'utf8'));report.catalogCount=catalog.length;assert.equal(catalog.length,249);
 server=await fixtureProxy();report.fixturePort=server.port;
 const config=path.join(run,'config.json');eventsFile=path.join(run,'native-events.jsonl');
 await fs.writeFile(config,JSON.stringify({port:server.port,arm:path.join(run,'unused-arm'),hold:path.join(run,'unused-hold'),events:eventsFile}));
 const launcher=path.join(run,'host');await fs.writeFile(launcher,'#!/bin/sh\nexec '+quote(path.join(root,'.venv/bin/python'))+' -I -B '+quote(path.join(root,'tests/control_cancel_fixture.py'))+' '+quote(config)+'\n',{mode:0o700});
 const manifest=JSON.parse(await fs.readFile(path.join(root,'extension/manifest.json')));
 const id=crypto.createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
 const registration=path.join(profile,'NativeMessagingHosts');await fs.mkdir(registration,{recursive:true});
 await fs.writeFile(path.join(registration,'local.country_proxy.json'),JSON.stringify({name:'local.country_proxy',description:'Disposable country picker acceptance',path:launcher,type:'stdio',allowed_origins:[`chrome-extension://${id}/`]}),{mode:0o600});
 const state=()=>bounded(popup.evaluate(()=>chrome.storage.local.get(null)),5000,'state');
 const route=()=>bounded(worker.evaluate(()=>chrome.proxy.settings.get({incognito:false})),5000,'route');
 const records=()=>bounded(worker.evaluate(()=>({statuses:self.pickerStatuses,routes:self.pickerRoutes})),5000,'records');
 async function inspectPage(page,names){
  const cdp=await browser.newCDPSession(page),scripts=[];
  cdp.on('Debugger.scriptParsed',event=>scripts.push(event));
  try{await cdp.send('Debugger.enable');const result=[];
   for(const name of names){const script=scripts.find(item=>item.url===`chrome-extension://${id}/${name}`);assert.ok(script,'Missing executed page script '+name);const {scriptSource}=await cdp.send('Debugger.getScriptSource',{scriptId:script.scriptId});const disk=await fs.readFile(path.join(root,'extension',name),'utf8');const hash=text=>crypto.createHash('sha256').update(text).digest('hex');assert.equal(scriptSource,disk,'Stale executed page script '+name);result.push({name,executedSHA:hash(scriptSource),diskSHA:hash(disk),equal:true});}return result;
  }finally{await cdp.detach();}
 }
 async function launch(){
  browser=await chromium.launchPersistentContext(profile,{headless:true,channel:'chromium',ignoreDefaultArgs:['--disable-extensions'],viewport:{width:440,height:940},args:[`--disable-extensions-except=${root}/extension`,`--load-extension=${root}/extension`,'--disable-quic']});
  report.browser=browser.browser().version();worker=browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker',{timeout:20000});
  (report.runtimes ||= []).push(await inspectRuntime(browser,root));
  popup=await browser.newPage();popup.setDefaultTimeout(5000);await popup.goto(`chrome-extension://${id}/popup.html`);
  command=(action,extra={})=>bounded(popup.evaluate(m=>chrome.runtime.sendMessage(m),{action,...extra}),5000,'command '+action);
  await waitFor(async()=>{const s=await state();return s.status && await popup.locator('#phase').innerText()!=='Загрузка…';},'popup initialized');
  (report.pageRuntimes ||= []).push({page:'popup',scripts:await inspectPage(popup,['popup.js','country-catalog.js'])});
  await worker.evaluate(()=>{self.pickerStatuses=[];self.pickerRoutes=[];chrome.storage.onChanged.addListener((c,a)=>{if(a==='local'&&c.status)self.pickerStatuses.push(c.status.newValue);});chrome.proxy.settings.onChange.addListener(e=>self.pickerRoutes.push({at:Date.now(),value:e.value}));});
 }
 async function assertOff(){const s=await state();assert.equal(s.enabled,false);assert.equal(s.status.phase,'off');assert.notEqual((await route()).levelOfControl,'controlled_by_this_extension');return s;}
 async function openPicker(){if(!await popup.locator('#country-picker').isVisible())await popup.locator('#country').click();await popup.locator('#country-picker').waitFor({state:'visible'});}
 async function allCountries(){await openPicker();await popup.locator('#country-search').fill('');const codes=await popup.locator('#country-results [data-country]').evaluateAll(elements=>elements.map(e=>e.dataset.country));assert.deepEqual(codes.sort(),[...catalog].sort());return codes.length;}
 async function screenshot(label){const target=path.join(run,label+'.png');await popup.screenshot({path:target,fullPage:true});report.screenshots.push(target);}
 async function assertFixtureRoute(){const r=await route();assert.equal(r.levelOfControl,'controlled_by_this_extension');assert.equal(r.value.mode,'fixed_servers');for(const key of ['proxyForHttp','proxyForHttps'])assert.deepEqual(r.value.rules[key],{scheme:'http',host:'127.0.0.1',port:server.port});assert.equal(r.value.rules.fallbackProxy.host,'127.0.0.1');assert.equal(r.value.rules.fallbackProxy.port,server.port);return r;}
 async function ordinaryHTTPS(label){const beforeBytes=server.traceBytes();const page=await browser.newPage();await page.goto('https://www.cloudflare.com/cdn-cgi/trace?country-picker='+Date.now(),{timeout:30000,waitUntil:'domcontentloaded'});const fields=Object.fromEntries((await page.locator('body').innerText()).trim().split('\n').filter(x=>x.includes('=')).map(x=>x.split('=')));assert.equal(fields.loc,cc);assert.ok(server.traceBytes()>beforeBytes,'ordinary HTTPS must traverse the fixture listener');await page.close();return {label,country:fields.loc,exitIp:fields.ip,traceBytesBefore:beforeBytes,traceBytesAfter:server.traceBytes(),route:await assertFixtureRoute()};}
 async function chooseActual(label){await openPicker();await popup.locator('#country-search').fill(cc);assert.equal(await popup.locator(`[data-country="${cc}"]`).count(),1);await popup.locator(`[data-country="${cc}"]`).click();const connected=await waitFor(async()=>{const s=await state();return s.status?.phase==='connected'?s:false;},label,65000);assert.equal(connected.enabled,true);assert.equal(connected.selected,cc);assert.equal(connected.status.browser.country,cc);return {connected,https:await ordinaryHTTPS(label)};}
 await launch();
 const fresh=await assertOff();assert.equal(fresh.selected,null);assert.deepEqual(fresh.countries,[]);assert.equal(await popup.locator('#country-name').innerText(),'Выберите страну');
 await popup.locator('#connect').click();assert.equal(await popup.locator('#country-picker').isVisible(),true);await assertOff();assert.equal((await state()).selected,null);
 report.checks.push({name:'fresh-profile-no-selection-no-auto-connect',result:'PASS'});
 report.allCatalog=await allCountries();await screenshot('all-countries-picker');
 for(const query of ['Япония','Japan','JP']){await popup.locator('#country-search').fill(query);const codes=await popup.locator('#country-results [data-country]').evaluateAll(es=>es.map(e=>e.dataset.country));assert.deepEqual(codes,['JP']);await assertOff();assert.equal((await state()).selected,null);}
 await popup.locator('[data-favorite="JP"]').click();await waitFor(async()=>(await state()).countries.includes('JP'),'favorite saved');assert.equal(await popup.locator('[data-quick-country="JP"]').count(),1);await assertOff();assert.equal((await state()).selected,null);
 await popup.locator('[data-favorite="JP"]').click();await waitFor(async()=>(await state()).countries.length===0,'favorite removed');await assertOff();assert.equal((await state()).selected,null);
 assert.equal((await records()).statuses.some(s=>s.phase!=='off'),false);assert.equal((await records()).routes.length,0);
 await fs.access(eventsFile).then(()=>{throw Error('Native helper started without a country choice');},e=>{if(e.code!=='ENOENT')throw e;});
 report.checks.push({name:'all-catalog-and-russian-english-iso-search-without-connection',result:'PASS',countries:report.allCatalog},{name:'favorite-toggle-does-not-select-or-connect',result:'PASS'});
 report.firstConnection=await chooseActual('explicit-country-outside-empty-favorites');assert.deepEqual((await state()).countries,[]);await screenshot('connected-country');
 report.checks.push({name:'explicit-selection-outside-favorites-real-https',result:'PASS',country:cc});
 const baselineRoute=await assertFixtureRoute(),eventStart=(await records()).statuses.length,routeStart=(await records()).routes.length;
 await popup.locator('#pin-selected').click();await waitFor(async()=>(await state()).countries.includes(cc),'pin actual country');
 const options=await browser.newPage();options.setDefaultTimeout(5000);await options.goto(`chrome-extension://${id}/options.html`);await options.locator('#countries li button').waitFor();report.pageRuntimes.push({page:'options',scripts:await inspectPage(options,['options.js','country-catalog.js'])});
 for(const query of ['Япония','Japan','JP']){await options.locator('#country-search').fill(query);assert.deepEqual(await options.locator('#country-results [data-add-country]').evaluateAll(es=>es.map(e=>e.dataset.addCountry)),['JP']);}
 await options.locator('#countries li button').click();await options.locator('#save').click();await waitFor(async()=>(await state()).countries.length===0,'empty favorites saved');
 assert.equal((await state()).selected,cc);assert.equal((await state()).enabled,true);assert.equal((await state()).status.phase,'connected');assert.deepEqual(await assertFixtureRoute(),baselineRoute);assert.equal((await records()).routes.length,routeStart);assert.ok((await records()).statuses.slice(eventStart).every(s=>s.phase==='connected'&&s.country===cc));
 const preInvalid=await state();assert.equal((await command('connect',{country:'ZZ'})).ok,false);assert.equal((await command('settings',{countries:['ZZ']})).ok,false);const postInvalid=await state();assert.equal(postInvalid.selected,cc);assert.equal(postInvalid.enabled,true);assert.deepEqual(postInvalid.countries,[]);assert.deepEqual(postInvalid.status,preInvalid.status);assert.deepEqual(await assertFixtureRoute(),baselineRoute);
 await options.locator('#country-search').fill('');const optionsScreenshot=path.join(run,'empty-favorites-options.png');await options.screenshot({path:optionsScreenshot,fullPage:true});report.screenshots.push(optionsScreenshot);
 report.favoritesConnection=await ordinaryHTTPS('after-empty-favorites-save');await options.close();
 report.checks.push({name:'empty-favorites-save-and-invalid-messages-preserve-active-country-route',result:'PASS'});
 await popup.locator('#disconnect').click();await waitFor(async()=>(await state()).status.phase==='off','disconnect');await assertOff();
 await popup.evaluate(async()=>{await chrome.storage.local.clear();await chrome.storage.local.set({countries:['NO','EE','AT'],selected:'EE',enabled:false});});
 await bounded(browser.close(),10000,'close before legacy restart');browser=null;command=null;
 await launch();const legacy=await assertOff();assert.deepEqual(legacy.countries,['NO','EE','AT']);assert.equal(legacy.selected,'EE');report.legacy={countries:legacy.countries,selected:legacy.selected,enabled:legacy.enabled};assert.equal(await allCountries(),catalog.length);await assertOff();
 report.checks.push({name:'legacy-favorites-selected-disabled-survive-real-restart',result:'PASS'});
 if(legacy.countries.includes(cc)){assert.equal((await command('settings',{countries:legacy.countries.filter(code=>code!==cc)})).ok,true);}
 report.afterRestart=await chooseActual('all-catalog-selection-outside-legacy-favorites');assert.ok(!(await state()).countries.includes(cc));await screenshot('connected-after-restart');
 report.checks.push({name:'post-restart-explicit-selection-outside-favorites-real-https',result:'PASS'});
 await popup.locator('#disconnect').click();await waitFor(async()=>(await state()).status.phase==='off','final disconnect');await assertOff();report.finalDisconnect=true;report.records=await records();report.result='PASS';
}catch(error){report.error=error.stack || error.message;if(popup){await popup.screenshot({path:path.join(run,'failure.png'),fullPage:true}).catch(()=>{});report.failureScreenshot=path.join(run,'failure.png');}if(worker)report.records=await bounded(worker.evaluate(()=>({statuses:self.pickerStatuses,routes:self.pickerRoutes})),5000,'failure records').catch(()=>null);}
finally{
 report.connections=server?.connections;
 if(command)await command('disconnect').catch(()=>{});
 let closed=!browser;if(browser)try{await bounded(browser.close(),10000,'browser close');closed=true;}catch(error){report.result='FAIL';report.cleanupError=error.message;}
 if(server)try{await bounded(server.close(),10000,'fixture close');}catch(error){report.result='FAIL';report.cleanupError=error.message;}
 report.productUnchanged=JSON.stringify(before)===JSON.stringify(await hashes());if(!report.productUnchanged){report.result='FAIL';report.error='Product sources changed during acceptance';}
 if(closed&&profile){await fs.rm(profile,{recursive:true,force:true});report.ownedProfileRemoved=true;}
 if(run){await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2)+'\n');await fs.writeFile(path.join(base,'latest.json'),JSON.stringify({result:report.result,report:path.join(run,'report.json')},null,2)+'\n');}
}
console.log(JSON.stringify({result:report.result,error:report.error,report:run&&path.join(run,'report.json'),country:report.country,catalogCount:report.catalogCount,checks:report.checks},null,2));
if(report.result!=='PASS')process.exitCode=1;
