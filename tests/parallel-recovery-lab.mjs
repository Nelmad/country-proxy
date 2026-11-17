// Concurrent recovery acceptance against production code in a disposable CfT.
// Synthetic AT/EE/NO origins and local CONNECT faults; no public network traffic.
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

const kit=import.meta.dirname,root=path.resolve(process.env.TEST_SOURCE_ROOT||path.join(kit,'..'));
await fs.mkdir(path.resolve(kit,'../.runtime'),{recursive:true});
const output=await fs.mkdtemp(path.resolve(kit,'../.runtime/parallel-recovery-'));
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const countries=['AT','EE','NO'],locations=['AT','EE','NO','EE','AT'];
const hash=s=>createHash('sha256').update(s).digest('hex');
const quote=s=>"'"+s.replaceAll("'","'\"'\"'")+"'";
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const report={result:'RUNNING',at:new Date().toISOString(),sourceRoot:root,selection:countries,
  publicTraffic:false,syntheticGeoip:true,productionIntervals:true,mainChromeTouched:false,scenarios:[],
  fixtureOverrides:['local country-filtered feeds', 'per-run TLS CA and Chrome SPKI trust',
    'distinct loopback ports stand for distinct public hosts', 'explicit rotate isolates first recovery scheduling',
    'one explicit reserve maintenance trigger isolates event-driven refill; its failure is a real CONNECT error']};
const save=()=>fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
async function until(read,label,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){const v=await read();if(v)return v;await delay(30);}throw Error('Timed out: '+label);}
async function sourceHashes(){const result={};for(const dir of ['native','extension'])for(const entry of (await fs.readdir(path.join(root,dir),{withFileTypes:true})).filter(e=>e.isFile()).sort((a,b)=>a.name.localeCompare(b.name)))result[dir+'/'+entry.name]=hash(await fs.readFile(path.join(root,dir,entry.name)));return result;}
function fixed(route,ports){assert.equal(route.levelOfControl,'controlled_by_this_extension');assert.equal(route.value.mode,'fixed_servers');const rules=route.value.rules;assert.deepEqual(rules.proxyForHttps,rules.proxyForHttp);assert.equal(rules.fallbackProxy.port,rules.proxyForHttps.port);assert.ok(rules.bypassList.includes('<-loopback>'));assert.ok(ports.includes(rules.proxyForHttps.port));return rules.proxyForHttps.port;}

async function scenario(name){
  const row={name,result:'RUNNING',ordinaryPages:[],pageErrors:[]};report.scenarios.push(row);await save();
  const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'cp-parallel-lab-'));
  const profile=path.join(scratch,'profile');const modes=['up','up','up','up','up'];
  const closes=[],sockets=[...Array(5)].map(()=>new Set()),requests=[];
  let chrome,popup,tab,worker,ports=[],sequence=0,connectionSequence=0;
  const native=async()=>{try{return (await fs.readFile(path.join(scratch,'native-events.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT')return [];throw e;}};
  async function listen(server){const all=new Set();server.on('connection',s=>{all.add(s);s.on('error',()=>{});s.on('close',()=>all.delete(s));});await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});closes.push(async()=>{for(const s of all)s.destroy();await new Promise(r=>server.close(r));});return server.address().port;}
  const state=()=>popup.evaluate(async()=>({...await chrome.storage.local.get(['status','pool','selectedCountries','selectionMode','enabled']),route:await chrome.proxy.settings.get({incognito:false})}));
  const command=(action,extra={})=>{if(action==='disconnect')row.disconnectedAtMs??=Date.now();return popup.evaluate(m=>chrome.runtime.sendMessage(m),{action,...extra});};
  async function fixture(action,port){const seq=++sequence;await fs.writeFile(path.join(scratch,'command.tmp'),JSON.stringify({seq,action,port}));await fs.rename(path.join(scratch,'command.tmp'),path.join(scratch,'command.json'));return until(async()=>{try{const r=JSON.parse(await fs.readFile(path.join(scratch,'reply.json'),'utf8'));return r.seq===seq&&r.ok&&r;}catch{return false;}},'fixture '+action);}
  function selection(s){assert.deepEqual(s.selectedCountries,countries);assert.equal(s.selectionMode,'multiple');assert.equal(s.enabled,true);if(s.status?.countries)assert.deepEqual(s.status.countries,countries);if(s.status?.country)assert.ok(countries.includes(s.status.country));fixed(s.route,[9,...ports]);}
  async function connected(index,timeout=12000){return until(async()=>{const s=await state();selection(s);if(s.status?.phase==='error'||s.status?.phase==='helper')throw Error(JSON.stringify(s.status));return s.status?.phase==='connected'&&s.status.proxy?.port===ports[index]&&s.status.browser?.ok&&s;},'connected '+index,timeout);}
  async function ordinary(index,label){const before=await state();selection(before);assert.equal(fixed(before.route,ports),ports[index]);const begin=Date.now();const response=await tab.goto('https://example.com/?test='+label+'-'+begin,{timeout:8000,waitUntil:'domcontentloaded'});assert.equal(response.status(),200);assert.equal(await tab.locator('body').innerText(),'fixture '+index);const after=await state();selection(after);assert.equal(fixed(after.route,ports),ports[index]);assert.ok(requests.some(r=>r.index===index&&r.endpoint==='ordinary'&&r.atMs>=begin));const result={label,index,startMs:begin,completeMs:Date.now(),country:after.status.country,status:200};row.ordinaryPages.push(result);return result;}
  const changeMode=(index,mode)=>{modes[index]=mode;for(const s of sockets[index])s.destroy();};
  const held=(index,after)=>requests.filter(r=>r.index===index&&r.mode==='hold'&&r.atMs>=after&&r.event==='CONNECT');
  try{
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=www.cloudflare.com',
      '-addext','subjectAltName=DNS:www.cloudflare.com,DNS:www.google.com,DNS:example.com','-keyout',path.join(scratch,'tls.key'),'-out',path.join(scratch,'tls.crt')],{stdio:'ignore'});
    const key=await fs.readFile(path.join(scratch,'tls.key')),cert=await fs.readFile(path.join(scratch,'tls.crt'));
    const fp=createHash('sha256').update(createPublicKey(key).export({type:'spki',format:'der'})).digest('base64');
    for(let index=0;index<5;index++){
      const origin=await listen(https.createServer({key,cert},(req,res)=>{
        const endpoint=req.headers.host==='example.com'?'ordinary':req.url.startsWith('/generate_204')?'target':'trace';
        requests.push({atMs:Date.now(),index,endpoint,event:'HTTPS',mode:modes[index]});
        const respond=()=>res.writeHead(endpoint==='target'?204:200,{'Content-Type':'text/plain','Cache-Control':'no-store'})
          .end(endpoint==='target'?undefined:endpoint==='ordinary'?'fixture '+index:'loc='+locations[index]+'\nip=8.8.4.'+(11+index)+'\n');
        if(modes[index]==='slow')setTimeout(respond,500);else respond();
      }));
      const proxy=http.createServer((_q,r)=>r.writeHead(403).end());
      proxy.on('connect',(req,client,head)=>{
        const connectionId=++connectionSequence;
        const endpoint=req.url.startsWith('example.com:')?'ordinary':req.url.startsWith('www.google.com:')?'target':'trace';
        requests.push({atMs:Date.now(),index,endpoint,event:'CONNECT',mode:modes[index],connectionId});
        sockets[index].add(client);client.on('close',()=>sockets[index].delete(client));
        if(!['www.cloudflare.com:443','www.google.com:443','example.com:443'].includes(req.url)||modes[index]==='down'){client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');return;}
        if(modes[index]==='hold'){
          // CONNECT upgrades leave a paused, half-open server socket. Drain the
          // peer FIN and close our writable side; otherwise a stopped curl can
          // look like a leaked client solely because the fixture never reads.
          client.once('end',()=>{requests.push({atMs:Date.now(),index,endpoint,event:'PEER_END',mode:'hold',connectionId});client.end();});
          client.resume();return;
        }
        const upstream=net.connect(origin,'127.0.0.1',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});
        upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());client.on('close',()=>upstream.destroy());upstream.on('close',()=>client.destroy());
      });ports.push(await listen(proxy));
    }
    await fs.writeFile(path.join(scratch,'config.json'),JSON.stringify({ports}));
    const ext=path.join(root,'extension'),manifest=JSON.parse(await fs.readFile(path.join(ext,'manifest.json')));
    const id=hash(Buffer.from(manifest.key,'base64')).slice(0,32).replace(/[a-f0-9]/g,c=>String.fromCharCode(97+parseInt(c,16)));
    const launcher=path.join(scratch,'native');await fs.writeFile(launcher,'#!/bin/sh\nexec '+[process.env.TEST_PYTHON||'python3','-I','-B',path.join(kit,'parallel_recovery_host.py'),root,scratch].map(quote).join(' ')+'\n',{mode:0o700});
    const registration=path.join(profile,'NativeMessagingHosts');await fs.mkdir(registration,{recursive:true});
    await fs.writeFile(path.join(registration,'local.country_proxy.json'),JSON.stringify({name:'local.country_proxy',description:'Parallel recovery QA',path:launcher,type:'stdio',allowed_origins:['chrome-extension://'+id+'/']}));
    chrome=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,ignoreDefaultArgs:['--disable-extensions'],args:[
      '--disable-background-networking','--enable-unsafe-extension-debugging','--disable-quic','--load-extension='+ext,
      '--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE 127.0.0.1','--proxy-server=http://127.0.0.1:9','--ignore-certificate-errors-spki-list='+fp]});
    row.browser=chrome.browser().version();row.executed=await inspectRuntime(chrome,root);
    worker=chrome.serviceWorkers()[0];await worker.evaluate(()=>{self.qaRoutes=[];self.qaErrors=[];chrome.proxy.settings.onChange.addListener(r=>self.qaRoutes.push({atMs:Date.now(),value:r.value}));chrome.proxy.onProxyError.addListener(e=>self.qaErrors.push({atMs:Date.now(),error:e.error}));});
    popup=await chrome.newPage();popup.on('pageerror',e=>row.pageErrors.push(e.message));await popup.goto('chrome-extension://'+id+'/popup.html');tab=await chrome.newPage();
    assert.equal((await command('connect',{countries})).ok,true);await connected(0);await ordinary(0,'initial');
    await until(async()=>{const r=await fixture('state');return r.state.entries.some(e=>e.port===ports[1]);},'verified initial reserve');
    row.initial=await fixture('state');row.trigger='manual rotate isolates discovery scheduling';
    changeMode(1,name==='reserve-wins'?'slow':'hold');changeMode(2,name==='fresh-wins'?'up':'hold');
    await fixture('arm');row.armedAtMs=Date.now();assert.equal((await command('rotate')).ok,true);
    if(name==='cancel-race'){
      await until(()=>held(1,row.armedAtMs).length>=2&&held(2,row.armedAtMs).length>=2,'both branches own real held CONNECTs',6000);
      row.disconnectedAtMs=Date.now();assert.equal((await command('disconnect')).ok,true);
      await until(async()=>{const n=await native();return n.some(e=>e.event==='session-stopped');},'owned cleanup');
      await until(()=>sockets[1].size===0&&sockets[2].size===0,'held native connections close on disconnect',3000);
      row.heldConnectionsClosed=true;changeMode(1,'up');changeMode(2,'up');await delay(500);
      const stopped=await state();assert.equal(stopped.enabled,false);assert.equal(stopped.status.phase,'off');assert.notEqual(stopped.route.levelOfControl,'controlled_by_this_extension');
      row.cleaned=await native();assert.ok(!row.cleaned.some(e=>e.event==='status'&&e.status.phase==='connected'&&e.atMs>=row.disconnectedAtMs));
    }else{
      const winner=name==='fresh-wins'?2:1,loser=name==='fresh-wins'?1:2;
      await connected(winner,6000);row.recovered=await ordinary(winner,'first-replacement');
      assert.equal(modes[loser],'hold','losing branch still physically held at ordinary page success');assert.ok(held(loser,row.armedAtMs).length>=2,'loser had both real native CONNECTs outstanding');
      const evidence=await native();const success=evidence.find(e=>e.event==='check-result'&&e.port===ports[winner]&&e.ok&&e.atMs>=row.armedAtMs);
      assert.ok(success?.otherInflight.includes(ports[loser]),'winner checked successfully before loser was disposed');
      assert.ok(evidence.some(e=>e.event==='check-cancel'&&e.port===ports[loser]&&e.atMs>=row.armedAtMs),'losing native work canceled');
      // Refill is allowed after browser confirmation and may legitimately retry
      // the same cancelled endpoint. Match the old race's physical connections
      // rather than mistaking that new owner for leaked work.
      const raceHeld=held(loser,row.armedAtMs).filter(e=>e.atMs<=success.atMs);
      assert.ok(raceHeld.length>=2,'both losing CONNECTs predate the winner');
      await until(()=>raceHeld.every(start=>requests.some(e=>e.event==='PEER_END'&&e.connectionId===start.connectionId)),
        'exact losing CONNECTs closed by production cleanup',3000);
      row.raceHeldConnections=raceHeld.map(start=>({connectionId:start.connectionId,startMs:start.atMs,
        closedMs:requests.find(e=>e.event==='PEER_END'&&e.connectionId===start.connectionId).atMs}));
      row.heldConnectionsClosed=true;
      row.secondsFromRotateToOrdinary=+( (row.recovered.completeMs-row.armedAtMs)/1000 ).toFixed(3);
      if(name==='fresh-wins'){
        const confirm=await until(async()=>{const n=await native();return n.find(e=>e.event==='feedback'&&e.command==='confirm'&&e.accepted&&e.port===ports[2]);},'B browser confirmation');
        const refill=await until(async()=>{const n=await native();return n.find(e=>e.event==='reserve-accepted'&&e.port===ports[3]&&e.atMs>=confirm.atMs);},'reserve C after B confirmation',5000);
        const offer=(await native()).find(e=>e.event==='status'&&e.status.phase==='connected'&&e.status.proxy?.port===ports[2]);
        assert.ok(offer&&offer.atMs<=confirm.atMs);
        assert.ok(!(await native()).some(e=>e.event==='refill-start'&&e.atMs>=offer.atMs&&e.atMs<confirm.atMs),'refill waits for Chrome confirmation');
        assert.ok(refill.atMs>=confirm.atMs);row.firstRefill={confirmAtMs:confirm.atMs,acceptedAtMs:refill.atMs,seconds:+((refill.atMs-confirm.atMs)/1000).toFixed(3)};
        // A healthy active route loses one reserve. The real CONNECT failure
        // should wake replacement supply rather than sleep for the 30s poll.
        changeMode(1,'down');row.reserveFailureAtMs=Date.now();await fixture('refresh',ports[1]);
        const additional=await until(async()=>{const n=await native();return n.find(e=>e.event==='reserve-accepted'&&e.port===ports[4]&&e.atMs>=row.reserveFailureAtMs);},'D fills removed reserve without 30s poll',5000);
        row.removalRefill={acceptedAtMs:additional.atMs,seconds:+((additional.atMs-row.reserveFailureAtMs)/1000).toFixed(3)};
        await ordinary(2,'after-refill');changeMode(4,'hold');changeMode(2,'down');
        row.physicalFailureAtMs=Date.now();row.secondTrigger='CONNECT 502 + existing socket closure; ordinary tab only, no rotate/check';
        try{await tab.goto('https://example.com/?fault='+Date.now(),{timeout:8000,waitUntil:'domcontentloaded'});row.failedNavigation=false;}catch{row.failedNavigation=true;}
        await connected(3,70000);row.secondRecovery=await ordinary(3,'second-replacement');
        row.secondsFromPhysicalFailureToOrdinary=+((row.secondRecovery.completeMs-row.physicalFailureAtMs)/1000).toFixed(3);
        assert.ok(row.failedNavigation||requests.some(r=>r.index===3&&r.endpoint==='ordinary'&&r.atMs>=row.physicalFailureAtMs));
        const n=await native(),secondOffer=n.find(e=>e.event==='status'&&e.status.phase==='connected'&&e.status.proxy?.port===ports[3]);
        assert.ok(secondOffer&&refill.atMs<secondOffer.atMs,'second winner was admitted as reserve after B confirmation');
        row.secondConfirm=await until(async()=>{const n=await native();return n.find(e=>e.event==='feedback'&&e.command==='confirm'&&e.accepted&&e.port===ports[3]);},'C confirmation');
        row.secondRefillStart=await until(async()=>{const n=await native();return n.find(e=>e.event==='refill-start'&&e.atMs>=row.secondConfirm.atMs);},'refill starts after C confirmation');
      }
      assert.equal((await command('disconnect')).ok,true);
      await until(async()=>{const n=await native();return n.some(e=>e.event==='session-stopped');},'clean stop');
      const stopped=await state();assert.equal(stopped.enabled,false);assert.equal(stopped.status.phase,'off');assert.notEqual(stopped.route.levelOfControl,'controlled_by_this_extension');
    }
    row.nativeEvents=await native();const stopped=row.nativeEvents.findLast(e=>e.event==='session-stopped');
    assert.deepEqual(stopped.inflight,[]);assert.equal(stopped.budget.running,0);assert.equal(stopped.budget.requests,0);assert.equal(stopped.budget.closed,true);
    row.maxPhysicalChecks=Math.max(...row.nativeEvents.filter(e=>e.event==='check-start').map(e=>e.running));assert.ok(row.maxPhysicalChecks<=10);
    row.browserEvents=await worker.evaluate(()=>({routes:self.qaRoutes,errors:self.qaErrors}));
    for(const e of row.browserEvents.routes.filter(e=>e.atMs>=row.armedAtMs&&e.atMs<row.disconnectedAtMs)){
      assert.equal(e.value.mode,'fixed_servers','enabled recovery never uses direct/system routing');
      const rules=e.value.rules;assert.deepEqual(rules.proxyForHttp,rules.proxyForHttps);
      assert.equal(rules.fallbackProxy.host,rules.proxyForHttps.host);assert.equal(rules.fallbackProxy.port,rules.proxyForHttps.port);
      assert.ok(rules.bypassList.includes('<-loopback>'));assert.ok([9,...ports].includes(rules.proxyForHttps.port));
    }
    const identity=row.nativeEvents.find(e=>e.event==='source');assert.ok(identity);
    for(const [name,digest] of Object.entries(identity.sha256))assert.equal(digest,report.sourceHashes['native/'+name]);
    assert.deepEqual(row.pageErrors,[]);row.result='PASS';
  }catch(error){row.result='FAIL';row.failure=error.stack;row.nativeEvents=await native();}
  finally{
    if(popup)await command('disconnect').catch(()=>{});
    if(chrome)await chrome.close();for(const close of closes.reverse())await close();
    row.requests=requests;row.ports=ports;
    const n=await native();row.nativeEvents=n;row.finalNativeStop=n.findLast(e=>e.event==='session-stopped');
    await fs.rm(scratch,{recursive:true,force:true});row.temporaryProfileRemoved=true;
    await save();
  }
  console.log(JSON.stringify({name,result:row.result,secondsFromRotateToOrdinary:row.secondsFromRotateToOrdinary,failure:row.failure}));
}
console.log('receipt',path.join(output,'report.json'));
report.harnessHashes={};
for(const file of ['parallel-recovery-lab.mjs','parallel_recovery_host.py','chrome-runtime.mjs'])report.harnessHashes['tests/'+file]=hash(await fs.readFile(path.join(kit,file)));
report.sourceHashes=await sourceHashes();
for(const name of process.env.TEST_CASE?[process.env.TEST_CASE]:['fresh-wins','reserve-wins','cancel-race'])await scenario(name);
assert.deepEqual(await sourceHashes(),report.sourceHashes,'source snapshot immutable during browser run');
report.result=report.scenarios.every(s=>s.result==='PASS')?'PASS':'FAIL';await save();
console.log(JSON.stringify({result:report.result,receipt:path.join(output,'report.json')}));if(report.result!=='PASS')process.exitCode=1;
