// Explicit clean ZIP acceptance. This installs dependencies and uses only disposable test Chrome.
// Required: TEST_INSTALL_ZIP, externally approved TEST_INSTALL_ZIP_SHA256,
// absolute TEST_PYTHON; optional external PLAYWRIGHT_MODULE.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {inspectRuntime} from './chrome-runtime.mjs';

const root=path.resolve(import.meta.dirname,'..');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const exec=promisify(execFile);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const countries=['AT','EE','NO'];
const started=performance.now(), deadline=started+420000;
const report={kind:'fresh-zip-real-install',result:'FAIL',availability:'NOT_RUN',startedAt:new Date().toISOString(),
  mainChromeTouched:false,homeOverridden:false,fixtureRegistration:false,dependenciesEnabled:true,
  countries,steps:[],cleanup:{},limits:{installerMs:240000,publicWindowMs:120000,globalMs:420000}};
let receipt,scratch,app,profile,history,browser,popup,registrationPath,registrationBytes,manifest,id,installer,aborted=false,step='preflight',matchesEffectiveRoute,proxyConfig,BLOCKED,chromeExecutable;
const tracked=new Map();
const check=()=>{assert.ok(!aborted && performance.now()<deadline,'GLOBAL_DEADLINE');};
const timeout=ms=>Math.max(1,Math.min(ms,deadline-performance.now()));
async function bounded(promise,ms,code){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(code)),ms);})]);}finally{clearTimeout(timer);}}
async function mark(name){check();step=name;report.steps.push({name,elapsedMs:Math.round(performance.now()-started)});console.log(name);await save();}
async function save(){if(receipt)await fs.writeFile(path.join(receipt,'report.json'),JSON.stringify(report,null,2)+'\n');}
async function absent(p){try{await fs.lstat(p);return false;}catch(e){if(e.code==='ENOENT')return true;throw e;}}
function inside(base,p){const relative=path.relative(base,p);return relative!=='' && !relative.startsWith('..'+path.sep) && relative!=='..' && !path.isAbsolute(relative);}
async function owned(p){assert.ok(inside(scratch,p),'PATH_OUTSIDE_OWNED_ROOT');assert.equal(await fs.realpath(p),p,'PATH_ALIAS');assert.equal((await fs.lstat(p)).uid,process.getuid(),'PATH_OWNER');}
async function hashes(directory){const rows=[];for(const name of ['native','extension']){const walk=async d=>{for(const entry of (await fs.readdir(d,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const p=path.join(d,entry.name);assert.ok(!entry.isSymbolicLink(),'SOURCE_SYMLINK');if(entry.isDirectory()){if(entry.name!=='__pycache__')await walk(p);}else if(entry.isFile() && !entry.name.endsWith('.pyc'))rows.push([path.relative(directory,p),sha(await fs.readFile(p))]);}};await walk(path.join(directory,name));}return {sha256:sha(JSON.stringify(rows)),files:rows.length};}

// Execute only the trusted checkout helper; the archive contributes data, never code.
const extractor=path.join(root,'scripts/archive_extract.py');

async function processList(){const {stdout}=await exec('/bin/ps',['-axo','uid=,pid=,ppid=,command='],{timeout:5000,maxBuffer:8*1024*1024});return stdout.split('\n').flatMap(line=>{const m=line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);return m?[{uid:Number(m[1]),pid:Number(m[2]),ppid:Number(m[3]),command:m[4]}]:[];});}
async function collectOwned(){if(!scratch || !app || !profile || !inside(scratch,app) || !inside(scratch,profile))return [];const rows=(await processList()).filter(r=>r.uid===process.getuid() && r.pid!==process.pid);let changed=true;const owners=new Set(rows.filter(r=>r.command.includes(app) || r.command.includes(profile)).map(r=>r.pid));for(const r of rows)if(tracked.get(r.pid)===r.command)owners.add(r.pid);while(changed){changed=false;for(const r of rows)if(owners.has(r.ppid) && !owners.has(r.pid)){owners.add(r.pid);changed=true;}}const own=rows.filter(r=>owners.has(r.pid));for(const r of own)tracked.set(r.pid,r.command);return own;}
function killInstaller(){if(installer && installer.exitCode===null){try{process.kill(-installer.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}}}
async function runInstaller(){const out=await fs.open(path.join(receipt,'installer.log'),'wx',0o600);let size=0;try{await new Promise((resolve,reject)=>{
  installer=spawn(path.join(app,'Install.command'),['--profile',profile,'--data-dir',history],{cwd:app,env:process.env,detached:true,stdio:['ignore','pipe','pipe']});
  let finished=false;const done=(error)=>{if(finished)return;finished=true;clearTimeout(timer);error?reject(error):resolve();};
  const timer=setTimeout(()=>{killInstaller();done(Error('INSTALLER_TIMEOUT'));},timeout(240000));
  // Installer output contains paths/dependency download diagnostics, never native probe stderr.
  for(const stream of [installer.stdout,installer.stderr])stream.on('data',b=>{if(size<2*1024*1024){const part=b.subarray(0,2*1024*1024-size);size+=part.length;try{fsSyncWrite(out.fd,part);}catch{killInstaller();done(Error('INSTALLER_LOG_WRITE'));}}});
  installer.on('error',()=>done(Error('INSTALLER_SPAWN')));installer.on('close',code=>done(code===0?null:Error('INSTALLER_EXIT')));
 });}finally{await out.close();}}
// Synchronous writes keep stdout/stderr ordering and avoid dangling log-write promises at cleanup.
import {writeSync as fsSyncWrite} from 'node:fs';
async function originalRegistration(){assert.deepEqual(await fs.readFile(registrationPath),registrationBytes,'REGISTRATION_CHANGED');}
async function state(){return bounded(popup.evaluate(()=>chrome.storage.local.get(['selectionMode','selectedCountries','selected','enabled','status'])),timeout(6000),'STATE_TIMEOUT');}
async function route(){return bounded(popup.evaluate(()=>chrome.proxy.settings.get({incognito:false})),timeout(6000),'ROUTE_TIMEOUT');}
function safeRoute(s,r){assert.equal(s.enabled,true,'SEARCH_NOT_ENABLED');assert.equal(s.selectionMode,'multiple');assert.deepEqual(s.selectedCountries,countries);if(s.status?.country)assert.ok(countries.includes(s.status.country),'STATUS_OUTSIDE_SELECTION');assert.ok(matchesEffectiveRoute(r,BLOCKED) || (s.status?.proxy && matchesEffectiveRoute(r,proxyConfig(s.status.proxy))),'UNSAFE_EFFECTIVE_ROUTE');}
async function waitFor(fn,ms,code){const end=performance.now()+timeout(ms);while(performance.now()<end){check();const found=await bounded(fn(),timeout(6000),code);if(found)return found;await sleep(200);}throw Error(code);}
async function hello(){await originalRegistration();const value=await bounded(popup.evaluate(()=>new Promise((resolve,reject)=>{const p=chrome.runtime.connectNative('local.country_proxy');const timer=setTimeout(()=>{p.disconnect();reject(Error('HELLO_TIMEOUT'));},12000);p.onMessage.addListener(m=>{if(m.type==='hello'){clearTimeout(timer);p.disconnect();resolve({type:m.type,version:m.version,feedbackProtocol:m.feedbackProtocol,historyMode:m.history?.mode});}});p.onDisconnect.addListener(()=>{const failed=!!chrome.runtime.lastError;if(failed){clearTimeout(timer);reject(Error('HELLO_DISCONNECT'));}});})),timeout(15000),'HELLO_TIMEOUT');assert.equal(value.version,manifest.version);assert.equal(value.feedbackProtocol,1);assert.equal(value.historyMode,'persistent','HELLO_HISTORY_NOT_PERSISTENT');return value;}
async function screenshot(name){await popup.screenshot({path:path.join(receipt,name+'.png'),mask:[popup.locator('#proxy'),popup.locator('#detail'),popup.locator('#error'),popup.locator('#reserve-diagnostics'),popup.locator('#source-quality')],timeout:timeout(5000)});}
async function launch(){check();browser=await chromium.launchPersistentContext(profile,{channel:'chromium',executablePath:chromeExecutable,headless:true,ignoreDefaultArgs:['--disable-extensions'],timeout:timeout(25000),args:['--enable-unsafe-extension-debugging','--disable-quic','--no-first-run','--no-default-browser-check']});if(aborted){await browser.close();throw Error('GLOBAL_DEADLINE');}
  browser.setDefaultTimeout(10000);browser.setDefaultNavigationTimeout(15000);report.browser=browser.browser().version();await collectOwned();
  const manager=await browser.newPage();await manager.goto('chrome://extensions/');const toggle=manager.locator('extensions-toolbar cr-toggle');await toggle.waitFor();if(!(await toggle.evaluate(el=>el.checked)))await toggle.click();assert.equal(await toggle.evaluate(el=>el.checked),true);
  const alreadyLoaded=await manager.evaluate(id=>new Promise(resolve=>chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true},rows=>resolve(rows.some(row=>row.id===id && row.state==='ENABLED')))),id);
  if(!alreadyLoaded){const cdp=await browser.browser().newBrowserCDPSession();try{const loaded=await cdp.send('Extensions.loadUnpacked',{path:path.join(app,'extension')});assert.equal(loaded.id,id);}finally{await cdp.detach();}}await manager.close();
  popup=await browser.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);await waitFor(async()=>await popup.locator('#phase').innerText()!=='Загрузка…',10000,'POPUP_NOT_READY');
  return bounded(inspectRuntime(browser,app),timeout(30000),'RUNTIME_INSPECTION_TIMEOUT');
}
async function stopped(){const s=await state();return s.enabled===false && s.status?.phase==='off' && (await route()).levelOfControl!=='controlled_by_this_extension';}
async function stopUI(){await popup.locator('#disconnect').click({timeout:timeout(10000)});await waitFor(stopped,15000,'UI_STOP_FAILED');await sleep(500);assert.equal(await stopped(),true,'STOP_RECONNECTED');await originalRegistration();}
async function ordinary(s,publicEnd){const tab=await browser.newPage();try{
  assert.equal(matchesEffectiveRoute(await route(),proxyConfig(s.status.proxy)),true,'TAB_ROUTE');let response,body,navigationFailed=false;
  try{response=await tab.goto('https://www.cloudflare.com/cdn-cgi/trace?fresh-install='+Date.now(),{timeout:timeout(Math.max(1,Math.min(20000,publicEnd-performance.now()))),waitUntil:'domcontentloaded'});body=await tab.locator('body').innerText({timeout:timeout(Math.max(1,Math.min(3000,publicEnd-performance.now())))});}catch{navigationFailed=true;}
  const after=await state(),r=await route();safeRoute(after,r);assert.ok(!['helper','error','stopError','off'].includes(after.status?.phase),'TAB_HELPER_OR_PRODUCT_ERROR');
  const endpoint=p=>p?[p.scheme,p.host,p.port]:null;
  const same=after.status?.phase==='connected' && after.status?.id===s.status.id && after.status?.attempt===s.status.attempt && JSON.stringify(endpoint(after.status.proxy))===JSON.stringify(endpoint(s.status.proxy)) && after.status?.browser?.exitIp===s.status.browser.exitIp;
  if(!same)return {result:'INCONCLUSIVE',reason:'SAFE_ROUTE_OR_OFFER_CHANGED'};
  assert.equal(after.status.browser?.ok,true,'TAB_BROWSER_NOT_VERIFIED');assert.equal(matchesEffectiveRoute(r,proxyConfig(s.status.proxy)),true,'TAB_ROUTE');
  if(navigationFailed || response?.status()!==200)return {result:'INCONCLUSIVE',reason:navigationFailed?'PUBLIC_TAB_TRANSPORT_OR_TIMEOUT':'PUBLIC_TAB_HTTP'};
  const values=Object.fromEntries(body.split('\n').filter(x=>x.includes('=')).map(x=>{const n=x.indexOf('=');return [x.slice(0,n),x.slice(n+1)];}));assert.ok(net.isIP(values.ip),'TAB_TRACE_IP');assert.ok(countries.includes(values.loc),'TAB_TRACE_COUNTRY');assert.equal(values.ip,s.status.browser.exitIp,'TAB_EXIT_MISMATCH');assert.equal(values.loc,s.status.browser.country,'TAB_COUNTRY_MISMATCH');return {result:'PASS',country:values.loc,exitMatched:true,ordinaryHTTPS:true};
 }finally{await tab.close();}}

let chromium;
async function run(){
  assert.ok(process.platform==='darwin','MACOS_REQUIRED');assert.ok(process.env.TEST_INSTALL_ZIP && process.env.TEST_PYTHON,'ZIP_AND_PYTHON_REQUIRED');assert.ok(path.isAbsolute(process.env.TEST_PYTHON),'ABSOLUTE_PYTHON_REQUIRED');
  const expectedZipSHA256=process.env.TEST_INSTALL_ZIP_SHA256;
  assert.match(expectedZipSHA256 || '',/^[0-9a-f]{64}$/,'EXPECTED_ZIP_SHA256_REQUIRED');
  report.expectedZipSHA256=expectedZipSHA256;
  await fs.mkdir(path.join(root,'.runtime'),{recursive:true});receipt=await fs.mkdtemp(path.join(root,'.runtime/fresh-install-receipt-'));await fs.chmod(receipt,0o700);
  const zip=path.resolve(process.env.TEST_INSTALL_ZIP);assert.equal(await fs.realpath(zip),zip,'ZIP_ALIAS');const zipInfo=await fs.lstat(zip);assert.ok(zipInfo.isFile() && zipInfo.size<=134217728,'ZIP_TYPE_OR_SIZE');const zipBefore=await fs.readFile(zip);report.zipSHA256=sha(zipBefore);
  assert.equal(report.zipSHA256,expectedZipSHA256,'ZIP_APPROVAL_MISMATCH');report.zipApprovalMatched=true;
  scratch=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'cp-fresh-install-'));await fs.chmod(scratch,0o700);app=path.join(scratch,"Installed app ' clean");profile=path.join(scratch,'test Chrome profile');history=path.join(scratch,'private history');await fs.mkdir(profile,{mode:0o700});await fs.mkdir(history,{mode:0o700});await owned(profile);await owned(history);
  await mark('extract checksum-verified ZIP');const extracted=await exec(process.env.TEST_PYTHON,['-I','-B',extractor,zip,app],{timeout:timeout(15000),maxBuffer:65536});report.archive=JSON.parse(extracted.stdout);assert.equal(report.archive.zipSHA256,report.zipSHA256);await owned(app);assert.ok(await absent(path.join(app,'.venv')),'VENV_ALREADY_PRESENT');assert.ok(await absent(path.join(app,'.runtime')),'RUNTIME_ALREADY_PRESENT');
  manifest=JSON.parse(await fs.readFile(path.join(app,'extension/manifest.json')));assert.equal(manifest.version,report.archive.buildVersion);id=sha(Buffer.from(manifest.key,'base64')).slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));report.extension={id,version:manifest.version,minimumChrome:manifest.minimum_chrome_version};report.sourceBefore=await hashes(app);
  ({matchesEffectiveRoute,proxyConfig,BLOCKED}=await import(pathToFileURL(path.join(app,'extension/controller.js')).href));
  await mark('real Install.command with inherited PATH');report.launcherRoute='Install.command --profile --data-dir';await runInstaller();check();
  registrationPath=path.join(profile,'NativeMessagingHosts/local.country_proxy.json');await owned(path.dirname(registrationPath));const registrationInfo=await fs.lstat(registrationPath);assert.ok(registrationInfo.isFile() && !registrationInfo.isSymbolicLink());assert.equal(registrationInfo.uid,process.getuid());assert.equal(registrationInfo.mode&0o777,0o600);registrationBytes=await fs.readFile(registrationPath);const registration=JSON.parse(registrationBytes);
  assert.equal(registration.name,'local.country_proxy');assert.equal(registration.type,'stdio');assert.deepEqual(registration.allowed_origins,[`chrome-extension://${id}/`]);assert.equal(registration.path,path.join(app,'.runtime','host-'+sha(Buffer.from(profile))));await owned(path.join(app,'.runtime'));await owned(path.join(app,'.venv'));
  const metadata=String.raw`import importlib.metadata as m,json,pathlib,re,shlex,sys,hashlib
assert sys.version_info>=(3,11)
app=pathlib.Path(sys.argv[1]);history=sys.argv[2];wrapper=pathlib.Path(sys.argv[3]).read_text()
lines=wrapper.splitlines();assert len(lines)==2 and lines[0]=='#!/bin/sh'
assert shlex.split(lines[1])==['exec',str(app/'.venv/bin/python'),'-I','-B',str(app/'native/host.py'),'--data-dir',history]
receipt=json.loads((app/'.runtime/dependency-install.json').read_text())
assert receipt['schemaVersion']==1
for filename,key in [('requirements.txt','requirementsSHA256'),('build-requirements.txt','buildRequirementsSHA256')]:
 assert hashlib.sha256((app/filename).read_bytes()).hexdigest()==receipt[key]
versions={}
for line in (app/'requirements.txt').read_text().splitlines():
 if not line or line.startswith('#'):continue
 requirement=line.split(' --hash=',1)[0]
 if '==' in requirement:
  name,want=requirement.split('==');actual=m.version(name);assert actual==want;versions[name]=actual
 else:
  name,url=requirement.split(' @ ');want=re.search(r'#sha256=([0-9a-f]{64})$',url).group(1)
  assert receipt['sourceArchiveSHA256']==want
normalize=lambda n:re.sub(r'[-_.]+','-',n).lower()
actual={normalize(d.metadata['Name']):d.version for d in m.distributions()}
assert set(actual)==set(receipt['distributions'])|{'pip'}
assert all(actual[n]==v for n,v in receipt['distributions'].items())
assert receipt['buildIsolation']=='fresh-venv-with-hash-locked-backend'
print(json.dumps({'version':'.'.join(map(str,sys.version_info[:3])),'pinnedDistributions':versions,'sourceArchiveHashCheckedByInstaller':True,'installerReceiptVerified':True,'exactRuntimeGraph':True,'exactLauncherArguments':True}))`;
  const installed=await exec(path.join(app,'.venv/bin/python'),['-I','-B','-c',metadata,app,history,registration.path],{timeout:timeout(15000),maxBuffer:65536});report.installedPython=JSON.parse(installed.stdout);report.registration={exactProfile:true,exactApplication:true,unchanged:true,mode:'0600'};
  ({chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright'));
  chromeExecutable=await fs.realpath(process.env.TEST_CHROME_EXECUTABLE || chromium.executablePath());assert.equal(path.basename(chromeExecutable),'Google Chrome for Testing','TEST_CHROME_ONLY');assert.ok(chromeExecutable.includes('/Google Chrome for Testing.app/Contents/MacOS/'),'TEST_CHROME_ONLY');report.browserExecutable={name:path.basename(chromeExecutable),sha256:sha(await fs.readFile(chromeExecutable)),testChromeOnly:true};
  await mark('test Chrome UI developer mode and CDP unpacked load');report.runtime=await launch();report.uiLoad={developerMode:true,method:'CDP Extensions.loadUnpacked; substitutes OS directory picker'};report.nativeHello=await hello();
  const initial=await state();assert.equal(initial.enabled,false);assert.ok(!initial.selectedCountries?.length && !initial.selected,'INITIAL_SELECTION');assert.equal(initial.status?.phase,'off');assert.notEqual((await route()).levelOfControl,'controlled_by_this_extension');report.initialOff=true;await screenshot('initial-off');
  await mark('popup UI equal AT EE NO selection');await popup.locator('#mode-multiple').click();for(const cc of countries)await popup.locator(`[data-select-country="${cc}"]`).check();await popup.locator('#selection-apply').click();
  await waitFor(async()=>{const s=await state();return s.enabled===true && s.selectionMode==='multiple' && JSON.stringify(s.selectedCountries)===JSON.stringify(countries) && (await route()).levelOfControl==='controlled_by_this_extension';},10000,'SELECTION_NOT_APPLIED');
  let searching=false;const publicEnd=performance.now()+120000;report.availability='INCONCLUSIVE';
  while(performance.now()<publicEnd){check();const s=await state();safeRoute(s,await route());const phase=s.status?.phase;assert.ok(!['helper','error','stopError','off'].includes(phase),'SEARCH_HELPER_OR_PRODUCT_ERROR');if(['searching','checking','slow','empty','verifying','confirming','replacing','connected'].includes(phase))searching=true;
    if(s.status?.country)assert.ok(countries.includes(s.status.country),'STATUS_OUTSIDE_SELECTION');
    if(phase==='connected'){assert.equal(s.status.browser?.ok,true,'CONNECTED_NOT_BROWSER_VERIFIED');assert.ok(countries.includes(s.status.browser.country),'CONNECTED_OUTSIDE_SELECTION');report.connection=await ordinary(s,publicEnd);report.availability=report.connection.result;await screenshot('connected');break;}await sleep(500);
  }
  assert.equal(searching,true,'SEARCH_NOT_OBSERVED');report.search={observed:true,elapsedMs:Math.round(120000-Math.max(0,publicEnd-performance.now())),singleWindow:true};await originalRegistration();await mark('real UI Stop releases route');await collectOwned();await stopUI();report.stop={ui:true,off:true,routeReleased:true};await screenshot('stopped');await browser.close();browser=null;popup=null;
  await mark('restart same test profile off with persisted selection');report.restartRuntime=await launch();const restored=await state();assert.deepEqual(restored.selectedCountries,countries);assert.equal(restored.selectionMode,'multiple');assert.equal(await stopped(),true);report.restartHello=await hello();report.restart={off:true,selectionPersisted:true,realNativeHello:true};await originalRegistration();assert.equal(sha(await fs.readFile(zip)),report.zipSHA256,'ZIP_CHANGED');report.sourceAfter=await hashes(app);assert.deepEqual(report.sourceAfter,report.sourceBefore,'INSTALLED_SOURCE_CHANGED');report.result='PASS';
}

const watchdog=setTimeout(()=>{aborted=true;killInstaller();void browser?.close().catch(()=>{});},420000);
try{await run();}catch(error){report.result='FAIL';report.failure={step,name:error?.name || 'Error',code:/^[A-Z_]+$/.test(error?.message || '')?error.message:'ASSERTION_OR_OPERATION_FAILED'};}
finally{
  clearTimeout(watchdog);aborted=true;
  const cleanupErrors=[];let before=[],scanSucceeded=false;
  try{before=await collectOwned();scanSucceeded=true;}catch{cleanupErrors.push('OWNED_PROCESS_SCAN');}
  if(popup && !popup.isClosed())try{await bounded(popup.evaluate(()=>chrome.runtime.sendMessage({action:'disconnect'})),5000,'CLEANUP_DISCONNECT');}catch{cleanupErrors.push('DISCONNECT');}
  if(browser)try{await bounded(browser.close(),10000,'BROWSER_CLOSE');}catch{cleanupErrors.push('BROWSER_CLOSE');}
  try{killInstaller();}catch{cleanupErrors.push('INSTALLER_REAP');}
  let survivors=[];
  try{for(const signal of ['SIGTERM','SIGKILL']){survivors=await collectOwned();for(const r of survivors){if(r.command===tracked.get(r.pid))try{process.kill(r.pid,signal);}catch(e){if(e.code!=='ESRCH')throw e;}}if(survivors.length)await sleep(signal==='SIGTERM'?1000:300);}survivors=await collectOwned();scanSucceeded=true;if(survivors.length)cleanupErrors.push('OWNED_PROCESS_SURVIVORS');}catch{scanSucceeded=false;cleanupErrors.push('OWNED_PROCESS_REAP');}
  if(registrationPath && registrationBytes)try{assert.deepEqual(await fs.readFile(registrationPath),registrationBytes);}catch{cleanupErrors.push('REGISTRATION_CHANGED');}
  if(scratch && scanSucceeded && !survivors.length)try{await fs.rm(scratch,{recursive:true,force:false});report.cleanup.disposableRootRemoved=await absent(scratch);}catch{cleanupErrors.push('DISPOSABLE_ROOT_REMOVE');}
  report.cleanup={...report.cleanup,observedOwnedProcesses:before.length,remainingOwnedProcesses:survivors.length,errors:cleanupErrors,scope:'only app/profile paths and their same-UID descendants; no global Chrome operations',socketClaim:'no independent socket inventory'};
  if(cleanupErrors.length)report.result='FAIL';report.elapsedMs=Math.round(performance.now()-started);await save();
}
console.log(JSON.stringify({result:report.result,availability:report.availability,receipt:receipt?path.join(receipt,'report.json'):null}));
if(report.result!=='PASS')process.exitCode=1;
