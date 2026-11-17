// Two public replacements with an observed fresh refill in one disposable profile.
// Only addressed native health observations are faulted; public servers are unchanged.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {inspectRuntime} from './chrome-runtime.mjs';
import {withdrawalBoundary,observeAutonomousRecovery,finalizeAutonomousRecovery} from './autonomous-recovery.mjs';
import {attachProbeObserver} from './https-probe-observer.mjs';
import {browserProofs, confirmationProofs, faultTrigger, navigationError, pendingProbeAtCutoff, readOfferSessions} from './failover-evidence.mjs';
import {readRefillSessions,boundOffer,postReplacementAdmissions,stageFaults,sameRefillRoute,repeatedRefillOutcome,readPublicProbes,publicProbeCoverage} from './refill-evidence.mjs';
import {matchesEffectiveRoute, proxyConfig} from '../extension/controller.js';

const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const python = process.env.TEST_PYTHON || path.join(root, '.venv/bin/python');
const countries = (process.env.TEST_COUNTRIES || 'AT,EE,NO').split(',').map(s => s.trim().toUpperCase()).sort();
const catalog = JSON.parse(await fs.readFile(path.join(root, 'extension/countries.json')));
assert.ok(countries.length >= 2 && new Set(countries).size === countries.length && countries.every(c => catalog.includes(c)));
if(process.argv.length>2)throw Error('Usage: node tests/public-refill-failover.mjs');
const pairWindow=360000, recoveryWindow=150000, refillWindow=360000, nativeChecks=360;
const scenario='twoReplacementsWithRefill';
const traceURL = 'https://www.cloudflare.com/cdn-cgi/trace';
const output = path.join(root, '.runtime');
await fs.mkdir(output, {recursive: true});
const run = await fs.mkdtemp(path.join(output, 'public-refill-'));
const receipt = path.join(run, 'report.json');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'country-proxy-public-refill-'));
const profile = path.join(scratch, 'profile');
const report = {countries, scenario, limit: {pairWindowMs: pairWindow, recoveryMs: recoveryWindow, refillMs:refillWindow, nativeChecks}, result: 'FAIL', failureInjected: false, stages:[], tabChecks:[], recoveryRoutes:[], observationLimited:false};
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
  const check = {startMs:Date.now()-started, stage:report.currentStage??'baseline',
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
  if (!ready(after) || after.status.attempt !== s.status.attempt || after.status.id !== s.status.id || key(after.status.proxy) !== key(p) || !matchesEffectiveRoute(await route(), proxyConfig(p))) return finish('route_changed_during_navigation');
  if (!net.isIP(data.ip) || !countries.includes(data.loc)) {finish('invalid_or_outside_group'); throw Error('INVALID_OR_OUTSIDE_GROUP_TAB_EXIT');}
  if (data.ip !== s.status.browser.exitIp || data.loc !== s.status.browser.country ||
      data.ip !== after.status.browser.exitIp || data.loc !== after.status.browser.country) {
    report.unstableTabEgress=(report.unstableTabEgress || 0)+1;return finish('changed_exit');
  }
  finish('verified',{country:data.loc,scheme:p.scheme});
  return {generation:s.status.id,attempt:s.status.attempt ?? null,nativeCheckedAt:p.checkedAt,ip: data.ip, country: data.loc, host: p.host, scheme: p.scheme, atMs: Date.now()-started};
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
  await fs.writeFile(launcher, '#!/bin/sh\nexec ' + [python, '-I', '-B', path.join(root, 'tests/public_refill_host.py'),
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
  started=Date.now();
  deadline=started+pairWindow+2*recoveryWindow+refillWindow;
  report.at=new Date(started).toISOString();
  watchdog=setTimeout(()=>browser?.close().catch(()=>{}),deadline-Date.now()+8000);
  assert.equal((await command('connect',{countries})).ok,true);
  await popup.evaluate(()=>{window.tracking=true;});
  const journal=()=>readRefillSessions(scratch);
  const checkBudget=async()=>{
    if(await fs.access(path.join(scratch,'budget-reached')).then(()=>true,()=>false))throw new WindowEnded('PHYSICAL_CHECK_BUDGET_REACHED');
  };
  async function current(){
    await checkBudget();
    const s=await observe();
    if(['error','helper'].includes(s.status?.phase))throw Error('SESSION_'+s.status.phase.toUpperCase());
    return s;
  }
  async function baseline(until, expected=null, after=null){
    armCutoff(until);
    let last=null,nextTrace=0;
    while(Date.now()<until){
      const s=await current();
      if(expected&&!sameRefillRoute(s.status,expected,await journal()))throw new WindowEnded('ROUTE_OR_SESSION_CHANGED_DURING_REFILL');
      if(ready(s)){
        lastConfirmedAt??=Date.now()-started;
        const sessions=await journal(), bound=boundOffer(sessions,s.status.attempt);
        if(expected&&bound&&bound.session!==expected.session)throw new WindowEnded('NATIVE_SESSION_CHANGED_DURING_REFILL');
        const reserve=faultTrigger('freshReserve',s.pool,countries);
        const admissions=after!==null?postReplacementAdmissions(sessions,bound,after,s.pool,countries):[];
        const admission=admissions[0]??null;
        const canArm=reserve.canArm && bound && (after===null||admission);
        if(last&&(last.key!==key(s.status.proxy)||last.attempt!==s.status.attempt))last=null;
        if((!last||(canArm&&Date.now()-started-last.atMs>10000))&&Date.now()>=nextTrace){
          const value=await tabTrace(s,until);nextTrace=Date.now()+6000;
          last=value?{...value,key:key(s.status.proxy)}:null;
          if(value&&!report.firstTab)report.firstTab={country:value.country,scheme:value.scheme,atMs:value.atMs};
        }
        if(canArm&&last&&Date.now()-started-last.atMs<10001){
          const latest=await current(),rows=await journal(),owner=boundOffer(rows,latest.status?.attempt);
          const accepted=after!==null?postReplacementAdmissions(rows,owner,after,latest.pool,countries):[];
          if(Date.now()<until&&ready(latest)&&owner&&owner.session===bound.session
            &&latest.status.attempt===last.attempt&&latest.status.id===last.generation&&(!expected||owner.session===expected.session)&&key(latest.status.proxy)===last.key
            &&latest.status.browser.exitIp===last.ip&&latest.status.browser.country===last.country
            &&faultTrigger('freshReserve',latest.pool,countries).canArm&&(after===null||accepted.length>0)
            &&matchesEffectiveRoute(await route(),proxyConfig(latest.status.proxy))){
            return {route:last,bound:owner,admission:accepted[0]??null,admissions:accepted,pool:aggregate(latest)};
          }
        }
      }else last=null;
      await pause(450);
    }
    await checkBudget();
    throw new WindowEnded(after===null?(report.firstTab?'NO_INITIAL_FRESH_RESERVE':'NO_INITIAL_VERIFIED_TAB'):'NO_POST_REPLACEMENT_REFILL_WITHIN_WINDOW');
  }
  async function arm(number,value){
    const {route:a,bound}=value;
    const stage={number,session:bound.session,attempt:bound.offer.attempt,armedAtMs:Date.now(),
      from:{country:a.country,scheme:a.scheme},reserveAtFault:value.pool,admission:value.admission,
      qualifyingAdmissionIds:(value.admissions??[]).map(a=>a.id)};
    report.stages.push(stage);report.failureInjected=true;
    await popup.evaluate(()=>{window.faultArmed=true;});
    const file=path.join(scratch,'fault.json'),tmp=file+'.new';
    await fs.writeFile(tmp,JSON.stringify({stage:number,session:stage.session,attempt:stage.attempt,endpoint:a.key}),{mode:0o600});
    await fs.rename(tmp,file);
    report.currentStage='replacement-'+number;
    return stage;
  }
  async function replace(stage,a,until,first){
    armCutoff(until);let nextTry=0,lastRoute=null;
    while(Date.now()<until){
      const s=await current();
      if(ready(s)){
        const identity=[key(s.status.proxy),s.status.browser.exitIp,s.status.attempt].join('/');
        if(identity!==lastRoute){lastRoute=identity;append(report.recoveryRoutes,{stage:stage.number,atMs:Date.now()-started,
          attempt:s.status.attempt,differentHost:s.status.proxy.host!==a.host,differentExit:s.status.browser.exitIp!==a.ip,
          country:s.status.browser.country,scheme:s.status.proxy.scheme});}
      }
      if(ready(s)&&s.status.proxy.host!==a.host&&s.status.browser.exitIp!==a.ip&&Date.now()>=nextTry){
        const b=await tabTrace(s,until);nextTry=Date.now()+6000;
        if(b&&Date.now()<=until){
          const sessions=await journal(),faults=stageFaults(sessions,stage),bound=boundOffer(sessions,b.attempt);
          if(faults.length<2)throw new WindowEnded('INDEPENDENT_CHANGE_BEFORE_TWO_ADDRESSED_FAILURES');
          if(!bound||bound.session!==stage.session)throw new WindowEnded('NATIVE_SESSION_CHANGED');
          const original=sessions.find(x=>x.session===stage.session)?.offers.find(o=>o.attempt===stage.attempt);
          if(original?.feedback!=='confirm'||original.injectedHealthFailures<2)throw new WindowEnded('FAULTED_OFFER_NOT_CONFIRMED');
          const events=await popup.evaluate(()=>window.evidence);
          assert.ok(!events.outsideGroup&&!events.unexpectedRoute);
          const reusedInitialHost=Boolean(first&&b.host===first.host), reusedInitialExit=Boolean(first&&b.ip===first.ip);
          if(reusedInitialHost){
            const exclusion=sessions.find(x=>x.session===stage.session)?.exclusions.find(e=>e.attempt===report.stages[0].attempt);
            if(!exclusion||b.nativeCheckedAt<exclusion.untilMs)throw Error('INITIAL_ROUTE_REUSED_BEFORE_NATURAL_EXCLUSION');
          }
          stage.faults=faults;stage.replacement={attempt:b.attempt,nativeCheckedAt:b.nativeCheckedAt,country:b.country,scheme:b.scheme,
            origin:bound.offer.origin,refillAdmissionId:bound.offer.refillAdmissionId,
            differentHost:true,differentExit:true,ordinaryHttps:true,reusedInitial:reusedInitialHost||reusedInitialExit,reusedInitialHost,reusedInitialExit,
            fromFaultArmedToTabMs:started+b.atMs-stage.armedAtMs,secondFailureToTabMs:started+b.atMs-faults[1].atMs};
          stage.result='PASS';
          return {route:{...b,key:key(s.status.proxy)},bound};
        }
      }
      await pause(450);
    }
    await checkBudget();throw new WindowEnded('NO_VERIFIED_REPLACEMENT_'+stage.number+'_WITHIN_WINDOW');
  }
  async function followNaturalRecovery(b, initial) {
    const anchor={...b.route,session:b.bound.session};
    const sessions=await journal(),withdrawnAtMs=withdrawalBoundary(sessions,anchor);
    const out=report.autonomousRecovery={result:'INCONCLUSIVE',session:anchor.session,
      fromAttempt:anchor.attempt,fromCountry:anchor.country,withdrawnAtMs,
      observedAtMs:Date.now(),windowMs:recoveryWindow,failuresInjected:0};
    if(withdrawnAtMs===null){out.reason='NO_CONFIRMED_WITHDRAWAL_BOUNDARY';return;}
    await fs.rm(path.join(scratch,'fault.json'),{force:true});
    await popup.evaluate(()=>{window.faultArmed=false;});
    const until=Math.min(deadline,withdrawnAtMs+recoveryWindow);
    out.deadlineMs=until;report.currentStage='autonomous-recovery';armCutoff(until);
    try {
      const result=await observeAutonomousRecovery({anchor,initial,initialAttempt:report.stages[0].attempt,
        countries,withdrawnAtMs,deadline:until,observe:current,journal,
        trace:async(s,end)=>{const value=await tabTrace(s,end);return value?{...value,completedAtMs:started+value.atMs}:null;},
        effectiveRoute:async proxy=>matchesEffectiveRoute(await route(),proxyConfig(proxy)),
        events:()=>popup.evaluate(()=>window.evidence),pause});
      Object.assign(out,result);
      if(result.result!=='PASS')await checkBudget();
    }catch(error){
      if(!(error instanceof WindowEnded))throw error;
      out.reason=error.message;
    }finally{out.endedAtMs=Date.now();}
  }
  report.currentStage='initial';
  const initial=await baseline(started+pairWindow);
  const firstStage=await arm(1,initial);
  const b=await replace(firstStage,initial.route,Math.min(deadline,firstStage.armedAtMs+recoveryWindow),null);
  await fs.unlink(path.join(scratch,'fault.json'));
  const confirmedAt=b.bound.offer.offeredAtMs+b.bound.offer.feedbackMs;
  report.refill={afterAttempt:b.bound.offer.attempt,session:b.bound.session,confirmedAtMs:confirmedAt,
    openedAtMs:Date.now(),windowMs:refillWindow};
  report.currentStage='post-replacement-refill';
  let replenished;
  try {replenished=await baseline(Math.min(deadline,confirmedAt+refillWindow),{...b.route,session:b.bound.session},confirmedAt);}
  catch(error){
    if(error instanceof WindowEnded&&error.message==='ROUTE_OR_SESSION_CHANGED_DURING_REFILL'){
      report.strictReason=error.message;
      report.refill.observationEndedAtMs=Date.now();
      await followNaturalRecovery(b,initial.route);
    }
    throw error;
  }
  report.refill.readyAtMs=Date.now();report.refill.admission=replenished.admission;
  report.refill.armedQualifyingAdmissionIds=replenished.admissions.map(a=>a.id);
  report.refill.elapsedFromConfirmationMs=report.refill.readyAtMs-confirmedAt;
  const secondStage=await arm(2,replenished);
  const c=await replace(secondStage,replenished.route,Math.min(deadline,secondStage.armedAtMs+recoveryWindow),initial.route);
  const qualifying=postReplacementAdmissions(await journal(),b.bound,confirmedAt,null,countries,Date.now(),false);
  report.refill.qualifyingAdmissionIds=qualifying.map(a=>a.id);
  const outcome=repeatedRefillOutcome(report.stages,qualifying,c.bound);
  report.repeatedReplacements=outcome.repeatedReplacements;
  report.twoPoolReplacements=outcome.twoPoolReplacements;
  report.refill.usedOnSecondReplacement=outcome.usedOnSecondReplacement;
  report.result=outcome.result;
  if(report.result!=='PASS')report.reason='FRESH_REFILL_NOT_USED_ON_SECOND_REPLACEMENT';
} catch(error) {
  report.result=error instanceof WindowEnded?'INCONCLUSIVE':'FAIL';
  report.reason=error.message.split('\n')[0];
} finally {
  clearTimeout(watchdog);clearTimeout(cutoffTimer);
  if(!cutoffSnapshot&&cutoffAt&&Date.now()>=cutoffAt)captureCutoff();
  report.measuredMs=started?Date.now()-started:null;
  report.firstBrowserMs=lastConfirmedAt??null;
  const errors=[];
  if(popup&&!popup.isClosed()&&state){
    try{
      report.final=aggregate(await state());report.states=await popup.evaluate(()=>window.evidence);
      decisions=await popup.evaluate(()=>window.probeDecisions);confirmations=await popup.evaluate(()=>window.probeConfirmations);
      report.refillSessionsAtCutoff=await readRefillSessions(scratch);
      if(report.states.outsideGroup||report.states.unexpectedRoute){report.result='FAIL';report.reason='OUTSIDE_GROUP_OR_UNEXPECTED_ROUTE';}
      if(cutoffSnapshot){const boundary=await popup.evaluate(at=>window.probeAtCutoff(at),cutoffAt);cutoffOffer=boundary.offer;
        report.probeCutoff={atMs:cutoffAt,capturedAtMs:cutoffSnapshot.capturedAtMs,phaseHistoryLimited:boundary.limited};}
      report.sourceQuality={};
      await Promise.all(countries.map(async c=>{const response=await command('sourceQuality',{country:c});if(response.report)report.sourceQuality[c]=response.report;}));
    }catch(error){errors.push('collection: '+error.message.split('\n')[0]);}
    try{
      await popup.evaluate(()=>{window.tracking=false;});
      const reply=await bounded(command('disconnect'),6000);assert.equal(reply.ok,true);
      const off=await state();assert.equal(off.enabled,false);assert.equal(off.status.phase,'off');
      report.disconnectRestored=(await route()).levelOfControl!=='controlled_by_this_extension';assert.ok(report.disconnectRestored);
      const stoppedBy=Date.now()+6000;
      while((await readRefillSessions(scratch)).some(s=>s.lifecycle.running)&&Date.now()<stoppedBy)await pause(50);
      assert.ok(!(await readRefillSessions(scratch)).some(s=>s.lifecycle.running),'all native sessions stopped');
    }catch(error){errors.push('disconnect: '+error.message.split('\n')[0]);}
  }
  const network=monitor?.snapshot()||{requests:[],available:false,limited:false};
  if(monitor){try{await bounded(monitor.close(),5000);}catch{errors.push('observer close');}}
  let closed=!browser;
  if(browser){try{await bounded(browser.close(),12000);closed=true;}catch{errors.push('browser close');}}
  try{
    report.offerSessions=await readOfferSessions(scratch);report.refillSessions=await readRefillSessions(scratch);
    report.publicNativeProbes=await readPublicProbes(scratch);
    report.pendingProbe=cutoffSnapshot?pendingProbeAtCutoff(cutoffOffer,cutoffAt,cutoffSnapshot.network,report.offerSessions):null;
    report.browserRejections=browserProofs(decisions,network,report.offerSessions);
    report.browserConfirmations=confirmationProofs(confirmations,network,report.offerSessions);
    report.workerNetwork={available:network.available,limited:network.limited};
    report.startedPhysicalChecks=await readNumber('started');
    report.nativeProbeCoverage=publicProbeCoverage(report.publicNativeProbes,report.startedPhysicalChecks,
      await fs.access(path.join(scratch,'probe-journal-error')).then(()=>true,()=>false));
    report.budgetReached=await fs.access(path.join(scratch,'budget-reached')).then(()=>true,()=>false);
    if(report.result==='INCONCLUSIVE'&&report.budgetReached)report.reason='PHYSICAL_CHECK_BUDGET_REACHED';
    if(report.nativeProbeCoverage.writeError){report.result='FAIL';report.reason='QA_PROBE_JOURNAL_ERROR';}
    else if(!report.nativeProbeCoverage.complete&&report.result!=='FAIL'){
      report.result='INCONCLUSIVE';report.reason='QA_PROBE_JOURNAL_INCOMPLETE';
    }
    if(report.result==='PASS'&&report.refillSessions.some(s=>s.truncated)){report.result='INCONCLUSIVE';report.reason='QA_JOURNAL_TRUNCATED';}
    for(const stage of report.stages){
      stage.faults=stageFaults(report.refillSessions,stage);
      if(stage.result==='PASS'&&stage.faults.length<2&&report.result!=='FAIL'){
        report.result='INCONCLUSIVE';report.reason='NO_TWO_ADDRESSED_FAILURES';
      }
    }
    assert.ok(report.startedPhysicalChecks<=nativeChecks);
    if(report.sourceSHA256!==await sourceDigest()){report.result='FAIL';report.reason='PRODUCT_CHANGED_DURING_RUN';}
  }catch(error){errors.push('finalization: '+error.message.split('\n')[0]);}
  if(closed){try{await fs.rm(scratch,{recursive:true,force:true});await assert.rejects(fs.access(scratch),{code:'ENOENT'});report.profileRemoved=true;}catch{errors.push('profile cleanup');}}
  if(report.result==='PASS'&&(!report.disconnectRestored||!report.profileRemoved||!report.refillSessions?.length||report.refillSessions.some(s=>s.lifecycle.running)))errors.push('incomplete final lifecycle proof');
  if(errors.length){report.cleanupErrors=errors;report.result='FAIL';}
  if(report.autonomousRecovery)report.autonomousRecovery=finalizeAutonomousRecovery(report.autonomousRecovery,{
    failed:report.result==='FAIL',incomplete:!report.disconnectRestored||!report.profileRemoved||
      !report.nativeProbeCoverage?.complete||report.observationLimited||!report.refillSessions?.length||
      report.refillSessions.some(s=>s.truncated||s.lifecycle.running)});
  await fs.writeFile(receipt,JSON.stringify(report,null,2)+'\n',{mode:0o600});
}
console.log(report.result,report.reason||'A_TO_B_REFILL_TO_C',report.measuredMs);
if(report.result!=='PASS')process.exitCode=report.result==='INCONCLUSIVE'?2:1;
