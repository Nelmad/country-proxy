// Same real-curl/TLS/Chrome oracle against a frozen baseline or a candidate.
// Only local origins, per-run trust, feed availability and loopback identities are fixtures.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,createPublicKey} from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {inspectRuntime} from './chrome-runtime.mjs';

const kit=import.meta.dirname,root=path.resolve(process.env.TEST_SOURCE_ROOT||path.join(kit,'..'));
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const countries=['AT','EE','NO'],locations=['AT','EE','NO','AT','EE'];
const hash=data=>createHash('sha256').update(data).digest('hex');
const quote=value=>"'"+value.replaceAll("'","'\"'\"'")+"'";
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
await fs.mkdir(path.resolve(kit,'../.runtime'),{recursive:true});
const output=await fs.mkdtemp(path.resolve(kit,'../.runtime/native-reserve-latency-'));
const report={result:'RUNNING',at:new Date().toISOString(),sourceRoot:root,selection:countries,
  publicTraffic:false,syntheticGeoip:true,mainChromeTouched:false,productionTimers:true,
  limits:['One paired real-browser latency observation, not a statistical public-network estimate',
    'First transition uses manual rotate to isolate reserve recheck; second transition is a physical outage',
    'TTL, generation and aggregate saturation are separate Python regressions'],scenarios:[]};
const save=()=>fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
async function until(read,label,ms=15000){const end=Date.now()+ms;while(Date.now()<end){const value=await read();if(value)return value;await delay(30);}throw Error('Timed out: '+label);}
async function bounded(promise,ms){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Cleanup timeout')),ms);})]);}finally{clearTimeout(timer);}}
async function sourceHashes(){const result={};for(const dir of ['native','extension'])for(const file of (await fs.readdir(path.join(root,dir),{withFileTypes:true})).filter(e=>e.isFile()).sort((a,b)=>a.name.localeCompare(b.name)))result[dir+'/'+file.name]=hash(await fs.readFile(path.join(root,dir,file.name)));return result;}

async function scenario(name){
  const row={name,result:'RUNNING',ordinaryPages:[]};report.scenarios.push(row);await save();
  const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'cp-native-reserve-lab-')),profile=path.join(scratch,'profile');
  const modes=['up','up','up','up','up'],ports=[],closes=[],requests=[],sockets=[...Array(5)].map(()=>new Set());
  let chrome,popup,tab,worker,commandSequence=0,connectionSequence=0,heldFirstTrace=false;
  const native=async()=>{try{return (await fs.readFile(path.join(scratch,'native-events.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code==='ENOENT')return [];throw error;}};
  async function allSessionsStopped(){const events=await native(),started=events.filter(e=>e.event==='session-started').map(e=>e.session);return started.length>0&&started.every(session=>events.some(e=>e.event==='session-stopped'&&e.session===session));}
  const state=()=>popup.evaluate(async()=>({...await chrome.storage.local.get(['status','pool','enabled','selectedCountries','selectionMode']),route:await chrome.proxy.settings.get({incognito:false})}));
  const command=(action,extra={})=>{if(action==='disconnect')row.disconnectedAtMs??=Date.now();return popup.evaluate(value=>chrome.runtime.sendMessage(value),{action,...extra});};
  async function fixture(action){const seq=++commandSequence;await fs.writeFile(path.join(scratch,'command.tmp'),JSON.stringify({seq,action}));await fs.rename(path.join(scratch,'command.tmp'),path.join(scratch,'command.json'));return until(async()=>{try{const r=JSON.parse(await fs.readFile(path.join(scratch,'reply.json'),'utf8'));return r.seq===seq&&r.ok&&r;}catch{return false;}},'fixture '+action);}
  async function listen(server){const all=new Set();server.on('connection',socket=>{all.add(socket);socket.on('error',()=>{});socket.on('close',()=>all.delete(socket));});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});closes.push(async()=>{for(const socket of all)socket.destroy();await new Promise(resolve=>server.close(resolve));});return server.address().port;}
  function selected(s,group=countries){assert.deepEqual(s.selectedCountries,group);assert.equal(s.selectionMode,'multiple');assert.equal(s.enabled,true);if(s.status?.country)assert.ok(group.includes(s.status.country));assert.equal(s.route.levelOfControl,'controlled_by_this_extension');assert.equal(s.route.value.mode,'fixed_servers');const rules=s.route.value.rules;assert.deepEqual(rules.proxyForHttp,rules.proxyForHttps);assert.equal(rules.fallbackProxy.port,rules.proxyForHttps.port);assert.ok(rules.bypassList.includes('<-loopback>'));assert.ok([9,...ports].includes(rules.proxyForHttps.port));}
  async function connected(index,ms=15000,group=countries){return until(async()=>{const s=await state();selected(s,group);if(['error','helper'].includes(s.status?.phase))throw Error('Unexpected product error: '+s.status.error);return s.status?.phase==='connected'&&s.status.browser?.ok&&s.status.proxy.port===ports[index]&&s;},'connected '+index,ms);}
  async function ordinary(index,label,group=countries){const before=await state();selected(before,group);assert.equal(before.route.value.rules.proxyForHttps.port,ports[index]);const start=Date.now();const response=await tab.goto('https://example.com/?case='+label+'-'+start,{timeout:8000,waitUntil:'domcontentloaded'});assert.equal(response.status(),200);assert.equal(await tab.locator('body').innerText(),'fixture '+index);const after=await state();selected(after,group);assert.equal(after.status.proxy.port,ports[index]);const result={index,label,country:after.status.country,startMs:start,endMs:Date.now(),status:200};row.ordinaryPages.push(result);return result;}
  const changeMode=(index,mode)=>{modes[index]=mode;for(const socket of sockets[index])socket.destroy();};
  const holds=()=>requests.filter(event=>event.event==='CONNECT'&&event.native&&event.held&&event.atMs>=row.armedAtMs);
  try{
    for(const prefix of ['tls','bad'])execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=www.cloudflare.com',
      '-addext','subjectAltName=DNS:www.cloudflare.com,DNS:www.google.com,DNS:example.com','-keyout',path.join(scratch,prefix+'.key'),'-out',path.join(scratch,prefix+'.crt')],{stdio:'ignore'});
    const key=await fs.readFile(path.join(scratch,'tls.key')),cert=await fs.readFile(path.join(scratch,'tls.crt'));
    const badKey=await fs.readFile(path.join(scratch,'bad.key')),badCert=await fs.readFile(path.join(scratch,'bad.crt'));
    const fp=createHash('sha256').update(createPublicKey(key).export({type:'spki',format:'der'})).digest('base64');
    for(let index=0;index<5;index++){
      const handler=(req,res)=>{const endpoint=req.headers.host==='example.com'?'ordinary':req.url.startsWith('/generate_204')?'target':'trace';requests.push({event:'HTTPS',atMs:Date.now(),index,endpoint,mode:modes[index]});if(modes[index]==='http'&&endpoint==='target'){res.writeHead(503).end();return;}res.writeHead(endpoint==='target'?204:200,{'Content-Type':'text/plain','Cache-Control':'no-store'}).end(endpoint==='target'?undefined:endpoint==='ordinary'?'fixture '+index:'loc='+(modes[index]==='country'?'DE':locations[index])+'\nip=8.8.4.'+(11+index)+'\n');};
      const origin=await listen(https.createServer({key,cert},handler)),badOrigin=await listen(https.createServer({key:badKey,cert:badCert},handler));
      const proxy=http.createServer((_req,res)=>res.writeHead(403).end());
      proxy.on('connect',(req,client,head)=>{
        const connection=++connectionSequence,call=Number(req.headers['x-country-proxy-lab']),isNative=Number.isSafeInteger(call)&&call>0;
        const endpoint=req.url.startsWith('www.cloudflare.com:')?'trace':req.url.startsWith('www.google.com:')?'target':'ordinary';
        const mode=modes[index];let held=isNative&&((mode==='hold')||(mode==='target-held'&&endpoint==='target')||(['http','tls'].includes(mode)&&endpoint==='trace'));
        if(isNative&&mode==='first-trace'&&endpoint==='trace'&&!heldFirstTrace){heldFirstTrace=true;held=true;}
        const event={event:'CONNECT',atMs:Date.now(),index,endpoint,connection,native:isNative,call:isNative?call:null,mode,held};requests.push(event);
        sockets[index].add(client);client.on('close',()=>sockets[index].delete(client));
        if(!['www.cloudflare.com:443','www.google.com:443','example.com:443'].includes(req.url)||mode==='down'){client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');return;}
        if(held){client.once('end',()=>{requests.push({event:'PEER_END',atMs:Date.now(),connection,call});client.end();});client.resume();return;}
        const upstream=net.connect(isNative&&mode==='tls'&&endpoint==='target'?badOrigin:origin,'127.0.0.1',()=>{event.acceptedAtMs=Date.now();client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());client.on('close',()=>upstream.destroy());upstream.on('close',()=>client.destroy());
      });ports.push(await listen(proxy));
    }
    await fs.writeFile(path.join(scratch,'config.json'),JSON.stringify({ports}));
    const extension=path.join(root,'extension'),manifest=JSON.parse(await fs.readFile(path.join(extension,'manifest.json')));
    const id=hash(Buffer.from(manifest.key,'base64')).slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
    const launcher=path.join(scratch,'native');await fs.writeFile(launcher,'#!/bin/sh\nexec '+[process.env.TEST_PYTHON||'python3','-I','-B',path.join(kit,'native_reserve_latency_host.py'),root,scratch].map(quote).join(' ')+'\n',{mode:0o700});
    const registration=path.join(profile,'NativeMessagingHosts');await fs.mkdir(registration,{recursive:true});await fs.writeFile(path.join(registration,'local.country_proxy.json'),JSON.stringify({name:'local.country_proxy',description:'Native reserve latency QA',type:'stdio',path:launcher,allowed_origins:['chrome-extension://'+id+'/']}));
    chrome=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,ignoreDefaultArgs:['--disable-extensions'],args:['--disable-background-networking','--enable-unsafe-extension-debugging','--disable-quic','--load-extension='+extension,'--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE 127.0.0.1','--proxy-server=http://127.0.0.1:9','--ignore-certificate-errors-spki-list='+fp]});
    row.browser=chrome.browser().version();row.executed=await inspectRuntime(chrome,root);worker=chrome.serviceWorkers()[0];await worker.evaluate(()=>{self.qaRoutes=[];chrome.proxy.settings.onChange.addListener(e=>self.qaRoutes.push({atMs:Date.now(),value:e.value}));});
    popup=await chrome.newPage();await popup.goto('chrome-extension://'+id+'/popup.html');tab=await chrome.newPage();assert.equal((await command('connect',{countries})).ok,true);await connected(0);await ordinary(0,'initial');
    await until(async()=>{const s=await fixture('state');return s.entries.includes(ports[1]);},'initial verified reserve');
    row.initial=await fixture('state');const mode={success:'first-trace',http:'http',tls:'tls',country:'country','target-required':'target-held',stop:'hold','group-change':'hold'}[name];assert.ok(mode);
    changeMode(1,mode);await fixture('arm');row.armedAtMs=Date.now();row.trigger='manual rotate isolates reserve verification';assert.equal((await command('rotate')).ok,true);
    await until(()=>requests.some(e=>e.native&&e.index===1&&e.atMs>=row.armedAtMs),'native reserve request');
    if(name==='success'){
      await connected(1,12000);const first=await ordinary(1,'replacement');const events=await native();
      const take=events.find(e=>e.event==='take-start'&&e.atMs>=row.armedAtMs);
      const qualified=events.find(e=>e.event==='check-result'&&e.port===ports[1]&&e.ok&&e.atMs>=row.armedAtMs);
      const feedback=events.find(e=>e.event==='feedback'&&e.command==='confirm'&&e.accepted&&e.port===ports[1]);assert.ok(take&&qualified&&feedback);
      row.timing={takeToNativeMs:qualified.atMs-take.atMs,nativeToChromeConfirmMs:feedback.atMs-qualified.atMs,rotateToOrdinaryMs:first.endMs-row.armedAtMs};
      assert.ok(row.timing.takeToNativeMs<9000,'controlled reserve recheck should finish without the held first connection');
      const original=holds().find(e=>e.index===1&&e.endpoint==='trace');assert.ok(original);
      assert.ok(requests.some(e=>e.event==='CONNECT'&&e.native&&e.index===1&&e.endpoint==='trace'&&e.atMs>original.atMs&&!e.held),'native second connection, not a Chrome hedge');
      await until(()=>requests.some(e=>e.event==='PEER_END'&&e.connection===original.connection),'losing curl connection is reaped',3000);
      row.cancelledOriginal={connection:original.connection,startMs:original.atMs,endMs:requests.find(e=>e.event==='PEER_END'&&e.connection===original.connection).atMs};
      await until(async()=>{const s=await fixture('state');return s.entries.includes(ports[2])&&s.entries.includes(ports[3]);},'refill after accepted B',10000);
      row.refilledAfterChrome=true;changeMode(3,'hold');changeMode(1,'down');row.physicalFailureAtMs=Date.now();
      try{await tab.goto('https://example.com/?physical-fault='+Date.now(),{timeout:8000,waitUntil:'domcontentloaded'});}catch{}
      await connected(2,70000);const second=await ordinary(2,'physical-second-replacement');row.physicalFailureToOrdinaryMs=second.endMs-row.physicalFailureAtMs;
      await until(async()=>{const s=await fixture('state');return s.entries.includes(ports[4]);},'refill after physical replacement',10000);row.refilledAfterPhysicalReplacement=true;
    }else if(['http','tls','country'].includes(name)){
      const failure=await until(async()=>{const events=await native();return events.find(e=>e.event==='check-result'&&e.port===ports[1]&&e.ok===false&&e.atMs>=row.armedAtMs);},'strict native rejection',6000);
      assert.equal(failure.reason,name);row.nativeRejection=failure;
      assert.ok(!(await native()).some(e=>e.event==='status'&&e.status.phase==='connected'&&e.status.proxy?.port===ports[1]&&e.atMs>=row.armedAtMs));
      row.notOfferedToChrome=true;
    }else if(name==='target-required'){
      await delay(6500);assert.ok(requests.some(e=>e.event==='HTTPS'&&e.index===1&&e.endpoint==='trace'&&e.atMs>=row.armedAtMs));
      assert.ok(!(await native()).some(e=>e.event==='status'&&e.status.phase==='connected'&&e.status.proxy?.port===ports[1]&&e.atMs>=row.armedAtMs));row.noOfferWithoutTarget=true;
    }else{
      await until(()=>holds().length>=2,'both native controls held');await delay(5500);
      row.cancelAtMs=Date.now();const before=await fixture('state');row.beforeCancel=before;
      if(name==='stop')assert.equal((await command('disconnect')).ok,true);
      else assert.equal((await command('connect',{countries:['AT','NO']})).ok,true);
      await until(async()=>{const events=await native();return events.some(e=>e.event==='session-stopped'&&e.session===before.session);},'old session cleanup',6000);
      const originalHolds=holds().filter(e=>e.atMs<row.cancelAtMs);await until(()=>originalHolds.every(h=>requests.some(e=>e.event==='PEER_END'&&e.connection===h.connection)),'all owned curl connections closed',3000);
      row.cancelledNativeConnections=originalHolds.length;changeMode(1,'up');await delay(200);
      if(name==='group-change'){await connected(0,10000,['AT','NO']);await ordinary(0,'new-group',['AT','NO']);row.newGroupVerified=true;}
      else{const stopped=await state();assert.equal(stopped.enabled,false);assert.equal(stopped.status.phase,'off');assert.notEqual(stopped.route.levelOfControl,'controlled_by_this_extension');}
      assert.ok(!(await native()).some(e=>e.event==='status'&&e.session===before.session&&e.status.phase==='connected'&&e.atMs>=row.cancelAtMs));row.noLateOffer=true;
    }
    if(!row.disconnectedAtMs)assert.equal((await command('disconnect')).ok,true);
    await until(allSessionsStopped,'every started session stopped');
    const off=await state();assert.equal(off.enabled,false);assert.equal(off.status.phase,'off');assert.notEqual(off.route.levelOfControl,'controlled_by_this_extension');row.disconnectRestored=true;
    row.nativeEvents=await native();row.maxEndpointChecks=Math.max(0,...row.nativeEvents.filter(e=>e.event==='check-start').map(e=>e.running));row.maxCurlProcesses=Math.max(0,...row.nativeEvents.filter(e=>e.event==='curl-start').map(e=>e.running));assert.ok(row.maxEndpointChecks<=10);assert.ok(row.maxCurlProcesses<=22);
    for(const stopped of row.nativeEvents.filter(e=>e.event==='session-stopped')){assert.deepEqual(stopped.inflight,[]);assert.equal(stopped.curlRunning,0);assert.equal(stopped.budget.running,0);assert.equal(stopped.budget.requests,0);assert.equal(stopped.budget.closed,true);if(stopped.supplementalRunning!==null)assert.equal(stopped.supplementalRunning,0);}
    row.browserRoutes=await worker.evaluate(()=>self.qaRoutes);for(const event of row.browserRoutes.filter(e=>e.atMs>=row.armedAtMs&&e.atMs<row.disconnectedAtMs)){assert.equal(event.value.mode,'fixed_servers');const rules=event.value.rules;assert.deepEqual(rules.proxyForHttp,rules.proxyForHttps);assert.equal(rules.fallbackProxy.port,rules.proxyForHttps.port);assert.ok(rules.bypassList.includes('<-loopback>'));assert.ok([9,...ports].includes(rules.proxyForHttps.port));}
    row.result='PASS';
  }catch(error){row.result='FAIL';row.failure=error.stack;if(name==='success')row.censoredAtMs=Date.now();}
  finally{
    const cleanup=[];let closed=!chrome;
    if(popup)await bounded(command('disconnect'),6000).catch(()=>cleanup.push('disconnect'));
    if(popup)await until(allSessionsStopped,'every started session stopped before browser close',6000).catch(()=>cleanup.push('native-session-cleanup'));
    if(chrome){try{await bounded(chrome.close(),12000);closed=true;}catch{cleanup.push('browser');}}
    for(const close of closes.reverse()){try{await bounded(close(),3000);}catch{cleanup.push('local-server');}}
    row.requests=requests;row.ports=ports;row.nativeEvents=await native();
    const identity=row.nativeEvents.find(e=>e.event==='source');
    if(!identity||Object.entries(identity.sha256).some(([name,digest])=>digest!==report.sourceHashes['native/'+name]))cleanup.push('native-source-identity');
    if(closed){await fs.rm(scratch,{recursive:true,force:true});await assert.rejects(fs.access(scratch),{code:'ENOENT'});row.temporaryProfileRemoved=true;}
    if(cleanup.length){row.cleanupErrors=cleanup;row.result='FAIL';}
    await save();
  }
  console.log(JSON.stringify({name,result:row.result,timing:row.timing,failure:row.failure?.split('\n')[0]}));
}
console.log('receipt',path.join(output,'report.json'));report.sourceHashes=await sourceHashes();report.harnessHashes={};
for(const name of ['native-reserve-latency-lab.mjs','native_reserve_latency_host.py','chrome-runtime.mjs'])report.harnessHashes[name]=hash(await fs.readFile(path.join(kit,name)));
for(const name of process.env.TEST_CASE?[process.env.TEST_CASE]:['success','http','tls','country','target-required','stop','group-change'])await scenario(name);
assert.deepEqual(await sourceHashes(),report.sourceHashes,'product snapshot changed during run');report.result=report.scenarios.every(row=>row.result==='PASS')?'PASS':'FAIL';await save();
console.log(JSON.stringify({result:report.result,receipt:path.join(output,'report.json')}));if(report.result!=='PASS')process.exitCode=1;
