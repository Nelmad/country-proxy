// Explicit macOS/Linux browser acceptance: disposable same-path install/update/rollback.
// TEST_BASELINE_ROOT is read-only; every write stays in a new .runtime run directory.
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
const baseline=path.resolve(process.env.TEST_BASELINE_ROOT || '');
assert.ok(process.env.TEST_BASELINE_ROOT && baseline!==root,'Set TEST_BASELINE_ROOT to the read-only previous bundle');
const python=process.env.TEST_PYTHON || 'python3';
const roots=['extension','native','scripts','tests','docs','config','.github'];
const files=['README.md','CHANGELOG.md','CONTRIBUTING.md','Install.command','requirements.txt','package.json','project-checks.json','repo-manifest.json','AGENTS.md','CLAUDE.md','.gitignore'];
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function bounded(task,ms,message){let timer;try{return await Promise.race([task,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),ms);})]);}finally{clearTimeout(timer);}}
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
const quote=s=>"'"+s.replaceAll("'","'\"'\"'")+"'";
const report={at:new Date().toISOString(),kind:'isolated-install-update-rollback',result:'FAIL',stages:[],publicProxyPair:false,mainChromeTouched:false};
let browser,proxy,run,popup,registrationFile,installedRegistration;
async function exists(p){try{await fs.lstat(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function copySafe(source,dest){
 const info=await fs.lstat(source);assert.ok(!info.isSymbolicLink(),'No source symlinks');
 if(info.isDirectory()){
  await fs.mkdir(dest,{recursive:true});
  for(const name of (await fs.readdir(source)).sort())if(name!=='__pycache__' && name!=='.DS_Store')await copySafe(path.join(source,name),path.join(dest,name));
 }else{assert.ok(info.isFile());if(!source.endsWith('.pyc'))await fs.copyFile(source,dest);}
}
async function copyBundle(source,dest,replace=false){
 await fs.mkdir(dest,{recursive:true});
 for(const name of [...roots,...files]){
  const from=path.join(source,name),to=path.join(dest,name);
  if(replace)await fs.rm(to,{recursive:true,force:true});
  if(await exists(from))await copySafe(from,to);
 }
}
async function productHashes(dir){
 const out={};
 async function walk(at){for(const name of (await fs.readdir(at)).sort()){
  if(name==='__pycache__' || name.endsWith('.pyc'))continue;
  const p=path.join(at,name),s=await fs.lstat(p);assert.ok(!s.isSymbolicLink());
  if(s.isDirectory())await walk(p);else out[path.relative(dir,p)]=sha(await fs.readFile(p));
 }}
 for(const sub of ['extension','native'])await walk(path.join(dir,sub));return out;
}
async function listenProxy(){
 const sockets=new Set(),hits=[];
 const server=http.createServer((_q,r)=>{r.writeHead(405);r.end();});
 const track=s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('error',()=>{});s.setTimeout(65000,()=>s.destroy());};
 server.on('connection',track);
 server.on('connect',(req,client,head)=>{
  if(!new Set(['www.cloudflare.com:443','www.google.com:443','example.com:443']).has(req.url)){client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');return;}
  const [host,port]=req.url.split(':');const upstream=net.connect({host,port:Number(port)});track(upstream);
  const hit={at:Date.now(),target:req.url,sentBytes:head.length,receivedBytes:0};
  client.on('data',data=>{hit.sentBytes+=data.length;});upstream.on('data',data=>{hit.receivedBytes+=data.length;});
  upstream.on('connect',()=>{hits.push(hit);client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});
  client.on('close',()=>upstream.destroy());upstream.on('close',()=>client.destroy());upstream.on('error',()=>client.destroy());
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 return {port:server.address().port,hits,stop:async()=>{const done=new Promise(r=>server.close(r));for(const s of sockets)s.destroy();await done;}};
}
async function waitFor(fn,description,timeout=60000){const until=Date.now()+timeout;while(Date.now()<until){const result=await fn();if(result)return result;await delay(200);}throw Error('Timed out: '+description);}
const originalBefore=await productHashes(baseline);
const sourceBefore=await productHashes(root);
try{
 await fs.mkdir(path.join(root,'.runtime'),{recursive:true});
 run=await fs.mkdtemp(path.join(root,'.runtime/install-acceptance-20261030-'));
 const old=path.join(run,'previous-bundle'),next=path.join(run,'candidate-bundle'),app=path.join(run,'installed-app'),profile=path.join(run,'chrome-profile'),historyDir=path.join(run,'endpoint-history');
 await copyBundle(baseline,old);await copyBundle(root,next);
 const oldManifest=JSON.parse(await fs.readFile(path.join(old,'extension/manifest.json'))),newManifest=JSON.parse(await fs.readFile(path.join(next,'extension/manifest.json')));
 assert.equal(oldManifest.version,'0.2.0');
 const candidateVersion=newManifest.version;
 assert.match(candidateVersion,/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,'Candidate must have a numeric three-part release version');
 assert.equal(candidateVersion.trim(),candidateVersion,'Candidate version must not contain surrounding whitespace');
 assert.ok(candidateVersion.split('.').every(part=>Number(part)<=65535),'Candidate version components must fit Chrome limits');
 assert.ok(candidateVersion.split('.').some(part=>Number(part)>0),'Candidate version must not be all zero');
 assert.notEqual(candidateVersion,oldManifest.version,'Update candidate must differ from the previous bundle');
 assert.equal(oldManifest.key,newManifest.key);
 const id=sha(Buffer.from(oldManifest.key,'base64')).slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
 report.extensionId=id;report.installPath=app;report.profile=profile;
 const direct=await exec('/usr/bin/curl',['--fail','--silent','--show-error','--max-time','30','https://www.cloudflare.com/cdn-cgi/trace'],{timeout:35000});
 const cc=direct.stdout.split('\n').find(x=>x.startsWith('loc='))?.slice(4);assert.match(cc,/^[A-Z]{2}$/);report.country=cc;
 const countries=[...new Set([cc,'NO','EE','AT','SE'])];
 proxy=await listenProxy();
 const fixtureScript=path.join(run,'fixture-entry.py');
 await fs.writeFile(fixtureScript,`import asyncio,json,sys\nfrom pathlib import Path\nroot=Path(sys.argv[1]).resolve()\nsys.path.insert(0,str(root/'native'))\nimport host\nfrom core import Candidate,Session\nconfig=json.loads(Path(sys.argv[2]).read_text())\nasync def discover(country):\n if country!=config['country']:raise ValueError('Fixture country mismatch')\n return [Candidate('http','127.0.0.1',config['port'])],[]\nclass FixtureSession(Session):\n def __init__(self,country,emit):super().__init__(country,emit,discoverer=discover)\nhost.Session=FixtureSession\nasyncio.run(host.main())\n`);
 let manager,item;
 const launch=()=>chromium.launchPersistentContext(profile,{headless:true,channel:'chromium',ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${app}/extension`,`--load-extension=${app}/extension`,'--disable-quic']});
 const checkpoint=async(stage,step)=>{stage.step=step;console.log(stage.label,step);await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2)+'\n');};
 const openPopup=async()=>{popup=await browser.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);};
 const command=(action,extra={})=>popup.evaluate(m=>chrome.runtime.sendMessage(m),{action,...extra});
 for(const [label,snapshot,version] of [['install',old,'0.2.0'],['update',next,candidateVersion],['rollback',old,'0.2.0']]){
  const stage={label,version};report.stages.push(stage);console.log(label,version);
  if(browser){
   await checkpoint(stage,'disconnect before disable');
   await command('disconnect');
   manager=await browser.newPage();await manager.goto('chrome://extensions/');
   item=manager.locator('extensions-item').filter({hasText:'Country Proxy'});await item.waitFor();
   const toggle=item.locator('#enableToggle');assert.equal(await toggle.getAttribute('checked')!==null,true);
   await toggle.click();await waitFor(async()=>!(await toggle.getAttribute('checked')) && (await toggle.getAttribute('checked'))===null,'disabled extension',10000);
   stage.disabledBeforeReplacement=true;await checkpoint(stage,'disabled in UI');
   await popup.close();popup=null;
  }
  if(label==='rollback'){
   await exec(python,[path.join(app,'scripts/install.py'),'--profile',profile,'--prepare-legacy-rollback'],{timeout:30000});
   stage.legacyRegistrationPrepared=true;
  }
  await copyBundle(snapshot,app,true);
  const installerArgs=[path.join(app,'scripts/install.py'),'--profile',profile];
  if(label==='update')installerArgs.push('--data-dir',historyDir);
  const output=await exec(python,installerArgs,{timeout:240000,maxBuffer:2*1024*1024});
  await fs.writeFile(path.join(run,`${label}-installer.log`),output.stdout+output.stderr);
  stage.installerDependenciesEnabled=true;await checkpoint(stage,'installer done');
  registrationFile=path.join(profile,'NativeMessagingHosts/local.country_proxy.json');
  installedRegistration=await fs.readFile(registrationFile);
  const registration=JSON.parse(installedRegistration);assert.equal(registration.path,path.join(app,'.runtime',label==='update'?'host-'+sha(Buffer.from(profile)):'host'));assert.deepEqual(registration.allowed_origins,[`chrome-extension://${id}/`]);
  stage.registrationCorrect=true;
  stage.helperPath=registration.path;
  if(!browser){
   browser=await launch();
   report.browser=browser.browser().version();
   const setup=await browser.newPage();await setup.goto('chrome://extensions/');
   const devMode=setup.locator('extensions-toolbar cr-toggle');await devMode.waitFor();
   if(!(await devMode.evaluate(el=>el.checked)))await devMode.click();
   assert.equal(await devMode.evaluate(el=>el.checked),true);stage.developerModeEnabled=true;
   await setup.close();await checkpoint(stage,'developer mode enabled');
  }else{
   await checkpoint(stage,'enabling in UI');
   await item.locator('#enableToggle').click();
   await waitFor(async()=>await item.locator('#enableToggle').evaluate(el=>el.checked),'extension enabled',20000);
   await checkpoint(stage,'enabled in UI');
   await item.locator('#dev-reload-button').click();stage.explicitReload=true;await checkpoint(stage,'Reload clicked');
   stage.chromeInfo=await bounded(manager.evaluate(id=>new Promise(resolve=>chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true},infos=>{const i=infos.find(i=>i.id===id);resolve({id:i.id,version:i.version,state:i.state,disableReasons:i.disableReasons,manifestErrors:i.manifestErrors,runtimeErrors:i.runtimeErrors});})),id),10000,'Chrome extension info timed out');
   assert.notEqual(stage.chromeInfo.disableReasons.unsupportedDeveloperExtension,true,'Developer mode must remain enabled for unpacked extension');
   await checkpoint(stage,'Reload info read');
   await waitFor(async()=>{
    const worker=browser.serviceWorkers().find(w=>w.url()===`chrome-extension://${id}/background.js`);
    return worker && await bounded(worker.evaluate(()=>chrome.runtime.getManifest().version),2500,'worker metadata timeout').catch(()=>null)===version;
   },'reloaded current worker',30000);await checkpoint(stage,'current worker active');
   await manager.close();
  }
  await openPopup();await checkpoint(stage,'popup ready');
  stage.runtime=await bounded(inspectRuntime(browser,app,{names:version==='0.2.0'?['background.js','controller.js']:['background.js','controller.js','probe.js']}),20000,'runtime inspection timeout');assert.equal(stage.runtime.version,version);await checkpoint(stage,'runtime verified');
  if(label==='install'){
   assert.equal((await command('settings',{countries})).ok,true);
   await popup.evaluate(cc=>chrome.storage.local.set({selected:cc,acceptanceMarker:'preserve-across-upgrade-rollback'}),cc);
  }
  const stored=await popup.evaluate(()=>chrome.storage.local.get(['countries','selected','enabled','acceptanceMarker']));
  assert.deepEqual(stored.countries,countries);assert.equal(stored.selected,cc);assert.equal(stored.enabled,false);assert.equal(stored.acceptanceMarker,'preserve-across-upgrade-rollback');
  stage.settingsPreserved=true;stage.settings=stored;
  stage.nativeHello=await popup.evaluate(()=>new Promise((resolve,reject)=>{
   const p=chrome.runtime.connectNative('local.country_proxy');const timer=setTimeout(()=>{p.disconnect();reject(Error('Native hello timeout'));},15000);
   p.onMessage.addListener(m=>{if(m.type==='hello'){clearTimeout(timer);p.disconnect();resolve(m);}});
   p.onDisconnect.addListener(()=>{const e=chrome.runtime.lastError;if(e){clearTimeout(timer);reject(Error(e.message));}});
  }));assert.equal(stage.nativeHello.version,version);
  const config=path.join(app,'.runtime/install-fixture.json'),launcher=path.join(app,'.runtime/install-fixture-host');
  await fs.writeFile(config,JSON.stringify({country:cc,port:proxy.port}));
  await fs.writeFile(launcher,'#!/bin/sh\nexec '+quote(path.join(app,'.venv/bin/python'))+' -I -B '+quote(fixtureScript)+' '+quote(app)+' '+quote(config)+'\n',{mode:0o700});
  await fs.writeFile(registrationFile,JSON.stringify({...registration,path:launcher}));
  stage.connectUsesRealCoreWithControlledDiscovery=true;
  assert.equal((await command('connect',{country:cc})).ok,true);
  stage.connected=await waitFor(async()=>{
   const s=await popup.evaluate(()=>chrome.storage.local.get(['status','selected','enabled']));assert.equal(s.selected,cc);assert.equal(s.enabled,true);
   if(s.status?.phase==='error' || s.status?.phase==='helper')throw Error(JSON.stringify(s.status));
   return s.status?.phase==='connected'?s.status:false;
  },'verified connection',90000);
  assert.equal(stage.connected.country,cc);assert.equal(stage.connected.proxy.port,proxy.port);
  const assertRoute=async()=>{
   const value=await popup.evaluate(()=>chrome.proxy.settings.get({incognito:false}));
   assert.equal(value.levelOfControl,'controlled_by_this_extension');assert.equal(value.value.mode,'fixed_servers');
   for(const key of ['proxyForHttp','proxyForHttps'])assert.deepEqual(value.value.rules[key],{host:'127.0.0.1',port:proxy.port,scheme:'http'},key);
   assert.equal(value.value.rules.fallbackProxy.host,'127.0.0.1');assert.equal(value.value.rules.fallbackProxy.port,proxy.port);
   assert.deepEqual(value.value.rules.bypassList,['<-loopback>']);return value;
  };
  stage.connectedRoute=await assertRoute();stage.pageRouteBefore=await assertRoute();
  const traceCounters=()=>proxy.hits.filter(h=>h.target==='www.cloudflare.com:443').reduce((total,h)=>({connections:total.connections+1,sentBytes:total.sentBytes+h.sentBytes,receivedBytes:total.receivedBytes+h.receivedBytes}),{connections:0,sentBytes:0,receivedBytes:0});
  const traceHitsBefore=traceCounters();
  const trace=await browser.newPage();await trace.goto('https://www.cloudflare.com/cdn-cgi/trace?install-acceptance='+Date.now(),{timeout:30000,waitUntil:'domcontentloaded'});
  const body=await trace.locator('body').innerText();assert.ok(body.split('\n').includes('loc='+cc));await trace.close();stage.ordinaryHTTPSPageConfirmed=true;
  stage.pageRouteAfter=await assertRoute();
  stage.traceListenerHits={before:traceHitsBefore,after:traceCounters()};
  assert.ok(stage.traceListenerHits.after.sentBytes>stage.traceListenerHits.before.sentBytes && stage.traceListenerHits.after.receivedBytes>stage.traceListenerHits.before.receivedBytes,'ordinary trace page must exchange traffic through a fixture tunnel, including a reused connection');
  await command('disconnect');
  const settings=await popup.evaluate(()=>chrome.proxy.settings.get({incognito:false}));assert.notEqual(settings.levelOfControl,'controlled_by_this_extension');
  stage.disconnectRestored=true;
  await fs.writeFile(registrationFile,installedRegistration);installedRegistration=null;
  stage.productMatchesSnapshot=JSON.stringify(await productHashes(app))===JSON.stringify(await productHashes(snapshot));assert.equal(stage.productMatchesSnapshot,true);
  stage.result='PASS';
  await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2)+'\n');
 }
 report.result='PASS';
}catch(error){report.error=error.stack || error.message;if(run)await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2)+'\n');console.error(report.error);}
finally{
 if(popup)await bounded(popup.evaluate(()=>chrome.runtime.sendMessage({action:'disconnect'})),5000,'cleanup disconnect timed out').catch(error=>{report.cleanupError=error.message;report.result='FAIL';});
 if(browser)await bounded(browser.close(),10000,'browser close timed out').catch(error=>{report.cleanupError=error.message;report.result='FAIL';});
 if(registrationFile && installedRegistration)await fs.writeFile(registrationFile,installedRegistration);
 if(proxy)await proxy.stop();
 report.originalProductUnchanged=JSON.stringify(await productHashes(baseline))===JSON.stringify(originalBefore);
 report.candidateProductUnchanged=JSON.stringify(await productHashes(root))===JSON.stringify(sourceBefore);
 if(!report.originalProductUnchanged || !report.candidateProductUnchanged){report.result='FAIL';report.error='Source product changed during acceptance';}
 if(run)await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify(report,null,2));
if(report.result!=='PASS')process.exitCode=1;
