// Fields retained by the public QA report. Neither endpoint addresses nor raw errors leave the fixture.
import fs from 'node:fs/promises';
import path from 'node:path';
import {joinProbeRequests,resourceTiming,requestOrdinal,uniqueProbeAttempts} from './https-probe-observer.mjs';
import {readReserveDiagnostics} from '../extension/reserve-diagnostics.js';

const integer = x => Number.isSafeInteger(x) && x >= 0;
const nullableInteger = x => x === null || integer(x);
const reasons = new Set(['country','invalid_trace','http','timeout','transport','unknown']);

/** Called only after the currently selected route has been verified by the browser. */
export function faultTrigger(mode, pool, countries, now=Date.now()) {
  const matchingGroup = Array.isArray(pool?.countries) && pool.countries.length === countries.length
    && countries.every((country,i) => pool.countries[i] === country);
  const count = matchingGroup && integer(pool.count) ? pool.count : 0;
  const remainingMs = count && Number.isFinite(pool?.expiresAt) ? Math.max(0, pool.expiresAt-now) : 0;
  const ready = count>0 && remainingMs>5000;
  return {canArm:mode==='firstVerifiedTab' || (mode==='freshReserve' && ready),
    reserve:{matchingGroup,count,present:count>0,ready,remainingMs}};
}

// Cumulative curl timings are not disjoint TCP/SOCKS/TLS durations.
export function readNativeProbe(value) {
  const fail=()=>{throw Error('INVALID_NATIVE_PROBE');};
  const ms=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=120000;
  const status=v=>v===null||(integer(v)&&(v===0||(v>=100&&v<=599)));
  if(!value||value.version!==1||!integer(value.startedAtMs)||!ms(value.elapsedMs)||
      typeof value.joinedEarlier!=='boolean'||typeof value.limited!=='boolean'||
      !(value.joinedEarlier?value.queueWaitMs===null:ms(value.queueWaitMs))||
      !Array.isArray(value.controls)||value.controls.length>4)fail();
  const seen=new Set();
  const controls=value.controls.map(row=>{
    if(!row||!['trace','target'].includes(row.endpoint)||![1,2].includes(row.ordinal)||
        !ms(row.startMs)||!ms(row.endMs)||row.endMs<row.startMs||row.endMs>value.elapsedMs||
        !['completed','failed','cancelled','timeout','error'].includes(row.outcome)||
        !(row.curlCode===null||(integer(row.curlCode)&&row.curlCode<=999))||
        !status(row.httpStatus)||!status(row.connectStatus))fail();
    const key=row.endpoint+':'+row.ordinal;
    if(seen.has(key))fail();seen.add(key);
    if((row.outcome==='completed'&&row.curlCode!==0)||
        (row.outcome==='failed'&&!(integer(row.curlCode)&&row.curlCode>0))||
        (['cancelled','timeout','error'].includes(row.outcome)&&row.curlCode!==null))fail();
    let timingMs=null;
    if(row.timingMs!==null){
      if(!['completed','failed'].includes(row.outcome)||row.curlCode===null||!row.timingMs||typeof row.timingMs!=='object')fail();
      const names=['nameLookup','connect','appConnect','pretransfer','startTransfer','total'];
      if(!names.every(name=>ms(row.timingMs[name])))fail();
      timingMs=Object.fromEntries(names.map(name=>[name,row.timingMs[name]]));
    }
    let diagnosis;
    if(Object.hasOwn(row,'diagnosis')){
      diagnosis=null;
      if(row.diagnosis!==null){
        const d=row.diagnosis;
        const verify=v=>v===null||(integer(v)&&v<=2147483647);
        if(!['completed','failed'].includes(row.outcome)||!timingMs||!d||typeof d!=='object'||
          !['none','certificate','tls_handshake','tls_io','tls_closed','timeout','dns','proxy_negotiation','tcp_connect','transport','unknown'].includes(d.errorClass)||
          !['complete','dns','tcp_connect','proxy_negotiation','tls','negotiation_or_tls','post_tls','response','unknown'].includes(d.phase)||
          !verify(d.sslVerifyResult)||!verify(d.proxySslVerifyResult)||typeof d.tlsCompletedEvidence!=='boolean'||
          d.tlsCompletedEvidence!==Boolean(timingMs&&timingMs.appConnect>0))fail();
        diagnosis={errorClass:d.errorClass,phase:d.phase,sslVerifyResult:d.sslVerifyResult,
          proxySslVerifyResult:d.proxySslVerifyResult,tlsCompletedEvidence:d.tlsCompletedEvidence};
      }
    }
    let metadataMode;
    if(Object.hasOwn(row,'metadataMode')){
      if(!['json','numeric_only'].includes(row.metadataMode)||!timingMs||!diagnosis)fail();
      metadataMode=row.metadataMode;
    }
    return {endpoint:row.endpoint,ordinal:row.ordinal,startMs:row.startMs,endMs:row.endMs,
      outcome:row.outcome,curlCode:row.curlCode,httpStatus:row.httpStatus,connectStatus:row.connectStatus,timingMs,
      ...(diagnosis===undefined?{}:{diagnosis}),...(metadataMode===undefined?{}:{metadataMode})};
  });
  return {version:1,startedAtMs:value.startedAtMs,elapsedMs:value.elapsedMs,queueWaitMs:value.queueWaitMs,
    joinedEarlier:value.joinedEarlier,limited:value.limited,controls};
}

export async function readOfferSessions(directory) {
  const names = await fs.readdir(directory);
  if (names.includes('offers-overflow')) throw Error('OFFER_JOURNAL_LIMIT');
  const files = names.filter(name => /^offers-\d{4}\.json$/.test(name)).sort();
  if (files.length > 64) throw Error('OFFER_JOURNAL_LIMIT');
  return Promise.all(files.map(async file => {
    const data = JSON.parse(await fs.readFile(path.join(directory,file),'utf8'));
    const session = Number(file.slice(7,11));
    if (data.version !== 1 || data.session !== session || session < 1 || typeof data.truncated !== 'boolean'
        || !Array.isArray(data.offers) || data.offers.length > 512) throw Error('INVALID_OFFER_JOURNAL');
    let last = 0;
    const offers = data.offers.map(row => {
      if (!integer(row.attempt) || row.attempt <= last || !integer(row.offeredAtMs)
          || !['pool','discovery','unknown'].includes(row.origin) || !['confirm','reject','pending'].includes(row.feedback)
          || !nullableInteger(row.feedbackMs) || !integer(row.injectedHealthFailures)
          || !(row.reason === null || reasons.has(row.reason))) throw Error('INVALID_OFFER_ROW');
      let recheckRejection = null;
      if (row.recheckRejection != null) {
        const {atMs,reason} = row.recheckRejection;
        if (row.feedback !== 'confirm' || !integer(atMs) || atMs < row.offeredAtMs || !reasons.has(reason)) {
          throw Error('INVALID_RECHECK_REJECTION');
        }
        recheckRejection = {atMs,reason,activeNativeCheckedAt:integer(row.recheckRejection.checkedAt) ? row.recheckRejection.checkedAt : null};
      }
      last = row.attempt;
      return {attempt:row.attempt, offeredAtMs:row.offeredAtMs, origin:row.origin, feedback:row.feedback,
        feedbackMs:row.feedbackMs, reason:row.reason, recheckRejection, injectedHealthFailures:row.injectedHealthFailures,
        nativeCheckedAt:integer(row.checkedAt) ? row.checkedAt : null,
        reserveLeaseAgeMs:integer(row.reserveLeaseAgeMs) ? row.reserveLeaseAgeMs : null};
    });
    if (!Array.isArray(data.takes) || data.takes.length > 512) throw Error('INVALID_RESERVE_TAKES');
    const takes = data.takes.map(t => {
      if (!integer(t.atMs) || !nullableInteger(t.elapsedMs) || !Array.isArray(t.leaseAgesMs) || t.leaseAgesMs.length>2
          || !t.leaseAgesMs.every(integer) || !['selected','noEligible','cancelled','error','pending'].includes(t.result)
          || !Array.isArray(t.rechecks) || t.rechecks.length>2) throw Error('INVALID_RESERVE_TAKE');
      const rechecks=t.rechecks.map(r => {
        if (!['passed','failed','cancelled','error','pending'].includes(r.outcome)) throw Error('INVALID_RESERVE_RECHECK');
        const reason=r.reason === null || /^[a-z_]{1,32}$/.test(r.reason) ? r.reason : 'unknown';
        return {outcome:r.outcome,reason,...(Object.hasOwn(r,'nativeProbe')?{nativeProbe:readNativeProbe(r.nativeProbe)}:{})};
      });
      return {atMs:t.atMs,elapsedMs:t.elapsedMs,leaseAgesMs:t.leaseAgesMs,result:t.result,rechecks};
    });
    const removals=data.removals ?? [];
    if (!Array.isArray(removals) || removals.length>512) throw Error('INVALID_RESERVE_REMOVALS');
    let lastRemovalId = 0;
    return {session, truncated:data.truncated, offers, takes, removals:removals.map(row => {
      if (Object.hasOwn(row, 'id')) {
        const parsed = readReserveDiagnostics({state:'waiting',counts:{},removals:[row]});
        if (parsed.removalsLimited || parsed.removals.length !== 1 || parsed.removals[0].id <= lastRemovalId) {
          throw Error('INVALID_RESERVE_REMOVAL');
        }
        lastRemovalId = parsed.removals[0].id;
        return parsed.removals[0];
      }
      const {atMs,ageMs,stage,reason} = row;
      if (!integer(atMs) || !integer(ageMs) || !['maintenance','prune'].includes(stage)
          || !['connect','tls','transport','timeout','http','country','invalid_trace','unavailable','internal','unknown',
            'expired','removed','notRetained'].includes(reason)) throw Error('INVALID_RESERVE_REMOVAL');
      return {atMs,ageMs,stage,reason};
    })};
  }));
}

export function browserProofs(decisions, network, sessions) {
  return decisions.map(({offer,diagnostic}) => {
    const networkProof = joinProbeRequests(network,{verifyingAt:offer?.verifyingAt,
      checkedAt:diagnostic.checkedAt,latencyMs:diagnostic.latencyMs});
    const matches=[];
    for (const session of sessions) {
      for (const row of session.offers) {
        if (!offer || row.attempt !== offer.attempt || row.offeredAtMs > offer.verifyingAt
            || row.nativeCheckedAt === null || row.nativeCheckedAt !== (offer.initialCheckedAt ?? offer.checkedAt)) continue;
        let decision;
        if (row.feedback==='reject' && row.reason===diagnostic.reason && row.nativeCheckedAt===offer.checkedAt) {
          decision='initial';
        } else if (row.feedback==='confirm' && row.recheckRejection?.reason===diagnostic.reason
            && row.recheckRejection.atMs>=diagnostic.checkedAt) {
          decision='recheck';
        } else continue;
        matches.push({session:session.session,attempt:row.attempt,origin:row.origin,decision});
      }
    }
    return {offer, diagnostic, native:matches.length === 1 ? matches[0] : null, network:networkProof};
  });
}

// Successful probes need the same exact matching as failures. A slow confirmation
// alone cannot identify which HTTPS control or which connection phase took time.
export function confirmationProofs(confirmations, network, sessions) {
  const ms = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 120000
    ? Math.round(value*1000)/1000 : null;
  return confirmations.slice(0,512).map(({offer,browser,connectedAt}) => {
    const stamp = value=>integer(value)?value:null;
    const safeOffer = {attempt:stamp(offer?.attempt),checkedAt:stamp(offer?.checkedAt),
      initialCheckedAt:stamp(offer?.initialCheckedAt),verifyingAt:stamp(offer?.verifyingAt)};
    const diagnostic = {checkedAt:stamp(browser?.checkedAt),latencyMs:ms(browser?.latencyMs)};
    const proof = joinProbeRequests(network,{verifyingAt:safeOffer.verifyingAt,...diagnostic});
    const matches = sessions.flatMap(session=>session.offers.filter(row=>
      integer(safeOffer.attempt) && row.attempt===safeOffer.attempt && integer(safeOffer.verifyingAt) &&
      row.offeredAtMs<=safeOffer.verifyingAt && row.nativeCheckedAt!==null &&
      row.nativeCheckedAt===(safeOffer.initialCheckedAt??safeOffer.checkedAt) && row.feedback==='confirm')
      .map(row=>({session:session.session,row})));
    const match = matches.length===1 && !sessions.some(s=>s.truncated) ? matches[0] : null;
    const confirmedAt = match && integer(match.row.feedbackMs) ? match.row.offeredAtMs+match.row.feedbackMs : null;
    const initial = confirmedAt!==null && integer(diagnostic.checkedAt) && confirmedAt>=diagnostic.checkedAt;
    const native = match ? {session:match.session,attempt:match.row.attempt,origin:match.row.origin,
      decision:initial?'initial':'recheck'} : null;
    const requested = browser?.verifiedRequests;
    const explicit = requested !== undefined;
    const validSelection = requested && ['trace','target'].every(endpoint=>[1,2].includes(requested[endpoint]));
    const winners = validSelection ? {trace:requested.trace,target:requested.target} :
      !explicit && proof.requests.every(row=>requestOrdinal(row)===1) ? {trace:1,target:1} : null;
    const requests = proof.requests.map(row=>({endpoint:row.endpoint,ordinal:requestOrdinal(row),
      selected:winners ? winners[row.endpoint]===requestOrdinal(row) : null,
      requestStartAfterProbeMs:typeof row.startWallMs==='number'?ms(row.startWallMs-proof.nonce):null,
      elapsedMs:ms(row.elapsedMs),headersElapsedMs:ms(row.headersElapsedMs),
      bodyAfterHeadersMs:ms(row.elapsedMs)!==null&&ms(row.headersElapsedMs)!==null?ms(row.elapsedMs-row.headersElapsedMs):null,
      outcome:['pending','headers','completed','failed','cancelled','redirected'].includes(row.outcome)?row.outcome:'unknown',
      httpStatus:integer(row.httpStatus)&&row.httpStatus>=100&&row.httpStatus<=599?row.httpStatus:null,
      error:typeof row.error==='string'&&/^net::ERR_[A-Z0-9_]+$/.test(row.error)?row.error:null,
      connectionReused:typeof row.connectionReused==='boolean'?row.connectionReused:null,
      protocol:['http/1.0','http/1.1','h2','h3'].includes(row.protocol)?row.protocol:null,
      timing:resourceTiming(row.timing?.offsetsMs)}));
    return {offer:safeOffer,diagnostic,native,
      timing:{offerToVerifyingMs:match?ms(safeOffer.verifyingAt-match.row.offeredAtMs):null,
        verifyingToProbeMs:proof.attribution==='matched'?ms(proof.nonce-safeOffer.verifyingAt):null,
        probeMs:diagnostic.latencyMs,
        probeEndToConfirmMs:initial?ms(confirmedAt-diagnostic.checkedAt):null,
        probeEndToConnectedMs:integer(connectedAt)&&integer(diagnostic.checkedAt)?ms(connectedAt-diagnostic.checkedAt):null},
      network:{attribution:proof.attribution,nonce:proof.nonce,requests,verifiedRequests:winners,
        // A complete pair means both endpoint requests were observed, not that both CDP streams finished.
        completePair:['trace','target'].every(endpoint=>requests.some(row=>row.endpoint===endpoint)),
        selectedPairObserved:Boolean(winners&&['trace','target'].every(endpoint=>requests.some(row=>row.endpoint===endpoint&&row.selected))),
        observationLimited:Boolean(network.limited||sessions.some(s=>s.truncated))}};
  });
}

// A pending probe has no final duration to prove its nonce. Report endpoint states only
// for one current native offer and one worker GET group in its observed interval. Never
// export URLs, request IDs, IPs or headers. These events do not identify CONNECT/TLS.
export function pendingProbeAtCutoff(offer, cutoff, network, sessions) {
  if (!offer) return null;
  const unknown = () => ({state:'unknown',httpStatus:null,error:null});
  const result = {atMs:cutoff,attempt:offer.attempt,nativeCheckedAt:offer.checkedAt,
    verifyingAt:offer.verifyingAt,elapsedMs:cutoff-offer.verifyingAt,
    nativeMatches:0,nonceMatches:0,attribution:'unknown',trace:unknown(),target:unknown(),requests:[]};
  if (!integer(cutoff) || !integer(offer.verifyingAt) || cutoff<offer.verifyingAt) return result;
  const candidates=sessions.flatMap(s => s.offers.filter(o => o.attempt===offer.attempt &&
    integer(o.nativeCheckedAt) && o.nativeCheckedAt===offer.initialCheckedAt && o.offeredAtMs<=offer.verifyingAt));
  result.nativeMatches=candidates.length;
  const groups=new Map();
  for (const row of network.requests) {
    if (!integer(row.nonce) || row.nonce<offer.verifyingAt || row.nonce>cutoff) continue;
    if (!groups.has(row.nonce)) groups.set(row.nonce,[]);
    groups.get(row.nonce).push(row);
  }
  result.nonceMatches=groups.size;
  if (!network.available || network.limited || sessions.some(s=>s.truncated) ||
      candidates.length!==1 || groups.size!==1) return result;
  const rows=[...groups.values()][0];
  if (!uniqueProbeAttempts(rows)) return result;
  result.attribution='unique_interval';
  for (const row of rows) {
    if (!['trace','target'].includes(row.endpoint) || !integer(row.startWallMs) || row.startWallMs>cutoff) continue;
    // The deadline timer can run late. A subsequent state transition must not be
    // backdated just because its request began before the cutoff.
    if (row.outcome!=='pending' && (!integer(row.elapsedMs) || row.startWallMs+row.elapsedMs>cutoff)) continue;
    if (!['pending','headers','completed','failed','cancelled','redirected'].includes(row.outcome)) continue;
    const state={state:row.outcome,
      httpStatus:integer(row.httpStatus) && row.httpStatus>=100 && row.httpStatus<=599 ? row.httpStatus : null,
      error:typeof row.error==='string' && /^net::ERR_[A-Z0-9_]+$/.test(row.error) ? row.error : null};
    result.requests.push({endpoint:row.endpoint,ordinal:requestOrdinal(row),...state});
    // Legacy endpoint summaries describe the primary; the bounded list includes a hedge.
    if (requestOrdinal(row)===1) result[row.endpoint]=state;
  }
  return result;
}

export function navigationError(error) {
  return error.name === 'TimeoutError' ? 'timeout' : /\bnet::ERR_[A-Z0-9_]+\b/.exec(error.message)?.[0] || 'navigation_error';
}
