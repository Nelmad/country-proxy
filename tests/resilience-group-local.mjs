// External QA fixture. Uses the unpacked extension as supplied; never forwards to a public service.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,createPublicKey} from 'node:crypto';
import fs from 'node:fs/promises';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {inspectRuntime} from './chrome-runtime.mjs';
import {attachProbeObserver} from './https-probe-observer.mjs';

const kit=import.meta.dirname, root=path.resolve(kit,'..');
await fs.mkdir(path.join(root,'.runtime'),{recursive:true});
const run=await fs.mkdtemp(path.join(root,'.runtime/soak-group-local-'));
const dest=path.join(run,'report.json');
console.log('receipt', dest);
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'cp-offer-local-')), profile=path.join(temp,'profile');
const quote=s=>"'"+s.replaceAll("'","'\"'\"'")+"'";
const allowed=new Set(['www.cloudflare.com:443','www.google.com:443']);
const closes=[], passCounts=[0,0,0];
const modes=['up','up','up'], clients=[new Set(),new Set(),new Set()];
const codes=['AT','EE','NO'];
async function listen(server) {
  const sockets=new Set();
  server.on('connection',s=>{sockets.add(s);s.on('error',()=>{});s.on('close',()=>sockets.delete(s));});
  closes.push(async()=>{for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return server.address().port;
}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn, label, ms=180000) {
  const end=Date.now()+ms;
  while(Date.now()<end){if(await fn())return;await pause(240);}
  throw Error('Missing controlled transition: '+label);
}
let browser, timer, watchdog, observer, monitoring, monitorError, monitoringActive=false;
async function bounded(promise,ms) { let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('QA cleanup timeout')),ms);})]);}finally{clearTimeout(timer);} }
const report={result:'RUNNING',kind:'30-minute-physical-proxy-failures',publicTraffic:false,selection:codes,
  defaultProductTimers:true,nativeAndChromeHttps:true,syntheticGeoip:true,watchdogSeconds:2040,samples:0,ordinaryTabChecks:0,scenarios:[]};
const save=async()=>{await fs.writeFile(dest+'.tmp',JSON.stringify(report,null,2)+'\n',{mode:0o600});await fs.rename(dest+'.tmp',dest);};
try {
  const keyfile=path.join(temp,'tls.key'),certfile=path.join(temp,'tls.crt');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=www.cloudflare.com',
    '-addext','subjectAltName=DNS:www.cloudflare.com,DNS:www.google.com','-keyout',keyfile,'-out',certfile],{stdio:'ignore'});
  const key=await fs.readFile(keyfile), cert=await fs.readFile(certfile);
  const fp=createHash('sha256').update(createPublicKey(key).export({type:'spki',format:'der'})).digest('base64');
  const ports=[];
  for(let idx=0;idx<3;idx++) {
    const origin=await listen(https.createServer({key,cert},(req,res)=>{
      const u=new URL(req.url,'https://local.invalid');
      if(u.pathname==='/cdn-cgi/trace')res.writeHead(200,{'Content-type':'text/plain','Cache-Control':'no-store'}).end('loc='+codes[idx]+'\nip=8.8.4.'+(11+idx)+'\n');
      else if(u.pathname==='/generate_204')res.writeHead(204).end();
      else res.writeHead(404).end();
    }));
    const proxy=http.createServer((_q,res)=>res.writeHead(403).end());
    proxy.on('connect',(req,client,head)=>{
      if(!allowed.has(req.url)){client.destroy();return;}
      if(modes[idx]==='down'){client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');return;}
      clients[idx].add(client);client.once('close',()=>clients[idx].delete(client));
      const upstream=net.connect(origin,'127.0.0.1',()=>{
        passCounts[idx]++;client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);
      });
      upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());
      client.on('close',()=>upstream.destroy());upstream.on('close',()=>client.destroy());
    });
    ports.push(await listen(proxy));
  }
  const extension=path.join(root,'extension');
  const {key:extKey}=JSON.parse(await fs.readFile(path.join(extension,'manifest.json')));
  const id=createHash('sha256').update(Buffer.from(extKey,'base64')).digest('hex').slice(0,32).replace(/[a-f0-9]/g,c=>String.fromCharCode(97+parseInt(c,16)));
  await fs.writeFile(path.join(temp,'ports.json'),JSON.stringify(ports),{mode:0o600});
  const launcher=path.join(temp,'local-host');const python=process.env.TEST_PYTHON || 'python3';
  await fs.writeFile(launcher,'#!/bin/sh\nexec '+[python,'-I','-B',path.join(kit,'resilience_group_local_host.py'),root,temp].map(quote).join(' ')+'\n',{mode:0o700});
  const reg=path.join(profile,'NativeMessagingHosts');await fs.mkdir(reg,{recursive:true});
  await fs.writeFile(path.join(reg,'local.country_proxy.json'),JSON.stringify({name:'local.country_proxy',description:'Offer QA',type:'stdio',path:launcher,allowed_origins:['chrome-extension://'+id+'/']}),{mode:0o600});
  browser=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,ignoreDefaultArgs:['--disable-extensions'],
    args:['--disable-background-networking','--disable-quic','--disable-extensions-except='+extension,'--load-extension='+extension,
      '--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE 127.0.0.1','--proxy-server=http://127.0.0.1:9','--ignore-certificate-errors-spki-list='+fp]});
  watchdog=setTimeout(()=>{monitorError=Error('QA overall 34-minute limit');void browser.close().catch(()=>{});},2040000);
  report.runtime=await inspectRuntime(browser,root);
  observer=await attachProbeObserver(browser,'chrome-extension://'+id+'/background.js');
  const popup=await browser.newPage();await popup.goto('chrome-extension://'+id+'/popup.html');
  const cmd=(action,extra={})=>popup.evaluate(m=>chrome.runtime.sendMessage(m),{action,...extra});
  const state=()=>popup.evaluate(async()=>({...await chrome.storage.local.get(['status','pool','selectedCountries','enabled','selectionMode']),
    route:await chrome.proxy.settings.get({incognito:false})}));
  await popup.evaluate(()=>{
    window.routeViolations=0;window.watch=false;window.qaProxyErrors=0;
    chrome.proxy.onProxyError.addListener(()=>{window.qaProxyErrors++;});
    chrome.proxy.settings.onChange.addListener(c=>{
      if(window.watch && !c.incognitoSpecific && (c.value.mode!=='fixed_servers'||c.levelOfControl!=='controlled_by_this_extension')) window.routeViolations++;
    });
  });
  assert.equal((await cmd('connect',{countries:codes})).ok,true);
  const started=Date.now();report.at=new Date(started).toISOString();report.browser=browser.browser().version();
  const hashes = async()=>{
    const hash=createHash('sha256');
    for(const dir of ['native','extension'])for(const ent of (await fs.readdir(path.join(root,dir),{withFileTypes:true})).filter(e=>e.isFile()).sort((a,b)=>a.name.localeCompare(b.name))){
      hash.update(dir+'/'+ent.name+'\0').update(await fs.readFile(path.join(root,dir,ent.name)));
    }
    return hash.digest('hex');
  };
  report.sourceSHA=await hashes();
  await popup.evaluate(()=>{window.watch=true;});
  const check=async()=>{const s=await state();assert.deepEqual(s.selectedCountries,codes);assert.equal(s.selectionMode,'multiple');assert.equal(s.enabled,true);
    assert.equal(s.route.value.mode,'fixed_servers');assert.equal(s.route.levelOfControl,'controlled_by_this_extension');
    const rules=s.route.value.rules;for(const k of ['proxyForHttp','proxyForHttps','fallbackProxy']){
      const p=rules[k];assert.equal(p.host,'127.0.0.1');assert.ok(ports.includes(p.port)||p.port===9);
    }
    assert.ok(rules.bypassList.includes('<-loopback>'));if(s.status?.country)assert.ok(codes.includes(s.status.country));
    report.samples++;return s;
  };
  const sample=()=>{if(monitoringActive)return;monitoringActive=true;monitoring=check().catch(e=>{monitorError=e;}).finally(()=>{monitoringActive=false;});};
  timer=setInterval(sample,1000);
  const waitState=async(predicate,label)=>{let state;await until(async()=>{if(monitorError)throw monitorError;state=await check();return predicate(state);},label);return state;};
  const healthy=s=>s.status?.phase==='connected' && s.status.browser?.ok && s.route.value.rules.proxyForHttps?.port===s.status.proxy.port;
  const fresh=s=>healthy(s) && s.pool?.count>0 && s.pool.expiresAt>Date.now()+1000;
  const tab=await browser.newPage();
  const trace=async(s)=>{const idx=ports.indexOf(s.status.proxy.port);assert.ok(idx>=0);
    const response=await tab.goto('https://www.cloudflare.com/cdn-cgi/trace?soak='+Date.now(),{timeout:10000});
    assert.equal(response.status(),200);const lines=Object.fromEntries((await tab.locator('body').innerText()).trim().split('\n').map(l=>l.split('=')));
    assert.equal(lines.ip,s.status.browser.exitIp);assert.equal(lines.loc,codes[idx]);report.ordinaryTabChecks++;return idx;
  };
  const at=async(seconds)=>{while(Date.now()<started+seconds*1000){if(monitorError)throw monitorError;await pause(Math.min(1000,started+seconds*1000-Date.now()));}};
  const first=await waitState(fresh,'first route with reserve');report.initialCountry=codes[await trace(first)];await save();
  for(const [number,second] of [60,630,1210].entries()){
    await at(second);const before=await waitState(fresh,'fresh reserve');const idx=await trace(before);
    const failed=Date.now();modes[idx]='down';for(const socket of clients[idx])socket.destroy();
    const after=await waitState(s=>healthy(s) && s.status.proxy.port!==ports[idx],'idle failover');
    const next=await trace(after);assert.notEqual(next,idx);assert.notEqual(before.status.browser.exitIp,after.status.browser.exitIp);
    report.scenarios.push({failureNumber:number+1,injectedAtSeconds:(failed-started)/1000,
      before:codes[idx],after:codes[next],distinctListenerAndTestExit:true,secondsToVerifiedTab:(Date.now()-failed)/1000});
    modes[idx]='up';await save();console.log(JSON.stringify(report.scenarios.at(-1)));
  }
  await at(1800);await trace(await waitState(healthy,'final ordinary tab'));assert.equal(report.sourceSHA,await hashes());
  report.durationSeconds=(Date.now()-started)/1000;assert.ok(report.durationSeconds>=1800);
  report.routeViolations=await popup.evaluate(()=>{window.watch=false;return window.routeViolations;});assert.equal(report.routeViolations,0);
  report.observedProxyErrors=await popup.evaluate(()=>window.qaProxyErrors);
  clearInterval(timer);if(monitoring)await monitoring;if(monitorError)throw monitorError;
  assert.equal((await cmd('disconnect')).ok,true);const stopped=await state();assert.equal(stopped.enabled,false);assert.equal(stopped.status.phase,'off');
  report.disconnectRestored=stopped.route.levelOfControl!=='controlled_by_this_extension';assert.ok(report.disconnectRestored);report.result='PASS';
} catch(err){report.result='FAIL';report.failure=err.stack?.split('\n').slice(0,3).join('\n')||String(err);}
finally {
  clearInterval(timer);clearTimeout(watchdog);if(monitoring)await bounded(monitoring,5000).catch(()=>{});
  const cleanup=[];
  if(observer){
    const snapshot=observer.snapshot(),secondary=snapshot.requests.filter(r=>r.ordinal===2);
    report.workerProbes={observed:snapshot.requests.length,secondaryAttempts:secondary.length,
      cancelledSecondaryAttempts:secondary.filter(r=>r.outcome==='cancelled').length,limited:snapshot.limited,
      cancellationCase:secondary.some(r=>r.outcome==='cancelled')?'observed_but_not_causally_attributed':'not_exercised'};
    try{await bounded(observer.close(),5000);}catch{cleanup.push('observer');}
  }
  let closed=!browser;
  if(browser){try{await bounded(browser.close(),12000);closed=true;}catch{cleanup.push('browser');}}
  for(const close of closes.reverse()){try{await bounded(close(),3000);}catch{cleanup.push('local-server');}}
  if(closed){await fs.rm(temp,{recursive:true,force:true});await assert.rejects(fs.access(temp),{code:'ENOENT'});report.temporaryProfileRemoved=true;}
  if(cleanup.length){report.cleanupErrors=cleanup;report.result='FAIL';}
  await save();
}
console.log(JSON.stringify(report));if(report.result!=='PASS')process.exitCode=1;
