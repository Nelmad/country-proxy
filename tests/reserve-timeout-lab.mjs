// The same local SOCKS5/TLS/Chrome oracle runs unchanged against frozen source roots.
// No product report, check result, timer, timeout decision or browser feedback is injected.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,createPublicKey} from 'node:crypto';
import fs from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {inspectRuntime} from './chrome-runtime.mjs';

const kit=import.meta.dirname,args=process.argv.slice(2),baselineIndex=args.indexOf('--baselineRoot');
const root=path.resolve(baselineIndex>=0?args[baselineIndex+1]:process.env.TEST_SOURCE_ROOT||path.join(kit,'..'));
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const countries=['AT','EE','NO'],locations=['AT','EE','NO','AT','EE'];
const hash=value=>createHash('sha256').update(value).digest('hex');
const quote=value=>"'"+value.replaceAll("'","'\"'\"'")+"'";
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const output=await fs.mkdtemp(path.join(os.tmpdir(),'cp-reserve-timeout-receipt-'));
const report={result:'RUNNING',at:new Date().toISOString(),sourceRoot:root,selection:countries,
  publicTraffic:false,syntheticGeoip:true,mainChromeTouched:false,productionTimers:true,
  limits:['Controlled loopback SOCKS5/HTTPS origins; not a public-proxy reliability estimate',
    'Loopback ports stand in for independent proxy hosts; egress IPs and GeoIP are synthetic',
    'Physical outages use closed proxy sockets; no health result or rotate command is injected'],clockObservations:[],scenarios:[]};
const save=()=>fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
function observeClocks(wallMs,monotonicMs,label){const gapMs=wallMs-monotonicMs;if(Math.abs(gapMs)<=1000)return;const scenario=report.scenarios.at(-1)?.name,observation={scenario,label,wallMs,monotonicMs,gapMs},prior=report.clockObservations.find(item=>item.scenario===scenario&&item.label===label);if(prior){if(Math.abs(gapMs)>Math.abs(prior.gapMs))Object.assign(prior,observation);}else if(report.clockObservations.length<64)report.clockObservations.push(observation);}
async function until(read,label,ms=15000){const activeStart=performance.now(),wallStart=Date.now(),wallEnd=wallStart+ms+120000;while(performance.now()-activeStart<ms){observeClocks(Date.now()-wallStart,performance.now()-activeStart,label);if(Date.now()>wallEnd)throw Error('ERROR_ENVIRONMENT_WALL_CAP: '+label);const value=await read();observeClocks(Date.now()-wallStart,performance.now()-activeStart,label);if(Date.now()>wallEnd)throw Error('ERROR_ENVIRONMENT_WALL_CAP: '+label);if(value)return value;await delay(30);}observeClocks(Date.now()-wallStart,performance.now()-activeStart,label);throw Error('Timed out: '+label);}
async function bounded(promise,ms){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Cleanup timeout')),ms);})]);}finally{clearTimeout(timer);}}
async function sourceHashes(){const result={};for(const dir of ['native','extension'])for(const file of (await fs.readdir(path.join(root,dir),{withFileTypes:true})).filter(e=>e.isFile()).sort((a,b)=>a.name.localeCompare(b.name)))result[dir+'/'+file.name]=hash(await fs.readFile(path.join(root,dir,file.name)));return result;}

async function scenario(name){
  const row={name,result:'RUNNING',ordinaryPages:[],renewals:[],physicalFailovers:[]};report.scenarios.push(row);await save();
  const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'cp-reserve-timeout-profile-')),profile=path.join(scratch,'profile');
  const pendingTunnels=new Set();
  const modes=Array.from({length:5},()=>({kind:'up',failed:false})),ports=[],requests=[],closes=[],sockets=Array.from({length:5},()=>new Set());
  let chrome,popup,tab,worker,sequence=0,connectionSequence=0;
  const native=async()=>{try{return (await fs.readFile(path.join(scratch,'native-events.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code==='ENOENT')return [];throw error;}};
  const state=()=>popup.evaluate(async()=>({...await chrome.storage.local.get(['status','pool','enabled','selectedCountries','selectionMode']),route:await chrome.proxy.settings.get({incognito:false})}));
  const command=(action,extra={})=>{if(action==='disconnect')row.disconnectedAtMs??=Date.now();return popup.evaluate(value=>chrome.runtime.sendMessage(value),{action,...extra});};
  async function fixture(){const seq=++sequence;await fs.writeFile(path.join(scratch,'command.tmp'),JSON.stringify({seq,action:'state'}));await fs.rename(path.join(scratch,'command.tmp'),path.join(scratch,'command.json'));return until(async()=>{try{const value=JSON.parse(await fs.readFile(path.join(scratch,'reply.json'),'utf8'));return value.seq===seq&&value.ok&&value;}catch{return false;}},'native state');}
  async function nativeUntil(read,label,ms){const start=(await fixture()).monotonicMs,wallEnd=Date.now()+ms+120000;while(true){if(Date.now()>wallEnd)throw Error('ERROR_ENVIRONMENT_WALL_CAP: '+label);const value=await read();if(value)return value;if((await fixture()).monotonicMs-start>ms)throw Error('Timed out by native clock: '+label);await delay(30);}}
  async function stopped(){const events=await native(),started=events.filter(e=>e.event==='session-started');return started.length&&started.every(s=>events.some(e=>e.event==='session-stopped'&&e.session===s.session));}
  async function listen(server){const all=new Set();server.on('connection',socket=>{all.add(socket);socket.on('error',()=>{});socket.on('close',()=>all.delete(socket));});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});closes.push(async()=>{for(const socket of all)socket.destroy();await new Promise(resolve=>server.close(resolve));});return server.address().port;}
  function selected(s,group=countries){assert.deepEqual(s.selectedCountries,group);assert.equal(s.selectionMode,'multiple');assert.equal(s.enabled,true);if(s.status?.country)assert.ok(group.includes(s.status.country));assert.equal(s.route.levelOfControl,'controlled_by_this_extension');assert.equal(s.route.value.mode,'fixed_servers');const rules=s.route.value.rules;assert.deepEqual(rules.proxyForHttp,rules.proxyForHttps);assert.equal(rules.fallbackProxy.port,rules.proxyForHttps.port);assert.ok(rules.bypassList.includes('<-loopback>'));assert.ok([9,...ports].includes(rules.proxyForHttps.port));}
  async function connected(index,ms=15000,group=countries){return until(async()=>{const s=await state();selected(s,group);if(['error','helper'].includes(s.status?.phase))throw Error('Product error: '+s.status.error);return s.status?.phase==='connected'&&s.status.browser?.ok&&s.status.proxy.port===ports[index]&&s;},'Chrome connected '+index,ms);}
  async function ordinary(index,label,group=countries){const before=await state();selected(before,group);assert.equal(before.route.value.rules.proxyForHttps.port,ports[index]);const startMs=Date.now(),response=await tab.goto('https://example.com/?case='+label+'-'+startMs,{timeout:8000,waitUntil:'domcontentloaded'});assert.equal(response.status(),200);assert.equal(await tab.locator('body').innerText(),'fixture '+index);const after=await state();selected(after,group);assert.equal(after.status.proxy.port,ports[index]);const value={index,label,country:after.status.country,startMs,endMs:Date.now(),status:200};row.ordinaryPages.push(value);return value;}
  function mode(index,kind){modes[index]={kind,failed:false,armedAtMs:Date.now()};for(const socket of sockets[index])socket.destroy();return Date.now();}
  async function reserve(index){return until(async()=>{const s=await fixture();return s.entries.find(e=>e.port===ports[index]);},'reserve admission '+index,15000);}
  async function arm(index,kind){const admission=await reserve(index),armedAtMonoMs=(await fixture()).monotonicMs,armedAtMs=mode(index,kind),wallEnd=armedAtMs+155000;let maintenance;while(!maintenance){if(Date.now()>wallEnd)throw Error('ERROR_ENVIRONMENT_WALL_CAP: ordinary due maintenance '+index);const snapshot=await fixture(),events=await native();if(Date.now()>wallEnd)throw Error('ERROR_ENVIRONMENT_WALL_CAP: ordinary due maintenance '+index);const leaseAgeMs=snapshot.monotonicMs-admission.verifiedAtMonoMs;observeClocks(Date.now()-admission.checkedAt,leaseAgeMs,'maintenance lease clocks');maintenance=events.find(e=>e.event==='maintenance-start'&&e.port===ports[index]&&e.monotonicMs>=armedAtMonoMs);if(!maintenance&&leaseAgeMs>35000)throw Error('Timed out: ordinary due maintenance '+index+' native lease age='+leaseAgeMs+' ms');if(!maintenance)await delay(30);}const maintenanceAgeMs=maintenance.monotonicMs-admission.verifiedAtMonoMs,maintenanceWallAgeMs=maintenance.atMs-admission.checkedAt;observeClocks(maintenanceWallAgeMs,maintenanceAgeMs,'due maintenance');assert.ok(maintenanceAgeMs>=30000&&maintenanceAgeMs<=35000,'ordinary maintenance must run after 30–35 s of actual pool monotonic time');return {index,port:ports[index],admission,armedAtMs,armedAtMonoMs,maintenanceAtMs:maintenance.atMs,maintenanceAtMonoMs:maintenance.monotonicMs,maintenanceAgeMs,maintenanceWallAgeMs};}
  async function renewed(armed){const end=await nativeUntil(async()=>{const events=await native();return events.find(e=>e.event==='maintenance-end'&&e.port===armed.port&&e.monotonicMs>=armed.armedAtMonoMs);},'maintenance result '+armed.index,42000);assert.equal(end.retained,true,'reserve lost after primary curl28 while its existing extra could still finish');assert.ok(end.verifiedAtMonoMs>armed.admission.verifiedAtMonoMs,'lease must renew only with fresh evidence');const events=await native(),check=events.find(e=>e.event==='check-result'&&e.port===armed.port&&e.stage==='maintenance'&&e.monotonicMs>=armed.armedAtMonoMs);assert.ok(check?.ok,'maintenance full check must succeed');assert.equal(check.country,locations[armed.index]);assert.ok(countries.includes(check.country));const calls=events.filter(e=>e.event==='curl-start'&&e.context?.check===check.check),outcomes=events.filter(e=>e.event==='curl-result'&&e.context?.check===check.check);assert.equal(outcomes.filter(e=>e.code===28).length,1,'one real primary curl28 must precede the successful already-running extra');for(const [endpoint,status] of [['trace','200'],['target','204']])assert.ok(outcomes.some(e=>e.endpoint===endpoint&&e.code===0&&e.httpStatus===status),'both real curl controls must succeed');assert.ok(calls.length<=4);assert.ok(requests.some(e=>e.index===armed.index&&e.releasedAfterPrimary28&&e.atMs>=armed.armedAtMs),'existing extra must actually complete after primary28');for(const call of calls){assert.equal(call.curlConnectTimeout,'30');assert.equal(call.curlMaxTime,'45');assert.equal(call.processTimeout,47);}assert.equal(requests.filter(e=>e.index===armed.index&&e.primaryTimeout&&e.atMs>=armed.armedAtMs).length,1);const primary28=outcomes.find(e=>e.code===28),originCalls=calls.filter(e=>e.endpoint===primary28.endpoint).sort((a,b)=>a.call-b.call),extraSuccess=outcomes.find(e=>e.endpoint===primary28.endpoint&&e.call===originCalls[1]?.call&&e.code===0);assert.equal(originCalls.length,2);assert.ok(extraSuccess&&originCalls[1].monotonicMs<primary28.monotonicMs&&primary28.monotonicMs<extraSuccess.monotonicMs,'only a pre-existing extra may succeed after28');assert.ok(requests.some(e=>e.index===armed.index&&e.releasedAfterPrimary28&&e.nativeCheck===check.check));for(const endpoint of ['trace','target'])assert.ok(calls.filter(e=>e.endpoint===endpoint).length<=2);const value={...armed,primaryTimeoutAtMonoMs:primary28.monotonicMs,extraStartedAtMonoMs:originCalls[1].monotonicMs,extraSucceededAtMonoMs:extraSuccess.monotonicMs,renewedAtMs:end.atMs,renewedAtMonoMs:end.monotonicMs,verifiedAtMonoMs:end.verifiedAtMonoMs,checkedAt:end.checkedAt,check:check.check,country:check.country,exitIp:check.exitIp,curlCalls:calls.length,curlCodes:outcomes.map(e=>({endpoint:e.endpoint,code:e.code,httpStatus:e.httpStatus}))};row.renewals.push(value);return value;}
  async function physical(from,to){
    const atMonoMs=(await fixture()).monotonicMs,atMs=mode(from,'down'),wallEnd=atMs+195000;
    try{await tab.goto('https://example.com/?outage='+atMs,{timeout:8000,waitUntil:'domcontentloaded'});}catch{}
    let verified=false;
    while(!verified){
      if(Date.now()>wallEnd)throw Error('ERROR_ENVIRONMENT_WALL_CAP: physical Chrome connected '+to);
      const snapshot=await fixture(),s=await state();
      if(Date.now()>wallEnd)throw Error('ERROR_ENVIRONMENT_WALL_CAP: physical Chrome connected '+to);
      selected(s);if(['error','helper'].includes(s.status?.phase))throw Error('Product error: '+s.status.error);
      const elapsedNativeMs=snapshot.monotonicMs-atMonoMs;observeClocks(Date.now()-atMs,elapsedNativeMs,'physical Chrome connected '+to);
      verified=s.status?.phase==='connected'&&s.status.browser?.ok&&s.status.proxy.port===ports[to];
      if(!verified&&elapsedNativeMs>75000)throw Error('Timed out: physical Chrome connected '+to+' native elapsed='+elapsedNativeMs+' ms');
      if(!verified)await delay(30);
    }
    const page=await ordinary(to,'physical-'+from+'-'+to),elapsedNativeMs=(await fixture()).monotonicMs-atMonoMs,events=await native();assert.ok(events.some(e=>e.event==='take-result'&&e.port===ports[to]&&e.monotonicMs>=atMonoMs),'replacement must originate from the retained pool');const offered=events.find(e=>e.event==='status'&&e.status.phase==='connected'&&e.status.proxy?.port===ports[to]&&e.monotonicMs>=atMonoMs);const feedback=events.find(e=>e.event==='feedback'&&e.command==='confirm'&&e.accepted&&e.port===ports[to]&&e.monotonicMs>=atMonoMs);assert.ok(offered&&feedback);assert.ok(feedback.monotonicMs-atMonoMs<=75000,'Chrome must confirm within75s of native time');row.physicalFailovers.push({from,to,atMs,atMonoMs,offeredAtMs:offered.atMs,confirmedAtMs:feedback.atMs,ordinaryAtMs:page.endMs,elapsedMs:page.endMs-atMs,elapsedNativeMs,origin:'pool'});
  }
  try{
    for(const prefix of ['tls','bad'])execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=www.cloudflare.com','-addext','subjectAltName=DNS:www.cloudflare.com,DNS:www.google.com,DNS:example.com','-keyout',path.join(scratch,prefix+'.key'),'-out',path.join(scratch,prefix+'.crt')],{stdio:'ignore'});
    const key=await fs.readFile(path.join(scratch,'tls.key')),cert=await fs.readFile(path.join(scratch,'tls.crt')),badKey=await fs.readFile(path.join(scratch,'bad.key')),badCert=await fs.readFile(path.join(scratch,'bad.crt'));
    const fingerprint=createHash('sha256').update(createPublicKey(key).export({type:'spki',format:'der'})).digest('base64');
    for(let index=0;index<5;index++){
      const handler=(req,res)=>{const endpoint=req.headers.host==='example.com'?'ordinary':req.url.startsWith('/generate_204')?'target':'trace',kind=modes[index].kind;requests.push({event:'HTTPS',atMs:Date.now(),index,endpoint,mode:kind});if(kind==='timeout-http'&&endpoint==='target'){res.writeHead(503).end();return;}res.writeHead(endpoint==='target'?204:200,{'Content-Type':'text/plain','Cache-Control':'no-store'}).end(endpoint==='target'?undefined:endpoint==='ordinary'?'fixture '+index:'loc='+(kind==='timeout-country'?'DE':locations[index])+'\nip='+(kind==='timeout-invalid_trace'?'127.0.0.1':'8.8.4.'+(11+index))+'\n');};
      const origin=await listen(https.createServer({key,cert},handler)),badOrigin=await listen(https.createServer({key:badKey,cert:badCert},handler));
      const proxy=net.createServer(client=>{
        const connection=++connectionSequence;sockets[index].add(client);client.on('close',()=>{sockets[index].delete(client);requests.push({event:'CLOSED',atMs:Date.now(),index,connection});});client.on('error',()=>{});
        let buffer=Buffer.alloc(0),phase='greeting';
        const data=chunk=>{
          buffer=Buffer.concat([buffer,chunk]);
          if(phase==='greeting'){
            if(buffer.length<2||buffer.length<2+buffer[1])return;
            if(buffer[0]!==5||!buffer.subarray(2,2+buffer[1]).includes(0)){client.end(Buffer.from([5,255]));return;}
            buffer=buffer.subarray(2+buffer[1]);phase='request';client.write(Buffer.from([5,0]));
          }
          if(phase!=='request'||buffer.length<4)return;
          const type=buffer[3],length=type===3?(buffer.length>=5?buffer[4]:null):type===1?4:type===4?16:null;
          if(length===null)return;
          const offset=type===3?5:4;if(buffer.length<offset+length+2)return;
          const hostname=type===3?buffer.subarray(offset,offset+length).toString():buffer.subarray(offset,offset+length).join('.'),port=buffer.readUInt16BE(offset+length),head=buffer.subarray(offset+length+2);
          client.off('data',data);phase='tunnel';
          const endpoint=hostname==='www.cloudflare.com'?'trace':hostname==='www.google.com'?'target':hostname==='example.com'?'ordinary':'unexpected';
          const current=modes[index],kind=current.kind,faultEndpoint=['timeout-country','timeout-invalid_trace'].includes(kind)?'trace':'target';
          const event={event:'SOCKS',atMs:Date.now(),index,connection,endpoint,mode:kind,rejected:false,held:false};requests.push(event);
          if(endpoint==='unexpected'||port!==443||buffer[0]!==5||buffer[1]!==1||kind==='down'){client.end(Buffer.from([5,1,0,1,0,0,0,0,0,0]));return;}
          if(kind.startsWith('timeout')&&endpoint===faultEndpoint&&!current.failed){current.failed=true;event.held=true;event.primaryTimeout=true;client.once('end',()=>client.end());client.resume();return;}
          if(['timeout-held-target','timeout-stop','timeout-group-change'].includes(kind)&&endpoint==='target'){event.held=true;client.once('end',()=>client.end());client.resume();return;}
          const openTunnel=()=>{if(client.destroyed)return;const upstream=net.connect(kind==='timeout-tls'&&endpoint==='target'?badOrigin:origin,'127.0.0.1',()=>{event.acceptedAtMs=Date.now();event.held=false;client.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());client.on('close',()=>upstream.destroy());upstream.on('close',()=>client.destroy());};
          if(kind.startsWith('timeout')&&endpoint===faultEndpoint&&!current.timeoutReleased){
            event.held=true;event.existingExtra=true;
            const pending=(async()=>{try{
              const observed=await until(async()=>client.destroyed?{closed:true}:(await native()).find(e=>e.event==='curl-result'&&e.port===ports[index]&&e.endpoint===endpoint&&e.code===28&&e.context?.stage==='maintenance'&&e.atMs>=current.armedAtMs),'real primary timeout before extra completes',60000);
              if(!observed.closed){event.releasedAfterPrimary28=true;event.primaryTimeoutObservedAtMs=observed.atMs;event.nativeCheck=observed.context.check;current.timeoutReleased=true;openTunnel();}
            }catch(error){row.fixtureErrors??=[];row.fixtureErrors.push(error.message);client.destroy();}})();
            pendingTunnels.add(pending);pending.finally(()=>pendingTunnels.delete(pending));return;
          }
          openTunnel();
        };client.on('data',data);
      });ports.push(await listen(proxy));
    }
    await fs.writeFile(path.join(scratch,'config.json'),JSON.stringify({ports}));
    const extension=path.join(root,'extension'),manifest=JSON.parse(await fs.readFile(path.join(extension,'manifest.json'))),id=hash(Buffer.from(manifest.key,'base64')).slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
    const launcher=path.join(scratch,'native');await fs.writeFile(launcher,'#!/bin/sh\nexec '+[process.env.TEST_PYTHON||'python3','-I','-B',path.join(kit,'reserve_maintenance_host.py'),root,scratch].map(quote).join(' ')+'\n',{mode:0o700});
    const registration=path.join(profile,'NativeMessagingHosts');await fs.mkdir(registration,{recursive:true});await fs.writeFile(path.join(registration,'local.country_proxy.json'),JSON.stringify({name:'local.country_proxy',description:'Local reserve maintenance QA',type:'stdio',path:launcher,allowed_origins:['chrome-extension://'+id+'/']}));
    chrome=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,ignoreDefaultArgs:['--disable-extensions'],args:['--disable-background-networking','--enable-unsafe-extension-debugging','--disable-quic','--load-extension='+extension,'--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE 127.0.0.1','--proxy-server=http://127.0.0.1:9','--ignore-certificate-errors-spki-list='+fingerprint]});
    row.browser=chrome.browser().version();row.executed=await inspectRuntime(chrome,root);worker=chrome.serviceWorkers()[0];await worker.evaluate(()=>{self.qaRoutes=[];chrome.proxy.settings.onChange.addListener(event=>self.qaRoutes.push({atMs:Date.now(),value:event.value}));});
    popup=await chrome.newPage();await popup.goto('chrome-extension://'+id+'/popup.html');tab=await chrome.newPage();assert.equal((await command('connect',{countries})).ok,true);await connected(0);await ordinary(0,'initial');
    const armed=await arm(1,name==='success'?'timeout':'timeout-'+name);row.armedAtMs=armed.armedAtMs;row.armed=armed;
    if(name==='success'){
      await renewed(armed);await ordinary(0,'after-maintenance');await physical(0,1);const second=await arm(2,'timeout');await renewed(second);await ordinary(1,'after-second-maintenance');await physical(1,2);const proof=await native(),b=proof.find(e=>e.event==='feedback'&&e.command==='confirm'&&e.accepted&&e.port===ports[1]),c=proof.find(e=>e.event==='reserve-accepted'&&e.port===ports[2]);assert.ok(b&&c&&c.monotonicMs>=b.monotonicMs,'C must first enter reserve after B confirmation');assert.ok(!proof.some(e=>e.event==='reserve-accepted'&&e.port===ports[2]&&e.monotonicMs<b.monotonicMs));row.newAfterFirstReplacement=true;await reserve(3);await reserve(4);row.refilledAfterSecondPhysical=true;
    }else if(['tls','http','country','invalid_trace'].includes(name)){
      const failure=await nativeUntil(async()=>{const events=await native();return events.find(e=>e.event==='check-result'&&e.port===ports[1]&&e.stage==='maintenance'&&e.ok===false&&e.atMs>=armed.armedAtMs);},'strict timeout rejection',42000);assert.equal(failure.reason,name);assert.ok((await native()).some(e=>e.event==='curl-result'&&e.context?.check===failure.check&&e.code===28),'negative must exercise actual curl28 first');await until(async()=>{const events=await native();return events.some(e=>e.event==='maintenance-end'&&e.port===ports[1]&&e.atMs>=armed.armedAtMs&&!e.retained);},'rejected reserve removed');assert.ok(!((await fixture()).entries.some(e=>e.port===ports[1])));row.nativeRejection=failure;await ordinary(0,'after-strict-rejection');
    }else{
      await until(()=>requests.some(e=>e.index===1&&e.held&&e.atMs>=armed.armedAtMs),'timeout connection held',10000);if(name==='held-target')await delay(5500);else{const primary=await nativeUntil(async()=>(await native()).find(e=>e.event==='curl-result'&&e.port===ports[1]&&e.endpoint==='target'&&e.code===28&&e.context?.stage==='maintenance'&&e.atMs>=armed.armedAtMs),'primary28 before cancellation',42000);row.cancelAfterPrimary28={check:primary.context.check,atMs:primary.atMs};}assert.ok(!(await native()).some(e=>e.event==='check-result'&&e.port===ports[1]&&e.ok&&e.atMs>=armed.armedAtMs));row.noRenewalWithoutTarget=true;
      if(name==='held-target'){
        const failure=await nativeUntil(async()=>{const events=await native();return events.find(e=>e.event==='check-result'&&e.port===ports[1]&&e.stage==='maintenance'&&e.ok===false&&e.atMs>=armed.armedAtMs);},'held SOCKS handshake timeout',42000);row.nativeRejection=failure;assert.equal(failure.reason,'timeout');assert.equal(failure.endpoint,'target');assert.equal(failure.code,28);
        // Both SOCKS handshakes are held. The primary expires at30s; the
        // already-running extra can use its remaining connect budget, inside47s.
        const events=await native(),calls=events.filter(e=>e.event==='curl-start'&&e.context?.check===failure.check),outcomes=events.filter(e=>e.event==='curl-result'&&e.context?.check===failure.check);
        assert.equal(calls.length,3,'one trace and two target transfers, no third target');for(const call of calls){assert.equal(call.curlConnectTimeout,'30');assert.equal(call.curlMaxTime,'45');assert.equal(call.processTimeout,47);}
        const targetCalls=calls.filter(e=>e.endpoint==='target'),targetResults=outcomes.filter(e=>e.endpoint==='target');assert.equal(targetCalls.length,2);assert.deepEqual(targetResults.map(e=>e.code),[28,28]);assert.ok(outcomes.some(e=>e.endpoint==='trace'&&e.code===0&&e.httpStatus==='200'));
        const checkStart=events.find(e=>e.event==='check-start'&&e.check===failure.check),timeoutElapsedMs=targetResults[1].monotonicMs-targetCalls[1].monotonicMs,checkElapsedMs=failure.monotonicMs-checkStart.monotonicMs,timeoutWallElapsedMs=targetResults[1].atMs-targetCalls[1].atMs,checkWallElapsedMs=failure.atMs-checkStart.atMs;row.deadlineEvidence={phase:'SOCKS handshake',clock:'Python time.monotonic',expectedConnectTimeoutMs:30000,curlMaxTimeMs:45000,processTimeoutMs:47000,timeoutElapsedMs,checkElapsedMs,timeoutWallElapsedMs,checkWallElapsedMs};observeClocks(timeoutWallElapsedMs,timeoutElapsedMs,'held SOCKS timeout');observeClocks(checkWallElapsedMs,checkElapsedMs,'held SOCKS complete check');assert.ok(timeoutElapsedMs>=0&&timeoutElapsedMs<=34000,'held SOCKS handshake must not exceed its original connect limit plus margin');assert.ok(checkElapsedMs>=0&&checkElapsedMs<=40000,'the existing delayed connection must stay inside the original47s supervisor');
        await until(async()=>{const events=await native();return events.some(e=>e.event==='maintenance-end'&&e.port===ports[1]&&e.atMs>=armed.armedAtMs&&!e.retained);},'timed out reserve removed');await ordinary(0,'after-held-target');
      }else{
        const before=await fixture();assert.ok(before.inflight.includes(ports[1])&&before.supplementalRunning>0,'cancellation must reach the new await-existing-extra state');row.cancelAtMs=Date.now();
        if(name==='group-change')assert.equal((await command('connect',{countries:['AT','NO']})).ok,true);else assert.equal((await command('disconnect')).ok,true);
        await until(async()=>{const events=await native();return events.some(e=>e.event==='session-stopped'&&e.session===before.session);},'old session cleanup',6000);
        const held=requests.filter(e=>e.index===1&&e.held&&e.atMs>=armed.armedAtMs&&e.atMs<row.cancelAtMs);await until(()=>held.every(h=>requests.some(e=>e.event==='CLOSED'&&e.connection===h.connection)),'held sockets reaped',3000);row.cancelledHeldConnections=held.length;
        mode(1,'up');await delay(200);assert.ok(!(await native()).some(e=>e.event==='status'&&e.session===before.session&&e.status.phase==='connected'&&e.status.proxy?.port===ports[1]&&e.atMs>=row.cancelAtMs));row.noLateOffer=true;
        if(name==='group-change'){await connected(0,15000,['AT','NO']);await ordinary(0,'new-group',['AT','NO']);row.newGroupVerified=true;}
      }
    }
    assert.ok(!(await native()).some(e=>e.event==='feedback'&&e.command==='confirm'&&e.accepted&&e.port===ports[1]&&e.atMs>=armed.armedAtMs)||name==='success','bad reserve must never reach browser confirmation');
    assert.ok(name==='success'||!(await native()).some(e=>e.event==='status'&&e.status.phase==='connected'&&e.status.proxy?.port===ports[1]&&e.atMs>=armed.armedAtMs),'bad reserve must never be offered to Chrome');
    if(!row.disconnectedAtMs)assert.equal((await command('disconnect')).ok,true);await until(stopped,'all native sessions stopped');const off=await state();assert.equal(off.enabled,false);assert.equal(off.status.phase,'off');assert.notEqual(off.route.levelOfControl,'controlled_by_this_extension');row.disconnectRestored=true;row.result='PASS';
  }catch(error){row.result=error.message.startsWith('ERROR_ENVIRONMENT_')?error.message.split(':')[0]:'FAIL';row.failure=error.stack;}
  finally{
    const errors=[];let closed=!chrome;
    if(popup)await bounded(command('disconnect'),6000).catch(()=>errors.push('disconnect'));
    if(popup)await until(stopped,'native cleanup',6000).catch(()=>errors.push('native cleanup'));
    if(worker)try{row.browserRoutes=await worker.evaluate(()=>self.qaRoutes);}catch(error){errors.push('route observation: '+error.message);}
    if(chrome){try{await bounded(chrome.close(),12000);closed=true;}catch{errors.push('browser cleanup');}}
    for(const close of closes.reverse()){try{await bounded(close(),3000);}catch{errors.push('server cleanup');}}
    await bounded(Promise.allSettled([...pendingTunnels]),3000).catch(()=>errors.push('pending tunnel cleanup'));if(pendingTunnels.size)errors.push('pending tunnel leak');if(row.fixtureErrors?.length)errors.push('fixture error');row.pendingTunnelTasks=pendingTunnels.size;row.requests=requests;row.ports=ports;row.nativeEvents=await native();
    row.maxEndpointChecks=Math.max(0,...row.nativeEvents.filter(e=>e.event==='check-start').map(e=>e.running));row.maxCurlProcesses=Math.max(0,...row.nativeEvents.filter(e=>e.event==='curl-start').map(e=>e.running));
    try{assert.ok(row.maxEndpointChecks<=10);assert.ok(row.maxCurlProcesses<=22);for(const stopped of row.nativeEvents.filter(e=>e.event==='session-stopped')){assert.deepEqual(stopped.inflight,[]);assert.equal(stopped.curlRunning,0);assert.equal(stopped.budget.running,0);assert.equal(stopped.budget.requests,0);assert.equal(stopped.budget.closed,true);if(stopped.supplementalRunning!==null)assert.equal(stopped.supplementalRunning,0);}const identity=row.nativeEvents.find(e=>e.event==='source');assert.ok(identity);for(const [name,digest] of Object.entries(identity.sha256))assert.equal(digest,report.sourceHashes['native/'+name]);}catch(error){errors.push(error.message);}
    for(const event of row.browserRoutes||[])if(event.atMs>=row.armedAtMs&&event.atMs<row.disconnectedAtMs)try{assert.equal(event.value.mode,'fixed_servers');const rules=event.value.rules;assert.deepEqual(rules.proxyForHttp,rules.proxyForHttps);assert.equal(rules.fallbackProxy.port,rules.proxyForHttps.port);assert.ok(rules.bypassList.includes('<-loopback>'));assert.ok([9,...ports].includes(rules.proxyForHttps.port));}catch(error){errors.push('route: '+error.message);}
    if(closed){await fs.rm(scratch,{recursive:true,force:true});row.temporaryProfileRemoved=true;}
    if(errors.length){row.cleanupErrors=errors;row.priorResult=row.result;row.result='FAIL';}await save();
  }
  console.log(JSON.stringify({name,result:row.result,renewals:row.renewals.length,physicalFailovers:row.physicalFailovers.length,failure:row.failure?.split('\n')[0]}));
}

console.log('receipt',path.join(output,'report.json'));report.sourceHashes=await sourceHashes();report.harnessHashes={};for(const name of ['reserve-timeout-lab.mjs','reserve_maintenance_host.py','chrome-runtime.mjs'])report.harnessHashes[name]=hash(await fs.readFile(path.join(kit,name)));
for(const name of process.env.TEST_CASE?[process.env.TEST_CASE]:['success','tls','http','country','invalid_trace','held-target','stop','group-change'])await scenario(name);
assert.deepEqual(await sourceHashes(),report.sourceHashes,'product snapshot changed during run');report.result=report.scenarios.some(row=>row.result==='FAIL')?'FAIL':report.scenarios.every(row=>row.result==='PASS')?'PASS':report.scenarios.find(row=>row.result.startsWith('ERROR_ENVIRONMENT_'))?.result||'FAIL';await save();console.log(JSON.stringify({result:report.result,receipt:path.join(output,'report.json')}));if(report.result!=='PASS')process.exitCode=1;
