import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readRefillData,boundOffer,postReplacementAdmission,postReplacementAdmissions,stageFaults,sameRefillRoute,repeatedRefillOutcome,readPublicProbes,publicProbeCoverage,readPublicAttribution} from './refill-evidence.mjs';

test('missing records and write errors cannot count as complete public probe coverage',()=>{
  assert.deepEqual(publicProbeCoverage([{number:1},{number:2}],2),{complete:true,writeError:false,result:'PASS'});
  assert.equal(publicProbeCoverage([{number:1},{number:3}],3).result,'INCONCLUSIVE');
  assert.equal(publicProbeCoverage([{number:1},{number:3}],2).result,'INCONCLUSIVE');
  assert.equal(publicProbeCoverage([{number:1}],1,true).result,'FAIL');
});

test('physical public journal validates filename identity and removes foreign fields',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cp-probe-reader-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'native-probe-0001.json');
  const row={number:1,scheme:'socks4',slow:true,outcome:'failed',reason:'tls',nativeProbe:null};
  await fs.writeFile(file,JSON.stringify({...row,host:'PRIVATE'}));
  assert.deepEqual(await readPublicProbes(dir),[row]);
  await fs.writeFile(file,JSON.stringify({...row,number:2}));
  await assert.rejects(readPublicProbes(dir),/INVALID_PUBLIC_PROBE/);
  await fs.writeFile(file,'x'.repeat(16385));
  await assert.rejects(readPublicProbes(dir),/PUBLIC_PROBE_LIMIT/);
});
test('bounded public attribution keeps exact roles and opaque IDs while rejecting malformed provenance',()=>{
  const owner={role:'speculative',purpose:'refill',offerAttempt:2,refillRoundId:3,searchRoundId:4,
    maintenanceId:null,activeEndpointId:1,activeExitId:1};
  const raw={session:1,endpointId:2,hostId:2,exitId:null,laneRole:'speculative',firstOwner:owner,
    logicalCallers:[owner],coalesced:false,limited:false,sources:[{group:'GeoNode',country:'AT'}],sourceMode:'terminal_group_union'};
  assert.deepEqual(readPublicAttribution(raw),raw);
  const privateValues={...raw,host:'PRIVATE',firstOwner:{...owner,rawUrl:'PRIVATE'},sources:[{group:'GeoNode',country:'AT',url:'PRIVATE'}]};
  assert.ok(!JSON.stringify(readPublicAttribution(privateValues)).includes('PRIVATE'));
  for(const changed of [{session:0},{endpointId:513},{hostId:true},{laneRole:'PRIVATE'},
    {logicalCallers:[]},{logicalCallers:[owner,owner]},
    {firstOwner:{...owner,purpose:'health'}},{sources:[{group:'PRIVATE',country:'AT'}]},
    {sources:[{group:'GeoNode',country:'AT'},{group:'GeoNode',country:'AT'}]},
    {sourceMode:'unknown'},{limited:'false'}])assert.throws(()=>readPublicAttribution({...raw,...changed}));
  assert.throws(()=>readPublicAttribution({...raw,logicalCallers:Array(9).fill(owner),coalesced:true}));
});

test('any qualifying new admission can win; old/discovery/reused routes stay inconclusive',()=>{
  const stages=[1,2].map(number=>({number,session:1,attempt:number,result:'PASS',
    faults:[1,2].map(()=>({stage:number,attempt:number,admissionCount:4})),
    replacement:{attempt:number+1,origin:'pool',ordinaryHttps:true,differentHost:true,differentExit:true,
      reusedInitialHost:false,reusedInitialExit:false}}));
  const admissions=[3,4].map(id=>({id,attempt:2,confirmedAttemptAtAdmission:2,firstHostAdmissionId:id,firstExitAdmissionId:id}));
  const bound={session:1,offer:{attempt:3,origin:'pool',refillAdmissionId:4}};
  assert.deepEqual(repeatedRefillOutcome(stages,admissions,bound),
    {result:'PASS',repeatedReplacements:true,twoPoolReplacements:true,usedOnSecondReplacement:true});
  for(const alternative of [{...bound,session:2},{...bound,offer:{origin:'discovery',refillAdmissionId:3}},
    {...bound,offer:{...bound.offer,refillAdmissionId:2}}]){
    assert.deepEqual(repeatedRefillOutcome(stages,admissions,alternative),
      {result:'INCONCLUSIVE',repeatedReplacements:true,twoPoolReplacements:true,usedOnSecondReplacement:false});
  }
  for(const changed of [{firstHostAdmissionId:1},{firstExitAdmissionId:1},{confirmedAttemptAtAdmission:1},{attempt:3}])
    assert.equal(repeatedRefillOutcome(stages,[{...admissions[1],...changed}],bound).result,'INCONCLUSIVE');
  assert.equal(repeatedRefillOutcome(stages,{id:4},bound).result,'INCONCLUSIVE'); // Legacy identity has no newness proof.
  assert.equal(repeatedRefillOutcome(stages,[{id:4,attempt:2}],bound).result,'INCONCLUSIVE');
  assert.equal(repeatedRefillOutcome(stages.slice(0,1),admissions,bound).result,'INCONCLUSIVE');
  stages[1].replacement.reusedInitialHost=true;
  assert.equal(repeatedRefillOutcome(stages,admissions,bound).usedOnSecondReplacement,false);
  stages[1].replacement.reusedInitialHost=false;
  stages[1].replacement.reusedInitialExit=true;
  assert.equal(repeatedRefillOutcome(stages,admissions,bound).usedOnSecondReplacement,false);
  stages[1].replacement.reusedInitialExit=false;
  stages[1].faults[1].admissionCount=3;
  assert.equal(repeatedRefillOutcome(stages,admissions,bound).usedOnSecondReplacement,false);
  stages[1].faults[1].admissionCount=4;stages[1].faults[1].attempt=1;
  assert.equal(repeatedRefillOutcome(stages,admissions,bound).usedOnSecondReplacement,false);
  stages[1].faults[1].attempt=2;stages[1].faults[1].stage=1;
  assert.equal(repeatedRefillOutcome(stages,admissions,bound).usedOnSecondReplacement,false);
  stages[1].faults[1].stage=2;stages[0].replacement.origin='discovery';
  assert.equal(repeatedRefillOutcome(stages,admissions,bound).twoPoolReplacements,false);
  assert.equal(repeatedRefillOutcome(stages,admissions,bound).result,'INCONCLUSIVE');
  stages[1].replacement.ordinaryHttps=false;
  assert.equal(repeatedRefillOutcome(stages,admissions,bound).repeatedReplacements,false);
});

function data(){return {version:1,refillVersion:1,session:1,truncated:false,
  lifecycle:{running:true,startedAtMs:100,stoppedAtMs:null},offers:[{attempt:2,offeredAtMs:110,checkedAt:109,
    origin:'pool',feedback:'confirm',feedbackMs:10,injectedHealthFailures:0}],
  admissions:[{id:1,atMs:150,attempt:2,nativeCheckedAt:149,country:'NO',eligibleAtAdmission:true}],
  liveAdmissions:[1],faults:[],exclusions:[],refillRounds:[]};}
function currentData(){const raw=data();Object.assign(raw.admissions[0],{firstHostAdmissionId:1,firstExitAdmissionId:1,confirmedAttemptAtAdmission:2});return raw;}
const pool={countries:['AT','EE','NO'],count:1,expiresAt:10000};
test('maintenance projection keeps only bound attempts and distinguishes renewal from failure',()=>{
  const raw=data();
  const probe={version:1,startedAtMs:160,elapsedMs:3,queueWaitMs:0,joinedEarlier:false,limited:false,
    host:'PRIVATE',controls:[{endpoint:'trace',ordinal:1,startMs:0,endMs:1,outcome:'failed',curlCode:97,
      httpStatus:0,connectStatus:0,timingMs:null,url:'PRIVATE'}]};
  raw.maintenance=[{id:1,admissionId:1,attempt:2,atMs:160,elapsedMs:4,outcome:'completed',renewed:false,
    nativeCheckedAt:null,ok:false,check:{reason:'connect',endpoint:'trace',code:97},nativeProbe:probe,host:'PRIVATE'}];
  const [m]=readRefillData(raw,1).maintenance;
  assert.equal(m.admissionId,1);assert.equal(m.nativeProbe.controls[0].curlCode,97);
  assert.ok(!JSON.stringify(m).includes('PRIVATE'));
  raw.maintenance[0].renewed=true;assert.throws(()=>readRefillData(raw,1));
  raw.maintenance[0]={...raw.maintenance[0],ok:true,nativeCheckedAt:163};
  assert.equal(readRefillData(raw,1).maintenance[0].renewed,true);
  // Accept is observable before the refresh wrapper returns. A coalesced
  // verification can also belong to another caller, leaving its probe unknown.
  raw.maintenance[0]={...raw.maintenance[0],ok:null,outcome:'pending',nativeProbe:null};
  assert.equal(readRefillData(raw,1).maintenance[0].renewed,true);
  raw.maintenance[0].admissionId=99;assert.throws(()=>readRefillData(raw,1));
});
test('fresh admission requires post-confirmation completion and a currently live lease',()=>{
  const raw=currentData(),s=readRefillData(raw,1),bound=boundOffer([s],2);
  assert.equal(postReplacementAdmission([s],bound,120,pool,pool.countries,200).id,1);
  // Native confirmation ordering survives wall-clock movement.
  assert.equal(postReplacementAdmission([s],bound,150,pool,pool.countries,200).id,1);
  s.liveAdmissions=[];assert.equal(postReplacementAdmission([s],bound,120,pool,pool.countries,200),null);
  assert.equal(postReplacementAdmissions([s],bound,120,null,pool.countries,200,false).length,1);
  const legacy=readRefillData(data(),1);
  assert.equal(postReplacementAdmission([legacy],bound,120,pool,pool.countries,200),null);
});
test('expired pool, retained earlier entry, wrong attempt and session ambiguity do not arm fault2',()=>{
  const s=readRefillData(currentData(),1),bound=boundOffer([s],2);
  assert.equal(postReplacementAdmission([s],bound,120,{...pool,expiresAt:300},pool.countries,200),null);
  s.admissions[0].attempt=1;assert.equal(postReplacementAdmission([s],bound,120,pool,pool.countries,200),null);
  assert.equal(boundOffer([s,{...s,session:2}],2),null);
  s.truncated=true;assert.equal(boundOffer([s],2),null);
});
test('new identity fields reject forward/invalid references while legacy remains readable',()=>{
  for(const change of [{firstHostAdmissionId:2},{firstExitAdmissionId:-1},{confirmedAttemptAtAdmission:3},
    {confirmedAttemptAtAdmission:1},{firstHostAdmissionId:true}]){
    const raw=currentData();Object.assign(raw.admissions[0],change);assert.throws(()=>readRefillData(raw,1));
  }
  const partial=data();partial.admissions[0].firstHostAdmissionId=1;assert.throws(()=>readRefillData(partial,1));
  const linked=currentData();linked.admissions.push({...linked.admissions[0],id:2,firstHostAdmissionId:1,firstExitAdmissionId:2});
  assert.equal(readRefillData(linked,1).admissions[1].firstHostAdmissionId,1);
  linked.admissions[0].firstHostAdmissionId=0;assert.throws(()=>readRefillData(linked,1));
  const future=currentData();future.offers[0].refillAdmissionId=2;assert.throws(()=>readRefillData(future,1));
  const badFault=currentData();badFault.faults=[{stage:2,attempt:2,atMs:200,admissionCount:2}];assert.throws(()=>readRefillData(badFault,1));
  assert.equal(readRefillData(data(),1).admissions[0].firstHostAdmissionId,undefined);
});
test('arming selects any currently live new address, without pinning country or first admission',()=>{
  const raw=currentData();
  raw.admissions.push({...raw.admissions[0],id:2,firstHostAdmissionId:1,firstExitAdmissionId:2,country:'EE'});
  raw.admissions.push({...raw.admissions[0],id:3,firstHostAdmissionId:3,firstExitAdmissionId:3,country:'NO'});
  raw.admissions.push({id:4,atMs:170,attempt:2,nativeCheckedAt:169,country:'AT',eligibleAtAdmission:true});
  raw.liveAdmissions=[2,3];
  const session=readRefillData(raw,1),bound=boundOffer([session],2);
  assert.deepEqual(postReplacementAdmissions([session],bound,120,pool,pool.countries,200).map(a=>a.id),[3]);
  session.liveAdmissions=[1,3];
  const reversed=[...pool.countries].reverse();
  assert.deepEqual(postReplacementAdmissions([session],bound,120,{...pool,countries:reversed},reversed,200).map(a=>a.id),[1,3]);
  session.truncated=true;assert.deepEqual(postReplacementAdmissions([session],bound,120,pool,pool.countries,200),[]);
});
test('stage faults cannot be borrowed from a prior session, offer or window',()=>{
  const raw=data();raw.faults=[{stage:1,attempt:2,atMs:160},{stage:2,attempt:2,atMs:140},{stage:2,attempt:2,atMs:160},{stage:2,attempt:3,atMs:170}];
  const s=readRefillData(raw,1),stage={number:2,session:1,attempt:2,armedAtMs:150};
  assert.deepEqual(stageFaults([s,{...s,session:2}],stage),[{stage:2,attempt:2,atMs:160}]);
});
test('projection omits endpoint data and rejects broken lifecycle and live IDs',()=>{
  const raw=data();raw.host='PRIVATE';raw.admissions[0].exitIp='PRIVATE';
  assert.ok(!JSON.stringify(readRefillData(raw,1)).includes('PRIVATE'));
  assert.throws(()=>readRefillData({...raw,liveAdmissions:[9]},1));
  assert.throws(()=>readRefillData({...raw,lifecycle:{running:'yes'}},1));
});
test('same-offer health and browser rechecks preserve refill observation, replacement does not',()=>{
  const expected={key:'http://192.0.2.1:80',attempt:2,generation:'session-a',session:1};
  const sessions=[readRefillData(data(),1)];
  const status={phase:'verifying',proxy:{scheme:'http',host:'192.0.2.1',port:80},attempt:2,id:'session-a'};
  for(const phase of ['verifying','confirming','connected'])assert.ok(sameRefillRoute({...status,phase},expected,sessions));
  assert.ok(!sameRefillRoute({...status,phase:'replacing'},expected,sessions));
  assert.ok(!sameRefillRoute({...status,id:'session-b'},expected,sessions));
  assert.ok(!sameRefillRoute({...status,attempt:3},expected,sessions));
  assert.ok(!sameRefillRoute(status,expected,[{...sessions[0],session:2}]));
  assert.ok(!sameRefillRoute(status,expected,[]));
});
