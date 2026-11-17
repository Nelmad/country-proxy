// Production native/browser diagnostics against deterministic local HTTPS faults.
// Own disposable Chrome profile, one-run certificate, no external services.
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

const kit = import.meta.dirname;
const root = path.resolve(process.env.TEST_SOURCE_ROOT || path.join(kit, '..'));
const outputRoot = path.resolve(kit, '../.runtime');
await fs.mkdir(outputRoot, {recursive:true});
const output = await fs.mkdtemp(path.join(outputRoot, 'reserve-removal-'));
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-reserve-removal-'));
const profile = path.join(scratch, 'profile');
const reportPath = path.join(output, 'report.json');
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const report = {result:'RUNNING', sourceRoot:root, selection:['AT','EE','NO'], publicTraffic:false,
  nativeAndBrowserHttps:true, syntheticGeoip:true, scenarios:[], pageErrors:[], ordinaryTabChecks:0,
  fixtureOverrides:['local feeds and per-run CA', 'loopback pool identity and quarantine by host and port', 'explicit maintenance and prune triggers']};
const codes = report.selection;
const modes = ['up','up','up'];
const closes = [], clients = [new Set(),new Set(),new Set()], requests = [];
let chrome, popup, tab, ports, expectedActive, sequence = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = s => "'" + s.replaceAll("'", "'\"'\"'") + "'";
const hash = s => createHash('sha256').update(s).digest('hex');
const save = () => fs.writeFile(reportPath, JSON.stringify(report,null,2)+'\n', {mode:0o600});
async function until(read, label, timeout=20000) {
  const end = Date.now()+timeout;
  while (Date.now()<end) { const value = await read(); if (value) return value; await delay(50); }
  throw Error('Timed out: '+label);
}
async function listen(server) {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket); socket.on('error',()=>{}); socket.on('close',()=>sockets.delete(socket));
  });
  closes.push(async()=>{for(const socket of sockets)socket.destroy(); await new Promise(resolve=>server.close(resolve));});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return server.address().port;
}
async function sourceHashes() {
  const result = {};
  for(const directory of ['native','extension']) {
    for(const entry of (await fs.readdir(path.join(root,directory),{withFileTypes:true})).filter(e=>e.isFile()).sort((a,b)=>a.name.localeCompare(b.name))) {
      result[directory+'/'+entry.name] = hash(await fs.readFile(path.join(root,directory,entry.name)));
    }
  }
  return result;
}
const state = () => popup.evaluate(async()=>({...await chrome.storage.local.get(['status','pool','reserveDiagnostics','selectedCountries','selectionMode','enabled']),
  route:await chrome.proxy.settings.get({incognito:false})}));
const command = (action, extra={}) => popup.evaluate(m=>chrome.runtime.sendMessage(m),{action,...extra});
async function fixture(action, port) {
  const seq=++sequence;
  await fs.writeFile(path.join(scratch,'command.tmp'),JSON.stringify({seq,action,port}));
  await fs.rename(path.join(scratch,'command.tmp'),path.join(scratch,'command.json'));
  const reply=await until(async()=>{
    try {const r=JSON.parse(await fs.readFile(path.join(scratch,'reply.json'),'utf8'));return r.seq===seq && r;} catch{return false;}
  },'fixture '+action);
  assert.equal(reply.ok,true,reply.error);return reply;
}
async function invariants() {
  const s=await state();
  assert.deepEqual(s.selectedCountries,codes);assert.equal(s.selectionMode,'multiple');assert.equal(s.enabled,true);
  assert.equal(s.status.phase,'connected');assert.equal(s.status.proxy.port,expectedActive);
  assert.equal(s.route.levelOfControl,'controlled_by_this_extension');assert.equal(s.route.value.mode,'fixed_servers');
  assert.equal(s.route.value.rules.proxyForHttps.port,expectedActive);assert.equal(s.status.browser.ok,true);
  const response=await tab.goto('https://www.cloudflare.com/cdn-cgi/trace?ordinary='+Date.now(),{timeout:10000});
  assert.equal(response.status(),200);
  const text=await tab.locator('body').innerText();
  assert.match(text,/loc=AT/);assert.match(text,/ip=8\.8\.4\.11/);
  report.ordinaryTabChecks++;return s;
}
async function initial() {
  modes.fill('up');
  // Each scenario owns a fresh native session; failure history cannot poison the next control.
  assert.equal((await command('disconnect')).ok,true);
  await fs.rm(path.join(scratch,'command.json'),{force:true});
  await fs.rm(path.join(scratch,'reply.json'),{force:true});
  assert.equal((await command('connect',{countries:codes})).ok,true);
  const s=await until(async()=>{
    const s=await state();
    if(s.status?.phase==='error')throw Error(s.status.error);
    return s.status?.phase==='connected' && s.status.browser?.ok && s.pool?.count===2 && s;
  },'active and two native reserves',30000);
  expectedActive=s.status.proxy.port;assert.equal(expectedActive,ports[0]);
  await invariants();
  const native=await fixture('state');
  assert.equal(native.after.entries.length,2);
  return native.after;
}
async function measure(label) {
  await popup.locator('#reserve-diagnostics summary').click();
  await until(()=>popup.locator('#reserve-removal-list').isVisible(),'visible removal list');
  const cdp=await chrome.newCDPSession(popup);
  const cases=[];
  for(const font of [16,32]) {
    await popup.setViewportSize({width:320,height:600});
    await cdp.send('Page.setFontSizes',{fontSizes:{standard:font,fixed:font-2}});
    await popup.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const layout=await popup.evaluate(()=>{
      const list=document.getElementById('reserve-removal-list');
      return {viewport:innerWidth,width:document.documentElement.scrollWidth,
        listWidth:list.clientWidth,listScroll:list.scrollWidth,
        computedFont:parseFloat(getComputedStyle(list).fontSize),text:list.innerText};
    });
    assert.ok(layout.width<=320+1,JSON.stringify(layout));
    assert.ok(layout.listScroll<=layout.listWidth+1,JSON.stringify(layout));
    assert.ok(layout.text.length>0);cases.push({font,...layout});
    if(font===32){
      assert.ok(layout.computedFont>=cases[0].computedFont*1.99,'Actual diagnostics font doubles');
      await popup.locator('#reserve-removals').scrollIntoViewIfNeeded();
      await popup.screenshot({path:path.join(output,label+'-320-200.png')});
    }
  }
  await cdp.detach();return cases;
}
async function removal(label, action, mode, expected) {
  const before=await initial();
  const port=ports[1], entry=before.entries.find(e=>e.port===port);
  assert.ok(entry);
  if(mode)modes[1]=mode;
  const started=Date.now();const reply=await fixture(action,port);
  assert.equal(reply.after.entries.some(e=>e.port===port),false,'removed lease absent from actual native pool');
  const nativeRemoval=reply.after.diagnostics.removals?.find(row=>row.reserveId===entry.reserveId);
  const s=await invariants();
  const shown=await until(async()=>{
    const s=await state();return s.reserveDiagnostics?.removals?.length && s.reserveDiagnostics;
  },'addressed removal reaches Chrome storage',2000).catch(()=>null);
  const result={name:label,before:entry,nativeRemoval,browserRemoval:shown?.removals?.find(row=>row.reserveId===entry.reserveId),
    retainedActive:true,expected,networkRequests:requests.filter(r=>r.atMs>=started && r.index===1),
    oldAggregateRemoved:reply.after.diagnostics.counts.removed||0};
  report.scenarios.push(result);await save();
  assert.ok(nativeRemoval,'native must publish exact removal, not only removed counter');
  assert.equal(reply.after.diagnostics.removals.length,1,'one failed lease produces one exact removal');
  assert.equal(reply.after.entries.length,1,'independent healthy reserve stays present');
  assert.equal(nativeRemoval.reason,expected.reason);assert.equal(nativeRemoval.stage,expected.stage);
  assert.match(nativeRemoval.reserveId,/^[a-f0-9]{32}$/);
  if(entry.reserveId)assert.equal(nativeRemoval.reserveId,entry.reserveId);
  if(expected.check)for(const [key,value] of Object.entries(expected.check))assert.equal(nativeRemoval.check?.[key],value);
  assert.deepEqual(result.browserRemoval,nativeRemoval,'browser keeps the exact bounded native removal');
  result.layout=await measure(label);await save();
  if(expected.check?.status)assert.ok(result.layout.every(c=>c.text.includes('HTTP '+expected.check.status) && c.text.includes('Google')));
  if(expected.check?.code)assert.ok(result.layout.every(c=>c.text.includes('код curl '+expected.check.code) && c.text.includes('Google')));
}
try {
  console.log('receipt',reportPath);
  report.sourceHashes=await sourceHashes();
  for(const prefix of ['tls','untrusted'])execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1',
    '-subj','/CN=www.cloudflare.com','-addext','subjectAltName=DNS:www.cloudflare.com,DNS:www.google.com',
    '-keyout',path.join(scratch,prefix+'.key'),'-out',path.join(scratch,prefix+'.crt')],{stdio:'ignore'});
  const key=await fs.readFile(path.join(scratch,'tls.key')),cert=await fs.readFile(path.join(scratch,'tls.crt'));
  const fp=createHash('sha256').update(createPublicKey(key).export({type:'spki',format:'der'})).digest('base64');
  const badOrigin=await listen(https.createServer({key:await fs.readFile(path.join(scratch,'untrusted.key')),
    cert:await fs.readFile(path.join(scratch,'untrusted.crt'))},(_q,r)=>r.writeHead(204).end()));
  ports=[];
  for(let index=0;index<3;index++) {
    const origin=await listen(https.createServer({key,cert},(request,response)=>{
      const pathname=new URL(request.url,'https://local.invalid').pathname;
      const target=pathname==='/generate_204';
      if(!target && pathname!=='/cdn-cgi/trace'){response.writeHead(404).end();return;}
      requests.push({atMs:Date.now(),index,endpoint:target?'target':'trace',mode:modes[index]});
      if(modes[index]==='hold')return;
      if(target && modes[index]==='http503')response.writeHead(503,{'Cache-Control':'no-store'}).end();
      else response.writeHead(target?204:200,{'Content-Type':'text/plain','Cache-Control':'no-store'})
        .end(target?undefined:'loc='+codes[index]+'\nip=8.8.4.'+(11+index)+'\n');
    }));
    const proxy=http.createServer((_q,r)=>r.writeHead(403).end());
    proxy.on('connect',(request,client,head)=>{
      if(!['www.cloudflare.com:443','www.google.com:443'].includes(request.url)){client.destroy();return;}
      clients[index].add(client);client.on('close',()=>clients[index].delete(client));
      const endpoint=request.url.startsWith('www.google')?'target':'trace';
      const upstream=net.connect(endpoint==='target' && modes[index]==='tls60'?badOrigin:origin,'127.0.0.1',()=>{
        requests.push({atMs:Date.now(),index,endpoint,event:'CONNECT',mode:modes[index]});
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);
      });
      upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());
      client.on('close',()=>upstream.destroy());upstream.on('close',()=>client.destroy());
    });
    ports.push(await listen(proxy));
  }
  await fs.writeFile(path.join(scratch,'config.json'),JSON.stringify({ports}));
  const ext=path.join(root,'extension'), manifest=JSON.parse(await fs.readFile(path.join(ext,'manifest.json')));
  const id=hash(Buffer.from(manifest.key,'base64')).slice(0,32).replace(/[a-f0-9]/g,c=>String.fromCharCode(97+parseInt(c,16)));
  const launcher=path.join(scratch,'native');
  await fs.writeFile(launcher,'#!/bin/sh\nexec '+[process.env.TEST_PYTHON||'python3','-I','-B',path.join(kit,'reserve_removal_host.py'),root,scratch].map(quote).join(' ')+'\n',{mode:0o700});
  const registration=path.join(profile,'NativeMessagingHosts');await fs.mkdir(registration,{recursive:true});
  await fs.writeFile(path.join(registration,'local.country_proxy.json'),JSON.stringify({name:'local.country_proxy',description:'Reserve removal QA',
    path:launcher,type:'stdio',allowed_origins:['chrome-extension://'+id+'/']}));
  chrome=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,ignoreDefaultArgs:['--disable-extensions'],args:[
    '--disable-background-networking','--enable-unsafe-extension-debugging','--disable-quic','--load-extension='+ext,
    '--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE 127.0.0.1','--proxy-server=http://127.0.0.1:9','--ignore-certificate-errors-spki-list='+fp]});
  report.browser=chrome.browser().version();report.executed=await inspectRuntime(chrome,root);
  popup=await chrome.newPage();popup.on('pageerror',e=>report.pageErrors.push(e.message));
  await popup.goto('chrome-extension://'+id+'/popup.html');tab=await chrome.newPage();
  const before=await initial();
  const refreshed=await fixture('refresh',ports[1]);
  assert.equal(refreshed.after.entries.length,2);assert.equal(refreshed.after.diagnostics.removals?.length||0,0);
  await invariants();report.scenarios.push({name:'successful-refresh',removed:false,entries:refreshed.after.entries});
  modes[1]='hold';const requestIndex=requests.length;
  await fixture('refresh-start',ports[1]);
  await until(()=>requests.slice(requestIndex).filter(r=>r.index===1 && !r.event).length===2,'two held real HTTPS requests');
  const cancelled=await fixture('refresh-cancel',ports[1]);modes[1]='up';
  assert.equal(cancelled.after.entries.length,2);assert.equal(cancelled.after.diagnostics.removals?.length||0,0);
  await invariants();report.scenarios.push({name:'cancelled-refresh',removed:false,entries:cancelled.after.entries});await save();
  await removal('google-http503','refresh','http503',{reason:'checkFailed',stage:'maintenance',check:{reason:'http',endpoint:'target',status:503}});
  await removal('google-tls60','refresh','tls60',{reason:'checkFailed',stage:'maintenance',check:{reason:'tls',endpoint:'target',code:60}});
  await removal('lease-expired','expire',null,{reason:'expired',stage:'prune'});
  await removal('lease-outside-group','outside',null,{reason:'outsideGroup',stage:'prune'});
  assert.deepEqual(await sourceHashes(),report.sourceHashes,'source snapshot immutable during browser run');
  assert.deepEqual(report.pageErrors,[]);assert.equal((await command('disconnect')).ok,true);
  const stopped=await state();assert.equal(stopped.enabled,false);assert.equal(stopped.status.phase,'off');
  report.disconnectRestored=stopped.route.levelOfControl!=='controlled_by_this_extension';assert.ok(report.disconnectRestored);
  report.result='PASS';
} catch(error) {report.result='FAIL';report.failure=error.stack;}
finally {
  if(chrome)await chrome.close();for(const close of closes.reverse())await close();
  try {await fs.copyFile(path.join(scratch,'native-events.jsonl'),path.join(output,'native-events.jsonl'));}catch{}
  await fs.rm(scratch,{recursive:true,force:true});report.temporaryProfileRemoved=true;
  await save();
}
console.log(JSON.stringify({result:report.result,receipt:reportPath,scenarios:report.scenarios.map(s=>s.name),failure:report.failure}));
if(report.result!=='PASS')process.exitCode=1;
