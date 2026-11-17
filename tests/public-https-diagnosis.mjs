// One production extension, one selected group and an isolated, disposable Chrome profile.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {inspectRuntime} from './chrome-runtime.mjs';
import {attachProbeObserver, joinProbeRequests} from './https-probe-observer.mjs';

const root = path.resolve(import.meta.dirname, '..');
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const python = process.env.TEST_PYTHON || path.join(root, '.venv/bin/python');
const countries = [...new Set((process.env.TEST_COUNTRIES || 'AT,EE,NO').split(',').map(s => s.trim().toUpperCase()))].sort();
const catalog = JSON.parse(await fs.readFile(path.join(root, 'extension/countries.json')));
assert.ok(countries.length >= 2 && countries.every(c => catalog.includes(c)));
const netlog = process.argv.includes('--netlog');
const sampleConfirmed = netlog || process.argv.includes('--sample-confirmed');
const rawLogName = 'chrome-netlog.json';
const shortNetlog = netlog && process.argv.includes('--short');
const windowMs = shortNetlog ? 360_000 : netlog ? 480_000 : sampleConfirmed ? 360_000 : 480_000;
const checkLimit = windowMs / 1000;
const desiredDistinct = sampleConfirmed ? 1 : 2;
const manualLimit = netlog && !shortNetlog ? 8 : sampleConfirmed ? 4 : 0;
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'country-proxy-https-'));
const profile = path.join(scratch, 'profile'), out = path.join(root, '.runtime');
await fs.mkdir(out, {recursive:true});
const reportDir = await fs.mkdtemp(path.join(out, 'public-https-'));
const receipt = path.join(reportDir, 'observations.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = s => "'" + s.replaceAll("'", "'\"'\"'") + "'";
const controls = {trace:'https://www.cloudflare.com/cdn-cgi/trace', target:'https://www.google.com/generate_204'};
const report = {result:'FAIL', controls, countries, limits:{windowMs,checkLimit,desiredDistinct,manualLimit},manualChanges:[]};
let chrome, popup, observer, started, watchdog;
async function bounded(job, ms) {
  let timer;
  try { return await Promise.race([job, new Promise((_,reject) => {timer=setTimeout(()=>reject(Error('operation timeout')),ms);})]); }
  finally { clearTimeout(timer); }
}
async function journal() {
  const lines = await fs.readFile(path.join(scratch,'offers.jsonl'),'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});
  return lines.split('\n').slice(0,-1).map(s=>JSON.parse(s));
}
function admitted(native) {
  const r = native?.nativeRequests;
  return r?.trace?.curl===0 && r.trace.status==='200' && r?.target?.curl===0 && r.target.status==='204';
}
// The controller serializes probes. Bind the terminal decision to its actual native
// offer and feedback, then to one network batch by the production probe's timestamps.
function diagnoses(events, native, network) {
  return events.decisions.map(e => {
    const pending=e.probe;
    if (!pending) return {attribution:'NO_VERIFYING_OFFER',decision:e.diagnostic};
    const offered=native.filter(n=>n.event==='offer' && n.attempt===pending.attempt &&
      n.checkedAt===pending.checkedAt && n.scheme===pending.scheme && n.country===pending.country && n.atMs<=pending.verifyingAt);
    const owners=new Set(offered.map(n=>n.session+'/'+n.alias));
    const offer=owners.size===1 ? offered.at(-1) : null;
    const proof=joinProbeRequests(network,{verifyingAt:pending.verifyingAt,checkedAt:e.diagnostic.checkedAt,latencyMs:e.diagnostic.latencyMs});
    const feedback=native.filter(n=>offer && n.event==='reject' && n.session===offer.session &&
      n.alias===offer.alias && n.attempt===offer.attempt && n.reason===e.diagnostic.reason && n.atMs>=e.diagnostic.checkedAt);
    const row={attempt:pending.attempt,verifiedAt:pending.verifyingAt,decision:e.diagnostic,
      native:offer,feedback:feedback[0] || null,join:proof,conclusive:false};
    const crossedManualChange = report.manualChanges.some(m=>m.atMs>=pending.verifyingAt && m.atMs<=e.diagnostic.checkedAt);
    if (!admitted(offer) || feedback.length!==1 || proof.attribution!=='matched' || crossedManualChange) return row;
    const endpoint=e.diagnostic.endpoint, requests=proof.requests;
    if (e.diagnostic.reason==='transport' && endpoint) {
      const failing=requests.filter(r=>r.endpoint===endpoint && r.outcome==='failed' && r.error && r.error!=='net::ERR_ABORTED');
      row.conclusive=failing.length===1;
    } else if (e.diagnostic.reason==='http') {
      row.conclusive=requests.some(r=>r.httpStatus != null && r.httpStatus!==(r.endpoint==='trace'?200:204) &&
        r.httpStatus===e.diagnostic.statuses?.[r.endpoint]);
    } else if (e.diagnostic.reason==='timeout' && endpoint) {
      row.conclusive=requests.some(r=>r.endpoint===endpoint && ['failed','cancelled'].includes(r.outcome));
    } else if (['invalid_trace','country'].includes(e.diagnostic.reason)) {
      row.conclusive=requests.some(r=>r.endpoint==='trace' && r.httpStatus===200);
    }
    return row;
  });
}
// A manual change, an aborted sibling or a failure on the Google control does
// not reproduce the specific Cloudflare error from the preceding investigation.
function traceFailure(row) {
  if (!row.conclusive || row.decision.reason !== 'transport' || row.decision.endpoint !== 'trace') return null;
  return row.join.requests.find(r=>r.endpoint==='trace' && r.outcome==='failed' && !r.canceled) || null;
}
const traceClosure = row => traceFailure(row)?.error === 'net::ERR_CONNECTION_CLOSED';
async function evidence() {
  const events=await popup.evaluate(()=>window.readEvidence());
  const native=await journal(), network=observer.snapshot();
  const resolved=diagnoses(events,native,network);
  return {events,native,network,resolved,distinct:new Set(resolved.filter(r=>r.conclusive).map(r=>r.native.alias)).size};
}
async function connect(action) {
  return popup.evaluate(({action,countries})=>chrome.runtime.sendMessage(action==='connect'?{action,countries}:{action}),{action,countries});
}
console.log('receipt',receipt);
try {
  const manifest=JSON.parse(await fs.readFile(path.join(root,'extension/manifest.json')));
  const id=crypto.createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32)
    .replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
  const extensionUrl='chrome-extension://'+id, workerUrl=extensionUrl+'/background.js';
  const launcher=path.join(scratch,'host');
  await fs.writeFile(path.join(scratch,'alias-salt'),crypto.randomBytes(32),{mode:0o600});
  await fs.writeFile(launcher, '#!/bin/sh\nexec '+[python,'-I','-B',path.join(root,'tests/https_diagnosis_host.py'),scratch,String(checkLimit)].map(quote).join(' ')+'\n',{mode:0o700});
  const registry=path.join(profile,'NativeMessagingHosts');
  await fs.mkdir(registry,{recursive:true});
  await fs.writeFile(path.join(registry,'local.country_proxy.json'), JSON.stringify({name:'local.country_proxy',description:'HTTPS observation in disposable profile',
    path:launcher,type:'stdio',allowed_origins:[extensionUrl+'/']}),{mode:0o600});
  const ext=path.join(root,'extension');
  chrome=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,timeout:20000,
    ignoreDefaultArgs:['--disable-extensions'],args:['--disable-extensions-except='+ext,'--load-extension='+ext,'--disable-quic',
      ...(netlog ? ['--log-net-log='+path.join(scratch,rawLogName),'--net-log-max-size-mb=32'] : [])]});
  report.browser=chrome.browser().version();report.runtime=await inspectRuntime(chrome,root);
  popup=await chrome.newPage();await popup.goto(extensionUrl+'/popup.html',{timeout:10000});
  const worker=chrome.serviceWorkers().find(w=>w.url()===workerUrl);
  assert.ok(worker);
  observer=await attachProbeObserver(chrome,workerUrl);
  report.beforeConnect=await worker.evaluate(async controls=>{
    const settings=await chrome.proxy.settings.get({incognito:false});
    const t=Date.now();
    const statuses=await Promise.all(Object.entries(controls).map(async ([key,url])=>{
      try {const res=await fetch(url+'?control='+t,{signal:AbortSignal.timeout(15000),cache:'no-store',credentials:'omit',redirect:'error'});
        return [key,res.status];}catch{return [key,null];}
    }));
    return {effectiveMode:settings.value.mode,owner:settings.levelOfControl,statuses:Object.fromEntries(statuses)};
  },controls);
  assert.notEqual(report.beforeConnect.owner,'controlled_by_this_extension');
  assert.equal(report.beforeConnect.statuses.trace,200);assert.equal(report.beforeConnect.statuses.target,204);
  await popup.evaluate(allowed=>{
    const decisions=[],limit=80;let pending=null,invalid=false,limited=false,confirmed=0,verifying=0;
    const append=(list,item)=>{if(list.length<limit)list.push(item);else limited=true;};
    chrome.storage.onChanged.addListener((c,area)=>{
      if(area!=='local' || !c.status?.newValue)return;
      const s=c.status.newValue;
      if(s.countries?.length && (s.countries.length!==allowed.length || s.countries.some(cc=>!allowed.includes(cc))))invalid=true;
      if(s.phase==='verifying'){
        verifying++;pending={attempt:s.attempt,checkedAt:s.proxy?.checkedAt,country:s.proxy?.country,scheme:s.proxy?.scheme,verifyingAt:s.updatedAt};
      } else if(s.phase==='replacing' && s.diagnostic?.stage==='browser'){
        const {reason,endpoint,latencyMs,checkedAt,statuses}=s.diagnostic;
        append(decisions,{probe:pending,diagnostic:{reason,endpoint,latencyMs,checkedAt,statuses}});pending=null;
      } else if(s.phase==='connected'){
        confirmed++;if(!allowed.includes(s.browser?.country))invalid=true;pending=null;
      } else if(['replacing','searching','off','error','helper','reserve'].includes(s.phase))pending=null;
    });
    window.readEvidence=()=>({decisions,limited,invalid,confirmed,verifying});
  },countries);
  started=Date.now();report.started=new Date(started).toISOString();
  watchdog=setTimeout(()=>chrome?.close().catch(()=>{}),windowMs+12000);
  assert.equal((await connect('connect')).ok,true);
  let nextUpdate=0;
  const sampled = new Set();
  while(Date.now()-started<windowMs){
    const s=await popup.evaluate(()=>chrome.storage.local.get(['status','selectedCountries','enabled','selectionMode']));
    assert.equal(s.enabled,true);assert.equal(s.selectionMode,'multiple');assert.deepEqual(s.selectedCountries,countries);
    if(['helper','error'].includes(s.status?.phase))throw Error('SESSION_'+s.status.phase.toUpperCase());
    const e=await evidence();
    assert.ok(!e.events.invalid && !e.events.limited && e.network.available && !e.network.limited);
    if(netlog ? e.resolved.some(traceClosure) : e.distinct>=desiredDistinct)break;
    if(sampleConfirmed && report.manualChanges.length<manualLimit && s.status?.phase==='connected'){
      const confirm=e.native.findLast(n=>n.event==='confirm' && n.attempt===s.status.attempt);
      const offering=e.native.findLast(n=>n.event==='offer' && n.attempt===s.status.attempt &&
        n.session===confirm?.session && n.alias===confirm?.alias && n.checkedAt===s.status.proxy?.checkedAt);
      if (confirm && admitted(offering) && !sampled.has(confirm.alias) && Date.now()-confirm.atMs>=4000) {
        // Only cycle a confirmed healthy address. Ignore probe intervals crossing this action.
        sampled.add(confirm.alias);
        const change={atMs:Date.now(),attempt:confirm.attempt,session:confirm.session,alias:confirm.alias};
        report.manualChanges.push(change);
        assert.equal((await connect('rotate')).ok,true);
        console.log('sampling another route after confirmed healthy offer',change.attempt);
      }
    }
    if(Date.now()>=nextUpdate){console.log('elapsed',Math.round((Date.now()-started)/1000),'nativeAttempts',s.status?.diagnostics?.attempts||0,
      'verifying',e.events.verifying,'rejections',e.events.decisions.length,'attributed',e.distinct);nextUpdate=Date.now()+30000;}
    await sleep(350);
  }
  report.elapsedMs=Date.now()-started;
  // Read terminal events already in flight before disconnecting the helper.
  await sleep(500);
  const e=await evidence();report.attempts=e.resolved;report.workerRequests=e.network.requests;
  report.nativeOffers=e.native.filter(n=>n.event==='offer');report.feedback=e.native.filter(n=>n.event!=='offer');
  report.counts={verifying:e.events.verifying,rejections:e.events.decisions.length,conclusiveDistinct:e.distinct,connectedUpdates:e.events.confirmed};
  report.result=e.distinct?'OBSERVED':'INCONCLUSIVE';
  assert.ok(!e.events.invalid && !e.events.limited && e.network.available && !e.network.limited);
} catch(error) {
  report.result='FAIL';report.error=String(error.message).split('\n')[0];console.error(report.error);
} finally {
  clearTimeout(watchdog);const errors=[];
  if(popup && !popup.isClosed()){try{await bounded(connect('disconnect'),7000);}catch{errors.push('disconnect');}}
  if(observer){try{await bounded(observer.close(),5000);}catch{errors.push('observer');}}
  let closed=!chrome;
  if(chrome){try{await bounded(chrome.close(),10000);closed=true;}catch{errors.push('browser');}}
  report.startedNativeChecks=Number(await fs.readFile(path.join(scratch,'started'),'utf8').catch(()=>'0'));
  if(netlog && closed && report.result!=='FAIL'){
    try {
      const rawPath=path.join(scratch,rawLogName);
      const stat=await fs.stat(rawPath);
      assert.ok(stat.isFile() && stat.size>0 && stat.size<=36*1024*1024);
      const raw=JSON.parse(await fs.readFile(rawPath,'utf8'));
      assert.ok(Array.isArray(raw.events) && raw.events.length && raw.constants?.logEventTypes);
      const {diagnoseNetLog}=await import('./netlog-phase.mjs');
      const {projectNetLog}=await import('./netlog-projection.mjs');
      report.netlog={captureMode:'Default',cases:[]};
      for(const row of report.attempts){
        const target=traceFailure(row);
        if(!target)continue;
        const input={nonce:target.nonce,scheme:row.native.scheme,error:target.error};
        const projection=projectNetLog(raw,[target.nonce]);
        const diagnosis=diagnoseNetLog(projection,input);
        await fs.writeFile(path.join(reportDir,'phase-'+report.netlog.cases.length+'.json'),
          JSON.stringify(projection)+'\n',{mode:0o600,flag:'wx'});
        report.netlog.cases.push({attempt:row.attempt,alias:row.native.alias,requestId:target.requestId,nonce:target.nonce,error:target.error,exactClosure:traceClosure(row),diagnosis});
      }
      report.result=report.netlog.cases.some(c=>c.exactClosure && c.diagnosis.stage!=='unknown')?'OBSERVED':'INCONCLUSIVE';
    }catch{errors.push('netlog-analysis');}
  }
  if(closed){try{await fs.rm(scratch,{recursive:true,force:true});report.profileRemoved=true;}catch{errors.push('remove-profile');}}
  if(errors.length){report.result='FAIL';report.cleanup=errors;}
  await fs.writeFile(receipt,JSON.stringify(report,null,2)+'\n',{mode:0o600});
}
console.log('result',report.result,report.counts);
if(report.result!=='OBSERVED')process.exitCode=report.result==='INCONCLUSIVE'?2:1;
