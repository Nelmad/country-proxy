// QA only: natural recovery is a separate claim from consuming a new refill.
import {boundOffer} from './refill-evidence.mjs';

export function withdrawalBoundary(sessions, anchor) {
  const session=sessions.find(s=>s.session===anchor.session&&!s.truncated);
  const offer=session?.offers.find(o=>o.attempt===anchor.attempt&&o.feedback==='confirm');
  const excluded=session?.exclusions.find(e=>e.attempt===anchor.attempt);
  return offer&&Number.isSafeInteger(excluded?.atMs)&&excluded.atMs>=offer.offeredAtMs
    ? excluded.atMs : null;
}

export function autonomousCandidate(status, anchor, sessions, countries, withdrawnAtMs) {
  if(status?.id!==anchor.generation)return {state:'inconclusive',reason:'GENERATION_CHANGED'};
  const active=sessions.filter(s=>s.lifecycle.running);
  if(active.length!==1||active[0].session!==anchor.session||active[0].truncated)
    return {state:'inconclusive',reason:'SESSION_OR_JOURNAL_CHANGED'};
  if(status.phase!=='connected'||!status.browser?.ok)return {state:'waiting'};
  const p=status.proxy,b=status.browser;
  if(!p||!countries.includes(p.country)||!countries.includes(b.country)||p.country!==b.country||p.exitIp!==b.exitIp)
    return {state:'fail',reason:'EXIT_OR_COUNTRY_MISMATCH'};
  if(status.attempt<=anchor.attempt||p.host===anchor.host||b.exitIp===anchor.ip)return {state:'waiting'};
  const bound=boundOffer(sessions,status.attempt);
  if(!bound||bound.session!==anchor.session)return {state:'waiting'};
  if(!['pool','discovery'].includes(bound.offer.origin)||!Number.isSafeInteger(withdrawnAtMs)||
    !Number.isSafeInteger(bound.offer.nativeCheckedAt)||bound.offer.nativeCheckedAt<withdrawnAtMs)
    return {state:'inconclusive',reason:'NO_FRESH_NATIVE_OFFER'};
  return {state:'candidate',bound};
}


export async function observeAutonomousRecovery({anchor,initial,initialAttempt,countries,withdrawnAtMs,
  deadline,observe,journal,trace,effectiveRoute,events,pause,now=Date.now}) {
  let nextTrace=0;
  while(now()<deadline){
    const s=await observe(),rows=await journal();
    const decision=autonomousCandidate(s.status,anchor,rows,countries,withdrawnAtMs);
    if(decision.state==='fail')throw Error(decision.reason);
    if(decision.state==='inconclusive')return {result:'INCONCLUSIVE',reason:decision.reason};
    if(decision.state==='candidate'&&now()>=nextTrace){
      const verified=await trace(s,deadline);nextTrace=now()+6000;
      if(verified&&now()<=deadline){
        const after=await observe(),finalRows=await journal();
        const proof=autonomousCandidate(after.status,anchor,finalRows,countries,withdrawnAtMs);
        if(proof.state==='fail')throw Error(proof.reason);
        if(proof.state==='candidate'&&verified.attempt===after.status.attempt&&
          verified.generation===after.status.id&&verified.host===after.status.proxy.host&&
          verified.ip===after.status.browser.exitIp&&await effectiveRoute(after.status.proxy)){
          const observed=await events();
          if(observed.outsideGroup||observed.unexpectedRoute)throw Error('OUTSIDE_GROUP_OR_UNEXPECTED_ROUTE');
          if(verified.host===initial.host){
            const exclusion=finalRows.find(s=>s.session===anchor.session)?.exclusions.find(e=>e.attempt===initialAttempt);
            if(!exclusion||proof.bound.offer.nativeCheckedAt<exclusion.untilMs)
              throw Error('INITIAL_ROUTE_REUSED_BEFORE_NATURAL_EXCLUSION');
          }
          return {result:'PASS',attempt:verified.attempt,origin:proof.bound.offer.origin,
            country:verified.country,scheme:verified.scheme,differentHost:true,differentExit:true,
            ordinaryHttps:true,nativeCheckedAt:proof.bound.offer.nativeCheckedAt,
            withdrawalToTabMs:verified.completedAtMs-withdrawnAtMs,
            reusedInitialHost:verified.host===initial.host,reusedInitialExit:verified.ip===initial.ip};
        }
      }
    }
    await pause(450);
  }
  return {result:'INCONCLUSIVE',reason:'NO_VERIFIED_AUTONOMOUS_RECOVERY_WITHIN_WINDOW'};
}

export function finalizeAutonomousRecovery(observed,{failed,incomplete}) {
  if(observed?.result!=='PASS')return observed;
  return failed?{...observed,result:'FAIL',reason:'FINAL_VALIDATION_FAILED'}:
    incomplete?{...observed,result:'INCONCLUSIVE',reason:'INCOMPLETE_FINAL_EVIDENCE'}:observed;
}
