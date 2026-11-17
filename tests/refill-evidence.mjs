// Explicit, bounded projections for the two-replacement public QA scenario.
import fs from 'node:fs/promises';
import path from 'node:path';
import {faultTrigger,readNativeProbe} from './failover-evidence.mjs';

const integer = x => Number.isSafeInteger(x) && x >= 0;
const nullable = x => x === null || integer(x);
const attributionRoles=new Set(['health','reserve','speculative','foreground','unknown']);
const attributionPurposes=new Set(['health','refill','maintenance','promotion','discovery','unknown']);
const attributionSources=new Set(['proxy-scraper','hproxy','Proxifly','ProxyScrape','GeoNode','Litport','ProxMint','Databay','injected']);
const opaqueId=value=>integer(value)&&value>=1&&value<=512;
function readIdentity(value){
  const names=['endpointId','hostId','exitId'];if(!names.some(name=>value[name]!==undefined))return {};
  if(!names.every(name=>value[name]===null||opaqueId(value[name])))throw Error('INVALID_PUBLIC_ATTRIBUTION');
  return Object.fromEntries(names.map(name=>[name,value[name]]));
}
function readOwner(value){
  if(!value||!attributionRoles.has(value.role)||!attributionPurposes.has(value.purpose))throw Error('INVALID_PUBLIC_ATTRIBUTION');
  const out={role:value.role,purpose:value.purpose};
  for(const name of ['offerAttempt','refillRoundId','searchRoundId','maintenanceId','activeEndpointId','activeExitId']){
    const field=value[name];if(field!==null&&!(name==='offerAttempt'&&field===0)&&!opaqueId(field))throw Error('INVALID_PUBLIC_ATTRIBUTION');out[name]=field;
  }return out;
}
export function readPublicAttribution(value){
  if(!value||!integer(value.session)||value.session<1||value.session>64||!attributionRoles.has(value.laneRole)||typeof value.limited!=='boolean')throw Error('INVALID_PUBLIC_ATTRIBUTION');
  const identity=readIdentity(value);if(Object.keys(identity).length!==3)throw Error('INVALID_PUBLIC_ATTRIBUTION');
  if(!Array.isArray(value.logicalCallers)||value.logicalCallers.length<1||value.logicalCallers.length>8||value.coalesced!==(value.logicalCallers.length>1))throw Error('INVALID_PUBLIC_ATTRIBUTION');
  const firstOwner=readOwner(value.firstOwner),logicalCallers=value.logicalCallers.map(readOwner);
  if(!logicalCallers.some(owner=>JSON.stringify(owner)===JSON.stringify(firstOwner)))throw Error('INVALID_PUBLIC_ATTRIBUTION');
  if(!['unknown','terminal_group_union'].includes(value.sourceMode)||!Array.isArray(value.sources)||value.sources.length>32)throw Error('INVALID_PUBLIC_ATTRIBUTION');
  const sources=value.sources.map(source=>{if(!source||!attributionSources.has(source.group)||!(/^[A-Z]{2}$/).test(source.country))throw Error('INVALID_PUBLIC_ATTRIBUTION');return {group:source.group,country:source.country};});
  if(new Set(sources.map(source=>source.group+'/'+source.country)).size!==sources.length)throw Error('INVALID_PUBLIC_ATTRIBUTION');
  if(Boolean(sources.length)!==(value.sourceMode==='terminal_group_union'))throw Error('INVALID_PUBLIC_ATTRIBUTION');
  return {session:value.session,...identity,laneRole:value.laneRole,firstOwner,logicalCallers,coalesced:value.coalesced,limited:value.limited,sources,sourceMode:value.sourceMode};
}

// Two working replacements and consumption of the observed fresh refill are
// separate claims. A replacement from discovery does not prove the latter.
export function repeatedRefillOutcome(stages, admissions, replacement) {
  const repeatedReplacements=Array.isArray(stages)&&stages.length===2&&stages.every((s,i)=>
    s?.number===i+1&&s.result==='PASS'&&s.replacement?.ordinaryHttps===true&&
    s.replacement.differentHost===true&&s.replacement.differentExit===true);
  const twoPoolReplacements=repeatedReplacements&&stages.every(s=>s.replacement.origin==='pool');
  const stage=stages?.[1],addressed=stage?.faults?.length>=2&&stage.faults.slice(0,2).every(f=>f.stage===2&&f.attempt===stage.attempt);
  const cutoff=addressed?stage.faults[1].admissionCount:null;
  const candidates=Array.isArray(admissions)?admissions:[];
  const consumed=candidates.find(a=>a.id===replacement?.offer?.refillAdmissionId);
  const usedOnSecondReplacement=Boolean(repeatedReplacements&&replacement?.offer?.origin==='pool'&&
    replacement.session===stage.session&&replacement.offer.attempt===stage.replacement.attempt&&
    integer(cutoff)&&consumed&&consumed.id<=cutoff&&newPostReplacementAdmission(consumed,stage.attempt)&&
    stage.replacement.reusedInitialHost===false&&stage.replacement.reusedInitialExit===false);
  return {repeatedReplacements,twoPoolReplacements,usedOnSecondReplacement,
    result:twoPoolReplacements&&usedOnSecondReplacement?'PASS':'INCONCLUSIVE'};
}

function newPostReplacementAdmission(a,attempt){return integer(a?.id)&&a.id>0&&a.attempt===attempt&&
  a.confirmedAttemptAtAdmission===attempt&&a.firstHostAdmissionId===a.id&&a.firstExitAdmissionId===a.id;}

export async function readPublicProbes(directory){
  const files=(await fs.readdir(directory)).filter(n=>/^native-probe-\d{4}\.json$/.test(n)).sort();
  if(files.length>360)throw Error('PUBLIC_PROBE_LIMIT');
  return Promise.all(files.map(async name=>{
    const file=path.join(directory,name);
    if((await fs.stat(file)).size>16384)throw Error('PUBLIC_PROBE_LIMIT');
    const d=JSON.parse(await fs.readFile(file,'utf8'));
    if(d.number!==Number(name.slice(13,17))||!integer(d.number)||d.number<1||d.number>360||
      !['http','https','socks4','socks5'].includes(d.scheme)||typeof d.slow!=='boolean'||
      !['passed','failed','cancelled','error'].includes(d.outcome)||
      !(d.reason===null||reasons.has(d.reason)))throw Error('INVALID_PUBLIC_PROBE');
    const out={number:d.number,scheme:d.scheme,slow:d.slow,outcome:d.outcome,reason:d.reason,
      nativeProbe:d.nativeProbe===null?null:readNativeProbe(d.nativeProbe)};
    if(d.attribution!==undefined)out.attribution=readPublicAttribution(d.attribution);
    return out;
  }));
}

export function publicProbeCoverage(probes, started, writeError=false){
  const complete=integer(started)&&started<=360&&Array.isArray(probes)&&probes.length===started&&
    probes.every((r,i)=>r.number===i+1);
  return {complete,writeError:Boolean(writeError),result:writeError?'FAIL':complete?'PASS':'INCONCLUSIVE'};
}
const names = new Set(['rounds','roundsWithSourceWarnings','roundsWithoutChecks','checked','cancelled',
  'qualified','qualifiedUnique','checkFailed','added','unused','quarantined','alreadyReserved',
  'sameHost','sameExit','outsideGroup','stale','full','expired','removed',
  'admissions','checks','fast','slow','peak_checks','country_starts','dropped']);
const reasons = new Set(['connect','tls','transport','timeout','http','country','invalid_trace','unavailable','internal','unknown']);
function fail(){throw Error('INVALID_REFILL_JOURNAL');}
function counts(value){
  if (!value || typeof value!=='object' || Array.isArray(value)) fail();
  return Object.fromEntries(Object.entries(value).filter(([k,v])=>names.has(k)&&integer(v)&&v<=1000000));
}
function rows(value, limit=512){if(!Array.isArray(value)||value.length>limit)fail();return value;}
function detail(value){
  if(!value||!reasons.has(value.reason))fail();
  const out={reason:value.reason};
  if(['trace','target'].includes(value.endpoint))out.endpoint=value.endpoint;
  if(integer(value.code)&&value.code<=255)out.code=value.code;
  if(integer(value.status)&&value.status>=100&&value.status<=599)out.status=value.status;
  if(typeof value.latencyMs==='number'&&Number.isFinite(value.latencyMs)&&value.latencyMs>=0&&value.latencyMs<=86400000)out.latencyMs=value.latencyMs;
  return out;
}

export function readRefillData(data, number){
  if(!data||data.version!==1||data.refillVersion!==1||data.session!==number||!integer(number)||number<1||number>64
    ||typeof data.truncated!=='boolean')fail();
  const life=data.lifecycle;
  if(!life||typeof life.running!=='boolean'||!nullable(life.startedAtMs)||!nullable(life.stoppedAtMs))fail();
  const offers=rows(data.offers).map(o=>{
    if(!integer(o.attempt)||o.attempt<1||!integer(o.offeredAtMs)||!nullable(o.checkedAt)
      ||!['pool','discovery','unknown'].includes(o.origin)||!['pending','confirm','reject'].includes(o.feedback)
      ||!nullable(o.feedbackMs)||!integer(o.injectedHealthFailures)
      ||(o.refillAdmissionId!==undefined&&(!integer(o.refillAdmissionId)||o.refillAdmissionId<1)))fail();
    return {...readIdentity(o),attempt:o.attempt,offeredAtMs:o.offeredAtMs,nativeCheckedAt:o.checkedAt,origin:o.origin,
      feedback:o.feedback,feedbackMs:o.feedbackMs,injectedHealthFailures:o.injectedHealthFailures,
      refillAdmissionId:o.refillAdmissionId??null};
  });
  const admissions=rows(data.admissions).map((r,index)=>{
    if(r.id!==index+1||!integer(r.atMs)||!integer(r.attempt)||!integer(r.nativeCheckedAt)
      ||!(/^[A-Z]{2}$/).test(r.country)||r.eligibleAtAdmission!==true)fail();
    const out={...readIdentity(r),id:r.id,atMs:r.atMs,attempt:r.attempt,nativeCheckedAt:r.nativeCheckedAt,country:r.country,eligibleAtAdmission:true};
    const fields=['firstHostAdmissionId','firstExitAdmissionId','confirmedAttemptAtAdmission'];
    if(fields.some(name=>r[name]!==undefined)){
      if(!fields.every(name=>r[name]===null||integer(r[name]))||
        fields.slice(0,2).some(name=>r[name]!==null&&r[name]>r.id)||
        r.confirmedAttemptAtAdmission===null||r.confirmedAttemptAtAdmission>r.attempt)fail();
      for(const name of fields)out[name]=r[name];
    }
    return out;
  });
  for(const a of admissions)for(const name of ['firstHostAdmissionId','firstExitAdmissionId']){
    const first=a[name];if(integer(first)&&first>0&&admissions[first-1]?.[name]!==first)fail();
  }
  for(const a of admissions)if(a.confirmedAttemptAtAdmission>0&&
    !offers.some(o=>o.attempt===a.confirmedAttemptAtAdmission&&o.feedback==='confirm'))fail();
  for(const offer of offers)if(offer.refillAdmissionId!==null){
    const admitted=admissions.find(a=>a.id===offer.refillAdmissionId);
    if(!admitted||admitted.attempt>=offer.attempt)fail();
  }
  const liveAdmissions=rows(data.liveAdmissions,2);
  if(!liveAdmissions.every(id=>integer(id)&&admissions.some(r=>r.id===id))||new Set(liveAdmissions).size!==liveAdmissions.length)fail();
  const faults=rows(data.faults).map(r=>{
    if(![1,2].includes(r.stage)||!integer(r.attempt)||r.attempt<1||!integer(r.atMs))fail();
    const out={stage:r.stage,attempt:r.attempt,atMs:r.atMs};
    if(r.admissionCount!==undefined){if(!integer(r.admissionCount)||r.admissionCount>admissions.length)fail();out.admissionCount=r.admissionCount;}
    return out;
  });
  const exclusions=rows(data.exclusions).map(r=>{
    if(!integer(r.attempt)||!integer(r.atMs)||!integer(r.untilMs)||r.untilMs<r.atMs)fail();
    return {attempt:r.attempt,atMs:r.atMs,untilMs:r.untilMs};
  });
  const refillRounds=rows(data.refillRounds).map((r,index)=>{
    if(r.id!==index+1||!integer(r.startedAtMs)||!integer(r.attempt)||!nullable(r.elapsedMs)
      ||!integer(r.checks)||!['pending','completed','cancelled','error'].includes(r.outcome))fail();
    return {id:r.id,startedAtMs:r.startedAtMs,attempt:r.attempt,outcome:r.outcome,elapsedMs:r.elapsedMs,checks:r.checks,
      counts:counts(r.counts),scheduler:counts(r.scheduler),failures:rows(r.failures,32).map(f=>{
        if(!integer(f.count)||f.count<1)fail();return {check:detail(f.check),count:f.count};
      })};
  });
  const maintenance=rows(data.maintenance??[]).map((r,index)=>{
    if(r.id!==index+1||!integer(r.attempt)||!integer(r.atMs)||!nullable(r.elapsedMs)
      ||!nullable(r.admissionId)||(r.admissionId!==null&&!admissions.some(a=>a.id===r.admissionId))
      ||!['pending','completed','cancelled','error'].includes(r.outcome)||typeof r.renewed!=='boolean'
      ||!nullable(r.nativeCheckedAt)||!(r.ok===null||typeof r.ok==='boolean')
      ||(r.renewed&&(r.nativeCheckedAt===null||r.ok===false)))fail();
    return {...readIdentity(r),id:r.id,admissionId:r.admissionId,attempt:r.attempt,atMs:r.atMs,elapsedMs:r.elapsedMs,
      outcome:r.outcome,renewed:r.renewed,nativeCheckedAt:r.nativeCheckedAt,ok:r.ok,
      check:r.check===null?null:detail(r.check),nativeProbe:r.nativeProbe===null?null:readNativeProbe(r.nativeProbe)};
  });
  return {session:number,truncated:data.truncated,lifecycle:{running:life.running,startedAtMs:life.startedAtMs,stoppedAtMs:life.stoppedAtMs},
    offers,admissions,liveAdmissions:[...liveAdmissions],faults,exclusions,refillRounds,maintenance};
}

export async function readRefillSessions(directory){
  const files=(await fs.readdir(directory)).filter(name=>/^offers-\d{4}\.json$/.test(name)).sort();
  if(files.length>64)fail();
  return Promise.all(files.map(async name=>readRefillData(JSON.parse(await fs.readFile(path.join(directory,name))),Number(name.slice(7,11)))));
}

export function boundOffer(sessions, attempt){
  if(sessions.some(s=>s.truncated))return null;
  const matches=sessions.filter(s=>s.lifecycle.running).flatMap(s=>s.offers.filter(o=>o.attempt===attempt&&o.feedback==='confirm')
    .map(offer=>({session:s.session,offer})));
  return matches.length===1?matches[0]:null;
}

export function postReplacementAdmission(sessions, bound, after, pool, countries, now=Date.now()){
  return postReplacementAdmissions(sessions,bound,after,pool,countries,now)[0]??null;
}

export function postReplacementAdmissions(sessions,bound,after,pool,countries,now=Date.now(),liveOnly=true){
  if(!bound||(liveOnly&&!faultTrigger('freshReserve',pool,countries,now).canArm))return [];
  const session=sessions.find(s=>s.session===bound.session&&s.lifecycle.running&&!s.truncated);
  if(!session||bound.offer.feedback!=='confirm')return [];
  // Native confirmed-at-admission ordering is authoritative; wall timestamps
  // remain chronology only. Legacy records lack proof and never qualify.
  return session.admissions.filter(a=>newPostReplacementAdmission(a,bound.offer.attempt)
    &&countries.includes(a.country)&&(!liveOnly||session.liveAdmissions.includes(a.id)));
}

export function stageFaults(sessions, stage){
  return sessions.filter(s=>s.session===stage.session).flatMap(s=>s.faults.filter(f=>f.stage===stage.number&&f.attempt===stage.attempt&&f.atMs>=stage.armedAtMs));
}

export function sameRefillRoute(status, expected, sessions){
  const p=status?.proxy;
  return ['connected','confirming','verifying'].includes(status?.phase)
    &&p&&`${p.scheme}://${p.host}:${p.port}`===expected.key
    &&status.attempt===expected.attempt&&status.id===expected.generation
    &&boundOffer(sessions,expected.attempt)?.session===expected.session;
}
