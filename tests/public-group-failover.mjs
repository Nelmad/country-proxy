// A single public group in a disposable profile. Only the isolated native helper's
// health observation for A is faulted; neither Chrome routes nor public endpoints are modified.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {inspectRuntime} from './chrome-runtime.mjs';
import {attachProbeObserver} from './https-probe-observer.mjs';
import {browserProofs, confirmationProofs, faultTrigger, navigationError, pendingProbeAtCutoff, readOfferSessions} from './failover-evidence.mjs';
import {matchesEffectiveRoute, proxyConfig} from '../extension/controller.js';

const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const python = process.env.TEST_PYTHON || path.join(root, '.venv/bin/python');
const countries = (process.env.TEST_COUNTRIES || 'AT,EE,NO').split(',').map(s => s.trim().toUpperCase()).sort();
const catalog = JSON.parse(await fs.readFile(path.join(root, 'extension/countries.json')));
assert.ok(countries.length >= 2 && new Set(countries).size === countries.length && countries.every(c => catalog.includes(c)));
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--fault-on-first-tab')) {
  throw Error('Usage: node tests/public-group-failover.mjs [--fault-on-first-tab]');
}
const scenario = args.length ? 'firstVerifiedTab' : 'freshReserve';
const pairWindow = 360000, recoveryWindow = 150000, nativeChecks = 360;
const traceURL = 'https://www.cloudflare.com/cdn-cgi/trace';
const output = path.join(root, '.runtime');
await fs.mkdir(output, {recursive: true});
const run = await fs.mkdtemp(path.join(output, 'public-group-'));
const receipt = path.join(run, 'report.json');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'country-proxy-public-group-'));
const profile = path.join(scratch, 'profile');
const report = {countries, scenario, limit: {pairWindowMs: pairWindow, recoveryMs: recoveryWindow, nativeChecks}, result: 'FAIL', failureInjected: false, tabChecks:[], recoveryRoutes:[], observationLimited:false};
const quote = s => "'" + s.replaceAll("'", "'\"'\"'") + "'";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, ms) {
  let timer;
  try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('deadline exceeded')),ms);})]); }
  finally { clearTimeout(timer); }
}
const key = p => p && `${p.scheme}://${p.host}:${p.port}`;
const readNumber = async file => Number(await fs.readFile(path.join(scratch, file), 'utf8').catch(() => '0'));
class WindowEnded extends Error {}
let browser, popup, page, command, state, route, deadline, started, watchdog, monitor;
let decisions = [], confirmations = [], cutoffTimer, cutoffAt, cutoffSnapshot, cutoffOffer=null;
function captureCutoff() {
  cutoffSnapshot={capturedAtMs:Date.now(),network:monitor?.snapshot() || {available:false,requests:[]}};
}
function armCutoff(at) {
  clearTimeout(cutoffTimer);
  cutoffAt=at;
  cutoffSnapshot=null;
  cutoffTimer=setTimeout(captureCutoff, Math.max(0,at-Date.now()));
}

function append(rows, item) {
  if (rows.length < 512) rows.push(item); else report.observationLimited=true;
}
async function readFaults() {
  const text = await fs.readFile(path.join(scratch,'health-faults'),'utf8').catch(e => {if (e.code === 'ENOENT') return ''; throw e;});
  const values=text.trim().split('\n').filter(Boolean).map(Number);
  if (!values.every(v => Number.isSafeInteger(v) && v>0)) throw Error('INVALID_FAULT_JOURNAL');
  return values;
}
let lastPhase, lastState, lastConfirmedAt, nextSampleAt = 0;
async function sourceDigest() {
  const digest=crypto.createHash('sha256');
  for (const directory of ['native','extension']) {
    const files=(await fs.readdir(path.join(root,directory),{withFileTypes:true})).filter(e=>e.isFile()).map(e=>e.name).sort();
    for (const name of files) {
      digest.update(directory+'/'+name+'\0');
      digest.update(crypto.createHash('sha256').update(await fs.readFile(path.join(root,directory,name))).digest());
    }
  }
  return digest.digest('hex');
}
function checkedGroup(s) {
  assert.equal(s.selectionMode, 'multiple');
  assert.deepEqual(s.selectedCountries, countries);
  assert.equal(s.enabled, true);
}
function ready(s) {
  return s.status?.phase === 'connected' && s.status.browser?.ok && countries.includes(s.status.browser.country);
}
function aggregate(s) {
  return {phase: s.status?.phase, attempts: s.status?.diagnostics?.attempts, passed: s.status?.diagnostics?.passed,
    failures: s.status?.diagnostics?.failures, reserve: s.reserveDiagnostics || null, count: s.pool?.count ?? 0};
}
async function observe() {
  const s = await state();
  checkedGroup(s);
  lastState = aggregate(s);
  if (Date.now() >= nextSampleAt) {
    nextSampleAt=Date.now()+30000;
    report.samples.push({atMs:Date.now()-started,...lastState});
    console.log('sample', JSON.stringify(report.samples.at(-1)));
  }
  if (s.status?.country) assert.ok(countries.includes(s.status.country));
  if (s.status?.phase !== lastPhase) {
    lastPhase = s.status?.phase;
    console.log(new Date().toISOString(), lastPhase, lastState.attempts ?? '');
  }
  return s;
}
async function tabTrace(s, until) {
  const p = s.status.proxy;
  const check = {startMs:Date.now()-started, stage:report.failureInjected?'replacement':'baseline',
    attempt:s.status.attempt ?? null, nativeCheckedAt:s.status.proxy.checkedAt, result:'started'};
  append(report.tabChecks,check);
  function finish(result,more={}) { Object.assign(check,{result,endMs:Date.now()-started},more); return null; }
  if (!matchesEffectiveRoute(await route(), proxyConfig(p))) return finish('effective_route_changed');
  let response;
  try {
    response = await page.goto(traceURL + '?public-group=' + crypto.randomUUID(), {
      timeout: Math.max(1, Math.min(18000, until-Date.now())), waitUntil: 'domcontentloaded'});
    if (!response?.ok()) return finish('http',{status:response?.status() ?? null});
  } catch (error) {
    if (page.isClosed()) throw error;
    return finish('navigation',{error:navigationError(error)});
  }
  let content;
  try {content=await page.locator('body').innerText({timeout: Math.max(1, Math.min(3000, until-Date.now()))});}
  catch (error) { if (page.isClosed()) throw error; return finish('body_read',{error:navigationError(error)}); }
  const data = Object.fromEntries(content.trim().split('\n').map(line => line.split('=')));
  const after = await observe();
  if (!ready(after) || key(after.status.proxy) !== key(p) || !matchesEffectiveRoute(await route(), proxyConfig(p))) return finish('route_changed_during_navigation');
  if (!net.isIP(data.ip) || !countries.includes(data.loc)) {finish('invalid_or_outside_group'); throw Error('INVALID_OR_OUTSIDE_GROUP_TAB_EXIT');}
  if (data.ip !== s.status.browser.exitIp || data.loc !== s.status.browser.country ||
      data.ip !== after.status.browser.exitIp || data.loc !== after.status.browser.country) {
    report.unstableTabEgress=(report.unstableTabEgress || 0)+1;return finish('changed_exit');
  }
  finish('verified',{country:data.loc,scheme:p.scheme});
  return {attempt:s.status.attempt ?? null,nativeCheckedAt:p.checkedAt,ip: data.ip, country: data.loc, host: p.host, scheme: p.scheme, atMs: Date.now()-started};
}

console.log('receipt', receipt);
try {
  report.sourceSHA256=await sourceDigest();
  report.samples=[];
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'extension/manifest.json')));
  const id = crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex')
    .slice(0,32).replace(/[0-9a-f]/g, c => String.fromCharCode(97+parseInt(c,16)));
  const hostDir = path.join(profile, 'NativeMessagingHosts');
  await fs.mkdir(hostDir, {recursive:true});
  const launcher = path.join(scratch, 'host');
  await fs.writeFile(launcher, '#!/bin/sh\nexec ' + [python, '-I', '-B', path.join(root, 'tests/public_group_host.py'),
    scratch, String(nativeChecks)].map(quote).join(' ') + '\n', {mode:0o700});
  await fs.writeFile(path.join(hostDir, 'local.country_proxy.json'), JSON.stringify({name:'local.country_proxy',
    description:'Isolated public group acceptance',path:launcher,type:'stdio',allowed_origins:[`chrome-extension://${id}/`]}), {mode:0o600});
  browser = await chromium.launchPersistentContext(profile, {channel:'chromium',headless:true,timeout:20000,
    ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${root}/extension`,`--load-extension=${root}/extension`,'--disable-quic']});
  report.browser = browser.browser().version();
  report.code = await inspectRuntime(browser, root);
  monitor = await attachProbeObserver(browser,`chrome-extension://${id}/background.js`);
  popup = await browser.newPage(); await popup.goto(`chrome-extension://${id}/popup.html`);
  page = await browser.newPage();
  command = (action, extra={}) => popup.evaluate(m => chrome.runtime.sendMessage(m), {action,...extra});
  state = () => popup.evaluate(() => chrome.storage.local.get(['selectionMode','selectedCountries','status','enabled','pool','reserveDiagnostics']));
  route = () => popup.evaluate(() => chrome.proxy.settings.get({incognito:false}));
  await popup.evaluate(allowed => {
    const events = window.evidence = {phaseCounts:{}, browserRejectionReasons:{}, confirmingWithdrawals:0, firstConfirmingAt:null, lastWithdrawalAt:null, outsideGroup:false, unexpectedRoute:false};
    const decisions = window.probeDecisions = [];
    const confirmations = window.probeConfirmations = [];
    let verifying=null, initialOffer=null;
    events.withdrawals=[];
    // Only verifying transitions and exits are needed. Generation IDs remain in
    // this test page. A stale attempt from a different generation cannot be reused.
    const transitions=[];
    let boundaryLimited=false;
    window.probeAtCutoff = at => {
      if (boundaryLimited) return {limited:true,offer:null};
      const last=transitions.findLast(t=>t.at<=at);
      return {limited:false,offer:last?.offer ?? null};
    };
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.status?.newValue) return;
      const s = changes.status.newValue;
      events.phaseCounts[s.phase] = (events.phaseCounts[s.phase] || 0)+1;
      if (s.phase==='verifying') {
        if (!initialOffer || initialOffer.id!==s.id || initialOffer.attempt!==s.attempt) {
          // A later native health check can refresh checkedAt for this same attempt.
          initialOffer={id:s.id,attempt:s.attempt,checkedAt:s.proxy?.checkedAt};
        }
        verifying={attempt:s.attempt,checkedAt:s.proxy?.checkedAt,initialCheckedAt:initialOffer.checkedAt,verifyingAt:s.updatedAt};
      }
      const boundaryOffer=s.phase==='verifying' && typeof s.id==='string' && s.id.length && initialOffer?.id===s.id
        && initialOffer.attempt===s.attempt && Number.isSafeInteger(s.updatedAt) ? {...verifying} : null;
      if (boundaryOffer || transitions.at(-1)?.offer) {
        if (transitions.length>=1024) boundaryLimited=true;
        else transitions.push({at:Number.isSafeInteger(s.updatedAt) ? s.updatedAt : Date.now(),offer:boundaryOffer});
      }
      if (s.phase==='replacing' && events.withdrawals.length<512) events.withdrawals.push({atMs:s.updatedAt,
        afterFault:Boolean(window.faultArmed), attempt:s.attempt ?? null, reason:s.diagnostic?.stage==='browser'?'browser_rejected':'withdrawn'});
      if (s.phase === 'replacing' && s.diagnostic?.stage === 'browser') {
        const {reason,endpoint,checkedAt,latencyMs,statuses}=s.diagnostic;
        if (decisions.length<512) decisions.push({offer:verifying,diagnostic:{reason,endpoint,checkedAt,latencyMs,statuses}});
        events.browserRejectionReasons[reason]=(events.browserRejectionReasons[reason] || 0)+1;
      }
      if (s.phase==='connected' && s.browser?.ok && verifying && initialOffer?.id===s.id &&
          initialOffer.attempt===s.attempt && Number.isSafeInteger(s.browser.checkedAt) &&
          s.browser.checkedAt>=verifying.verifyingAt) {
        const {checkedAt,latencyMs,verifiedRequests}=s.browser;
        if (confirmations.length<512) confirmations.push({offer:verifying,browser:{checkedAt,latencyMs,verifiedRequests},connectedAt:s.updatedAt});
        else events.confirmationsLimited=true;
      }
      if (['replacing','searching','off','connected','error','helper','reserve'].includes(s.phase)) verifying=null;
      if (window.faultArmed && s.phase === 'confirming') events.firstConfirmingAt ??= Date.now();
      if (window.faultArmed && s.phase === 'replacing') {events.confirmingWithdrawals++;events.lastWithdrawalAt=Date.now();}
      if (s.phase === 'connected' && !allowed.includes(s.browser?.country)) events.outsideGroup = true;
    });
    chrome.proxy.settings.onChange.addListener(change => {
      if (window.tracking && (change.value.mode !== 'fixed_servers' || change.levelOfControl !== 'controlled_by_this_extension')) events.unexpectedRoute = true;
    });
  },countries);
  started=Date.now(); const pairEnd=started+pairWindow;
  armCutoff(pairEnd);
  deadline=pairEnd+recoveryWindow;
  report.at=new Date(started).toISOString();
  watchdog=setTimeout(() => browser?.close().catch(()=>{}),deadline-Date.now()+8000);
  assert.equal((await command('connect',{countries})).ok,true);
  await popup.evaluate(() => {window.tracking=true;});
  let a, faultAt, nextTrace=0, lastKey=null, lastTrace=null;
  while (Date.now()<pairEnd) {
    const s=await observe();
    if (['error','helper'].includes(s.status?.phase)) throw Error('SESSION_'+s.status.phase.toUpperCase());
    if (ready(s)) {
      lastConfirmedAt ??= Date.now()-started;
      const k=key(s.status.proxy);
      if (k!==lastKey) {lastTrace=null;nextTrace=0;lastKey=k;}
      const trigger = faultTrigger(scenario,s.pool,countries);
      if ((!lastTrace || (trigger.canArm && Date.now()-started-lastTrace.atMs>10000)) && Date.now()>=nextTrace) {
        const verified=await tabTrace(s,pairEnd);
        lastTrace=verified;
        nextTrace=Date.now()+6000;
        if (verified && !report.firstTab) report.firstTab={country:verified.country,scheme:verified.scheme,atMs:verified.atMs};
      }
      if (trigger.canArm && lastTrace && Date.now()-started-lastTrace.atMs<10001) {
        const current=await observe();
        const currentTrigger = faultTrigger(scenario,current.pool,countries);
        if (Date.now()<pairEnd && ready(current) && currentTrigger.canArm && key(current.status.proxy)===k &&
            current.status.attempt===lastTrace.attempt && current.status.browser.country===lastTrace.country &&
            current.status.browser.exitIp===lastTrace.ip && matchesEffectiveRoute(await route(),proxyConfig(current.status.proxy))) {
          a=lastTrace;
          report.faultedOffer={attempt:current.status.attempt ?? null,nativeCheckedAt:current.status.proxy.checkedAt};
          report.faultBaseline={atMs:Date.now()-started,country:a.country,scheme:a.scheme,reserve:currentTrigger.reserve};
          if (currentTrigger.reserve.ready) {
            report.pair={atMs:report.faultBaseline.atMs,country:a.country,scheme:a.scheme,pool:aggregate(current)};
          }
          await popup.evaluate(() => {window.faultArmed=true;});
          await fs.writeFile(path.join(scratch,'fault'),k,{flag:'wx',mode:0o600});
          faultAt=Date.now();report.faultArmedAt=faultAt;report.failureInjected=true;break;
        }
      }
    } else lastTrace=null;
    await pause(450);
  }
  if (!a) throw new WindowEnded(report.firstTab
    ? (scenario==='freshReserve' ? 'NO_FRESH_RESERVE' : 'FIRST_TAB_NO_LONGER_CURRENT')
    : lastConfirmedAt!=null?'NO_ORDINARY_TAB_BASELINE':'NO_BROWSER_BASELINE');
  const end=Math.min(deadline,faultAt+recoveryWindow);
  armCutoff(end);
  let nextTry=0, lastRecoveryRoute=null;
  while (Date.now()<end) {
    const s=await observe();
    if (['error','helper'].includes(s.status?.phase)) throw Error('SESSION_'+s.status.phase.toUpperCase());
    if (ready(s)) {
      const routeKey=[key(s.status.proxy),s.status.browser.exitIp,s.status.attempt].join('/');
      if (routeKey!==lastRecoveryRoute) {
        lastRecoveryRoute=routeKey;
        append(report.recoveryRoutes,{atMs:Date.now()-started,attempt:s.status.attempt ?? null,nativeCheckedAt:s.status.proxy.checkedAt,
          differentHost:s.status.proxy.host!==a.host,differentExit:s.status.browser.exitIp!==a.ip,
          country:s.status.browser.country,scheme:s.status.proxy.scheme});
      }
    }
    if (ready(s) && s.status.proxy.host!==a.host && s.status.browser.exitIp!==a.ip && Date.now()>=nextTry) {
      const b=await tabTrace(s,end);
      nextTry=Date.now()+6000;
      if (b && Date.now()<=end) {
        assert.notEqual(b.host,a.host);assert.notEqual(b.ip,a.ip);
        const events=await popup.evaluate(()=>window.evidence);
        const faults=await readFaults();
        report.faultCount=faults.length;
        if (report.faultCount < 2) throw new WindowEnded('INDEPENDENT_CHANGE_BEFORE_TWO_HEALTH_FAILURES');
        assert.ok(events.firstConfirmingAt >= faults[0] && events.confirmingWithdrawals > 0 && events.lastWithdrawalAt >= faults[1]);
        report.healthTiming={firstFailureMs:faults[0]-faultAt,secondFailureMs:faults[1]-faultAt,secondFailureToTabMs:started+b.atMs-faults[1]};
        assert.ok(!events.outsideGroup && !events.unexpectedRoute);
        report.replacement={attempt:b.attempt,nativeCheckedAt:b.nativeCheckedAt,country:b.country,scheme:b.scheme,differentHost:true,differentExit:true,ordinaryHttps:true,
          msFromFaultArmedToTab:Date.now()-faultAt};
        report.result='PASS';break;
      }
    }
    await pause(450);
  }
  if (report.result!=='PASS')throw new WindowEnded('NO_VERIFIED_REPLACEMENT_WITHIN_WINDOW');
} catch(error) {
  report.result=error instanceof WindowEnded?'INCONCLUSIVE':'FAIL';
  report.reason=error.message.split('\n')[0];
} finally {
  clearTimeout(watchdog);
  clearTimeout(cutoffTimer);
  if (!cutoffSnapshot && cutoffAt && Date.now()>=cutoffAt) captureCutoff();
  report.measuredMs=started ? Date.now()-started : null;
  report.firstBrowserMs=lastConfirmedAt??null;
  if (popup && !popup.isClosed() && state) {
    try {
      if (cutoffSnapshot) {
        const boundary=await popup.evaluate(at=>window.probeAtCutoff(at),cutoffAt);
        cutoffOffer=boundary.offer;
        report.probeCutoff={atMs:cutoffAt,capturedAtMs:cutoffSnapshot.capturedAtMs,phaseHistoryLimited:boundary.limited};
      }
      report.final=aggregate(await state());
      report.states=await popup.evaluate(()=>window.evidence);
      decisions=await popup.evaluate(()=>window.probeDecisions);
      confirmations=await popup.evaluate(()=>window.probeConfirmations);
      if (report.states?.outsideGroup || report.states?.unexpectedRoute) { report.result='FAIL';report.reason='OUTSIDE_GROUP_OR_UNEXPECTED_ROUTE'; }
      report.sourceQualityAt=new Date().toISOString();
      report.sourceQuality={};
      await Promise.all(countries.map(async c => {
        const r=(await command('sourceQuality',{country:c})).report;
        if (r) report.sourceQuality[c]=r;
      }));
    } catch(error) { report.collectionError=error.message.split('\n')[0]; }
  }
  const errors=[];
  if (command && !popup.isClosed()) {
    try { await popup.evaluate(()=>{window.tracking=false;}); await bounded(command('disconnect'),6000); }
    catch (error) {errors.push('disconnect: '+error.message.split('\n')[0]);}
  }
  const network=monitor?.snapshot() || {requests:[],available:false,limited:false};
  if (monitor) {try {await monitor.close();} catch {errors.push('worker observer close failed');}}
  let closed=!browser;
  try { if (browser) {await bounded(browser.close(),12000);closed=true;} }
  catch (error) {errors.push('close: '+error.message.split('\n')[0]);}
  try {
    report.offerSessions=await readOfferSessions(scratch);
    report.pendingProbe=cutoffSnapshot ? pendingProbeAtCutoff(cutoffOffer,cutoffAt,cutoffSnapshot.network,report.offerSessions) : null;
    report.browserRejections=browserProofs(decisions,network,report.offerSessions);
    report.browserConfirmations=confirmationProofs(confirmations,network,report.offerSessions);
    report.workerNetwork={available:network.available,limited:network.limited};
    if (report.failureInjected) {
      const candidates=report.offerSessions.flatMap(s=>s.offers.filter(o=>o.attempt===report.faultedOffer.attempt
        && o.injectedHealthFailures>0).map(o=>({session:s.session,...o})));
      report.faultedSession=candidates.length===1 ? candidates[0].session : null;
      if (report.result==='PASS' && (candidates.length!==1 || candidates[0].injectedHealthFailures<2
          || candidates[0].feedback!=='confirm')) {
        report.result='INCONCLUSIVE';report.reason='NO_TWO_FAILURES_ON_CONFIRMED_OFFER';
      }
    }
    const faults=await readFaults();
    report.faultCount=faults.length;
    if (report.failureInjected) report.healthTiming={...report.healthTiming,
      firstFailureMs:faults.length?faults[0]-report.faultArmedAt:null,
      secondFailureMs:faults.length>1?faults[1]-report.faultArmedAt:null};
    report.startedPhysicalChecks=await readNumber('started');
    report.budgetReached=await fs.access(path.join(scratch,'budget-reached')).then(()=>true,()=>false);
    if (!report.final && lastState)report.final=lastState;
    if (report.sourceSHA256 !== await sourceDigest()) {
      report.resultBeforeSourceChange={result:report.result, reason:report.reason||null};
      report.result='FAIL';report.reason='PRODUCT_CHANGED_DURING_RUN';
    }
  } catch (error) {errors.push('finalization: '+error.message.split('\n')[0]);}
  if (closed) {
    try {await fs.rm(scratch,{recursive:true,force:true});report.profileRemoved=true;}
    catch {errors.push('profile cleanup failed');}
  }
  if (errors.length) {report.cleanupErrors=errors;report.result='FAIL';}
  await fs.writeFile(receipt,JSON.stringify(report,null,2)+'\n',{mode:0o600});
}
console.log(report.result,report.reason||'A_TO_B',report.measuredMs);
if (report.result!=='PASS')process.exitCode=report.result==='INCONCLUSIVE'?2:1;
