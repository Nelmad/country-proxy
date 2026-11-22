// Explicit macOS/Linux browser acceptance: disposable same-path install/update/rollback.
// TEST_BASELINE_ROOT is read-only; every write stays in a new .runtime run directory.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
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
const executablePath=await fs.realpath(process.env.TEST_CHROME_EXECUTABLE || process.env.CHROME_TEST_EXECUTABLE || '');
assert.equal(path.basename(executablePath),'Google Chrome for Testing','Explicit Chrome for Testing executable required');
assert.ok(executablePath.includes('/Google Chrome for Testing.app/Contents/MacOS/'),'Never use main Chrome');
// The install lifecycle is independent of external probe availability. Opt in
// separately to the unchanged TLS/country checks through a controlled CONNECT.
const optionalHTTPS=process.env.TEST_LIFECYCLE_HTTPS==='1';
// Trust the checkout contract, never code from the previous bundle being copied.
const contract=JSON.parse((await exec(python,['-I','-B','-c',"import json,sys;sys.path.insert(0,sys.argv[1]);from package import ROOT_FILES,SOURCE_DIRS;print(json.dumps({'files':ROOT_FILES,'roots':SOURCE_DIRS}))",path.join(root,'scripts')],{timeout:15000,maxBuffer:65536})).stdout);
const {roots,files}=contract;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function bounded(task,ms,message){let timer;try{return await Promise.race([task,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),ms);})]);}finally{clearTimeout(timer);}}
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
const quote=s=>"'"+s.replaceAll("'","'\"'\"'")+"'";
const report={at:new Date().toISOString(),kind:'isolated-install-update-rollback',result:'FAIL',stages:[],publicProxyPair:false,
 optionalHTTPS,externalAvailabilityRequired:false,browserExecutable:{path:executablePath,sha256:sha(await fs.readFile(executablePath))}};
let browser,proxy,run,popup,registrationFile,installedRegistration;
const mainRegistration=path.join(os.homedir(),'Library/Application Support/Google/Chrome/NativeMessagingHosts/local.country_proxy.json');
async function registrationSnapshot(){try{const [body,s]=await Promise.all([fs.readFile(mainRegistration),fs.stat(mainRegistration)]);return {sha256:sha(body),ino:s.ino,mtimeMs:s.mtimeMs,size:s.size,mode:s.mode};}catch(e){if(e.code==='ENOENT')return null;throw e;}}
const beforeRegistration=await registrationSnapshot();
async function venvIdentity(app){const cfg=path.join(app,'.venv/pyvenv.cfg'),python=path.join(app,'.venv/bin/python');if(!await exists(cfg))return null;const [d,p]=await Promise.all([fs.stat(path.join(app,'.venv')),fs.lstat(python)]);return {directoryInode:d.ino,pythonInode:p.ino,pythonRealpath:await fs.realpath(python),configurationSHA256:sha(await fs.readFile(cfg))};}
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
 for(const sub of ['extension','native','scripts','tests','config','.github'])if(await exists(path.join(dir,sub)))await walk(path.join(dir,sub));
 for(const sub of ['Install.command','package.json','project-checks.json','repo-manifest.json','requirements.txt','build-requirements.txt'])if(await exists(path.join(dir,sub)))out[sub]=sha(await fs.readFile(path.join(dir,sub)));
 return out;
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
async function ownedProcesses(){
 const processes=await exec('/bin/ps',['-axo','uid=,pid=,command='],{timeout:5000,maxBuffer:8*1024*1024});
 return processes.stdout.split('\n').flatMap(line=>{const m=line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);return m && Number(m[1])===process.getuid() && Number(m[2])!==process.pid && (m[3].includes(path.join(run,'installed-app')) || m[3].includes(path.join(run,'chrome-profile')))?[Number(m[2])]:[];});
}
const originalBefore=await productHashes(baseline);
const sourceBefore=await productHashes(root);
report.baselineFunctionalFiles=originalBefore;report.candidateFunctionalFiles=sourceBefore;
try{
 await fs.mkdir(path.join(root,'.runtime'),{recursive:true});
 run=await fs.mkdtemp(path.join(root,'.runtime/install-acceptance-'));
 await fs.chmod(run,0o700);
 const old=path.join(run,'previous-bundle'),next=path.join(run,'candidate-bundle'),app=path.join(run,'installed-app'),profile=path.join(run,'chrome-profile'),historyDir=path.join(run,'endpoint-history');
 await copyBundle(baseline,old);await copyBundle(root,next);
 const oldManifest=JSON.parse(await fs.readFile(path.join(old,'extension/manifest.json'))),newManifest=JSON.parse(await fs.readFile(path.join(next,'extension/manifest.json')));
 const baselineVersion=oldManifest.version,legacyBaseline=baselineVersion==='0.2.0';
 assert.match(baselineVersion,/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,'Baseline must declare its actual version');
 report.baselineVersion=baselineVersion;report.legacyBaseline=legacyBaseline;
 const candidateVersion=newManifest.version;
 assert.match(candidateVersion,/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,'Candidate must have a numeric three-part release version');
 assert.equal(candidateVersion.trim(),candidateVersion,'Candidate version must not contain surrounding whitespace');
 assert.ok(candidateVersion.split('.').every(part=>Number(part)<=65535),'Candidate version components must fit Chrome limits');
 assert.ok(candidateVersion.split('.').some(part=>Number(part)>0),'Candidate version must not be all zero');
 assert.notEqual(candidateVersion,oldManifest.version,'Update candidate must differ from the previous bundle');
 assert.equal(oldManifest.key,newManifest.key);
 const id=sha(Buffer.from(oldManifest.key,'base64')).slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
 report.extensionId=id;report.installPath=app;report.profile=profile;
 let cc=null;
 if(optionalHTTPS){
  let direct;
  try{direct=await exec('/usr/bin/curl',['--fail','--silent','--show-error','--max-time','30','https://www.cloudflare.com/cdn-cgi/trace'],{timeout:35000});}
  catch(error){
   // Only curl's explicit external DNS/connect/HTTP/TLS/timeout failures are
   // availability evidence. Spawn, harness and malformed-response errors fail.
   if(!new Set([5,6,7,22,28,35,52,55,56,60]).has(error.code))throw error;
   report.optionalHTTPSPreflight={result:'INCONCLUSIVE',reason:'EXTERNAL_TRACE_UNAVAILABLE',curlExitCode:error.code};
  }
  if(direct){cc=direct.stdout.split('\n').find(x=>x.startsWith('loc='))?.slice(4);assert.match(cc,/^[A-Z]{2}$/);report.optionalHTTPSCountry=cc;proxy=await listenProxy();}
 }
 const countries=['AT','EE','NO'];
 const savedGroups=[{id:'install-acceptance-group',name:'Acceptance AT EE NO',countries}];
 const preservedSelection=legacyBaseline?{selected:'AT'}:{selected:null,selectedCountries:countries,selectionMode:'multiple',savedCountryGroups:savedGroups};
 const fixtureScript=path.join(run,'fixture-entry.py');
 await fs.writeFile(fixtureScript,`import asyncio,json,sys\nfrom pathlib import Path\nroot=Path(sys.argv[1]).resolve()\nsys.path.insert(0,str(root/'native'))\nimport host\nfrom core import Candidate,Session\nconfig=json.loads(Path(sys.argv[2]).read_text())\nasync def discover(country):\n if country!=config['country']:raise ValueError('Fixture country mismatch')\n return [Candidate('http','127.0.0.1',config['port'])],[]\nclass FixtureSession(Session):\n def __init__(self,country,emit):super().__init__(country,emit,discoverer=discover)\nhost.Session=FixtureSession\nasyncio.run(host.main())\n`);
 let manager,item;
 const launch=()=>chromium.launchPersistentContext(profile,{headless:true,executablePath,ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${app}/extension`,`--load-extension=${app}/extension`,'--enable-unsafe-extension-debugging','--disable-quic','--no-first-run','--no-default-browser-check']});
 const checkpoint=async(stage,step)=>{stage.step=step;console.log(stage.label,step);await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2)+'\n');};
 const openPopup=async()=>{popup=await browser.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);};
 const command=(action,extra={})=>popup.evaluate(m=>chrome.runtime.sendMessage(m),{action,...extra});
 for(const [label,snapshot,version] of [['install',old,baselineVersion],['update',next,candidateVersion],['rollback',old,baselineVersion]]){
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
  if(label==='rollback' && legacyBaseline){
   await exec(python,[path.join(app,'scripts/install.py'),'--profile',profile,'--prepare-legacy-rollback'],{timeout:30000});
   stage.legacyRegistrationPrepared=true;
  }
  await copyBundle(snapshot,app,true);
  const venvBefore=await venvIdentity(app);
  const installerArgs=[path.join(app,'scripts/install.py'),'--profile',profile];
  const modernInstaller=version!=='0.2.0';
  if(modernInstaller)installerArgs.push('--data-dir',historyDir);
  const output=await exec(python,installerArgs,{timeout:240000,maxBuffer:2*1024*1024});
  await fs.writeFile(path.join(run,`${label}-installer.log`),output.stdout+output.stderr);
  stage.installerSHA256=sha(await fs.readFile(path.join(app,'scripts/install.py')));
  stage.requirementsSHA256=sha(await fs.readFile(path.join(app,'requirements.txt')));
  stage.installerDependenciesEnabled=true;await checkpoint(stage,'installer done');
  stage.venvBefore=venvBefore;stage.venvAfter=await venvIdentity(app);
  if(label==='install')assert.equal(venvBefore,null,'First install must create a fresh venv');
  else assert.deepEqual(stage.venvAfter,venvBefore,'Same-path update/rollback must reuse the existing venv');
  stage.venvReused=label!=='install';
  const distributions=await exec(path.join(app,'.venv/bin/python'),['-I','-B','-c',"import importlib.metadata as m,json,sys;import proxyscraper,certifi;print(json.dumps({'python':list(sys.version_info[:3]),'distributions':{d.metadata['Name']:d.version for d in m.distributions()}}))"],{timeout:15000,maxBuffer:65536});
  stage.installedEnvironment=JSON.parse(distributions.stdout);
  if(label==='update'){
   const dependencyReceipt=path.join(app,'.runtime/dependency-install.json');
   assert.ok(await exists(dependencyReceipt),'Current installer must produce the dependency receipt');
   stage.dependencyInstallReceipt=JSON.parse(await fs.readFile(dependencyReceipt));
   assert.equal(stage.dependencyInstallReceipt.schemaVersion,1);
   assert.equal(stage.dependencyInstallReceipt.requirementsSHA256,sha(await fs.readFile(path.join(app,'requirements.txt'))));
   assert.equal(stage.dependencyInstallReceipt.buildRequirementsSHA256,sha(await fs.readFile(path.join(app,'build-requirements.txt'))));
   const normalize=name=>name.toLowerCase().replace(/[-_.]+/g,'-');
   const actual=Object.fromEntries(Object.entries(stage.installedEnvironment.distributions).filter(([name])=>normalize(name)!=='pip').map(([name,version])=>[normalize(name),version]));
   assert.deepEqual(actual,stage.dependencyInstallReceipt.distributions,'Update must install the exact receipted runtime dependency graph');
   stage.dependencyInstallReceiptVerified=true;
  }
  registrationFile=path.join(profile,'NativeMessagingHosts/local.country_proxy.json');
  installedRegistration=await fs.readFile(registrationFile);
  const registration=JSON.parse(installedRegistration);assert.equal(registration.path,path.join(app,'.runtime',modernInstaller?'host-'+sha(Buffer.from(profile)):'host'));assert.deepEqual(registration.allowed_origins,[`chrome-extension://${id}/`]);
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
  const runtimeNames=version==='0.2.0'?['background.js','controller.js']:['background.js','controller.js','probe.js','traffic-gate.js'];
  for(const name of ['privacy-guard.js','special-destinations.js'])if(await exists(path.join(app,'extension',name)))runtimeNames.push(name);
  stage.runtime=await bounded(inspectRuntime(browser,app,{names:runtimeNames}),20000,'runtime inspection timeout');assert.equal(stage.runtime.version,version);await checkpoint(stage,'runtime verified');
  if(label==='install'){
   assert.equal((await command('settings',legacyBaseline?{countries}:{add:countries,remove:[]})).ok,true);
   await popup.evaluate(selection=>chrome.storage.local.set({...selection,acceptanceMarker:'preserve-across-upgrade-rollback'}),preservedSelection);
  }
  const stored=await popup.evaluate(()=>chrome.storage.local.get(['countries','selected','selectedCountries','selectionMode','savedCountryGroups','enabled','acceptanceMarker']));
  assert.deepEqual(stored.countries,countries);assert.equal(stored.selected,preservedSelection.selected);assert.equal(stored.enabled,false);assert.equal(stored.acceptanceMarker,'preserve-across-upgrade-rollback');
  if(!legacyBaseline){assert.deepEqual(stored.selectedCountries,countries);assert.equal(stored.selectionMode,'multiple');assert.deepEqual(stored.savedCountryGroups,savedGroups);}
  stage.settingsPreserved=true;stage.settings=stored;
  if(!legacyBaseline){
   await waitFor(async()=>await popup.locator('#country-name').innerText()==='Изменить группу (3)','preserved selection visible',10000);
   assert.deepEqual(await popup.locator('#favorites [data-quick-country]').evaluateAll(nodes=>nodes.map(node=>node.dataset.quickCountry)),countries);
   const group=popup.locator('[data-connect-group="install-acceptance-group"]');await group.waitFor({state:'attached'});
   if(!await popup.locator('#saved-groups details').evaluate(node=>node.open))await popup.locator('#saved-groups summary').click();
   assert.equal(await group.isVisible(),true);
   assert.equal(await group.getAttribute('aria-label'),'Подключить группу «Acceptance AT EE NO»');
   stage.preservedSettingsVisibleInPopup=true;
  }
  stage.extensionIdentityPreserved=stage.runtime.version===version && report.extensionId===id;
  stage.nativeHello=await popup.evaluate(()=>new Promise((resolve,reject)=>{
   const p=chrome.runtime.connectNative('local.country_proxy');const timer=setTimeout(()=>{p.disconnect();reject(Error('Native hello timeout'));},15000);
   p.onMessage.addListener(m=>{if(m.type==='hello'){clearTimeout(timer);p.disconnect();resolve(m);}});
   p.onDisconnect.addListener(()=>{const e=chrome.runtime.lastError;if(e){clearTimeout(timer);reject(Error(e.message));}});
  }));assert.equal(stage.nativeHello.version,version);assert.equal(stage.nativeHello.feedbackProtocol,1);
  if(modernInstaller)assert.equal(stage.nativeHello.history?.mode,'persistent','Exact profile launcher must enable persistent history');
  if(cc && proxy){
  stage.result='FAIL'; // Remains failed unless phase, cleanup and source checks finish.
  stage.optionalHTTPS={result:'RUNNING',publicProxyPair:false};
  try{
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
   const controllerSource=await fs.readFile(path.join(app,'extension/controller.js'),'utf8');
   // The current special-destination contract intentionally retains implicit
   // bypass on an active candidate; older snapshots explicitly cancel it.
   // Chrome may omit an empty list when returning effective proxy settings.
   const bypassList=value.value.rules.bypassList===undefined?[]:value.value.rules.bypassList;
   assert.deepEqual(bypassList,controllerSource.includes('bypassList: []')?[]:['<-loopback>']);return value;
  };
  stage.connectedRoute=await assertRoute();stage.pageRouteBefore=await assertRoute();
  const traceCounters=()=>proxy.hits.filter(h=>h.target==='www.cloudflare.com:443').reduce((total,h)=>({connections:total.connections+1,sentBytes:total.sentBytes+h.sentBytes,receivedBytes:total.receivedBytes+h.receivedBytes}),{connections:0,sentBytes:0,receivedBytes:0});
  const traceHitsBefore=traceCounters();
  const trace=await browser.newPage();await trace.goto('https://www.cloudflare.com/cdn-cgi/trace?install-acceptance='+Date.now(),{timeout:30000,waitUntil:'domcontentloaded'});
  const body=await trace.locator('body').innerText();assert.ok(body.split('\n').includes('loc='+cc));await trace.close();stage.ordinaryHTTPSPageConfirmed=true;
  stage.pageRouteAfter=await assertRoute();
  stage.traceListenerHits={before:traceHitsBefore,after:traceCounters()};
  assert.ok(stage.traceListenerHits.after.sentBytes>stage.traceListenerHits.before.sentBytes && stage.traceListenerHits.after.receivedBytes>stage.traceListenerHits.before.receivedBytes,'ordinary trace page must exchange traffic through a fixture tunnel, including a reused connection');
  assert.equal((await command('disconnect')).ok,true,'HTTPS Stop command rejected');
  const settings=await popup.evaluate(()=>chrome.proxy.settings.get({incognito:false}));assert.notEqual(settings.levelOfControl,'controlled_by_this_extension');
  stage.disconnectRestored=true;stage.optionalHTTPS.result='PASS';
  }catch(error){stage.optionalHTTPS={result:'FAIL',reason:error.message,externalAvailabilityRequired:false};throw error;}
  finally{
   try{assert.equal((await command('disconnect')).ok,true,'HTTPS cleanup Stop command rejected');}
   finally{
    try{await popup.evaluate(selection=>chrome.storage.local.set(selection),preservedSelection);}
    finally{await fs.writeFile(registrationFile,installedRegistration);}
   }
  }
  }else stage.optionalHTTPS={result:'NOT_RUN',reason:optionalHTTPS?'EXTERNAL_TRACE_UNAVAILABLE':'EXPLICIT_OPT_IN_NOT_SET'};
  installedRegistration=null;
  stage.productSHA256=sha(JSON.stringify(await productHashes(app)));
  stage.snapshotSHA256=sha(JSON.stringify(await productHashes(snapshot)));
  stage.productMatchesSnapshot=stage.productSHA256===stage.snapshotSHA256;assert.equal(stage.productMatchesSnapshot,true);
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
 report.mainRegistrationBefore=beforeRegistration;report.mainRegistrationAfter=await registrationSnapshot();
 report.mainRegistrationUnchanged=JSON.stringify(report.mainRegistrationBefore)===JSON.stringify(report.mainRegistrationAfter);
 if(!report.mainRegistrationUnchanged){report.result='FAIL';report.error='Main Chrome registration metadata changed';}
 if(run){
  // Match only this unique run's app/profile, then verify no owned process
  // remains before deleting its test profile and installed dependencies.
  let remaining=await ownedProcesses();
  const end=Date.now()+5000;
  while(remaining.length && Date.now()<end){await delay(200);remaining=await ownedProcesses();}
  report.cleanup={remainingOwnedProcesses:remaining,temporaryDirectoriesRemoved:false};
  if(remaining.length){report.result='FAIL';report.cleanupError='Owned processes remain; temporary artifacts retained for safe cleanup';}
  else{
   for(const name of ['previous-bundle','candidate-bundle','installed-app','chrome-profile','endpoint-history'])await fs.rm(path.join(run,name),{recursive:true,force:true});
   await fs.rm(path.join(run,'fixture-entry.py'),{force:true});
   report.cleanup.temporaryDirectoriesRemoved=true;
  }
 }
 if(run)await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify(report,null,2));
if(report.result!=='PASS')process.exitCode=1;
