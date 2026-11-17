// Real Chrome proxy/HTTPS oracle for overlapping rechecks and bounded hedging.
// Offers are injected into the production Controller; no native helper is used.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash, createPublicKey} from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {inspectRuntime} from './chrome-runtime.mjs';
import {attachProbeObserver} from './https-probe-observer.mjs';

const kit=import.meta.dirname,root=path.resolve(process.env.TEST_SOURCE_ROOT||path.join(kit,'..'));
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,label,ms=5000){const end=Date.now()+ms;while(Date.now()<end){const result=await read();if(result)return result;await delay(20);}throw Error('Timed out: '+label);}
async function bounded(promise,label,ms=8000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Timed out: '+label)),ms);})]);}finally{clearTimeout(timer);}}
await fs.mkdir(path.resolve(kit,'../.runtime'),{recursive:true});
const directory=await fs.mkdtemp(path.resolve(kit,'../.runtime/browser-latency-'));
const report={result:'RUNNING',at:new Date().toISOString(),sourceRoot:root,mainChromeTouched:false,
  selection:['AT','EE','NO'],nativePipeline:false,publicTraffic:false,syntheticGeoip:true,
  scope:'Production Controller and probeBrowser with actual chrome.proxy.settings and local HTTPS; addressed native offers are injected.',
  fixtureOverrides:['A disposable extension copy exposes existing Controller/probe bindings through a test-only background footer; those two production modules are unchanged.'],
  cases:[]};
const save=()=>fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
async function sourceHashes(){const result={};for(const dir of ['native','extension'])for(const file of (await fs.readdir(path.join(root,dir),{withFileTypes:true})).filter(e=>e.isFile()).sort((a,b)=>a.name.localeCompare(b.name)))result[dir+'/'+file.name]=hash(await fs.readFile(path.join(root,dir,file.name)));return result;}

async function scenario(name){
  const row={name,result:'RUNNING',requests:[],tunnels:[],pageErrors:[]};report.cases.push(row);await save();
  const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'cp-browser-latency-'));
  const profile=path.join(scratch,'profile'),close=[];
  const mode={hold:false,country:'AT',status:204,badTls:false,connectHold:0};const pending=[];
  let chrome,worker,observer,originPort,badPort,proxyPort,clientSockets=new Set();const heldClients=[];
  const snapshot=()=>worker.evaluate(()=>({probes:self.latency.probes,results:self.latency.results,
    events:self.latency.events,feedback:self.latency.feedback,enabled:self.latency.controller.enabled,
    active:self.latency.controller.active,countries:self.latency.controller.countries,routes:self.latency.routes,
    proxyErrors:self.latency.proxyErrors}));
  const call=code=>worker.evaluate(code);
  async function listen(server){const sockets=new Set();server.on('connection',socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});close.push(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});return server.address().port;}
  function certificate(prefix){execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1',
    '-subj','/CN=www.cloudflare.com','-addext','subjectAltName=DNS:www.cloudflare.com,DNS:www.google.com,DNS:example.com',
    '-keyout',path.join(scratch,prefix+'.key'),'-out',path.join(scratch,prefix+'.crt')],{stdio:'ignore'});}
  function release(){mode.hold=false;for(const respond of pending.splice(0))respond();}
  function closeClients(){for(const socket of clientSockets)socket.destroy();}
  try{
    certificate('trusted');certificate('untrusted');
    const good={key:await fs.readFile(path.join(scratch,'trusted.key')),cert:await fs.readFile(path.join(scratch,'trusted.crt'))};
    const bad={key:await fs.readFile(path.join(scratch,'untrusted.key')),cert:await fs.readFile(path.join(scratch,'untrusted.crt'))};
    const fp=createHash('sha256').update(createPublicKey(good.key).export({type:'spki',format:'der'})).digest('base64');
    const origin=(request,response)=>{
      const endpoint=request.headers.host==='example.com'?'ordinary':request.headers.host==='www.google.com'?'target':'trace';
      const parsed=new URL(request.url,'https://'+request.headers.host);
      const entry={atMs:Date.now(),endpoint,nonce:parsed.searchParams.get('t'),attempt:parsed.searchParams.get('attempt')==='2'?2:1,held:mode.hold};row.requests.push(entry);
      const respond=()=>{
        entry.responseAtMs=Date.now();entry.status=endpoint==='target'?mode.status:200;
        response.writeHead(entry.status,{'Content-Type':'text/plain','Cache-Control':'no-store'})
          .end(endpoint==='trace'?'loc='+mode.country+'\nip=192.0.2.91\n':endpoint==='ordinary'?'ordinary HTTPS fixture':undefined);
      };
      if(mode.hold&&endpoint!=='ordinary')pending.push(respond);else respond();
    };
    originPort=await listen(https.createServer(good,origin));badPort=await listen(https.createServer(bad,origin));
    const scheme=['socks4-hedge','probe-socks4-hedge'].includes(name)?'socks4':'http';
    function connect(endpoint,client,head,reply){
      const tunnel={endpoint,atMs:Date.now(),scheme,untrusted:mode.badTls&&endpoint==='target'};row.tunnels.push(tunnel);
      clientSockets.add(client);client.on('close',()=>clientSockets.delete(client));
      if(endpoint==='trace'&&mode.connectHold>0){mode.connectHold--;tunnel.heldBeforeSuccess=true;heldClients.push(client);client.resume();client.on('end',()=>{tunnel.peerEndAtMs=Date.now();client.end();});return;}
      const upstream=net.connect(mode.badTls&&endpoint==='target'?badPort:originPort,'127.0.0.1',()=>{
        tunnel.successAtMs=Date.now();client.write(reply);if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);
      });
      upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());
      client.on('close',()=>upstream.destroy());upstream.on('close',()=>client.destroy());
    }
    let proxy;
    if(scheme==='socks4'){
      proxy=net.createServer(client=>{
        let bytes=Buffer.alloc(0);
        const receive=chunk=>{
          bytes=Buffer.concat([bytes,chunk]);if(bytes.length>512){client.destroy();return;}
          const end=bytes.indexOf(0,8);if(bytes.length<9||end<0)return;
          client.off('data',receive);
          const names={'127.0.0.2':'trace','127.0.0.3':'target','127.0.0.4':'ordinary'};
          const endpoint=names[[...bytes.subarray(4,8)].join('.')];
          if(bytes[0]!==4||bytes[1]!==1||bytes.readUInt16BE(2)!==443||!endpoint){client.end(Buffer.from([0,91,0,0,0,0,0,0]));return;}
          connect(endpoint,client,bytes.subarray(end+1),Buffer.from([0,90,1,187,...bytes.subarray(4,8)]));
        };client.on('data',receive);
      });
    }else{
      proxy=http.createServer((_request,response)=>response.writeHead(403).end());
      proxy.on('connect',(request,client,head)=>{
        if(!['www.cloudflare.com:443','www.google.com:443','example.com:443'].includes(request.url)){client.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
        const endpoint=request.url.startsWith('www.google.com:')?'target':request.url.startsWith('www.cloudflare.com:')?'trace':'ordinary';
        connect(endpoint,client,head,'HTTP/1.1 200 Connection Established\r\n\r\n');
      });
    }
    proxyPort=await listen(proxy);
    const extension=path.join(scratch,'extension');await fs.cp(path.join(root,'extension'),extension,{recursive:true});
    await fs.appendFile(path.join(extension,'background.js'),'\nself.latencyModules = {Controller, probeBrowser, BLOCKED, matchesEffectiveRoute};\n');
    const manifest=JSON.parse(await fs.readFile(path.join(extension,'manifest.json')));
    const id=hash(Buffer.from(manifest.key,'base64')).slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
    chrome=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,ignoreDefaultArgs:['--disable-extensions'],args:[
      '--load-extension='+extension,'--disable-extensions-except='+extension,'--disable-quic','--disable-background-networking',
      '--host-resolver-rules=MAP www.cloudflare.com 127.0.0.2,MAP www.google.com 127.0.0.3,MAP example.com 127.0.0.4,MAP * ~NOTFOUND,EXCLUDE 127.0.0.1','--proxy-server=http://127.0.0.1:9',
      '--ignore-certificate-errors-spki-list='+fp]});
    row.browser=chrome.browser().version();row.runtime=await inspectRuntime(chrome,root,{names:['controller.js','probe.js']});
    worker=chrome.serviceWorkers().find(w=>w.url()===`chrome-extension://${id}/background.js`);
    await until(()=>worker.evaluate(async()=> (await chrome.storage.local.get('status')).status?.phase==='off'),'background starts disabled');
    observer=await attachProbeObserver(chrome,worker.url());
    await worker.evaluate(async({port,scheme})=>{
      const {Controller,probeBrowser,BLOCKED,matchesEffectiveRoute}=self.latencyModules;
      const qa=self.latency={probes:0,results:[],events:[],feedback:[],routes:[],jobs:[],proxyErrors:[]};
      // Observe Chrome's actual error events; the production background's own
      // Controller remains disabled, so this is not its event-handler oracle.
      chrome.proxy.onProxyError.addListener(event=>qa.proxyErrors.push({atMs:Date.now(),error:event.error,fatal:event.fatal}));
      const apply=async value=>{await chrome.proxy.settings.set({value,scope:'regular'});await verifyRoute(value);};
      const verifyRoute=async value=>{const actual=await chrome.proxy.settings.get({incognito:false});if(!matchesEffectiveRoute(actual,value))throw Error('Fixture effective route mismatch');};
      const api={apply,verifyRoute,block:()=>apply(BLOCKED),save:async()=>{},publish:async event=>qa.events.push({...event,atMs:Date.now()}),
        clear:()=>chrome.proxy.settings.clear({scope:'regular'}),startNative:async()=>{},stopNative:async()=>{},
        confirm:async event=>qa.feedback.push({...event,atMs:Date.now()}),reject:async event=>qa.feedback.push({...event,atMs:Date.now()})};
      qa.controller=new Controller(api,async(...args)=>{qa.probes++;const result=await probeBrowser(...args);qa.results.push(result);return result;});
      chrome.proxy.settings.onChange.addListener(change=>qa.routes.push({atMs:Date.now(),enabled:qa.controller.enabled,value:change.value}));
      qa.offer=country=>qa.controller.status({id:qa.controller.id,feedbackProtocol:1,attempt:1,phase:'connected',
        countries:[...qa.controller.countries],proxy:{scheme,host:'127.0.0.1',port,country,exitIp:'192.0.2.91'}});
      await qa.controller.start(['NO','AT','EE']);await qa.offer('AT');
    },{port:proxyPort,scheme});
    let state=await snapshot();assert.equal(state.active?.country,'AT');assert.equal(state.probes,1);
    assert.deepEqual(state.countries,['AT','EE','NO']);assert.equal(row.requests.filter(r=>r.endpoint==='trace').length,1);
    assert.equal(row.requests.filter(r=>r.endpoint==='target').length,1);
    row.initialConfirmedAt=state.feedback.find(e=>e.command==='confirm').atMs;
    if(name==='probe-socks4-hedge'){
      closeClients();await delay(80);mode.connectHold=1;
      row.recheckStartedAtMs=Date.now();
      await call(()=>{self.latency.jobs=[self.latency.controller.recheck()];});
      await until(()=>row.tunnels.some(t=>t.heldBeforeSuccess),'primary SOCKS4 handshake remains before TLS');
      const held=row.tunnels.find(t=>t.heldBeforeSuccess);row.firstHeldAtMs=held.atMs;
      assert.equal((await snapshot()).events.at(-1).phase,'verifying');
      await bounded(call(()=>Promise.all(self.latency.jobs)),'production browser probe hedge',12000);
      state=await snapshot();const proof=state.results.at(-1);
      assert.equal(state.active?.country,'AT');assert.equal(proof.ok,true);assert.equal(state.probes,2);
      assert.equal(proof.verifiedRequests.target,1);assert.ok([1,2].includes(proof.verifiedRequests.trace));
      assert.ok(row.tunnels.some(t=>t.endpoint==='trace'&&t.atMs>=held.atMs+4500&&!t.heldBeforeSuccess&&t.successAtMs),'supplement opens an independent SOCKS4 handshake after the delay');
      // Chrome's connection pool may let the primary HTTP request use the
      // successful supplemental tunnel. Record the actual winning ordinal.
      const traceRequests=row.requests.filter(r=>r.endpoint==='trace'&&r.atMs>=row.recheckStartedAtMs);
      assert.ok(traceRequests.length>=1&&traceRequests.length<=2,'at most two trace requests in one probe');
      assert.ok(traceRequests.some(r=>r.attempt===proof.verifiedRequests.trace));
      assert.equal(new Set(traceRequests.map(r=>r.attempt)).size,traceRequests.length,'no repeated ordinal');
      assert.equal(row.requests.filter(r=>r.endpoint==='target').length,2,'healthy target is not duplicated');
      row.verificationMs=proof.latencyMs;row.verifiedRequests=proof.verifiedRequests;
      await until(()=>{
        const requests=observer.snapshot().requests.filter(r=>r.nonce>=row.recheckStartedAtMs);
        return requests.length===3&&requests.every(r=>['completed','cancelled','failed'].includes(r.outcome));
      },'all primary and supplemental fetch requests terminate');
      row.heldSocketOpenAfterProbe=heldClients.some(client=>!client.destroyed);
      // AbortSignal governs fetch ownership; Chromium may retain an unused
      // ConnectJob in its pool. Observe a later failure without claiming that
      // fetch cancellation guarantees immediate closure of that TCP socket.
      row.heldTerminationInjectedAtMs=Date.now();for(const client of heldClients)client.destroy();
      await delay(300);state=await snapshot();
      assert.equal(state.probes,2);assert.equal(state.results.length,2);
      assert.equal(state.feedback.filter(e=>e.command==='confirm').length,2);
      row.proxyErrorsAfterRecheck=state.proxyErrors;
    }else if(name==='connect-hedge'||name==='socks4-hedge'){
      closeClients();await delay(80);mode.connectHold=1;
      await call(()=>{
        const q=self.latency;q.firstAbort=new AbortController();q.hedgeUrl='https://www.cloudflare.com/cdn-cgi/trace?t='+Date.now();
        q.firstFetch=fetch(q.hedgeUrl,{cache:'no-store',credentials:'omit',redirect:'error',signal:q.firstAbort.signal})
          .then(async r=>({status:r.status,body:await r.text()})).catch(e=>({error:e.name}));
      });
      await until(()=>row.tunnels.some(t=>t.heldBeforeSuccess),'first proxy handshake genuinely pending');
      row.firstHeldAtMs=row.tunnels.find(t=>t.heldBeforeSuccess).atMs;await delay(5000);
      row.secondStartedAtMs=Date.now();
      row.hedgeResult=await bounded(call(async()=>{
        const response=await fetch(self.latency.hedgeUrl,{cache:'no-store',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(7000)});
        return {status:response.status,body:await response.text(),completedAtMs:Date.now()};
      }),'independent CONNECT hedge',8000);
      await call(async()=>{self.latency.firstAbort.abort();await self.latency.firstFetch;});
      assert.equal(row.hedgeResult.status,200);assert.match(row.hedgeResult.body,/loc=AT\n/);
      assert.ok(row.tunnels.some(t=>t.endpoint==='trace'&&!t.heldBeforeSuccess&&t.atMs>=row.secondStartedAtMs),'second fetch opens independent proxy connection');
      row.secondFetchMs=row.hedgeResult.completedAtMs-row.secondStartedAtMs;
    }else if(name==='overlap'){
      mode.hold=true;
      await call(()=>{self.latency.jobs=[self.latency.controller.recheck(),self.latency.controller.recheck()];});
      await until(()=>row.requests.filter(r=>r.held).length===2,'real pending HTTPS pair');
      await call(()=>{self.latency.jobs.push(self.latency.controller.recheck());});
      await delay(120);assert.equal((await snapshot()).probes,2);
      row.releasedAtMs=Date.now();release();
      await bounded(call(()=>Promise.all(self.latency.jobs)),'shared recheck completion');
      state=await snapshot();row.probesAfterOverlap=state.probes;
      row.controlRequestsAfterOverlap=row.requests.filter(r=>r.endpoint!=='ordinary').length;
      row.distinctProbeNonces=[...new Set(row.requests.filter(r=>r.endpoint!=='ordinary').map(r=>r.nonce))];
      assert.equal(state.probes,2,'overlapping requests must not become serial duplicate probes');
      assert.equal(row.controlRequestsAfterOverlap,4,'one initial pair plus one shared pair');
      await bounded(call(()=>self.latency.controller.recheck()),'fresh later recheck');
      state=await snapshot();row.probesAfterFresh=state.probes;assert.equal(state.probes,3);
      assert.equal(row.requests.filter(r=>r.endpoint!=='ordinary').length,6);
      const page=await chrome.newPage();page.on('pageerror',error=>row.pageErrors.push(error.message));
      const response=await page.goto('https://example.com/?latency-lab='+Date.now(),{timeout:5000});assert.equal(response.status(),200);
      assert.equal(await page.locator('body').innerText(),'ordinary HTTPS fixture');row.ordinaryHttps=true;await page.close();
    }else if(['country','http','tls'].includes(name)){
      if(name==='country')mode.country='DE';if(name==='http')mode.status=503;if(name==='tls')mode.badTls=true;
      closeClients();
      await bounded(call(()=>self.latency.controller.recheck()),'negative '+name);
      state=await snapshot();assert.equal(state.active,null);
      assert.equal(state.feedback.filter(e=>e.command==='confirm').length,1);
      const rejected=state.feedback.filter(e=>e.command==='reject');assert.equal(rejected.length,1);
      assert.equal(rejected[0].reason,name==='tls'?'transport':name);
      const route=await call(()=>chrome.proxy.settings.get({incognito:false}));assert.equal(route.value.rules.proxyForHttps.port,9);
      if(name==='tls')assert.ok(row.tunnels.some(t=>t.endpoint==='target'&&t.untrusted));
      row.rejection=rejected[0].reason;
    }else{
      mode.hold=true;await call(()=>{self.latency.jobs=[self.latency.controller.recheck()];});
      await until(()=>row.requests.filter(r=>r.held).length===2,'pending before invalidation');
      await call(()=>{self.latency.jobs.push(self.latency.controller.recheck());});
      if(name==='stop')await bounded(call(()=>self.latency.controller.stop()),'stop pending check');
      else await bounded(call(()=>self.latency.controller.start(['NO','EE'])),'change group pending check');
      release();await bounded(call(()=>Promise.all(self.latency.jobs)),'cancelled callers');await delay(120);
      state=await snapshot();assert.equal(state.active,null);assert.equal(state.feedback.filter(e=>e.command==='confirm').length,1);
      if(name==='stop')assert.equal(state.enabled,false);
      else{
        assert.deepEqual(state.countries,['EE','NO']);mode.country='EE';
        await bounded(call(()=>self.latency.offer('EE')),'new group requires fresh verification');
        state=await snapshot();assert.equal(state.active?.country,'EE');assert.equal(state.probes,3);
        assert.equal(state.feedback.filter(e=>e.command==='confirm').length,2);
      }
    }
    row.state=await snapshot();
    for(const e of row.state.routes.filter(e=>e.enabled)){
      assert.equal(e.value.mode,'fixed_servers','enabled fixture never uses a direct/system route');
      assert.deepEqual(e.value.rules.proxyForHttp,e.value.rules.proxyForHttps);
      const fallback=e.value.rules.fallbackProxy,https=e.value.rules.proxyForHttps;
      assert.equal(fallback.host,https.host);assert.equal(fallback.port,https.port);
      // Chrome can normalize an HTTP fallback to SOCKS4 at the same address;
      // this is the same accepted representation as matchesEffectiveRoute().
      assert.ok(fallback.scheme===https.scheme||(https.scheme==='http'&&fallback.scheme==='socks4'));
      assert.deepEqual(e.value.rules.bypassList,['<-loopback>']);
      assert.ok([proxyPort,9].includes(e.value.rules.proxyForHttps.port));
    }
    assert.deepEqual(row.pageErrors,[]);row.result='PASS';
  }catch(error){row.error=error.stack;row.result='FAIL';if(worker)row.state=await snapshot().catch(()=>null);}
  finally{
    if(observer){row.network=observer.snapshot();await observer.close();}
    release();
    if(worker)await call(async()=>{self.latency?.firstAbort?.abort();await self.latency?.firstFetch;}).catch(()=>{});
    if(worker)await bounded(call(()=>self.latency?.controller.stop()),'final controller stop').catch(error=>{row.cleanupError=error.message;row.result='FAIL';});
    if(chrome)await chrome.close();for(const cleanup of close.reverse())await cleanup();
    await fs.rm(scratch,{recursive:true,force:true});row.temporaryProfileRemoved=true;await save();
  }
  console.log(JSON.stringify({name,result:row.result,probesAfterOverlap:row.probesAfterOverlap,error:row.error}));
}

console.log('receipt',path.join(directory,'report.json'));
report.sourceHashes=await sourceHashes();
report.harnessHashes={'tests/browser-latency-lab.mjs':hash(await fs.readFile(path.join(kit,'browser-latency-lab.mjs'))),
  'tests/chrome-runtime.mjs':hash(await fs.readFile(path.join(kit,'chrome-runtime.mjs'))),
  'tests/https-probe-observer.mjs':hash(await fs.readFile(path.join(kit,'https-probe-observer.mjs')))};
for(const name of process.env.TEST_CASE?[process.env.TEST_CASE]:['overlap','probe-socks4-hedge','country','http','tls','stop','group'])await scenario(name);
assert.deepEqual(await sourceHashes(),report.sourceHashes,'product source must remain immutable during acceptance');
report.result=report.cases.every(row=>row.result==='PASS')?'PASS':'FAIL';await save();
console.log(JSON.stringify({result:report.result,receipt:path.join(directory,'report.json')}));
if(report.result!=='PASS')process.exitCode=1;
