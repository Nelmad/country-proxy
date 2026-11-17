// Opt-in network acceptance. Run only in an isolated stage3 checkout:
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright node tests/reserve-race-lab.mjs
// Uses a fresh Chrome for Testing profile + registration per scenario. Never
// touches installed Chrome. All TLS/GeoIP is real; three distinct loopback ports
// share ONE public exit. Gates affect ordering/CONNECT transport only.
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
const python=path.join(root,'.venv/bin/python');
const allowed=new Set(['www.cloudflare.com:443','www.google.com:443','example.com:443']);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const quote=s=>"'"+s.replaceAll("'","'\"'\"'")+"'";
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const report={at:new Date().toISOString(),result:'FAIL',kind:'isolated-two-reserve-race',
  mainChromeTouched:false,provesDifferentPublicIP:false,productionIntervals:true,
  fixtureAllowances:['distinct loopback ports replace distinct public host/egress identity',
    'owned-source candidates replace public discovery',
    'file gates order actual native checks and hold/reject actual CONNECT transport'],scenarios:[]};
let run;
async function bounded(operation,ms,label){let timer;try{return await Promise.race([
  Promise.resolve().then(operation),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Timed out: '+label)),ms);})
]);}finally{clearTimeout(timer);}}
async function exists(file){try{await fs.access(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function waitFor(fn,label,ms=60000){const until=Date.now()+ms;while(Date.now()<until){const value=await fn();if(value)return value;await delay(150);}throw Error('Timed out: '+label);}
async function hashes(){const result={};for(const directory of ['native','extension']){
  async function walk(at){for(const entry of (await fs.readdir(at,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    if(entry.name==='__pycache__'||entry.name.endsWith('.pyc'))continue;
    const file=path.join(at,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile())result[path.relative(root,file)]=sha(await fs.readFile(file));
  }}await walk(path.join(root,directory));}return result;}
function fixed(value){
  assert.equal(value.mode,'fixed_servers','enabled route must remain fixed_servers');
  const r=value.rules;assert.ok(r);for(const key of ['proxyForHttp','proxyForHttps','fallbackProxy'])assert.ok(r[key],key);
  assert.deepEqual(r.proxyForHttp,r.proxyForHttps);
  assert.equal(r.fallbackProxy.host,r.proxyForHttps.host);assert.equal(r.fallbackProxy.port,r.proxyForHttps.port);
  assert.ok(r.bypassList.includes('<-loopback>'));return r.proxyForHttps.port;
}
async function proxy(label,directory){
  const sockets=new Set(),state={label,hits:[],held:[],rejected:[],denied:[],bytes:{},closed:false};
  const server=http.createServer((_req,res)=>{res.writeHead(405);res.end();});
  function track(socket){sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});socket.setTimeout(65000,()=>socket.destroy());}
  server.on('connection',track);
  server.on('connect',(req,client,head)=>{void(async()=>{
    if(!allowed.has(req.url)){state.denied.push(req.url);client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');return;}
    if(label==='A' && await exists(path.join(directory,'hold-A'))){
      state.held.push({at:Date.now(),target:req.url});
      await fs.writeFile(path.join(directory,'held-A'),'actual native CONNECT outstanding\n');return;
    }
    if(label==='A' && await exists(path.join(directory,'reject-A'))){
      state.rejected.push({at:Date.now(),target:req.url});
      await fs.writeFile(path.join(directory,'rejected-A'),'actual browser CONNECT rejected\n');
      client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');return;
    }
    const [host,port]=req.url.split(':');const upstream=net.connect({host,port:Number(port)});track(upstream);
    const bytes=state.bytes[req.url]??={toOrigin:0,fromOrigin:0};
    client.on('data',chunk=>{bytes.toOrigin+=chunk.length;});
    upstream.on('data',chunk=>{bytes.fromOrigin+=chunk.length;});
    upstream.on('connect',()=>{if(client.destroyed){upstream.destroy();return;}
      state.hits.push({at:Date.now(),target:req.url});client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if(head.length){bytes.toOrigin+=head.length;upstream.write(head);}client.pipe(upstream);upstream.pipe(client);
    });
    client.on('close',()=>upstream.destroy());upstream.on('close',()=>client.destroy());upstream.on('error',()=>client.destroy());
  })().catch(()=>client.destroy());});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  state.port=server.address().port;
  state.close=async()=>{if(state.closed)return;state.closed=true;const closed=new Promise(resolve=>server.close(resolve));for(const s of sockets)s.destroy();await closed;};
  return state;
}

async function scenario(name,countries,cc){
  const entry={name,result:'FAIL',startedAt:new Date().toISOString()};report.scenarios.push(entry);
  const directory=await fs.mkdtemp(path.join(run,name+'-'));
  entry.directory=directory;
  const profile=path.join(directory,'profile'),config=path.join(directory,'config.json');
  let browser,worker,popup,page,command,active,a,b;
  const cleanup={errors:[],browserClosed:true,profileRemoved:false,nativeExited:false};
  const attempt=async(label,operation)=>{try{await bounded(operation,12000,label);return true;}catch(error){cleanup.errors.push({label,error:error.message});return false;}};
  try{
    active=await proxy('active',directory);a=await proxy('A',directory);b=await proxy('B',directory);
    entry.ports={active:active.port,A:a.port,B:b.port};
    await fs.writeFile(config,JSON.stringify({scenario:name,ports:[active.port,a.port,b.port]})+'\n',{mode:0o600});
    const launcher=path.join(directory,'host');
    await fs.writeFile(launcher,'#!/bin/sh\nexec '+quote(python)+' -I -B '+quote(path.join(root,'tests/reserve_race_fixture.py'))+' '+quote(config)+'\n',{mode:0o700});
    const manifest=JSON.parse(await fs.readFile(path.join(root,'extension/manifest.json')));
    const id=sha(Buffer.from(manifest.key,'base64')).slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
    const registration=path.join(profile,'NativeMessagingHosts');await fs.mkdir(registration,{recursive:true});
    await fs.writeFile(path.join(registration,'local.country_proxy.json'),JSON.stringify({name:'local.country_proxy',
      description:'Disposable stage3 reserve race',path:launcher,type:'stdio',allowed_origins:[`chrome-extension://${id}/`]}),{mode:0o600});
    entry.profile=profile;entry.registration=path.join(registration,'local.country_proxy.json');
    browser=await chromium.launchPersistentContext(profile,{headless:true,channel:'chromium',timeout:45000,
      ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${root}/extension`,
        `--load-extension=${root}/extension`,'--disable-quic'],viewport:{width:640,height:650}});
    cleanup.browserClosed=false;
    entry.browser=browser.browser().version();entry.executable=chromium.executablePath();
    worker=browser.serviceWorkers()[0]||await browser.waitForEvent('serviceworker',{timeout:20000});
    entry.runtime=await inspectRuntime(browser,root);
    popup=await browser.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);page=await browser.newPage();
    command=(action,extra={})=>bounded(()=>popup.evaluate(message=>chrome.runtime.sendMessage(message),{action,...extra}),5000,'command '+action);
    const state=()=>bounded(()=>popup.evaluate(async()=>({...await chrome.storage.local.get(['status','enabled','selected','selectionMode','selectedCountries','pool']),route:await chrome.proxy.settings.get({incognito:false})})),5000,'state');
    const native=async()=>{try{return (await fs.readFile(path.join(directory,'native-events.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code==='ENOENT')return [];throw error;}};
    const records=()=>bounded(()=>worker.evaluate(()=>({states:self.raceStates,routes:self.raceRoutes,errors:self.raceErrors})),5000,'records');
    function selection(s){assert.equal(s.enabled,true);assert.equal(s.selected,null);assert.equal(s.selectionMode,'multiple');assert.deepEqual(s.selectedCountries,countries);if(s.status?.countries)assert.deepEqual(s.status.countries,countries);if(s.status?.country)assert.ok(countries.includes(s.status.country));fixed(s.route.value);}
    function routed(s,listener){selection(s);assert.equal(s.route.levelOfControl,'controlled_by_this_extension');
      assert.equal(fixed(s.route.value),listener.port,'actual HTTPS route must match expected listener');
      assert.equal(s.route.value.rules.proxyForHttps.host,'127.0.0.1');
      assert.equal(s.route.value.rules.proxyForHttps.scheme,'http');return s.route;}
    async function connected(port,ms=90000){return waitFor(async()=>{const s=await state();selection(s);if(['helper','error'].includes(s.status?.phase))throw Error(JSON.stringify(s.status));
      if(s.status?.phase!=='connected'||s.status.proxy?.port!==port)return false;
      routed(s,{port});return s;},'Chrome connected '+port,ms);}
    const browserTarget='example.com:443';
    const bytesFor=listener=>({... (listener.bytes[browserTarget]||{toOrigin:0,fromOrigin:0})});
    function transferred(listener,before){const after=bytesFor(listener),delta={toOrigin:after.toOrigin-before.toOrigin,fromOrigin:after.fromOrigin-before.fromOrigin};
      assert.ok(delta.toOrigin>0&&delta.fromOrigin>0,'ordinary HTTPS must transfer TLS bytes through expected listener');
      assert.ok(listener.hits.some(h=>h.target===browserTarget),'expected listener must have established browser-only CONNECT');return {before,after,delta};}
    async function ordinaryPage(label,listener){
      const routeBefore=routed(await state(),listener),before=bytesFor(listener),startedAt=Date.now();
      // Native checks and extension probes use only Cloudflare/Google. Traffic
      // for this distinct origin is therefore attributable to this browser tab.
      const url='https://example.com/?reserve-race='+label+'-'+startedAt;
      const response=await page.goto(url,{timeout:25000,waitUntil:'domcontentloaded'});
      assert.equal(response?.status(),200);assert.ok((await page.locator('body').innerText()).length>0);
      const routeAfter=routed(await state(),listener);
      return {url,startedAt,finishedAt:Date.now(),status:response.status(),listenerPort:listener.port,
        routeBefore,routeAfter,transfer:transferred(listener,before)};
    }
    async function trace(label){const start=Date.now();await page.goto('https://www.cloudflare.com/cdn-cgi/trace?reserve-race='+label+'-'+start,{timeout:25000,waitUntil:'domcontentloaded'});
      const fields=Object.fromEntries((await page.locator('body').innerText()).trim().split('\n').filter(line=>line.includes('=')).map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));
      assert.equal(fields.loc,cc);return {at:Date.now(),country:fields.loc,exitIp:fields.ip};}
    assert.equal((await command('disconnect')).ok,true);assert.equal((await command('settings',{countries:[...countries]})).ok,true);
    await worker.evaluate(()=>{self.raceStates=[];self.raceRoutes=[];self.raceErrors=[];
      chrome.storage.onChanged.addListener((c,area)=>{if(area==='local'&&c.status)self.raceStates.push(c.status.newValue);});
      chrome.proxy.settings.onChange.addListener(e=>self.raceRoutes.push({at:Date.now(),value:e.value}));
      chrome.proxy.onProxyError.addListener(e=>self.raceErrors.push({at:Date.now(),error:e.error,fatal:e.fatal}));});
    assert.equal((await command('connect',{countries})).ok,true);
    entry.before=await connected(active.port);assert.equal(entry.before.status.browser.country,cc);
    entry.ordinaryPageBefore=await ordinaryPage('before',active);
    entry.httpsBefore=await trace('before');
    entry.poolBefore=await waitFor(async()=>{const s=await state();selection(s);return s.pool?.count===2&&s.pool.expiresAt>Date.now()?s:false;},'two actual native-verified reserves',90000);
    const beforeEvents=await native();
    for(const p of [a,b])assert.ok(beforeEvents.some(e=>e.event==='checker-result'&&e.port===p.port&&e.accepted&&!e.promotion),'reserve never verified by native');
    entry.injectedAt=Date.now();entry.eventOffset=(await records()).states.length;
    await fs.writeFile(path.join(directory,'fail-injected'),'physically stop active listener\n');
    await active.close(); // Physical listener + socket failure, not a route mutation.
    assert.equal(active.closed,true);entry.activePhysicallyStopped=true;
    // One ordinary HTTPS request triggers real Chrome failure detection. There is
    // no rotate/check/connect command anywhere in the recovery interval.
    const failureBytesBefore=bytesFor(b),failureUrl='https://example.com/?reserve-race-failure='+entry.injectedAt;
    let failureResponse;
    try{failureResponse=await page.goto(failureUrl,{timeout:10000,waitUntil:'domcontentloaded'});entry.failedPage=false;}
    catch(error){entry.failedPage=true;entry.failedPageError=error.message;}
    if(entry.failedPage){selection(await state());entry.failureRequest={url:failureUrl,outcome:'failed-closed'};}
    else{
      // Chrome can retry the navigation after automatic recovery has already
      // installed B. A success is allowed only with actual B route + traffic.
      assert.equal(failureResponse?.status(),200);
      entry.failureRequest={url:failureUrl,outcome:'recovered-via-B',status:failureResponse.status(),
        listenerPort:b.port,route:routed(await state(),b),transfer:transferred(b,failureBytesBefore)};
    }
    entry.after=await connected(b.port,120000);assert.equal(entry.after.status.browser.country,cc);
    entry.ordinaryPageAfter=await ordinaryPage('after',b);
    entry.httpsAfter=await trace('after');assert.equal(entry.httpsBefore.exitIp,entry.httpsAfter.exitIp);
    const nativeEvents=await waitFor(async()=>{const e=await native();return e.some(x=>x.event==='feedback'&&x.command==='confirm'&&x.proxy?.port===b.port&&x.accepted)?e:false;},'addressed B browser confirmation',10000);
    entry.nativeEvents=nativeEvents;entry.records=await records();
    const post=entry.records.states.slice(entry.eventOffset);
    assert.ok(post.some(s=>s.phase==='replacing'));assert.ok(post.some(s=>s.phase==='reserve'));
    const bConnected=post.findIndex(s=>s.phase==='connected'&&s.proxy?.port===b.port);assert.ok(bConnected>=0);
    assert.ok(!post.slice(0,bConnected).some(s=>s.phase==='searching'),'ready reserves must precede foreground search');
    const bConfirmed=nativeEvents.find(e=>e.event==='feedback'&&e.command==='confirm'&&e.proxy?.port===b.port&&e.accepted);
    const replacementStart=nativeEvents.find(e=>e.event==='checker-start'&&e.promotion);
    assert.ok(replacementStart);
    // Failure timestamp is wall clock; native records use seconds from time.time.
    entry.discoveryDuringReplacement=nativeEvents.filter(e=>e.event==='discover'&&e.at*1000>=entry.injectedAt&&e.mono<=bConfirmed.mono);
    assert.equal(entry.discoveryDuringReplacement.length,0,'no new discovery until Chrome confirms B');
    entry.routesDuringReplacement=entry.records.routes.filter(e=>e.at>=entry.injectedAt&&e.at<=entry.after.status.updatedAt);
    assert.ok(entry.routesDuringReplacement.some(e=>fixed(e.value)===9),'replacement gap must install blocked route');
    for(const e of entry.routesDuringReplacement){const port=fixed(e.value);assert.ok([9,a.port,b.port].includes(port),'unexpected/direct replacement route');}
    for(const s of post){if(s.countries)assert.deepEqual(s.countries,countries);if(s.country)assert.ok(countries.includes(s.country));}
    const promotions=nativeEvents.filter(e=>e.promotion);
    if(name==='native-hang'){
      const bSuccess=promotions.find(e=>e.event==='checker-result'&&e.port===b.port&&e.accepted);
      assert.ok(bSuccess?.a_outstanding,'B native success must arrive while A is outstanding');
      assert.ok(a.held.length>0,'A must have real pending native CONNECT');
      assert.ok(promotions.some(e=>e.event==='checker-cancel'&&e.port===a.port),'A loser must be cancelled');
      assert.ok(!nativeEvents.some(e=>e.event==='status'&&e.status.phase==='connected'&&e.status.proxy?.port===a.port),'hung A must never be offered');
    }else{
      const aOffer=nativeEvents.find(e=>e.event==='status'&&e.status.phase==='connected'&&e.status.proxy?.port===a.port);
      assert.ok(aOffer,'A must win real native checking first');assert.ok(a.rejected.length>0,'Chrome must actually attempt rejected A CONNECT');
      const rejected=nativeEvents.find(e=>e.event==='feedback'&&e.command==='reject'&&e.proxy?.port===a.port&&e.accepted);
      assert.ok(rejected,'Chrome must send addressed accepted rejection for A');
      assert.equal(rejected.attempt,aOffer.status.attempt);
      assert.ok(!post.some(s=>s.phase==='connected'&&s.proxy?.port===a.port),'Chrome-rejected A must never be shown connected');
      assert.ok(bConfirmed.mono>rejected.mono);
    }
    entry.secondsToReplacement=+((entry.after.status.updatedAt-entry.injectedAt)/1000).toFixed(3);
    entry.result='PASS';
  }catch(error){entry.error=error.stack||error.message;
    if(worker)entry.records=await bounded(()=>worker.evaluate(()=>({states:self.raceStates,routes:self.raceRoutes,errors:self.raceErrors})),5000,'failure records').catch(()=>null);
    if(await exists(path.join(directory,'native-events.jsonl')))entry.nativeEvents=(await fs.readFile(path.join(directory,'native-events.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  }finally{
    if(command)await attempt('disconnect',()=>command('disconnect'));
    if(browser)cleanup.browserClosed=await attempt('browser.close',()=>browser.close());
    // Chrome should close Native Messaging itself. A verified, exact owned child
    // can receive SIGTERM to finish asynchronous curl cleanup if it lingers.
    const pidFile=path.join(directory,'native-pid.json');
    if(await exists(pidFile))await attempt('native cleanup',async()=>{
      const owned=JSON.parse(await fs.readFile(pidFile,'utf8'));assert.equal(owned.config,config);assert.ok(Number.isInteger(owned.pid)&&owned.pid>1);
      const alive=()=>{try{process.kill(owned.pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
      if(alive()){
        const line=(await exec('/bin/ps',['-p',String(owned.pid),'-o','command='],{timeout:3000})).stdout;
        assert.ok(line.includes(path.join(root,'tests/reserve_race_fixture.py'))&&line.includes(config),'PID ownership mismatch');
        process.kill(owned.pid,'SIGTERM');await waitFor(()=>!alive(),'owned native exit',8000);
      }cleanup.nativeExited=true;
    });else cleanup.nativeExited=true;
    await Promise.all([active,a,b].filter(Boolean).map(p=>attempt('proxy.close '+p.label,()=>p.close())));
    if(cleanup.browserClosed)cleanup.profileRemoved=await attempt('profile.remove',()=>fs.rm(profile,{recursive:true,force:true}));
    entry.connections=Object.fromEntries([active,a,b].filter(Boolean).map(p=>[p.label,{port:p.port,hits:p.hits,held:p.held,rejected:p.rejected,denied:p.denied,bytes:p.bytes}]));
    entry.cleanup=cleanup;if(cleanup.errors.length){entry.result='FAIL';entry.error??='Cleanup failed';}
    entry.finishedAt=new Date().toISOString();await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(entry,null,2)+'\n');
  }
  console.log(JSON.stringify({scenario:name,result:entry.result,report:path.join(directory,'report.json'),secondsToReplacement:entry.secondsToReplacement,error:entry.error}));
  assert.equal(entry.result,'PASS',name+' failed: '+entry.error);
}

const before=await hashes();
try{
  const base=path.join(root,'.runtime/stage3-reserve-race');await fs.mkdir(base,{recursive:true});run=await fs.mkdtemp(path.join(base,'run-'));report.directory=run;
  const code=`import asyncio,json,sys\nsys.path.insert(0,${JSON.stringify(path.join(root,'native'))})\nfrom core import curl,TRACE,TARGET,country_code\nasync def main():\n a,b=await asyncio.gather(curl(TRACE,slow=True),curl(TARGET,slow=True))\n if a[0] or b[0] or a[1]!='200' or b[1]!='204':raise RuntimeError('Real HTTPS baseline unavailable')\n fields=dict(x.split('=',1) for x in a[2].splitlines() if '=' in x)\n print(json.dumps({'country':country_code(fields.get('loc')),'exitIp':fields.get('ip')}))\nasyncio.run(main())`;
  report.baseline=JSON.parse((await exec(python,['-I','-B','-c',code],{timeout:50000})).stdout);
  const cc=report.baseline.country,countries=[cc,cc==='NO'?'EE':'NO'].sort();report.selectedCountries=countries;
  await scenario('native-hang',countries,cc);await scenario('browser-reject',countries,cc);
  report.result='PASS';
}catch(error){report.error=error.stack||error.message;}
finally{
  report.productUnchanged=JSON.stringify(before)===JSON.stringify(await hashes());
  if(!report.productUnchanged){report.result='FAIL';report.error??='Product sources changed during acceptance';}
  if(run){await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2)+'\n');await fs.writeFile(path.join(path.dirname(run),'latest.json'),JSON.stringify({result:report.result,report:path.join(run,'report.json')},null,2)+'\n');}
}
console.log(JSON.stringify({result:report.result,report:run&&path.join(run,'report.json'),error:report.error},null,2));
if(report.result!=='PASS')process.exitCode=1;
