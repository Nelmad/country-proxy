import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {browserProofs,confirmationProofs,faultTrigger,navigationError,pendingProbeAtCutoff,readOfferSessions,readNativeProbe} from './failover-evidence.mjs';

const nativeTimingFixture=()=>({version:1,startedAtMs:1000,elapsedMs:110,
  queueWaitMs:4,joinedEarlier:false,limited:false,host:'PRIVATE',_startedNs:'PRIVATE',controls:[
    {endpoint:'trace',ordinal:1,startMs:0,endMs:100,outcome:'cancelled',curlCode:null,httpStatus:null,connectStatus:null,timingMs:null},
    {endpoint:'target',ordinal:1,startMs:0,endMs:20,outcome:'completed',curlCode:0,httpStatus:204,connectStatus:200,
      timingMs:{nameLookup:1,connect:2,appConnect:4,pretransfer:5,startTransfer:6,total:7,url:'PRIVATE'}},
    {endpoint:'trace',ordinal:2,startMs:80,endMs:100,outcome:'completed',curlCode:0,httpStatus:200,connectStatus:200,
      timingMs:{nameLookup:1,connect:2,appConnect:4,pretransfer:5,startTransfer:6,total:7},body:'PRIVATE'}]});

test('native physical probe projection validates bounded ordinals and cumulative timings',()=>{
  const source=nativeTimingFixture(),result=readNativeProbe(source);
  assert.equal(result.controls[2].ordinal,2);assert.equal(result.controls[2].timingMs.total,7);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  const earlier=readNativeProbe({...source,joinedEarlier:true,queueWaitMs:null});
  assert.equal(earlier.queueWaitMs,null);
  for(const overrides of [{elapsedMs:Infinity},{queueWaitMs:-1},{joinedEarlier:true},
    {controls:[...source.controls,source.controls[0]]},{controls:Array(5).fill(source.controls[0])}])
    assert.throws(()=>readNativeProbe({...source,...overrides}),/INVALID_NATIVE_PROBE/);
  for(const overrides of [{ordinal:3},{startMs:NaN},{endMs:111},{curlCode:'PRIVATE'},
    {httpStatus:99},{timingMs:{total:2}},{outcome:'completed'},
    {outcome:'cancelled',curlCode:null,timingMs:{nameLookup:1,connect:2,appConnect:4,pretransfer:5,startTransfer:6,total:7}}]){
    const controls=[{...source.controls[0],...overrides}];
    assert.throws(()=>readNativeProbe({...source,controls}),/INVALID_NATIVE_PROBE/);
  }
});

test('failed curl keeps partial counters and only bounded diagnostic enums across JSON',()=>{
  const value=nativeTimingFixture();
  const row={...value.controls[1],outcome:'failed',curlCode:28,httpStatus:0,
    timingMs:{nameLookup:1,connect:2,appConnect:0,pretransfer:0,startTransfer:0,total:20},
    metadataMode:'numeric_only',diagnosis:{errorClass:'timeout',phase:'negotiation_or_tls',sslVerifyResult:0,
      proxySslVerifyResult:0,tlsCompletedEvidence:false,errormsg:'PRIVATE'}};
  value.controls=[row];
  const projected=readNativeProbe(value);
  assert.equal(projected.controls[0].timingMs.connect,2);
  assert.equal(projected.controls[0].diagnosis.phase,'negotiation_or_tls');
  assert.equal(projected.controls[0].metadataMode,'numeric_only');
  assert.throws(()=>readNativeProbe({...value,controls:[{...row,metadataMode:'PRIVATE'}]}),/INVALID_NATIVE_PROBE/);
  assert.ok(!JSON.stringify(projected).includes('PRIVATE'));
  for(const overrides of [{phase:'PRIVATE'},{errorClass:'PRIVATE'},{sslVerifyResult:-1},
    {proxySslVerifyResult:Infinity},{tlsCompletedEvidence:true}]){
    assert.throws(()=>readNativeProbe({...value,controls:[{...row,diagnosis:{...row.diagnosis,...overrides}}]}),/INVALID_NATIVE_PROBE/);
  }
  assert.throws(()=>readNativeProbe({...value,controls:[{...row,outcome:'cancelled',curlCode:null,timingMs:null}]}),/INVALID_NATIVE_PROBE/);
});

test('offer reader retains only the exact optional native probe from its reserve recheck',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cp-native-timing-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'offers-0001.json');
  const data={version:1,session:1,truncated:false,offers:[],removals:[],takes:[{
    atMs:990,elapsedMs:130,leaseAgesMs:[100],result:'selected',rechecks:[
      {outcome:'passed',reason:null,nativeProbe:nativeTimingFixture()},
      {outcome:'cancelled',reason:null}]}]};
  await fs.writeFile(file,JSON.stringify(data));
  const [session]=await readOfferSessions(dir),rows=session.takes[0].rechecks;
  assert.equal(rows[0].nativeProbe.controls[2].ordinal,2);
  assert.equal(rows[1].nativeProbe,undefined);assert.ok(!JSON.stringify(session).includes('PRIVATE'));
  data.takes[0].rechecks[0].nativeProbe.controls[2].ordinal=1;
  await fs.writeFile(file,JSON.stringify(data));
  await assert.rejects(readOfferSessions(dir),/INVALID_NATIVE_PROBE/);
});

test('Python native projection crosses the JSON boundary without changing attribution or timings',()=>{
  const record={...nativeTimingFixture(),_startedNs:1000000};
  record.controls[0]={...record.controls[0],outcome:'failed',curlCode:28,httpStatus:0,connectStatus:0,
    metadataMode:'numeric_only',
    timingMs:{nameLookup:1,connect:2,appConnect:0,pretransfer:0,startTransfer:0,total:100},
    diagnosis:{errorClass:'timeout',phase:'negotiation_or_tls',sslVerifyResult:0,
      proxySslVerifyResult:0,tlsCompletedEvidence:false,errormsg:'PRIVATE'}};
  const script=`import json,sys
from native_probe_observer import project_native_probe
record=json.load(sys.stdin)
print(json.dumps([project_native_probe(record,0),project_native_probe(record,2000000)]))
`;
  const child=spawnSync(process.env.TEST_PYTHON||'python3',['-B','-c',script],{
    cwd:fileURLToPath(new URL('.',import.meta.url)),input:JSON.stringify(record),encoding:'utf8',
    timeout:5000,maxBuffer:65536});
  assert.equal(child.error,undefined);assert.equal(child.status,0,child.stderr);
  const [fresh,joined]=JSON.parse(child.stdout);
  assert.deepEqual(readNativeProbe(fresh),fresh);
  assert.deepEqual(readNativeProbe(joined),joined);
  assert.equal(fresh.queueWaitMs,1);assert.equal(fresh.joinedEarlier,false);
  assert.equal(joined.queueWaitMs,null);assert.equal(joined.joinedEarlier,true);
  assert.equal(joined.controls[2].ordinal,2);
  assert.equal(joined.controls[2].timingMs.appConnect,4);
  assert.equal(joined.controls[0].diagnosis.errorClass,'timeout');
  assert.equal(joined.controls[0].metadataMode,'numeric_only');
  assert.ok(!child.stdout.includes('PRIVATE'));
});

test('successful confirmation separates queue, fetch and feedback; exact nonce identifies slow control',()=>{
  const offer={attempt:3,checkedAt:90,initialCheckedAt:90,verifyingAt:110};
  const browser={checkedAt:20111,latencyMs:20000,exitIp:'PRIVATE'};
  const record={offer,browser,connectedAt:20115};
  const network={requests:[{nonce:111,endpoint:'trace',elapsedMs:20000,headersElapsedMs:19998,outcome:'completed',httpStatus:200,
    timing:{offsetsMs:{connectStart:1,connectEnd:50,sslStart:10,sslEnd:50,sendStart:51,sendEnd:52,receiveHeadersStart:19997,receiveHeadersEnd:19998}},headers:'PRIVATE'},
    {nonce:111,endpoint:'target',elapsedMs:80,headersElapsedMs:80,outcome:'completed',httpStatus:204}]};
  const native={session:1,offers:[{attempt:3,nativeCheckedAt:90,offeredAtMs:100,feedback:'confirm',feedbackMs:20013,origin:'pool'}]};
  const [row]=confirmationProofs([record],network,[native]);
  assert.deepEqual(row.timing,{offerToVerifyingMs:10,verifyingToProbeMs:1,probeMs:20000,probeEndToConfirmMs:2,probeEndToConnectedMs:4});
  assert.equal(row.native.decision,'initial');assert.equal(row.network.attribution,'matched');
  assert.equal(row.network.requests[0].timing.intervalsMs.waitingForHeaders,19945);
  assert.equal(row.network.requests[0].bodyAfterHeadersMs,2);assert.equal(row.network.requests[1].timing,null);
  assert.ok(!JSON.stringify(row).includes('PRIVATE'));
  assert.equal(confirmationProofs([record],network,[native,native])[0].native,null);
  const recheck=confirmationProofs([{...record,offer:{...offer,verifyingAt:21000},browser:{checkedAt:21101,latencyMs:100}}],{requests:[]},[native])[0];
  assert.equal(recheck.native.decision,'recheck');assert.equal(recheck.timing.probeEndToConfirmMs,null);
});

test('successful proof leaves missing or invalid intervals unknown and remains bounded',()=>{
  const record={offer:{attempt:1,checkedAt:95,verifyingAt:101},browser:{checkedAt:120,latencyMs:18}};
  const network={requests:[{nonce:102,endpoint:'trace',elapsedMs:null,headersElapsedMs:null,outcome:'completed',httpStatus:200}]};
  const proofs=confirmationProofs(Array(600).fill(record),network,[]);
  assert.equal(proofs.length,512);assert.equal(proofs[0].network.requests[0].bodyAfterHeadersMs,null);
  assert.equal(proofs[0].timing.offerToVerifyingMs,null);
});

test('successful hedged proof identifies explicit winners without attributing the cancelled primary',()=>{
  const offer={attempt:1,checkedAt:95,verifyingAt:101};
  const browser={checkedAt:6102,latencyMs:6000,verifiedRequests:{trace:2,target:1,secret:'PRIVATE'}};
  const rows=[{nonce:102,endpoint:'trace',ordinal:1,startWallMs:102,outcome:'cancelled',error:'net::ERR_ABORTED'},
    {nonce:102,endpoint:'trace',ordinal:2,startWallMs:5103,elapsedMs:999,outcome:'completed',httpStatus:200},
    {nonce:102,endpoint:'target',ordinal:1,startWallMs:102,outcome:'completed',httpStatus:204}];
  const run=(b=browser,r=rows)=>confirmationProofs([{offer,browser:b}],{requests:r},[])[0];
  const result=run();
  assert.equal(result.network.attribution,'matched');assert.equal(result.network.completePair,true);
  assert.equal(result.network.selectedPairObserved,true);
  assert.deepEqual(result.network.verifiedRequests,{trace:2,target:1});
  assert.deepEqual(result.network.requests.map(r=>r.selected),[false,true,true]);
  assert.equal(result.network.requests[1].requestStartAfterProbeMs,5001);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  for(const verifiedRequests of [undefined,null,{trace:3,target:1},{trace:2}]){
    const unknown=run({...browser,verifiedRequests});
    assert.equal(unknown.network.verifiedRequests,null);
    assert.equal(unknown.network.selectedPairObserved,false);
  }
  assert.equal(run(browser,rows.filter(r=>r.ordinal!==2)).network.selectedPairObserved,false);
  assert.equal(run(browser,[...rows,{...rows[1]}]).network.attribution,'ambiguous');
});

test('pending hedged probe retains each ordinal and uses primary for legacy endpoint summaries',()=>{
  const offer={attempt:2,verifyingAt:150,checkedAt:125,initialCheckedAt:125};
  const sessions=[{offers:[{attempt:2,offeredAtMs:130,nativeCheckedAt:125}]}];
  const primary={nonce:151,endpoint:'trace',ordinal:1,startWallMs:152,elapsedMs:null,outcome:'pending'};
  const hedge={...primary,ordinal:2,startWallMs:180,elapsedMs:10,outcome:'completed',httpStatus:200};
  const result=pendingProbeAtCutoff(offer,200,{available:true,requests:[primary,hedge]},sessions);
  assert.equal(result.attribution,'unique_interval');assert.equal(result.trace.state,'pending');
  assert.deepEqual(result.requests.map(r=>[r.ordinal,r.state]),[[1,'pending'],[2,'completed']]);
});

test('journal preserves pending/rejected attempts, attributes a checked-out reserve and omits extra fields',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cp-journal-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'offers-0001.json');
  const row={attempt:1,offeredAtMs:100,checkedAt:95,origin:'pool',feedback:'reject',feedbackMs:20,
    reason:'transport',injectedHealthFailures:0,reserveLeaseAgeMs:230,host:'example.invalid'};
  const blank={...row,attempt:2,origin:'discovery',feedback:'pending',reason:null,feedbackMs:null,reserveLeaseAgeMs:null};
  const accepted={...blank,attempt:3,feedback:'confirm',feedbackMs:50,recheckRejection:{atMs:300,checkedAt:280,reason:'timeout'}};
  await fs.writeFile(file,JSON.stringify({version:1,session:1,truncated:false,offers:[row,blank,accepted],
    removals:[{atMs:400,ageMs:3300,stage:'maintenance',reason:'connect'}],
    takes:[{atMs:80,elapsedMs:16,leaseAgesMs:[230,560],result:'selected',rechecks:[{outcome:'passed',reason:null}]}]}));
  const [data]=await readOfferSessions(dir);
  assert.equal(data.offers[0].nativeCheckedAt,95);
  assert.equal(data.offers[0].reserveLeaseAgeMs,230);
  assert.equal(data.takes[0].result,'selected');
  assert.equal(data.offers[1].feedback,'pending');
  assert.deepEqual(data.offers[2].recheckRejection,{atMs:300,activeNativeCheckedAt:280,reason:'timeout'});
  assert.equal(data.removals[0].reason,'connect');
  assert.equal(JSON.stringify(data).includes('example.invalid'),false);
  await fs.writeFile(path.join(dir,'offers-overflow'),'');
  await assert.rejects(readOfferSessions(dir),/OFFER_JOURNAL_LIMIT/);
});

test('worker probe evidence can match even when native generation attribution remains ambiguous',()=>{
  const offer={attempt:1,checkedAt:95,verifyingAt:101};
  const diagnostic={reason:'transport',checkedAt:120,latencyMs:18,endpoint:'trace'};
  const event={offer,diagnostic};
  const net={requests:[{nonce:102,endpoint:'trace',error:'net::ERR_TUNNEL_CONNECTION_FAILED',outcome:'failed'}]};
  const row={attempt:1,offeredAtMs:100,nativeCheckedAt:95,origin:'pool',feedback:'reject',reason:'transport'};
  const session={session:1,offers:[row]};
  const [matched]=browserProofs([event],net,[session]);
  assert.equal(matched.native.origin,'pool');
  assert.equal(matched.network.attribution,'matched');
  assert.equal(browserProofs([event],net,[session,{...session,session:2}])[0].native,null);
  assert.equal(browserProofs([event],net,[{...session,offers:[{...row,nativeCheckedAt:42}]}])[0].native,null);
});

test('an ordinary tab only records the network error or timeout, not the navigation URL',()=>{
  assert.equal(navigationError(Object.assign(Error('Timeout connecting to https://example.invalid'),{name:'TimeoutError'})),'timeout');
  assert.equal(navigationError(Error('page.goto: net::ERR_CONNECTION_CLOSED at https://example.invalid')),'net::ERR_CONNECTION_CLOSED');
});

test('later browser rejection joins the initial attempt across a successful native health refresh',()=>{
  const diagnostic={reason:'transport',checkedAt:230,latencyMs:19};
  const offer={attempt:2,initialCheckedAt:80,checkedAt:200,verifyingAt:210};
  const network={requests:[{nonce:211,endpoint:'target',outcome:'failed',error:'net::ERR_CONNECTION_CLOSED'}]};
  const row={attempt:2,nativeCheckedAt:80,offeredAtMs:81,origin:'discovery',feedback:'confirm',
    recheckRejection:{atMs:231,reason:'transport'}};
  const examine=r=>browserProofs([{offer,diagnostic}],network,[{session:3,offers:[r]}])[0];
  assert.equal(examine(row).native.decision,'recheck');
  assert.equal(examine(row).network.attribution,'matched');
  assert.equal(examine({...row,recheckRejection:null}).native,null);
  assert.equal(examine({...row,recheckRejection:{atMs:225,reason:'transport'}}).native,null);
  assert.equal(examine({...row,nativeCheckedAt:75}).native,null);
});

test('only the first-tab scenario arms a verified active route without a fresh group reserve',()=>{
  const countries=['AT','EE','NO'], now=10000;
  const pool={countries,count:1,expiresAt:now+5001};
  assert.equal(faultTrigger('freshReserve',pool,countries,now).canArm,true);
  for (const insufficient of [undefined,{...pool,count:0},{...pool,expiresAt:now+5000},{...pool,countries:['EE']}]) {
    const normal=faultTrigger('freshReserve',insufficient,countries,now);
    const first=faultTrigger('firstVerifiedTab',insufficient,countries,now);
    assert.equal(normal.canArm,false);
    assert.equal(first.canArm,true);
    assert.deepEqual(first.reserve,normal.reserve);
    assert.equal(first.reserve.ready,false);
  }
  assert.deepEqual(faultTrigger('firstVerifiedTab',{...pool,expiresAt:9000},countries,now).reserve,
    {matchingGroup:true,count:1,present:true,ready:false,remainingMs:0});
});

test('pending probe snapshots just the active offer and both observed control states at the deadline',()=>{
  const offer={attempt:3,verifyingAt:150,checkedAt:125,initialCheckedAt:125};
  const sessions=[{offers:[{attempt:3,offeredAtMs:140,nativeCheckedAt:125}]}];
  const trace={nonce:151,endpoint:'trace',startWallMs:153,elapsedMs:null,outcome:'pending',httpStatus:null,
    url:'https://private.invalid/?key=private',headers:{secret:true}};
  const target={nonce:151,endpoint:'target',startWallMs:154,elapsedMs:40,outcome:'completed',httpStatus:204};
  const net={available:true,requests:[trace,target]};
  const r=pendingProbeAtCutoff(offer,200,net,sessions);
  assert.deepEqual([r.attribution,r.nativeMatches,r.nonceMatches,r.elapsedMs],['unique_interval',1,1,50]);
  assert.deepEqual(r.trace,{state:'pending',httpStatus:null,error:null});
  assert.deepEqual(r.target,{state:'completed',httpStatus:204,error:null});
  assert.equal(JSON.stringify(r).includes('private'),false);
  const unseen=pendingProbeAtCutoff(offer,200,{...net,requests:[trace]},sessions);
  assert.equal(unseen.target.state,'unknown');
  const late=pendingProbeAtCutoff(offer,200,{...net,requests:[trace,{...target,elapsedMs:95,outcome:'cancelled',error:'net::ERR_ABORTED'}]},sessions);
  assert.deepEqual(late.target,{state:'unknown',httpStatus:null,error:null});
});

test('pending probe refuses a previous or ambiguous generation, duplicated control and overlapping nonce',()=>{
  const offer={attempt:2,verifyingAt:150,checkedAt:125,initialCheckedAt:125};
  const sessions=[{offers:[{attempt:2,offeredAtMs:130,nativeCheckedAt:125}]}];
  const row={nonce:151,endpoint:'trace',startWallMs:152,elapsedMs:5,outcome:'failed',error:'net::ERR_CONNECTION_CLOSED'};
  const run=(rows,s=sessions)=>pendingProbeAtCutoff(offer,200,{available:true,requests:rows},s);
  assert.equal(run([row]).trace.error,'net::ERR_CONNECTION_CLOSED');
  for (const r of [run([row],[...sessions,...sessions]),run([row,row]),run([row,{...row,nonce:170}]),
    run([{...row,nonce:100}]),run([row],[{offers:[{attempt:2,offeredAtMs:120,nativeCheckedAt:120}]}])]) {
    assert.equal(r.attribution,'unknown');
    assert.equal(r.trace.state,'unknown');
    assert.equal(r.target.state,'unknown');
  }
  assert.equal(pendingProbeAtCutoff(null,200,{available:true,requests:[row]},sessions),null);
});

test('public journal preserves exact production reserve cause, independently of neighboring failures',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cp-removals-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const a={id:1,reserveId:'a'.repeat(32),atMs:1000,ageMs:32000,stage:'maintenance',
    reason:'checkFailed',check:{reason:'http',endpoint:'target',status:'503',latencyMs:10,body:'PRIVATE'}};
  const b={id:2,reserveId:'b'.repeat(32),atMs:1001,ageMs:33000,stage:'promotion',
    reason:'checkFailed',check:{reason:'tls',endpoint:'trace',code:60,host:'PRIVATE'}};
  const file=path.join(dir,'offers-0001.json');
  const save=rows=>fs.writeFile(file,JSON.stringify({version:1,session:1,truncated:false,offers:[],takes:[],removals:rows}));
  await save([a,b]);
  const [data]=await readOfferSessions(dir);
  assert.equal(data.removals[0].check.status,503);
  assert.equal(data.removals[0].check.endpoint,'target');
  assert.equal(data.removals[1].check.code,60);
  assert.equal(data.removals[1].reserveId,b.reserveId);
  assert.ok(!JSON.stringify(data).includes('PRIVATE'));
  await save([a,a]);
  await assert.rejects(readOfferSessions(dir),/INVALID_RESERVE_REMOVAL/);
  await save([{...a,reserveId:'PRIVATE'}]);
  await assert.rejects(readOfferSessions(dir),/INVALID_RESERVE_REMOVAL/);
});


// Natural recovery must not be mistaken for the original fresh-pool claim.
const recoveryModule=await import('./autonomous-recovery.mjs');
const recoveryFixture=()=>({
  anchor:{session:1,generation:'g',attempt:2,host:'old',ip:'old-exit'},
  sessions:[{session:1,truncated:false,lifecycle:{running:true},exclusions:[{attempt:2,atMs:1000}],
    offers:[{attempt:2,feedback:'confirm',offeredAtMs:500},
      {attempt:3,feedback:'confirm',origin:'discovery',nativeCheckedAt:1100}]}],
  status:{id:'g',attempt:3,phase:'connected',proxy:{host:'new',country:'EE',exitIp:'new-exit'},
    browser:{ok:true,country:'EE',exitIp:'new-exit'}}});
test('autonomous recovery requires a withdrawn anchor and a fresh confirmed independent route',()=>{
  const f=recoveryFixture();assert.equal(recoveryModule.withdrawalBoundary(f.sessions,f.anchor),1000);
  assert.equal(recoveryModule.autonomousCandidate(f.status,f.anchor,f.sessions,['NO','EE','AT'],1000).state,'candidate');
  f.sessions[0].offers[1].origin='pool';
  assert.equal(recoveryModule.autonomousCandidate(f.status,f.anchor,f.sessions,['NO','EE','AT'],1000).state,'candidate');
  f.sessions[0].exclusions=[];assert.equal(recoveryModule.withdrawalBoundary(f.sessions,f.anchor),null);
});
test('autonomous evidence rejects reused, stale, unconfirmed or changed-generation routes',()=>{
  for(const [change,expected] of [
    [f=>f.status.proxy.host='old','waiting'],[f=>{f.status.browser.exitIp=f.status.proxy.exitIp='old-exit';},'waiting'],
    [f=>f.sessions[0].offers[1].nativeCheckedAt=999,'inconclusive'],
    [f=>f.sessions[0].offers[1].feedback='pending','waiting'],
    [f=>f.status.id='other','inconclusive'],[f=>f.sessions[0].session=2,'inconclusive'],
    [f=>f.sessions[0].truncated=true,'inconclusive'],
    [f=>{f.status.proxy.country=f.status.browser.country='DE';},'fail'],
    [f=>f.status.browser.exitIp='unexpected','fail'],[f=>f.status.phase='checking','waiting']]){
    const f=recoveryFixture();change(f);
    assert.equal(recoveryModule.autonomousCandidate(f.status,f.anchor,f.sessions,['AT','EE','NO'],1000).state,expected);
  }
});


test('actual autonomous observation waits through withdrawal and needs an ordinary HTTPS proof',async()=>{
  const f=recoveryFixture();let now=1000,reads=0,traceCalls=0;
  const result=await recoveryModule.observeAutonomousRecovery({anchor:f.anchor,initial:{host:'initial',ip:'initial-exit'},
    initialAttempt:1,countries:['NO','AT','EE'],withdrawnAtMs:1000,deadline:2000,
    observe:async()=>({status:++reads===1?{id:'g',phase:'checking'}:f.status}),journal:async()=>f.sessions,
    trace:async()=>{traceCalls++;return {attempt:3,generation:'g',host:'new',ip:'new-exit',country:'EE',scheme:'socks4',completedAtMs:now};},
    effectiveRoute:async()=>true,events:async()=>({}),pause:async ms=>{now+=ms;},now:()=>now});
  assert.equal(result.result,'PASS');assert.equal(result.origin,'discovery');assert.equal(traceCalls,1);
  assert.equal(result.withdrawalToTabMs,450);assert.equal('host' in result,false);
});
test('actual autonomous observation refuses initial exclusion bypass, bad route, cap and stale evidence',async()=>{
  const base=()=>{const f=recoveryFixture();let now=1000;return {f,config:{anchor:f.anchor,initial:{host:'initial',ip:'initial-exit'},
    initialAttempt:1,countries:['AT','EE','NO'],withdrawnAtMs:1000,deadline:1500,
    observe:async()=>({status:f.status}),journal:async()=>f.sessions,
    trace:async()=>({attempt:3,generation:'g',host:f.status.proxy.host,ip:f.status.browser.exitIp,country:'EE',scheme:'socks4',completedAtMs:now}),
    effectiveRoute:async()=>true,events:async()=>({}),pause:async ms=>{now+=ms;},now:()=>now}};};
  let x=base();x.f.status.proxy.host='initial';x.f.sessions[0].exclusions.push({attempt:1,atMs:500,untilMs:1200});
  await assert.rejects(recoveryModule.observeAutonomousRecovery(x.config),/INITIAL_ROUTE_REUSED/);
  x.f.sessions[0].offers[1].nativeCheckedAt=1201;
  assert.equal((await recoveryModule.observeAutonomousRecovery(x.config)).result,'PASS');
  x=base();x.config.effectiveRoute=async()=>false;
  assert.equal((await recoveryModule.observeAutonomousRecovery(x.config)).result,'INCONCLUSIVE');
  x=base();x.config.trace=async()=>null;
  assert.equal((await recoveryModule.observeAutonomousRecovery(x.config)).result,'INCONCLUSIVE');
  x=base();x.config.events=async()=>({unexpectedRoute:true});
  await assert.rejects(recoveryModule.observeAutonomousRecovery(x.config),/UNEXPECTED_ROUTE/);
  x=base();x.config.observe=async()=>{throw Error('PHYSICAL_CHECK_BUDGET_REACHED');};
  await assert.rejects(recoveryModule.observeAutonomousRecovery(x.config),/PHYSICAL_CHECK_BUDGET/);
  x=base();x.f.sessions[0].offers[1].nativeCheckedAt=900;
  assert.equal((await recoveryModule.observeAutonomousRecovery(x.config)).reason,'NO_FRESH_NATIVE_OFFER');
});
test('cleanup or incomplete evidence supersedes an observed autonomous success',()=>{
  const pass={result:'PASS',ordinaryHttps:true};
  assert.equal(recoveryModule.finalizeAutonomousRecovery(pass,{failed:true}).result,'FAIL');
  assert.equal(recoveryModule.finalizeAutonomousRecovery(pass,{incomplete:true}).result,'INCONCLUSIVE');
  assert.equal(recoveryModule.finalizeAutonomousRecovery(pass,{}).result,'PASS');
});
