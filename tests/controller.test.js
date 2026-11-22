import {dnrFixture} from './dnr-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Controller, DEFAULTS, normalizeCountries, restoreCountrySettings, validateCountry, normalizeSelection, proxyConfig, BLOCKED, matchesEffectiveRoute} from '../extension/controller.js';
import {probeBrowser} from '../extension/probe.js';
const candidate = {scheme:'http',host:'8.8.8.8',port:3128,country:'SE'};
function setup(probe=async()=>true, addressed=false) {
  const calls=[];
  const api=Object.fromEntries(['save','block','apply','publish','startNative','stopNative','clear','rotate',...(addressed?['reject','confirm']:[])].map(k=>[k,async (...args)=>{calls.push([k,...args]);}]));
  return {calls,c:new Controller(api,async (...args)=>{
    const result=await probe(...args);
    return typeof result==='boolean' ? {ok:result, ...(result?{}:{reason:'transport'})} : result;
  })};
}
test('countries configured independently of defaults',()=>{
 assert.deepEqual(normalizeCountries(['se','JP','SE'],['SE','JP']),['SE','JP']);
 assert.deepEqual(normalizeCountries([],['SE']),[]);
 assert.throws(()=>normalizeCountries(['ZZ'],['SE']));
 assert.throws(()=>normalizeCountries(null,['SE']));
});
test('proxy has fallback and no DIRECT',()=>{
 for(const config of [BLOCKED,proxyConfig(candidate)]) {
   assert.equal(config.mode,'fixed_servers');assert.ok(config.rules.fallbackProxy);
   assert.ok(!JSON.stringify(config).includes('DIRECT'));
 }
});
test('no live state until browser verification; rejected candidate rotates',async()=>{
 const {c,calls}=setup(async()=>false);await c.start('SE');
 await c.status({id:c.id,country:'SE',phase:'connected',proxy:candidate});
 assert.equal(c.active,null);assert.equal(calls.at(-1)[0],'rotate');
 assert.ok(calls.some(([k,v])=>k==='publish'&&v.phase==='verifying'));
 assert.ok(!calls.some(([k,v])=>k==='publish'&&v.phase==='connected'));
});
test('disconnect during browser verification cannot reconnect',async()=>{
 let finish;const {c,calls}=setup(()=>new Promise(r=>{finish=r;}));
 await c.start('SE');const event=c.status({id:c.id,country:'SE',phase:'connected',proxy:candidate});
 await new Promise(r=>setImmediate(r));const stop=c.stop();finish(true);await event;await stop;
 assert.equal(c.enabled,false);assert.equal(c.active,null);assert.equal(calls.at(-1)[1].phase,'off');
});
test('late event from old country ignored',async()=>{
 const {c,calls}=setup();await c.start('SE');const old=c.id;await c.start('JP');const before=calls.length;
 await c.status({id:old,country:'SE',phase:'connected',proxy:candidate});assert.equal(calls.length,before);
});
test('native disconnect blocks and leaves user enabled for reconnect',async()=>{
 const {c,calls}=setup();await c.start('SE');await c.status({id:c.id,country:'SE',phase:'connected',proxy:candidate});
 await c.lost();assert.equal(c.enabled,true);assert.equal(c.active,null);
 assert.deepEqual(calls.slice(-3).map(x=>x[0]),['block','save','publish']);
});
test('rejected queued duplicate is not reconnected',async()=>{
 let probes=0; const {c,calls}=setup(async()=>{probes++;return false;});await c.start('SE');
 const event={id:c.id,country:'SE',phase:'connected',proxy:candidate};await c.status(event);await c.status(event);
 assert.equal(probes,1);assert.equal(calls.filter(x=>x[0]==='rotate').length,1);
});
test('browser failure on active proxy triggers replacement even if native is healthy',async()=>{
 let healthy=true;const {c,calls}=setup(async()=>healthy);await c.start('SE');
 const event={id:c.id,country:'SE',phase:'connected',proxy:candidate};await c.status(event);
 healthy=false;await c.status({...event,force:true});
 assert.equal(c.active,null);assert.equal(calls.at(-1)[0],'rotate');
});

test('TLS proxy transport is preserved in every browser route',()=>{
 const config=proxyConfig({...candidate,scheme:'https'});
 for(const route of ['proxyForHttp','proxyForHttps','fallbackProxy']) assert.equal(config.rules[route].scheme,'https');
});

test('late health warning cannot restore rejected proxy after browser failure',async()=>{
 let healthy=true;const {c,calls}=setup(async()=>healthy);await c.start('SE');
 const event={id:c.id,country:'SE',phase:'connected',proxy:candidate};
 await c.status(event);healthy=false;await c.status({...event,force:true});
 const before=calls.length;
 await c.status({...event,phase:'confirming'});
 assert.equal(calls.length,before);assert.equal(c.active,null);
 assert.equal(calls.filter(([key])=>key==='publish').at(-1)[1].phase,'replacing');
});
test('late health warning for previous proxy cannot replace current UI state',async()=>{
 const {c,calls}=setup();await c.start('SE');
 const event={id:c.id,country:'SE',phase:'connected',proxy:candidate};
 await c.status(event);
 await c.status({...event,phase:'confirming'});
 assert.equal(calls.filter(([key])=>key==='publish').at(-1)[1].phase,'confirming');
 const replacement={...candidate,host:'1.1.1.1',port:8080};
 await c.status({...event,proxy:replacement});const before=calls.length;
 await c.status({...event,phase:'confirming'});
 assert.equal(calls.length,before);assert.equal(c.active.host,replacement.host);
});


test('reserve updates cannot replace connection state or change the browser route',async()=>{
 const {c,calls}=setup();await c.start('SE');
 await c.status({id:c.id,country:'SE',phase:'connected',proxy:candidate});
 const before=calls.length;
 await c.status({id:c.id,country:'SE',phase:'pool',reserveCount:2,reserveChecking:true,reserveExpiresAt:Date.now()+90000});
 assert.equal(c.active,candidate);assert.equal(calls.length,before+1);
 assert.equal(calls.at(-1)[0],'save');assert.equal(calls.at(-1)[1].pool.count,2);
 const saved=calls.length;
 await c.status({id:c.id,country:'NO',phase:'pool',reserveCount:2});assert.equal(calls.length,saved);
 const old=c.id;await c.stop();const stopped=calls.length;
 await c.status({id:old,country:'SE',phase:'pool',reserveCount:2});assert.equal(calls.length,stopped);
 assert.ok(calls.some(([k,v,changes])=>k==='publish' && v.phase==='stopping' && changes.enabled===false && changes.pool===null));
});
test('country switch clears reserve and requires Chrome verification for a replacement',async()=>{
 let probes=0;const {c,calls}=setup(async()=>{probes++;return true;});await c.start('SE');
 await c.status({id:c.id,country:'SE',phase:'connected',proxy:candidate});
 await c.status({id:c.id,country:'SE',phase:'reserve',proxy:null});assert.equal(c.active,null);
 await c.status({id:c.id,country:'SE',phase:'connected',proxy:{...candidate,host:'1.1.1.1'}});
 assert.equal(probes,2);await c.start('NO');
 assert.ok(calls.some(([k,v])=>k==='save' && v.selected==='NO' && v.pool===null));
});

test('queued forced browser check cannot restore an endpoint after native replacement starts',async()=>{
 const {c,calls}=setup();await c.start('SE');
 const event={id:c.id,country:'SE',phase:'connected',proxy:candidate};await c.status(event);
 const before=calls.length;
 const replacing=c.status({id:c.id,country:'SE',phase:'replacing',proxy:null});
 const staleCheck=c.status({...event,force:true});
 await Promise.all([replacing,staleCheck]);
 assert.equal(c.active,null);
 assert.deepEqual(calls.slice(before).map(([kind])=>kind),['block','publish']);
 assert.equal(calls.at(-1)[1].phase,'replacing');
});
test('queued forced browser check cannot switch a replacement back to the old endpoint',async()=>{
 const {c,calls}=setup();await c.start('SE');
 const event={id:c.id,country:'SE',phase:'connected',proxy:candidate};await c.status(event);
 const replacement={...candidate,host:'1.1.1.1'};
 const replacing=c.status({...event,proxy:replacement});
 const staleCheck=c.status({...event,force:true});
 await Promise.all([replacing,staleCheck]);
 assert.equal(c.active.host,replacement.host);
 assert.deepEqual(calls.filter(([kind])=>kind==='apply').map(([,v])=>v.rules.proxyForHttps.host),[candidate.host,replacement.host]);
});
test('browser exit observation survives native metadata refresh and clears with route',async()=>{
 const observed={ok:true,country:'SE',exitIp:'9.9.9.9',checkedAt:Date.now(),latencyMs:50};
 const {c,calls}=setup(async()=>observed);await c.start('SE');
 const event={id:c.id,country:'SE',phase:'connected',proxy:{...candidate,exitIp:'8.8.4.4'}};
 await c.status(event);await c.status({...event,proxy:{...event.proxy,latencyMs:99}});
 assert.equal(calls.at(-1)[1].browser.exitIp,observed.exitIp);
 assert.equal(calls.at(-1)[1].proxy.exitIp,'8.8.4.4');
 await c.status({...event,phase:'replacing',proxy:null});assert.equal(c.browser,null);
 assert.equal(calls.at(-1)[1].browser,undefined);
});
test('browser rejection exposes a structured reason while preserving the selected country',async()=>{
 const {c,calls}=setup(async()=>({ok:false,reason:'country',country:'PL',exitIp:'9.9.9.9'}));await c.start('SE');
 await c.status({id:c.id,country:'SE',phase:'connected',proxy:candidate});
 const status=calls.filter(([kind])=>kind==='publish').at(-1)[1];
 assert.equal(status.country,'SE');assert.equal(status.phase,'replacing');assert.equal(status.diagnostic.reason,'country');
 assert.equal(status.diagnostic.country,'PL');assert.equal(c.active,null);
});
test('native disconnect cancelling a pending browser probe does not request another rotation',async()=>{
 const {c,calls}=setup((country,signal)=>new Promise(resolve=>{
   signal.addEventListener('abort',()=>resolve({ok:false,reason:'cancelled'}),{once:true});
 }));
 await c.start('SE');const checking=c.status({id:c.id,country:'SE',phase:'connected',proxy:candidate});
 await new Promise(r=>setImmediate(r));const lost=c.lost();await Promise.all([checking,lost]);
 assert.equal(calls.filter(([kind])=>kind==='rotate').length,0);
 assert.equal(calls.at(-1)[1].phase,'helper');
});
function responses({traceStatus=200,targetStatus=204,body='ip=8.8.4.4\nloc=SE\n'}={}) {
 return async url=>url.includes('/trace') ? new Response(body,{status:traceStatus}) : new Response(null,{status:targetStatus});
}
test('browser probe requires both HTTPS origins and records the observed exit',async()=>{
 const calls=[];const fetcher=async(url,options)=>{calls.push({url,options});return responses()(url);};
 const result=await probeBrowser('SE',new AbortController().signal,{fetcher});
 assert.equal(result.ok,true);assert.equal(result.exitIp,'8.8.4.4');assert.equal(result.country,'SE');
 assert.equal(calls.length,2);assert.ok(calls.every(c=>c.url.startsWith('https://') && c.options.redirect==='error' && c.options.credentials==='omit'));
 assert.ok(result.checkedAt>0);assert.ok(result.latencyMs>=0);
});
test('browser probe distinguishes HTTP, country and malformed trace failures',async()=>{
 for(const [options,reason] of [[{targetStatus:503},'http'],[{traceStatus:201},'http'],[{body:'loc=PL\nip=8.8.4.4\n'},'country'],[{body:'loc=SE\nip=999.8.4.4\n'},'invalid_trace'],[{body:'loc=SE\n'},'invalid_trace']]) {
  const result=await probeBrowser('SE',new AbortController().signal,{fetcher:responses(options)});
  assert.equal(result.ok,false);assert.equal(result.reason,reason);
 }
 const ipv6=await probeBrowser('SE',new AbortController().signal,{fetcher:responses({body:'loc=SE\nip=2606:4700::1111\n'})});
 assert.equal(ipv6.ok,true);assert.equal(ipv6.exitIp,'2606:4700::1111');
});
test('a final HTTPS verdict cancels a hung companion before its timeout', async () => {
  for (const [endpoint, response, reason] of [
    ['target', () => new Response(null, {status: 503}), 'http'],
    ['trace', () => new Response('loc=PL\nip=8.8.4.4'), 'country'],
    ['trace', () => ({status: 200, text: async () => { throw TypeError('closed body'); }}), 'transport']
  ]) {
    const owner = new AbortController();
    let companionSignal;
    const fetcher = (url, {signal}) => {
      if ((url.includes('/trace') ? 'trace' : 'target') === endpoint) return Promise.resolve(response());
      companionSignal = signal;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
    };
    const deadline = setTimeout(() => owner.abort(), 500);
    try {
      const result = await probeBrowser(['AT', 'EE', 'NO'], owner.signal, {fetcher});
      assert.deepEqual([result.reason, result.endpoint], [reason, endpoint]);
      assert.ok(companionSignal.aborted);
      assert.equal(owner.signal.aborted, false);
    } finally {
      clearTimeout(deadline);
    }
  }
});

test('browser probe aborts the other fetch when one transport fails',async()=>{
 let otherSignal;
 const result=await probeBrowser('SE',new AbortController().signal,{fetcher:(url,{signal})=>{
  if(url.includes('/trace'))return Promise.reject(new TypeError('Network failure'));
  otherSignal=signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
 }});
 assert.equal(result.reason,'transport');assert.equal(result.endpoint,'trace');assert.equal(otherSignal.aborted,true);
});
test('browser probe distinguishes deadline and caller cancellation',async()=>{
 const waiting=(url,{signal})=>new Promise((resolve,reject)=>{
  if(signal.aborted)return reject(signal.reason);
  signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
 });
 // Node's AbortSignal timeout is unref'ed; keep the event loop alive for this bounded test.
 const keepAlive=setTimeout(()=>{},1000);
 try {
  const timed=await probeBrowser('SE',new AbortController().signal,{fetcher:waiting,timeoutMs:5});assert.equal(timed.reason,'timeout');
  const cancelled=new AbortController();cancelled.abort();
  const stopped=await probeBrowser('SE',cancelled.signal,{fetcher:waiting});assert.equal(stopped.reason,'cancelled');
 } finally {clearTimeout(keepAlive);}
});

test('last browser rejection survives native phases and clears on successful replacement',async()=>{
 let healthy=false;const {c,calls}=setup(async()=>healthy?{ok:true,country:'SE',exitIp:'9.9.9.9'}:{ok:false,reason:'timeout'});
 await c.start('SE');const event={id:c.id,country:'SE',phase:'connected',proxy:candidate};
 await c.status(event);
 for(const phase of ['replacing','searching','checking','slow','empty']) {
  await c.status({...event,phase,proxy:null});
  assert.equal(calls.at(-1)[1].lastFailure.reason,'timeout');
 }
 healthy=true;await c.status({...event,proxy:{...candidate,host:'1.1.1.1'}});
 assert.equal(calls.at(-1)[1].phase,'connected');assert.equal(calls.at(-1)[1].lastFailure,undefined);
 assert.equal(c.lastFailure,null);
});
test('country switch and explicit stop clear the previous browser rejection',async()=>{
 const {c,calls}=setup(async()=>({ok:false,reason:'transport'}));await c.start('SE');
 await c.status({id:c.id,country:'SE',phase:'connected',proxy:candidate});
 assert.equal(c.lastFailure.reason,'transport');await c.start('EE');
 assert.equal(c.lastFailure,null);
 assert.equal(calls.filter(([kind])=>kind==='publish').at(-1)[1].lastFailure,undefined);
 await c.status({id:c.id,country:'EE',phase:'connected',proxy:{...candidate,country:'EE'}});
 assert.equal(c.lastFailure.reason,'transport');await c.stop();
 assert.equal(calls.at(-1)[1].phase,'off');assert.equal(calls.at(-1)[1].lastFailure,undefined);
});
test('forced browser events retain the last native diagnostic counters',async()=>{
 let healthy=true;const {c,calls}=setup(async()=>healthy);await c.start('SE');
 const event={id:c.id,country:'SE',phase:'connected',proxy:candidate};
 const diagnostics={attempts:12,passed:2,failures:{timeout:10}};
 await c.status({...event,diagnostics});await c.status({...event,force:true});
 assert.deepEqual(calls.at(-1)[1].diagnostics,diagnostics);
 healthy=false;await c.status({...event,force:true});
 assert.deepEqual(calls.filter(([kind])=>kind==='publish').at(-1)[1].diagnostics,diagnostics);
 await c.start('EE');assert.equal(c.diagnostics,null);
});
test('native disconnect invalidates a connected event queued before its browser probe starts',async()=>{
 let probes=0;const {c,calls}=setup(async()=>{probes++;return true;});await c.start('SE');
 const before=calls.length;const old=c.id;
 const queued=c.status({id:old,country:'SE',phase:'connected',proxy:candidate});
 const lost=c.lost();await Promise.all([queued,lost]);
 assert.notEqual(c.id,old);assert.equal(probes,0);assert.equal(c.active,null);
 assert.equal(calls.slice(before).some(([kind])=>kind==='apply'),false);
 assert.equal(calls.at(-1)[1].phase,'helper');assert.equal(c.enabled,true);
 // Previously delivered events from the old port remain invalid after the helper state.
 const after=calls.length;await c.status({id:old,country:'SE',phase:'connected',proxy:candidate});
 assert.equal(calls.length,after);
});

for(const pendingStage of ['apply','verifying'])for(const action of ['stop','lost','switch']) {
 test(`${action} during delayed ${pendingStage} cannot start an obsolete browser probe`,async()=>{
  let probes=0;const {c,calls}=setup(async()=>{probes++;return true;});await c.start('SE');
  let enter,release;const entered=new Promise(resolve=>{enter=resolve;});const held=new Promise(resolve=>{release=resolve;});
  const method=pendingStage==='apply'?'apply':'publish';const original=c.api[method];
  c.api[method]=async value=>{
   await original(value);
   if(pendingStage==='apply' || value.phase==='verifying'){enter();await held;}
  };
  const oldId=c.id;const checking=c.status({id:oldId,country:'SE',phase:'connected',proxy:candidate});
  await entered;
  const cancelled=action==='switch'?c.start('EE'):c[action]();
  release();await Promise.all([checking,cancelled]);
  assert.equal(probes,0,'cancelled generation must not create a fresh uncancelled probe');
  assert.notEqual(c.id,oldId);assert.equal(c.active,null);
  const statuses=calls.filter(([kind])=>kind==='publish').map(([,value])=>value);
  assert.equal(statuses.some(status=>status.phase==='connected'),false);
  assert.equal(statuses.at(-1).phase,{stop:'off',lost:'helper',switch:'searching'}[action]);
  if(action==='switch')assert.equal(c.country,'EE');
 });
}


const countryCatalog = JSON.parse(await readFile(new URL('../extension/countries.json', import.meta.url), 'utf8'));
test('fresh settings contain no preferred country and the full catalog remains eligible',()=>{
 assert.deepEqual(DEFAULTS,{countries:[],selected:null,selectedCountries:[],selectionMode:'single',enabled:false});
 const fresh=restoreCountrySettings({},countryCatalog);
 assert.deepEqual(fresh,{countries:[],selected:null,selectedCountries:[],selectionMode:'single',enabled:false,invalidEnabledSelection:false});
 assert.equal(countryCatalog.length,249);
 for(const code of countryCatalog)assert.equal(validateCountry(code,countryCatalog),code);
 for(const invalid of ['ZZ','EU','se',' NO ',null,{},[]])assert.throws(()=>validateCountry(invalid,countryCatalog));
});
test('saved country and favorites are independent and invalid enabled selection has no fallback',()=>{
 const restored=restoreCountrySettings({countries:['NO','EE','AT'],selected:'JP',enabled:true},countryCatalog);
 assert.deepEqual(restored,{countries:['NO','EE','AT'],selected:'JP',selectedCountries:['JP'],selectionMode:'single',enabled:true,invalidEnabledSelection:false});
 assert.deepEqual(restoreCountrySettings({countries:[],selected:'JP',enabled:true},countryCatalog),
  {...restored,countries:[]});
 for(const selected of ['ZZ',null,undefined,'no']) {
  const invalid=restoreCountrySettings({countries:['EE'],selected,enabled:true},countryCatalog);
  assert.equal(invalid.selected,null);assert.equal(invalid.enabled,false);assert.equal(invalid.invalidEnabledSelection,true);
 }
});

// Exercise the actual service worker message/startup branches with Chrome APIs replaced.
// No real proxy, browser profile, or network is used by these integration regressions.
async function backgroundHarness(saved={}, nativeOptions={}) {
 const previousChrome=globalThis.chrome;const previousFetch=globalThis.fetch;
 const state=structuredClone(saved);const calls=[];const nativeMessages=[];
 const listeners={};let route=null;let traceCountry='SE';let nativeAttempt=0;
 let externalSetting;
 const effective=()=>structuredClone(externalSetting ?? {value:route ?? {mode:'system'},
  levelOfControl:route?'controlled_by_this_extension':'controllable_by_this_extension'});
 const event=name=>({addListener:listener=>{listeners[name]=listener;}});
 const native={onMessage:event('nativeMessage'),onDisconnect:event('nativeDisconnect'),
  postMessage:value=>{nativeMessages.push(structuredClone(value));},disconnect:()=>{calls.push(['nativeDisconnect']);}};
 const privacySettings = Object.fromEntries(Object.entries({webRTCIPHandlingPolicy:'default',networkPredictionEnabled:true}).map(([name, initial]) => {
  let own, overlay;
  return [name, {onChange:event(name+'Change'),
   get:async()=>structuredClone(overlay ?? {value:own ?? initial,levelOfControl:own === undefined?'controllable_by_this_extension':'controlled_by_this_extension'}),
   set:async value=>{calls.push(['privacySet',value]);if(nativeOptions.privacyFailure?.({value,route}))throw Error('privacy policy denied');if(nativeOptions.privacySilentOverride?.({name,route}))overlay={value:initial,levelOfControl:'controlled_by_other_extensions'};else own=value.value;},
   clear:async()=>{calls.push(['privacyClear']);own=undefined;},
   override(value, notify=true){overlay=value;return notify?listeners[name+'Change']({...value}):undefined;}
  }];
 }));
 globalThis.chrome={
  declarativeNetRequest: (nativeOptions.gate ?? dnrFixture()).api,
  storage:{local:{get:async keys=>{
   await nativeOptions.beforeStorage?.(keys);
   if(keys==null)return structuredClone(state);
   return Object.fromEntries((typeof keys==='string'?[keys]:keys).filter(key=>key in state)
    .map(key=>[key,structuredClone(state[key])]));
  },set:async values=>{await nativeOptions.beforeStorageWrite?.(values);Object.assign(state,structuredClone(values));calls.push(['save',structuredClone(values)]);}}},
  proxy:{settings:{get:async()=>effective(),onChange:event('routeChange'),
   set:async({value})=>{await nativeOptions.beforeProxyWrite?.(value);route=structuredClone(value);calls.push(['route',route]);},
   clear:async()=>{route=null;calls.push(['clear']);}},onProxyError:event('proxyError')},
  privacy:{network:privacySettings},
  runtime:{id:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',getURL:path=>'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'+path,
   connectNative:()=>{calls.push(['nativeConnect']);
    if(nativeOptions.hello !== false)queueMicrotask(()=>listeners.nativeMessage({type:'hello',feedbackProtocol:nativeOptions.protocol ?? 1,sourceQuality:nativeOptions.sourceQuality}));
    return native;},
   onMessage:event('message'),onStartup:event('startup')},
  alarms:{create:async()=>{},clear:async()=>{},onAlarm:event('alarm')},
  action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}}
 };
 globalThis.fetch=async (url,options)=>{
  if(url==='chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/countries.json')return {json:async()=>countryCatalog};
  if(nativeOptions.beforeFetch)await nativeOptions.beforeFetch(url,options);
  if(url.startsWith('https://www.cloudflare.com/cdn-cgi/trace'))return new Response(`ip=8.8.4.4\nloc=${traceCountry}\n`.replaceAll('\\n','\n'),{status:200});
  if(url.startsWith('https://www.google.com/generate_204'))return new Response(null,{status:204});
  throw Error('Unexpected network URL in unit test');
 };
 const waitFor=async predicate=>{
  for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setImmediate(resolve));}
  assert.fail('Service worker did not reach the expected state');
 };
 const restore=()=>{globalThis.chrome=previousChrome;globalThis.fetch=previousFetch;};
 try {
  await import('../extension/background.js?test='+crypto.randomUUID());
  await waitFor(()=>calls.some(([key,value])=>key==='save'&&value.status));
  // Drain startup publication/hello microtasks before exposing or restoring globals.
  await new Promise(resolve=>setImmediate(resolve));
 } catch(error){restore();throw error;}
 return {state,calls,nativeMessages,privacySettings,get route(){return route;},restore,waitFor,
  overrideRoute(setting,notify=true){externalSetting=structuredClone(setting);if(notify)return listeners.routeChange(effective());},
  notifyRoute:change=>listeners.routeChange(change),
  send:message=>new Promise(resolve=>listeners.message(message,{id:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'},resolve)),
  emitRaw:value=>listeners.nativeMessage(value),
  emit:value=>listeners.nativeMessage({...value,...(value.type==='status'?{feedbackProtocol:1,attempt:++nativeAttempt}: {})}), setTrace:country=>{traceCountry=country;},
  proxyError:()=>listeners.proxyError(),
  alarm:()=>listeners.alarm({name:'reconnect'}), loseNative:()=>listeners.nativeDisconnect(),
  connect:async country=>{
   traceCountry=country;
   const reply=await new Promise(resolve=>listeners.message({action:'connect',country},{id:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'},resolve));
   assert.equal(reply.ok,true);
   const start=nativeMessages.at(-1);
   listeners.nativeMessage({type:'status',phase:'connected',id:start.id,country,proxy:{...candidate,country},feedbackProtocol:1,attempt:++nativeAttempt});
   await waitFor(()=>state.status?.phase==='connected');
  }
 };
}
test('service worker starts fresh without a country or native connection',async()=>{
 const h=await backgroundHarness();try {
  assert.equal(h.state.selected,null);assert.equal(h.state.enabled,false);assert.deepEqual(h.state.countries,[]);
  assert.equal(h.state.status.phase,'off');assert.equal(h.nativeMessages.length,0);assert.equal(h.route,null);
 } finally {h.restore();}
});
test('service worker connects every catalog country without adding it to favorites',async()=>{
 const h=await backgroundHarness({countries:['NO'],selected:'NO',enabled:false});try {
  for(const country of countryCatalog){
   assert.equal((await h.send({action:'connect',country})).ok,true);
   assert.equal(h.state.selected,country);assert.equal(h.nativeMessages.at(-1).country,country);
  }
  assert.deepEqual(h.state.countries,['NO']);assert.equal(h.nativeMessages.length,countryCatalog.length);
 } finally {h.restore();}
});
test('service worker preserves legacy preferences and resumes exact saved selection',async()=>{
 const h=await backgroundHarness({countries:['NO','EE','AT'],selected:'CA',enabled:true});try {
  assert.deepEqual(h.state.countries,['NO','EE','AT']);assert.equal(h.state.selected,'CA');
  assert.equal(h.nativeMessages.length,1);assert.equal(h.nativeMessages[0].country,'CA');
  assert.equal(h.state.status.country,'CA');assert.equal(h.state.status.phase,'searching');
 } finally {h.restore();}
});
test('editing or emptying favorites never changes a live country or restarts its connection',async()=>{
 const h=await backgroundHarness({countries:['SE','JP'],selected:'SE',enabled:false});try {
  await h.connect('SE');
  const status=structuredClone(h.state.status);const route=structuredClone(h.route);const messages=h.nativeMessages.length;
  for(const countries of [['JP'],[],['NO','AT']]){
   assert.equal((await h.send({action:'settings',add:countries.filter(code=>!h.state.countries.includes(code)),remove:h.state.countries.filter(code=>!countries.includes(code))})).ok,true);
   assert.deepEqual(h.state.countries,countries);assert.equal(h.state.selected,'SE');assert.equal(h.state.enabled,true);
   assert.deepEqual(h.state.status,status);assert.deepEqual(h.route,route);assert.equal(h.nativeMessages.length,messages);
  }
 } finally {h.restore();}
});
test('invalid connect and preferences leave connected status, settings and route unchanged',async()=>{
 const h=await backgroundHarness({countries:['SE'],selected:'SE',enabled:false});try {
  await h.connect('SE');const state=structuredClone(h.state);const route=structuredClone(h.route);const messages=h.nativeMessages.length;
  for(const message of [null,[],{},'connect',{action:'connect'},
   {action:'connect',country:'ZZ'},{action:'connect',country:'se'},
   {action:'connect',country:null},{action:'settings',countries:['ZZ']},{action:'settings',countries:null},
   {action:'settings',countries:[{}]},{action:'not-supported'}]){
   assert.equal((await h.send(message)).ok,false);assert.deepEqual(h.state,state);
   assert.deepEqual(h.route,route);assert.equal(h.nativeMessages.length,messages);
  }
 } finally {h.restore();}
});
test('invalid saved enabled selection remains blocked until explicit valid selection or stop',async()=>{
 for(const action of ['connect','disconnect']) {
  const h=await backgroundHarness({countries:['EE'],selected:'ZZ',enabled:true});try {
   assert.equal(h.state.selected,'ZZ');assert.equal(h.state.enabled,true);assert.equal(h.nativeMessages.length,0);
   assert.equal(h.state.status.phase,'error');assert.deepEqual(h.route,BLOCKED);
   assert.equal((await h.send({action,country:'JP'})).ok,true);
   if(action==='connect'){
    assert.equal(h.state.selected,'JP');assert.equal(h.state.enabled,true);assert.equal(h.nativeMessages.at(-1).country,'JP');
    assert.equal(h.state.status.phase,'searching');
   }else{assert.equal(h.state.enabled,false);assert.equal(h.state.status.phase,'off');assert.equal(h.route,null);}
  } finally {h.restore();}
 }
});


test('selected set is nonempty, canonical and independent of input order and favorites',()=>{
 assert.deepEqual(normalizeSelection(['PL','EE','NO','EE'],countryCatalog),['EE','NO','PL']);
 assert.deepEqual(normalizeSelection(['NO','PL','EE'],countryCatalog),['EE','NO','PL']);
 for(const invalid of [[],null,'EE',['EE','ZZ'],['ee'],[null]])assert.throws(()=>normalizeSelection(invalid,countryCatalog));
 const saved={countries:['AT'],selectionMode:'multiple',selected:null,selectedCountries:['PL','EE','NO'],enabled:true};
 assert.deepEqual(restoreCountrySettings(saved,countryCatalog),{...saved,selectedCountries:['EE','NO','PL'],invalidEnabledSelection:false});
 for(const selectedCountries of [[],['EE','ZZ'],null]){
  const restored=restoreCountrySettings({...saved,selected:'AT',selectedCountries},countryCatalog);
  assert.equal(restored.enabled,false);assert.equal(restored.invalidEnabledSelection,true);
  assert.deepEqual(restored.selectedCountries,[]);assert.equal(restored.selected,null);
 }
});
test('equal country pool accepts each member and retains the set across replacements',async()=>{
 const probes=[];const {c,calls}=setup(async countries=>{probes.push(countries);return true;});
 await c.start(['NO','PL','EE']);const id=c.id;
 assert.equal(c.country,null);assert.deepEqual(c.countries,['EE','NO','PL']);
 assert.deepEqual(calls.find(([k])=>k==='startNative')[1],{command:'start',country:null,countries:['EE','NO','PL'],id,feedbackProtocol:1});
 let index=1;
 for(const country of ['PL','NO','EE']){
  await c.status({id,countries:['EE','NO','PL'],country,phase:'connected',proxy:{...candidate,host:`8.8.8.${index++}`,country}});
  assert.equal(c.active.country,country);
  const latest=calls.filter(([k])=>k==='publish').at(-1)[1];
  assert.equal(latest.phase,'connected');assert.equal(latest.country,country);assert.deepEqual(latest.countries,['EE','NO','PL']);
  await c.status({id,countries:['EE','NO','PL'],country:null,phase:'pool',reserveCount:2,reserveExpiresAt:Date.now()+90000});
  assert.deepEqual(calls.at(-1)[1].pool.countries,['EE','NO','PL']);
  await c.status({id,countries:['EE','NO','PL'],country:null,phase:'replacing',proxy:null});
 }
 assert.deepEqual(probes,[['EE','NO','PL'],['EE','NO','PL'],['EE','NO','PL']]);
 assert.equal(calls.filter(([k,v])=>k==='save'&&v.enabled===true).length,1);
 assert.equal(calls.filter(([k])=>k==='startNative').length,1);
});
test('foreign native and browser egress never establishes a multi-country connection',async()=>{
 for(const foreign of ['native','browser']){
  const {c,calls}=setup(async()=>({ok:true,country:foreign==='browser'?'JP':'EE'}));
  await c.start(['EE','NO','PL']);const before=calls.length;
  await c.status({id:c.id,countries:['EE','NO','PL'],country:'EE',phase:'connected',proxy:{...candidate,country:foreign==='native'?'JP':'EE'}});
  assert.equal(c.active,null);assert.equal(calls.at(-1)[0],'rotate');
  assert.ok(!calls.slice(before).some(([k,v])=>k==='publish'&&v.phase==='connected'));
  if(foreign==='native')assert.ok(!calls.slice(before).some(([k])=>k==='apply'));
  assert.ok(calls.slice(before).some(([k])=>k==='block'));
 }
});
test('stale generation or a different permitted set cannot replace multi-country route',async()=>{
 const {c,calls}=setup();await c.start(['EE','NO','PL']);const old=c.id;
 await c.start(['AT','EE','PL']);const before=calls.length;
 await c.status({id:old,countries:['EE','NO','PL'],country:'PL',phase:'connected',proxy:{...candidate,country:'PL'}});
 await c.status({id:c.id,countries:['EE','NO','PL'],country:'PL',phase:'connected',proxy:{...candidate,country:'PL'}});
 assert.equal(calls.length,before);assert.equal(c.active,null);
});
test('changing the allowed set cancels an in-flight browser verification',async()=>{
 let finish;const {c,calls}=setup(()=>new Promise(resolve=>{finish=resolve;}));
 await c.start(['EE','NO','PL']);
 const check=c.status({id:c.id,countries:['EE','NO','PL'],country:'PL',phase:'connected',proxy:{...candidate,country:'PL'}});
 await new Promise(resolve=>setImmediate(resolve));const change=c.start(['AT','DE']);finish(true);
 await Promise.all([check,change]);assert.equal(c.active,null);assert.deepEqual(c.countries,['AT','DE']);
 assert.equal(calls.filter(([k,v])=>k==='publish'&&v.phase==='connected').length,0);
});
test('browser probe verifies actual egress against any member of an allowed set',async()=>{
 for(const country of ['NO','EE','PL','JP']){
  const fetcher=async url=>url.includes('cloudflare')?new Response(`ip=8.8.4.4\nloc=${country}\n`,{status:200}):new Response(null,{status:204});
  const result=await probeBrowser(['EE','NO','PL'],new AbortController().signal,{fetcher});
  assert.equal(result.ok,country!=='JP');assert.equal(result.country,country);
  if(country==='JP')assert.equal(result.reason,'country');
 }
});
test('service worker persists multi-country mode, independent favorites and restores same set after helper loss',async()=>{
 const h=await backgroundHarness({countries:['AT'],selected:'AT',enabled:false});try{
  assert.equal((await h.send({action:'connect',countries:['PL','EE','NO']})).ok,true);
  assert.deepEqual(h.state.selectedCountries,['EE','NO','PL']);assert.equal(h.state.selected,null);assert.equal(h.state.selectionMode,'multiple');
  const start=h.nativeMessages.findLast(message=>message.command==='start');h.setTrace('PL');
  h.emit({type:'status',id:start.id,countries:['EE','NO','PL'],country:'PL',phase:'connected',proxy:{...candidate,country:'PL'}});
  await h.waitFor(()=>h.state.status.phase==='connected');
  const status=structuredClone(h.state.status),route=structuredClone(h.route),count=h.nativeMessages.length;
  for(const msg of [{action:'settings',add:[],remove:['AT']},{action:'settings',add:['NO'],remove:[]}])assert.equal((await h.send(msg)).ok,true);
  assert.deepEqual(h.state.status,status);assert.deepEqual(h.route,route);assert.equal(h.nativeMessages.length,count);
  for(const msg of [{action:'connect',countries:[]},{action:'connect',countries:['PL','ZZ']},{action:'connect',country:'EE',countries:['EE']}]){
   const before=structuredClone(h.state);assert.equal((await h.send(msg)).ok,false);assert.deepEqual(h.state,before);assert.deepEqual(h.route,route);
  }
  h.loseNative();await h.waitFor(()=>h.state.status.phase==='helper');assert.deepEqual(h.route,BLOCKED);
  await h.alarm();await h.waitFor(()=>h.nativeMessages.length>count);
  assert.deepEqual(h.nativeMessages.at(-1).countries,['EE','NO','PL']);assert.equal(h.state.selected,null);
 }finally{h.restore();}
});
test('saved multi-country choice restores without falling back to the old selected country',async()=>{
 const h=await backgroundHarness({countries:[],selected:'AT',selectedCountries:['PL','NO','EE'],selectionMode:'multiple',enabled:true});try{
  assert.equal(h.nativeMessages.length,1);assert.deepEqual(h.nativeMessages[0].countries,['EE','NO','PL']);
  assert.equal(h.state.selected,null);assert.deepEqual(h.state.status.countries,['EE','NO','PL']);
 }finally{h.restore();}
 for(const selectedCountries of [[],['EE','ZZ'],null]){
  const x=await backgroundHarness({selected:'AT',selectedCountries,selectionMode:'multiple',enabled:true});try{
   assert.equal(x.nativeMessages.length,0);assert.equal(x.state.status.phase,'error');assert.deepEqual(x.route,BLOCKED);
   assert.deepEqual(x.state.selectedCountries,selectedCountries);
  }finally{x.restore();}
 }
});
test('multi mode with one selected country remains multi and singleton connect restores single mode',async()=>{
 const h=await backgroundHarness();try{
  assert.equal((await h.send({action:'connect',countries:['JP']})).ok,true);
  assert.equal(h.state.selectionMode,'multiple');assert.equal(h.state.selected,null);assert.deepEqual(h.state.selectedCountries,['JP']);
  assert.equal((await h.send({action:'connect',country:'EE'})).ok,true);
  assert.equal(h.state.selectionMode,'single');assert.equal(h.state.selected,'EE');assert.deepEqual(h.state.selectedCountries,['EE']);
 }finally{h.restore();}
});


// Statistics must keep censored and failed trials visible.
import {summary as recoverySummary} from './controller-benchmark.mjs';
test('recovery benchmark excludes timeouts and failures from successful quantiles',()=>{
 const s=recoverySummary([...Array.from({length:18},(_,i)=>({outcome:'success',elapsedMs:i+1})),
   {outcome:'timeout',censoredAfterMs:2000},{outcome:'failure',elapsedMs:999}]);
 assert.equal(s.total,20);assert.equal(s.successes,18);assert.equal(s.timeouts,1);assert.equal(s.failures,1);
 assert.deepEqual(s.successfulLatencyMs,{n:18,median:9,p95:18,max:18});
});
test('recovery benchmark absent successful latency remains null',()=>{
 const s=recoverySummary([{outcome:'timeout',censoredAfterMs:2000}]);
 assert.deepEqual(s.successfulLatencyMs,{n:0,median:null,p95:null,max:null});
 assert.equal(s.timeouts,1);assert.equal(s.successes,0);
});


function addressedStatus(c, proxy=candidate, attempt=1, extra={}) {
 return {id:c.id,countries:[...c.countries],phase:'connected',proxy,feedbackProtocol:1,attempt,...extra};
}
test('addressed browser rejection of A never targets an already offered B and probes stay serial',async()=>{
 let finish,live=0,maxLive=0,probes=0;
 const {c,calls}=setup(async()=>{
  probes++;live++;maxLive=Math.max(maxLive,live);
  const result=probes===1?await new Promise(resolve=>{finish=resolve;}):true;
  live--;return result;
 },true);
 await c.start('SE');const a=addressedStatus(c),b=addressedStatus(c,{...candidate,host:'1.1.1.1'},2);
 let nativeOffer=b,incorrectRejects=0;
 c.api.reject=async message=>{calls.push(['reject',message]);if(message.attempt===nativeOffer.attempt)incorrectRejects++;};
 const checkingA=c.status(a);await new Promise(resolve=>setImmediate(resolve));
 const checkingB=c.status(b);finish(false);await Promise.all([checkingA,checkingB]);
 assert.equal(incorrectRejects,0);assert.equal(maxLive,1);assert.equal(probes,2);assert.equal(c.active.host,b.proxy.host);
 assert.deepEqual(calls.filter(([k])=>k==='reject').map(([,v])=>v),[
  {command:'reject',id:a.id,attempt:1,proxy:{scheme:'http',host:candidate.host,port:candidate.port},reason:'transport'}]);
 assert.deepEqual(calls.filter(([k])=>k==='confirm').map(([,v])=>v),[
  {command:'confirm',id:b.id,attempt:2,proxy:{scheme:'http',host:b.proxy.host,port:b.proxy.port}}]);
 const before=calls.length;await c.status(a);await c.status({...a,force:true});assert.equal(calls.length,before);
 assert.equal(calls.filter(([k])=>k==='rotate').length,0);
});
test('new native offer of cached rejected endpoint is explicitly rejected without another probe',async()=>{
 let probes=0;const {c,calls}=setup(async()=>{probes++;return false;},true);await c.start('SE');
 const a=addressedStatus(c);await c.status(a);await c.status(a);await c.status({...a,attempt:2});await c.status({...a,attempt:2});
 assert.equal(probes,1);assert.deepEqual(calls.filter(([k])=>k==='reject').map(([,v])=>v.attempt),[1,2]);
});
test('automatic health recheck carries its original offer and ignores an older attempt at the same endpoint',async()=>{
 let healthy=true;const {c,calls}=setup(async()=>healthy,true);await c.start('SE');
 const a=addressedStatus(c);await c.status(a);await c.status({...a,attempt:2});
 const before=calls.length;await c.status({...a,force:true});await c.status({...a,phase:'confirming'});assert.equal(calls.length,before);
 healthy=false;await c.recheck();assert.equal(c.active,null);
 assert.equal(calls.at(-1)[0],'reject');assert.equal(calls.at(-1)[1].attempt,2);
});
test('overlapping rechecks share only the pending verification and a later trigger is fresh',async()=>{
 let probes=0,finish;
 const {c,calls}=setup(async()=>{
  probes++;
  if(probes===2)await new Promise(resolve=>{finish=resolve;});
  return {ok:true,country:'AT',exitIp:'192.0.2.81'};
 },true);
 await c.start(['NO','AT','EE']);
 await c.status(addressedStatus(c,{...candidate,country:'AT',exitIp:'192.0.2.81'}));
 const first=c.recheck(),queued=c.recheck();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(probes,2);
 const overlapping=c.recheck();finish();
 await Promise.all([first,queued,overlapping]);
 assert.equal(probes,2,'one HTTPS pair serves overlapping identical requests');
 assert.deepEqual(c.countries,['AT','EE','NO']);
 assert.equal(calls.filter(([kind])=>kind==='confirm').length,2);
 await c.recheck();assert.equal(probes,3,'completed result is not a recheck cache');
});
test('forced recheck can join an actual pending periodic browser verification',async()=>{
 let probes=0,finish;
 const {c}=setup(async()=>{
  probes++;if(probes===2)await new Promise(resolve=>{finish=resolve;});
  return {ok:true,country:'EE',exitIp:'192.0.2.82'};
 },true);
 await c.start(['AT','EE','NO']);
 const offer=addressedStatus(c,{...candidate,country:'EE',exitIp:'192.0.2.82'});
 await c.status(offer);c.lastBrowserCheck=0;
 const periodic=c.status(offer);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(probes,2);
 const forced=c.recheck();finish();await Promise.all([periodic,forced]);
 assert.equal(probes,2);
});
for(const stage of ['verifyRoute','confirm','publish'])test('a new recheck after HTTPS completion is fresh while '+stage+' is pending',async()=>{
 let probes=0,release,held=false;
 const {c,calls}=setup(async()=>++probes<3?{ok:true,country:'AT',exitIp:'192.0.2.83'}:{ok:false,reason:'http',endpoint:'target'},true);
 await c.start(['AT','EE','NO']);
 await c.status(addressedStatus(c,{...candidate,country:'AT',exitIp:'192.0.2.83'}));
 const original=c.api[stage] || (async()=>{});
 c.api[stage]=async(...args)=>{
  if(probes===2&&!held&&(stage!=='publish'||args[0].phase==='connected')){
   held=true;await new Promise(resolve=>{release=resolve;});
  }
  return original(...args);
 };
 const first=c.recheck();
 await new Promise(resolve=>setImmediate(resolve));assert.equal(typeof release,'function');
 const fresh=c.recheck();release();await Promise.all([first,fresh]);
 assert.equal(probes,3,'a fresh error after HTTPS completion must not reuse that result');
 assert.equal(c.active,null);
 assert.equal(calls.filter(([kind])=>kind==='reject').length,1);
 assert.equal(c.lastFailure.reason,'http');
});
for(const reason of ['country','http','transport'])test('overlapping rechecks preserve one addressed '+reason+' rejection',async()=>{
 let probes=0,finish;
 const {c,calls}=setup(async()=>{
  probes++;if(probes===1)return {ok:true,country:'AT',exitIp:'192.0.2.84'};
  await new Promise(resolve=>{finish=resolve;});
  return {ok:false,reason,endpoint:'trace'};
 },true);
 await c.start(['AT','EE','NO']);
 await c.status(addressedStatus(c,{...candidate,country:'AT',exitIp:'192.0.2.84'}));
 const first=c.recheck();await new Promise(resolve=>setImmediate(resolve));
 const second=c.recheck();finish();await Promise.all([first,second]);
 assert.equal(probes,2);assert.equal(c.active,null);
 assert.deepEqual(calls.filter(([kind])=>kind==='reject').map(([,message])=>message.reason),[reason]);
});
test('disconnect cancels a shared pending recheck without late confirmation',async()=>{
 let probes=0,finish,signal;
 const {c,calls}=setup(async(_countries,owner)=>{
  probes++;if(probes===2){signal=owner;await new Promise(resolve=>{finish=resolve;});}
  return {ok:true,country:'AT',exitIp:'192.0.2.85'};
 },true);
 await c.start(['AT','EE','NO']);
 await c.status(addressedStatus(c,{...candidate,country:'AT',exitIp:'192.0.2.85'}));
 const first=c.recheck();await new Promise(resolve=>setImmediate(resolve));const second=c.recheck();
 const stop=c.stop();assert.equal(signal.aborted,true);finish();await Promise.all([first,second,stop]);
 assert.equal(c.enabled,false);assert.equal(c.active,null);
 assert.equal(calls.filter(([kind])=>kind==='confirm').length,1);
 assert.equal(calls.filter(([kind])=>kind==='reject').length,0);
 await c.start(['AT','NO']);
 await c.status(addressedStatus(c,{...candidate,country:'AT',exitIp:'192.0.2.85'}));
 await c.recheck();assert.equal(probes,4,'new generation cannot reuse the retired shared operation');
});
test('withdrawing an offer interrupts just its probe; even a late success cannot confirm or penalize it', async () => {
 const gates = [], seen = [];
 const {c,calls} = setup(async (_selection, signal) => {
  seen.push(signal);
  return new Promise(resolve => gates.push(resolve));
 }, true);
 await c.start(['NO','EE']);
 const a = addressedStatus(c,{...candidate,country:'EE'});
 const b = addressedStatus(c,{...candidate,country:'NO',host:'1.1.1.1'},2);
 const withdraw = offer => ({...offer,phase:'replacing',proxy:null});
 const checkingA = c.status(a);
 await new Promise(resolve => setImmediate(resolve));
 assert.equal(seen.length,1);
 const replacing = c.status(withdraw(a));
 assert.equal(seen[0].aborted,true);
 gates[0](true); // Simulate a completed fetch delivering success after cancellation.
 await Promise.all([checkingA,replacing]);
 assert.equal(calls.some(([k,v]) => k==='reject'||k==='confirm'||(k==='publish' && v.phase==='connected')),false);
 const checkingB = c.status(b);
 await new Promise(resolve => setImmediate(resolve));
 const late = c.status(withdraw(a));
 assert.equal(seen[1].aborted,false);
 gates[1](true);
 await Promise.all([checkingB,late]);
 assert.equal(c.active.host,b.proxy.host);
 assert.deepEqual(calls.filter(([k])=>k==='confirm').map(([,m])=>m.attempt),[2]);
});
test('withdrawing before queued offer begins skips its apply and probe', async () => {
 const {c,calls} = setup(async()=>{throw Error('withdrawn offer probed');},true);
 await c.start('SE'); const a=addressedStatus(c);
 await Promise.all([c.status(a),c.status({...a,phase:'replacing',proxy:null})]);
 assert.equal(calls.some(([k])=>['apply','reject','confirm'].includes(k)),false);
 assert.equal(calls.filter(([k])=>k==='publish').at(-1)[1].phase,'replacing');
});
test('a replaced offer cannot reconnect from a queued same-attempt connected event',async()=>{
 const {c,calls}=setup(async()=>true,true);await c.start('SE');const a=addressedStatus(c);await c.status(a);
 await c.status({...a,phase:'replacing',proxy:null});const before=calls.length;await c.status(a);
 assert.equal(calls.length,before);assert.equal(c.active,null);
});
for(const invalid of [{feedbackProtocol:undefined},{attempt:undefined},{attempt:0},{attempt:1.5},{attempt:Number.MAX_SAFE_INTEGER+1},{proxy:null}]){
 test('addressed controller blocks an incompatible offer '+JSON.stringify(invalid),async()=>{
  let probes=0;const {c,calls}=setup(async()=>{probes++;return true;},true);await c.start('SE');
  await c.status(addressedStatus(c,candidate,1,invalid));assert.equal(probes,0);assert.equal(c.active,null);
  assert.equal(calls.some(([k])=>k==='apply'),false);assert.equal(calls.at(-1)[1].phase,'error');
  assert.match(calls.at(-1)[1].error,/Несовместимый/);
 });
}
for(const action of ['stop','lost','start']){
 test('cancellation during rejection publication sends no stale addressed feedback: '+action,async()=>{
  const {c,calls}=setup(async()=>false,true);await c.start('SE');
  let entered,release;const pending=new Promise(r=>{entered=r;}),held=new Promise(r=>{release=r;});
  const publish=c.api.publish;c.api.publish=async value=>{await publish(value);if(value.phase==='replacing'){entered();await held;}};
  const checking=c.status(addressedStatus(c));await pending;
  const cancel=action==='start'?c.start('EE'):c[action]();release();await Promise.all([checking,cancel]);
  assert.equal(calls.some(([k])=>k==='reject'||k==='confirm'),false);
 });
}
test('native capability mismatch aborts an active probe immediately and leaves the blocked error',async()=>{
 let started;const entered=new Promise(r=>{started=r;});let aborted=false;
 const {c,calls}=setup(async(_country,signal)=>{started();await new Promise(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));return {ok:false,reason:'cancelled'};},true);
 await c.start('SE');const checking=c.status(addressedStatus(c));await entered;
 await c.incompatible();await checking;
 assert.equal(aborted,true);assert.equal(c.active,null);assert.equal(calls.at(-1)[1].phase,'error');
 assert.equal(calls.some(([k])=>k==='reject'||k==='confirm'),false);
});
test('background rejects older native hello before sending start or applying a proxy',async()=>{
 const h=await backgroundHarness({}, {protocol:0});try{
  await h.send({action:'connect',country:'SE'});await h.waitFor(()=>h.state.status.phase==='error');
  assert.equal(h.nativeMessages.length,0);assert.deepEqual(h.route,BLOCKED);assert.match(h.state.status.error,/Несовместимый/);
 }finally{h.restore();}
});
test('background bounds missing hello and never sends a start to a silent helper',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const h=await backgroundHarness({}, {hello:false});try{
  await h.send({action:'connect',country:'SE'});assert.equal(h.nativeMessages.length,0);assert.deepEqual(h.route,BLOCKED);
  t.mock.timers.tick(5000);await h.waitFor(()=>h.state.status.phase==='error');
  assert.equal(h.nativeMessages.length,0);assert.deepEqual(h.route,BLOCKED);
 }finally{h.restore();}
});
test('pending native hello sends only the latest start and stop cancels a later hello',async()=>{
 const h=await backgroundHarness({}, {hello:false});try{
  await h.send({action:'connect',country:'SE'});await h.send({action:'connect',country:'EE'});
  assert.equal(h.nativeMessages.length,0);h.emitRaw({type:'hello',feedbackProtocol:1});
  assert.equal(h.nativeMessages.length,1);assert.equal(h.nativeMessages[0].country,'EE');
  await h.send({action:'disconnect'});const before=h.nativeMessages.length;
  h.emitRaw({type:'hello',feedbackProtocol:1});assert.equal(h.nativeMessages.length,before);assert.equal(h.route,null);
 }finally{h.restore();}
});
test('actual background emits addressed rejection and manual rotation remains separate',async()=>{
 const h=await backgroundHarness();try{
  await h.send({action:'connect',country:'SE'});const start=h.nativeMessages.at(-1);h.setTrace('JP');
  h.emitRaw({type:'status',phase:'connected',id:start.id,countries:['SE'],proxy:candidate,feedbackProtocol:1,attempt:7});
  await h.waitFor(()=>h.nativeMessages.some(m=>m.command==='reject'));
  assert.deepEqual(h.nativeMessages.at(-1),{command:'reject',id:start.id,attempt:7,proxy:{scheme:'http',host:candidate.host,port:candidate.port},reason:'country'});
  await h.send({action:'rotate'});assert.deepEqual(h.nativeMessages.at(-1),{command:'rotate',id:start.id});assert.deepEqual(h.route,BLOCKED);
 }finally{h.restore();}
});
test('actual background rejects status without addressed capability even after a valid hello',async()=>{
 const h=await backgroundHarness();try{
  await h.send({action:'connect',country:'SE'});const start=h.nativeMessages.at(-1);
  h.emitRaw({type:'status',phase:'connected',id:start.id,country:'SE',proxy:candidate});
  await h.waitFor(()=>h.state.status.phase==='error');assert.deepEqual(h.route,BLOCKED);
  assert.equal(h.nativeMessages.some(m=>['reject','confirm','rotate'].includes(m.command)),false);
 }finally{h.restore();}
});

test('late replacing for an older native offer cannot retire the verified replacement',async()=>{
 const {c,calls}=setup(async()=>true,true);await c.start('SE');const a=addressedStatus(c),b=addressedStatus(c,{...candidate,host:'1.1.1.1'},2);
 await c.status(a);await c.status(b);const before=calls.length;
 await c.status({...a,phase:'replacing',proxy:null});assert.equal(calls.length,before);assert.equal(c.active.host,b.proxy.host);
});
test('background ignores malformed old-generation status without invalidating the current route',async()=>{
 const h=await backgroundHarness();try{
  await h.connect('SE');const before=structuredClone(h.state.status),route=structuredClone(h.route);
  h.emitRaw({type:'status',id:'old-generation',phase:'connected'});
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(h.state.status,before);assert.deepEqual(h.route,route);
 }finally{h.restore();}
});

test('actual background health failure checks and rejects the exact verified offer',async()=>{
 const h=await backgroundHarness();try{
  await h.connect('SE');const start=h.nativeMessages.find(m=>m.command==='start');h.setTrace('JP');
  h.proxyError();await h.waitFor(()=>h.nativeMessages.some(m=>m.command==='reject'));
  assert.ok(h.nativeMessages.some(m=>m.command==='check'&&m.id===start.id));
  assert.deepEqual(h.nativeMessages.at(-1),{command:'reject',id:start.id,attempt:1,proxy:{scheme:'http',host:candidate.host,port:candidate.port},reason:'country'});
  assert.equal(h.nativeMessages.some(m=>m.command==='rotate'),false);assert.deepEqual(h.route,BLOCKED);
 }finally{h.restore();}
});
test('out-of-selection native offer sends addressed country rejection without applying it',async()=>{
 let probes=0;const {c,calls}=setup(async()=>{probes++;return true;},true);await c.start(['EE','NO']);
 await c.status(addressedStatus(c,{...candidate,country:'JP'},5));
 assert.equal(probes,0);assert.equal(calls.some(([k])=>k==='apply'),false);
 assert.deepEqual(calls.at(-1),['reject',{command:'reject',id:c.id,attempt:5,proxy:{scheme:'http',host:candidate.host,port:candidate.port},reason:'country'}]);
});


for(const blockerFails of [false,true])test('partial candidate route write followed by privacy failure stops neutrally; blocker failure='+blockerFails,async()=>{
 let probes=0,route;const {c,calls}=setup(async()=>{probes++;return true;},true);await c.start('SE');
 c.api.apply=async value=>{route=value;calls.push(['apply',value]);throw Error('privacy policy denied');};
 c.api.block=async()=>{route=BLOCKED;calls.push(['block']);if(blockerFails)throw Error('privacy still denied');};
 const old=c.id;await c.status(addressedStatus(c));
 assert.notEqual(c.id,old);assert.deepEqual(route,BLOCKED);assert.equal(probes,0);assert.equal(c.active,null);
 assert.equal(c.enabled,true);assert.equal(c.suspended,true);assert.equal(c.rejected.size,0);
 assert.equal(calls.filter(([k])=>k==='stopNative').length,1);
 assert.equal(calls.some(([k])=>k==='reject'||k==='confirm'||k==='rotate'),false);
 assert.equal(calls.at(-1)[1].phase,'error');assert.match(calls.at(-1)[1].error,/privacy policy denied/);
 assert.equal(calls.at(-1)[1].error.includes('Не удалось подтвердить блокировку'),blockerFails);
 assert.ok(calls.some(([k,v])=>k==='save'&&v.enabled===true));
});
for(const failureStage of ['verifying','connected','confirm','reject','probe'])test('local '+failureStage+' infrastructure failure blocks and stops the native gate',async()=>{
 const {c,calls}=setup(async()=>failureStage==='probe'?Promise.reject(Error('local probe failed')):failureStage!=='reject',true);
 await c.start('SE');let route;
 c.api.apply=async value=>{route=value;calls.push(['apply',value]);};c.api.block=async()=>{route=BLOCKED;calls.push(['block']);};
 const publish=c.api.publish;c.api.publish=async value=>{if(value.phase===failureStage)throw Error('local publish failed');await publish(value);};
 if(['confirm','reject'].includes(failureStage))c.api[failureStage]=async()=>{throw Error('local feedback failed');};
 await c.status(addressedStatus(c));
 assert.deepEqual(route,BLOCKED);assert.equal(c.suspended,true);assert.equal(c.active,null);
 assert.equal(calls.at(-1)[1].phase,'error');assert.ok(calls.some(([k])=>k==='stopNative'));
 if(failureStage!=='reject')assert.equal(c.rejected.size,0,'local infrastructure must not penalize an endpoint');
});
for(const action of ['stop','start'])test('late partial apply failure cannot overwrite newer '+action+' intent',async()=>{
 const {c,calls}=setup(async()=>true,true);await c.start('SE');
 let entered,release;const ready=new Promise(r=>{entered=r;}),held=new Promise(r=>{release=r;});
 c.api.apply=async()=>{entered();await held;throw Error('late privacy failure');};
 const checking=c.status(addressedStatus(c));await ready;const later=action==='stop'?c.stop():c.start('EE');release();
 await Promise.all([checking,later]);assert.equal(c.suspended,false);
 assert.equal(calls.some(([k,v])=>k==='publish'&&v.phase==='error'),false);
 if(action==='stop')assert.equal(calls.at(-1)[1].phase,'off');
 if(action==='start'){assert.equal(c.country,'EE');assert.equal(c.enabled,true);}else assert.equal(c.enabled,false);
});
test('actual background partial privacy failure preserves blocked intent, suppresses retry, and allows disconnect',async()=>{
 let failed=false;const h=await backgroundHarness({}, {privacyFailure:({route})=>{
  if(route?.rules?.proxyForHttps.port===candidate.port&&!failed){failed=true;return true;}return false;
 }});let saved;
 try{
  await h.send({action:'connect',country:'SE'});const start=h.nativeMessages.at(-1);
  h.emitRaw({type:'status',phase:'connected',id:start.id,countries:['SE'],proxy:candidate,feedbackProtocol:1,attempt:1});
  await h.waitFor(()=>h.state.status.phase==='error');
  assert.equal(failed,true);assert.deepEqual(h.route,BLOCKED);assert.equal(h.state.enabled,true);assert.equal(h.state.selected,'SE');
  assert.equal(h.nativeMessages.at(-1).command,'stop');assert.equal(h.nativeMessages.some(m=>['reject','confirm'].includes(m.command)),false);
  const count=h.nativeMessages.length;await h.alarm();await new Promise(r=>setImmediate(r));assert.equal(h.nativeMessages.length,count);
  saved=structuredClone(h.state);
  assert.equal((await h.send({action:'disconnect'})).ok,true);assert.equal(h.route,null);assert.equal(h.state.status.phase,'off');
 }finally{h.restore();}
 const restarted=await backgroundHarness(saved);try{
  await restarted.waitFor(()=>restarted.state.status.phase==='searching');
  await restarted.waitFor(()=>restarted.nativeMessages.some(message=>message.command==='start'));
  assert.equal(restarted.state.enabled,true);assert.equal(restarted.state.status.phase,'searching');assert.deepEqual(restarted.route,BLOCKED);
  await restarted.send({action:'disconnect'});
 }finally{restarted.restore();}
});

for(const action of ['connect','disconnect'])test('actual background '+action+' infrastructure error responds false and preserves the user intent',async()=>{
 let fail=false;const h=await backgroundHarness({}, {privacyFailure:()=>fail});try{
  if(action==='disconnect'){
   await h.connect('SE');
   // The clear path can fail independently of the candidate and blocker writes.
   const before=h.route;
   const original=chrome.proxy.settings.clear;chrome.proxy.settings.clear=async()=>{throw Error('clear denied');};
   const reply=await h.send({action});assert.equal(reply.ok,false);chrome.proxy.settings.clear=original;
   assert.equal(h.state.enabled,false);assert.equal(h.state.status.phase,'stopError');assert.deepEqual(h.route,BLOCKED);
   assert.match(h.state.status.error,/clear denied/);
   assert.equal((await h.send({action})).ok,true);assert.equal(h.state.status.phase,'off');assert.equal(h.route,null);
  }else{
   fail=true;const reply=await h.send({action,country:'SE'});assert.equal(reply.ok,false);
   assert.equal(h.state.enabled,true);assert.equal(h.state.status.phase,'error');assert.deepEqual(h.route,BLOCKED);
   assert.equal(h.state.status.lastFailure.stage,'local');assert.match(h.state.status.error,/Автоматические попытки остановлены/);
  }
 }finally{h.restore();}
});

test('source diagnostics support simultaneous country reads without changing the route', async () => {
  const h = await backgroundHarness({}, {sourceQuality: 1});
  try {
    assert.equal((await h.send({action: 'sourceQuality', country: 'NO'})).report, null);
    assert.equal(h.nativeMessages.length, 0);
    await h.send({action: 'connect', countries: ['EE','NO']});
    const first = h.send({action: 'sourceQuality', country: 'EE'});
    const second = h.send({action: 'sourceQuality', country: 'NO'});
    await h.waitFor(() => h.nativeMessages.filter(m => m.command === 'sourceQuality').length === 2);
    const requests = h.nativeMessages.filter(m => m.command === 'sourceQuality');
    const selectedRoute = structuredClone(h.route);
    const answer = m => h.emitRaw({type:'sourceQuality',id:m.id,token:m.token,report:{country:m.country}});
    answer({...requests[0], id:'stale-generation'});
    for (const m of requests.toReversed()) answer(m);
    assert.deepEqual((await Promise.all([first,second])).map(r => r.report.country), ['EE','NO']);
    assert.deepEqual(h.route, selectedRoute);
    assert.equal((await h.send({action:'sourceQuality',country:'SE'})).report, null);
    const pending = h.send({action:'sourceQuality',country:'NO'});
    await h.waitFor(() => h.nativeMessages.filter(m => m.command === 'sourceQuality').length === 3);
    await h.send({action:'disconnect'});
    assert.equal((await pending).report, null);
  } finally { h.restore(); }
});

test('effective route requires ownership, all protocols and the exact bypass rule', () => {
  const wanted = proxyConfig(candidate);
  const setting = () => ({levelOfControl:'controlled_by_this_extension',value:JSON.parse(JSON.stringify(wanted))});
  const normalized = setting();
  normalized.value.rules.fallbackProxy.scheme = 'socks4';
  assert.equal(matchesEffectiveRoute(normalized,wanted),true);
  for (const mutate of [
    s=>{s.levelOfControl='controlled_by_other_extensions';}, s=>{s.value.mode='direct';},
    s=>{s.value.rules.proxyForHttp.port++;}, s=>{s.value.rules.proxyForHttps.scheme='socks4';},
    s=>{s.value.rules.fallbackProxy.scheme='https';}, s=>{s.value.rules.fallbackProxy.host='8.8.4.4';},
    s=>{s.value.rules.bypassList.push('*');}, s=>{s.value.rules.bypassList=['<-loopback>'];},
    s=>{s.value.rules.singleProxy=candidate;}, s=>{delete s.value.rules.fallbackProxy;}
  ]) {
    const actual = setting();
    mutate(actual);
    assert.equal(matchesEffectiveRoute(actual,wanted),false);
  }
});
const foreignDirect = {levelOfControl:'controlled_by_other_extensions',value:{mode:'direct'}};

test('actual worker suspends on external takeover, without penalizing the address or overwriting the new route', async () => {
  const h = await backgroundHarness();
  try {
    await h.connect('SE');
    // An old notification for our blocker does not describe the effective route now.
    await h.notifyRoute({levelOfControl:'controlled_by_this_extension',value:BLOCKED});
    await h.notifyRoute({...foreignDirect,incognitoSpecific:true});
    assert.equal(h.state.status.phase,'connected');
    const before = h.calls.length, messages = h.nativeMessages.length;
    await h.overrideRoute(foreignDirect);
    assert.equal(h.state.status.phase,'error');
    assert.equal(h.state.status.proxy,null);
    assert.equal(h.state.enabled,true);
    assert.match(h.state.status.error,/Блокировка прямого выхода не подтверждена/);
    assert.equal(h.calls.slice(before).some(([name])=>name==='route'),false);
    assert.deepEqual(h.nativeMessages.slice(messages).map(m=>m.command),['stop']);
    assert.deepEqual((await chrome.proxy.settings.get({incognito:false})),foreignDirect);
    await h.overrideRoute(undefined);
    assert.equal(h.route,null,'the old address is gone when the other owner releases its setting');
  } finally { h.restore(); }
});

test('cached health checks re-read route ownership even without a settings notification', async () => {
  const h = await backgroundHarness();
  try {
    await h.connect('SE');
    const {id,attempt} = h.nativeMessages.find(m=>m.command==='confirm');
    const before = h.calls.length;
    h.overrideRoute(foreignDirect,false);
    h.emitRaw({type:'status',phase:'connected',country:'SE',proxy:candidate,feedbackProtocol:1,id,attempt});
    await h.waitFor(()=>h.state.status.phase==='error');
    assert.equal(h.calls.slice(before).some(([name,v])=>name==='save'&&v.status?.phase==='connected'),false);
  } finally { h.restore(); }
});

for (const notify of [false,true]) test('external takeover during a same-country browser probe, notification='+notify, async () => {
  let entered, release, interrupted=false;
  const pending = new Promise(r=>{entered=r;});
  const hold = new Promise(r=>{release=r;});
  const h = await backgroundHarness({}, {beforeFetch:async (url,{signal})=>{
    if (!url.includes('generate_204')) return;
    entered();
    const abort = new Promise((_,reject)=>signal.addEventListener('abort',()=>{
      interrupted = true;
      reject(signal.reason);
    },{once:true}));
    await Promise.race([hold,abort]);
  }});
  try {
    await h.send({action:'connect',country:'SE'});
    const {id} = h.nativeMessages.at(-1);
    h.emitRaw({type:'status',phase:'connected',country:'SE',proxy:candidate,feedbackProtocol:1,id,attempt:1});
    await pending;
    assert.equal(h.state.status.phase,'verifying');
    await h.overrideRoute(foreignDirect,notify);
    if (notify) assert.equal(interrupted,true,'takeover interrupts the pending fetch');
    release();
    await h.waitFor(()=>h.state.status.phase==='error');
    assert.equal(h.nativeMessages.some(m=>['confirm','reject'].includes(m.command)),false);
    assert.equal(h.calls.some(([name,v])=>name==='save'&&v.status?.phase==='connected'),false);
  } finally { release(); h.restore(); }
});


test('a takeover and release during one probe invalidates that proof even if the expected route is back', async () => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const h = await backgroundHarness({}, {beforeFetch:async url=>{
    if (url.includes('generate_204')) {
      entered.resolve();
      // Simulate a successful same-country response already in flight when ownership changes.
      await release.promise;
    }
  }});
  try {
    await h.send({action:'connect',country:'SE'});
    const {id} = h.nativeMessages.at(-1);
    h.emitRaw({type:'status',phase:'connected',country:'SE',proxy:candidate,feedbackProtocol:1,id,attempt:1});
    await entered.promise;
    h.overrideRoute(foreignDirect,false);
    h.overrideRoute(undefined,false);
    const notification = h.notifyRoute(foreignDirect); // get() now sees our old candidate.
    release.resolve();
    await notification;
    assert.equal(h.state.status.phase,'error');
    assert.deepEqual(h.route,BLOCKED);
    assert.equal(h.nativeMessages.some(m=>['confirm','reject'].includes(m.command)),false);
    assert.equal(h.calls.some(([name,v])=>name==='save'&&v.status?.phase==='connected'),false);
  } finally { release.resolve(); h.restore(); }
});

test('worker publishes reserve outcomes for the group without changing the active status, and clears stale or absent reports', async () => {
  const h = await backgroundHarness();
  const countries = ['NO', 'AT', 'EE'];
  try {
    await h.send({action: 'connect', countries});
    const {id} = h.nativeMessages.at(-1);
    const event = {type: 'status', id, countries, phase: 'pool', reserveCount: 1, reserveExpiresAt: Date.now() + 60000};
    const report = {state: 'waiting', counts: {rounds: 2, roundsWithoutChecks: 1, roundsWithSourceWarnings: 1, sameHost: 2, sameExit: 3, added: 1, checkFailed: 1}, failures: {timeout: 1}};
    h.emit({...event, diagnostics: {reserve: {...report, counts: {...report.counts, privateEndpoint: 'untrusted'}}}});
    await h.waitFor(() => h.state.pool?.count === 1);
    assert.deepEqual(h.state.reserveDiagnostics, {...report, limited: false});
    assert.equal(h.state.status.phase, 'searching');
    h.emit({...event, phase: 'checking', diagnostics: {attempts: 7}}); // Helper without reserve diagnostics.
    await h.waitFor(() => h.state.status.phase === 'checking');
    assert.equal(h.state.reserveDiagnostics, null);

    h.emit({...event, diagnostics: {reserve: {...report, limited: true}}});
    await h.waitFor(() => h.state.reserveDiagnostics?.limited);
    assert.ok((await h.send({action: 'connect', countries})).ok);
    h.emit({...event, diagnostics: {reserve: report}}); // Prior session with the exact same countries.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.state.reserveDiagnostics, null);
    const nextId = h.nativeMessages.at(-1).id;
    h.emit({...event, id: nextId, diagnostics: {reserve: report}});
    await h.waitFor(() => h.state.reserveDiagnostics?.counts.added === 1);
    assert.ok((await h.send({action: 'disconnect'})).ok);
    assert.equal(h.state.reserveDiagnostics, null);
  } finally { h.restore(); }
});

test('native egress changes on the same offer require fresh browser evidence, including country-only changes',async()=>{
  const results=[
    {ok:true,country:'EE',exitIp:'192.0.2.80'},
    {ok:true,country:'AT',exitIp:'192.0.2.82'},
    {ok:false,reason:'transport',endpoint:'trace'}];
  let probes=0;
  const {c,calls}=setup(async()=>results[probes++],true);
  const countries=['AT','EE','NO'];
  await c.start(countries);
  const initial={...candidate,country:'EE',exitIp:'192.0.2.1'};
  const offer={phase:'connected',id:c.id,countries,feedbackProtocol:1,attempt:7};
  const phases=()=>calls.filter(([k])=>k==='publish').map(([,s])=>s.phase);
  await c.status({...offer,proxy:initial});
  await c.status({...offer,proxy:{...initial,checkedAt:200}});
  assert.equal(probes,1);
  const moved={...initial,exitIp:'192.0.2.2'};
  await c.status({...offer,proxy:moved});
  assert.equal(probes,2);
  assert.deepEqual(phases().slice(-2),['verifying','connected']);
  assert.equal(c.browser.exitIp,results[1].exitIp);
  await c.status({...offer,proxy:{...moved,country:'NO'}});
  assert.equal(probes,3);
  assert.equal(phases().at(-1),'replacing');
  assert.equal(c.browser,null);
  assert.equal(calls.filter(([k])=>k==='apply').length,1);
  assert.deepEqual(c.countries,countries);
});

test('browser recheck queued during an egress change cannot republish the previous native egress',async()=>{
  let probes=0, resolve;
  const checked=exitIp=>({ok:true,country:'EE',exitIp});
  const {c,calls}=setup(async()=>++probes===1 ? checked('192.0.2.20') : new Promise(r=>{resolve=r;}),true);
  const countries=['AT','EE','NO'];
  await c.start(countries);
  const offer={phase:'connected',id:c.id,countries,feedbackProtocol:1,attempt:9};
  const a={...candidate,country:'EE',exitIp:'192.0.2.20'};
  const b={...a,exitIp:'192.0.2.21'};
  await c.status({...offer,proxy:a});
  const update=c.status({...offer,proxy:b});
  await new Promise(r=>setImmediate(r));
  assert.equal(probes,2);
  const queued=c.recheck();
  resolve(checked(b.exitIp));
  await Promise.all([update,queued]);
  assert.equal(c.active.exitIp,b.exitIp);
  assert.equal(c.browser.exitIp,b.exitIp);
  assert.equal(probes,2);
  assert.equal(calls.filter(([k])=>k==='apply').length,1);
});

test('reserve removals retain addressed cause and discard arbitrary payload fields', async () => {
  const {readReserveDiagnostics} = await import('../extension/reserve-diagnostics.js');
  const row = {id: 2, reserveId:'a'.repeat(32), atMs: 1730000000000, ageMs:32000,
    stage:'maintenance', reason:'checkFailed',
    check:{reason:'http',endpoint:'target',status:'503',code:0,latencyMs:83,body:'DO_NOT_STORE',url:'DO_NOT_STORE'},host:'DO_NOT_STORE'};
  const report = readReserveDiagnostics({state:'waiting',counts:{removed:1},removals:[row],removalsLimited:false});
  assert.deepEqual(report.removals,[{id:2,reserveId:'a'.repeat(32),atMs:1730000000000,ageMs:32000,
    stage:'maintenance',reason:'checkFailed',check:{reason:'http',endpoint:'target',status:503,code:0,latencyMs:83}}]);
  assert.ok(!JSON.stringify(report).includes('DO_NOT_STORE'));
  row.check.reason='tls';
  assert.equal(report.removals[0].check.reason,'http'); // snapshot, not a mutable view
});

test('reserve removal history rejects ambiguous identities, bounds records, and exposes incompleteness', async () => {
  const {readReserveDiagnostics} = await import('../extension/reserve-diagnostics.js');
  const row = id => ({id,reserveId:'b'.repeat(32),atMs:1000,stage:'prune',reason:'expired'});
  const read = removals => readReserveDiagnostics({state:'waiting',counts:{},removals});
  const bounded=read(Array.from({length:30},(_,i)=>row(i+1)));
  assert.equal(bounded.removals.length,20);
  assert.equal(bounded.removals[0].id,11);
  assert.equal(bounded.removalsLimited,true);
  const invalid=read([row(1),row(1),{...row(2),reserveId:'user:password@host'},row(3)]);
  assert.deepEqual(invalid.removals.map(r=>r.id),[1,3]);
  assert.equal(invalid.removalsLimited,true);
  assert.equal(read([{...row(1),atMs:-1}]).removals.length,0);
  assert.equal(read('untrusted').removalsLimited,true);
});

test('reserve removal text distinguishes expiry from its late check and never names an unknown cause', async () => {
  const {readReserveDiagnostics,reserveRemovalText} = await import('../extension/reserve-diagnostics.js');
  const report=readReserveDiagnostics({state:'waiting',counts:{},removals:[
    {id:1,reserveId:'c'.repeat(32),atMs:1000,stage:'maintenance',reason:'expired',
      check:{reason:'timeout',endpoint:'trace',code:28}},
    {id:2,reserveId:'d'.repeat(32),atMs:2000,stage:'promotion',reason:'checkFailed',
      check:{reason:'http',endpoint:'target',status:'503'}},
    {id:3,reserveId:'e'.repeat(32),atMs:3000,stage:'prune',reason:'private reason'}]});
  assert.match(reserveRemovalText(report.removals[0]),/истёк срок/i);
  assert.match(reserveRemovalText(report.removals[0]),/таймаут.*Cloudflare.*28/);
  assert.match(reserveRemovalText(report.removals[1]),/HTTP 503.*Google/);
  assert.match(reserveRemovalText(report.removals[2]),/не установлена/);
  assert.ok(!JSON.stringify(report).includes('private reason'));
});

test('addressed reserve removal history follows session lifecycle and does not alter routing', async () => {
  const h=await backgroundHarness(), countries=['AT','EE','NO'];
  try {
    await h.send({action:'connect',countries});
    const {id}=h.nativeMessages.at(-1), route=structuredClone(h.route);
    const report={state:'waiting',counts:{removed:1},removals:[
      {id:1,reserveId:'f'.repeat(32),atMs:1000,stage:'maintenance',reason:'checkFailed',check:{reason:'tls',endpoint:'trace',code:60}}]};
    const event={type:'status',id,countries,phase:'pool',reserveCount:0,diagnostics:{reserve:report}};
    h.emit(event);
    await h.waitFor(()=>h.state.reserveDiagnostics?.removals?.length===1);
    assert.deepEqual(h.route,route);
    await h.send({action:'connect',countries});
    h.emit(event);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(h.state.reserveDiagnostics,null);
    await h.send({action:'disconnect'});
    assert.equal(h.state.reserveDiagnostics,null);
  } finally {h.restore();}
});

test('reserve removal enum fields cannot coerce objects or arrays into a cause',async()=>{
  const {readReserveDiagnostics}=await import('../extension/reserve-diagnostics.js');
  const row={id:1,reserveId:'a'.repeat(32),atMs:1000,stage:'maintenance',reason:'checkFailed',check:{reason:'tls'}};
  const read=value=>readReserveDiagnostics({state:'waiting',counts:{},removals:[value]});
  for(const value of [{toString:null},['expired'],['tls'],17,null]){
    assert.equal(read({...row,reason:value}).removals[0].reason,'unknown');
    assert.equal(read({...row,check:{reason:value}}).removals[0].check.reason,'unknown');
    assert.equal(read({...row,stage:value}).removals.length,0);
    assert.equal(read({...row,stage:value}).removalsLimited,true);
  }
});

// Extra connections may win a slow HTTPS check; they never replace its criteria.
const hedgeResponse = (endpoint, {status, body='loc=EE\nip=8.8.8.8\n'} = {}) => ({
 status: status ?? (endpoint === 'trace' ? 200 : 204), text: async () => body
});
async function hedgeWait(predicate) {
 const until=Date.now()+1000;
 while (!predicate()) { assert.ok(Date.now()<until,'bounded hedge fixture'); await new Promise(r=>setTimeout(r,1)); }
}
function hedgeFixture(handler=()=>{}) {
 const calls=[];
 const fetcher=(url,{signal,...options})=>new Promise((resolve,reject)=>{
  const endpoint=url.includes('cloudflare')?'trace':'target';
  const row={endpoint,attempt:new URL(url).searchParams.get('attempt')==='2'?2:1,signal,options,resolve,reject};
  calls.push(row);signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})),{once:true});
  handler(row);
 });
 return {calls,fetcher};
}
test('fast verification needs only two original HTTPS requests and clears delayed work',async()=>{
 const f=hedgeFixture(row=>row.resolve(hedgeResponse(row.endpoint)));
 const result=await probeBrowser(['AT','EE','NO'],new AbortController().signal,{fetcher:f.fetcher,hedgeDelayMs:5});
 assert.equal(result.ok,true);assert.deepEqual(result.verifiedRequests,{trace:1,target:1});
 await new Promise(r=>setTimeout(r,10));assert.equal(f.calls.length,2);
 for(const row of f.calls)assert.deepEqual(row.options,{cache:'no-store',credentials:'omit',redirect:'error'});
});
test('one extra request can complete a slow origin while both HTTPS controls remain required',async()=>{
 const f=hedgeFixture(row=>{if(row.endpoint==='target'||row.attempt===2)row.resolve(hedgeResponse(row.endpoint));});
 const result=await probeBrowser(['AT','EE','NO'],new AbortController().signal,{fetcher:f.fetcher,hedgeDelayMs:5});
 assert.equal(result.ok,true);assert.equal(result.country,'EE');
 assert.deepEqual(result.verifiedRequests,{target:1,trace:2});assert.equal(f.calls.length,3);
 assert.ok(f.calls.every(row=>row.signal.aborted));
});
test('a successful hedged trace alone cannot confirm an unfinished target',async()=>{
 const f=hedgeFixture(row=>{if(row.endpoint==='trace'&&row.attempt===2)row.resolve(hedgeResponse('trace'));});
 const owner=new AbortController();let finished=false;
 const pending=probeBrowser(['AT','EE','NO'],owner.signal,{fetcher:f.fetcher,hedgeDelayMs:5}).then(r=>{finished=true;return r;});
 await hedgeWait(()=>f.calls.length===4);await Promise.resolve();assert.equal(finished,false);
 f.calls.find(r=>r.endpoint==='target'&&r.attempt===1).resolve(hedgeResponse('target'));
 assert.equal((await pending).ok,true);assert.ok(f.calls.every(r=>r.signal.aborted));
});
test('failed supplemental transport does not reject a pending healthy primary',async()=>{
 const f=hedgeFixture(row=>{if(row.endpoint==='target')row.resolve(hedgeResponse('target'));else if(row.attempt===2)row.reject(new TypeError('TLS or connection failure'));});
 let finished=false;const p=probeBrowser(['EE','NO'],new AbortController().signal,{fetcher:f.fetcher,hedgeDelayMs:5}).then(r=>{finished=true;return r;});
 await hedgeWait(()=>f.calls.length===3);await Promise.resolve();assert.equal(finished,false);
 f.calls.find(r=>r.endpoint==='trace'&&r.attempt===1).resolve(hedgeResponse('trace'));
 const result=await p;assert.equal(result.ok,true);assert.equal(result.verifiedRequests.trace,1);
});
test('primary failure stays immediate when its supplemental connection is held',async()=>{
 const f=hedgeFixture(row=>{if(row.endpoint==='target')row.resolve(hedgeResponse('target'));});
 const p=probeBrowser('EE',new AbortController().signal,{fetcher:f.fetcher,hedgeDelayMs:5,timeoutMs:1000});
 await hedgeWait(()=>f.calls.length===3);
 f.calls.find(r=>r.endpoint==='trace'&&r.attempt===1).reject(new TypeError('connection failed'));
 const result=await p;assert.equal(result.ok,false);assert.equal(result.reason,'transport');
 assert.ok(f.calls.every(r=>r.signal.aborted));
});
for(const [reason,opts] of [['country',{body:'loc=US\nip=8.8.8.8\n'}],['invalid_trace',{body:'loc=EE\nip=not-an-ip\n'}],['http',{status:503}]]){
 test('supplemental '+reason+' cannot be masked by a later primary success',async()=>{
  const f=hedgeFixture(row=>{if(row.endpoint==='target')row.resolve(hedgeResponse('target'));else if(row.attempt===2)row.resolve(hedgeResponse('trace',opts));});
  const result=await probeBrowser(['AT','EE','NO'],new AbortController().signal,{fetcher:f.fetcher,hedgeDelayMs:5});
  assert.equal(result.ok,false);assert.equal(result.reason,reason);assert.equal(result.endpoint,'trace');
  f.calls.find(r=>r.endpoint==='trace'&&r.attempt===1).resolve(hedgeResponse('trace'));
  await Promise.resolve();assert.equal(result.ok,false);assert.ok(f.calls.every(r=>r.signal.aborted));
 });
}
test('primary HTTP failure before the extra timer preserves fast rejection and starts no extras',async()=>{
 const f=hedgeFixture(row=>{if(row.endpoint==='target')row.resolve(hedgeResponse('target',{status:503}));});
 const result=await probeBrowser('EE',new AbortController().signal,{fetcher:f.fetcher,hedgeDelayMs:5});
 assert.equal(result.reason,'http');await new Promise(r=>setTimeout(r,10));assert.equal(f.calls.length,2);
 assert.ok(f.calls.every(r=>r.signal.aborted));
});
for(const cancel of [false,true])test('two held origins start at most four requests and obey '+(cancel?'caller cancellation':'one shared deadline'),async()=>{
 const f=hedgeFixture();const owner=new AbortController();
 const p=probeBrowser(['AT','EE','NO'],owner.signal,{fetcher:f.fetcher,hedgeDelayMs:5,timeoutMs:30});
 await hedgeWait(()=>f.calls.length===4);if(cancel)owner.abort();
 // AbortSignal.timeout is unref'ed; keep the bounded fixture alive until it fires.
 const keepAlive=setTimeout(()=>{},100);
 try {const r=await p;assert.equal(r.reason,cancel?'cancelled':'timeout');assert.equal(r.ok,false);}
 finally{clearTimeout(keepAlive);}
 assert.equal(f.calls.length,4);assert.ok(f.calls.every(r=>r.signal.aborted));
 for(const row of f.calls)row.resolve(hedgeResponse(row.endpoint));
 await Promise.resolve();assert.equal(f.calls.length,4);
});
test('supplemental 204 target is not accepted when trace gives an outside-group country',async()=>{
 const f=hedgeFixture(row=>{if(row.attempt===2)row.resolve(hedgeResponse(row.endpoint,row.endpoint==='trace'?{body:'loc=US\nip=8.8.8.8\n'}:{}));});
 const r=await probeBrowser(['AT','EE','NO'],new AbortController().signal,{fetcher:f.fetcher,hedgeDelayMs:5});
 assert.equal(r.ok,false);assert.equal(r.reason,'country');
});


for (const [name, unsafe, safe] of [['webRTCIPHandlingPolicy','default','disable_non_proxied_udp'],
  ['networkPredictionEnabled',true,false]]) {
 test('silent privacy override before admission closes gate: '+name, async()=>{
  const h=await backgroundHarness({}, {beforeFetch:async()=>{
    h.privacySettings[name].override({value:unsafe,levelOfControl:'controlled_by_other_extensions'},false);
  }});
  try {
   const reply=await h.send({action:'connect',country:'SE'}); assert.equal(reply.ok,true);
   const start=h.nativeMessages.at(-1);
   h.emitRaw({type:'status',phase:'connected',id:start.id,country:'SE',proxy:{...candidate,country:'SE'},feedbackProtocol:1,attempt:1});
   await h.waitFor(()=>h.state.status.phase==='error');
   assert.match(h.state.status.error,new RegExp(name));
   assert.deepEqual(await chrome.declarativeNetRequest.getSessionRules(),[]);
   assert.equal(h.state.enabled,true); assert.equal(h.state.status.proxy,null);
   assert.equal((await h.send({action:'disconnect'})).ok,true);
   assert.equal(h.state.status.phase,'off');
   assert.equal((await h.privacySettings[name].get()).value,unsafe,'Stop preserves foreign effective layer');
  } finally {h.restore();}
 });
 test('effective safe foreign privacy remains connected; unsafe change revokes immediately: '+name, async()=>{
  const h=await backgroundHarness();
  try {
   h.privacySettings[name].override({value:safe,levelOfControl:'controlled_by_other_extensions'},false);
   await h.connect('SE');
   await h.privacySettings[name].override({value:safe,levelOfControl:'controlled_by_other_extensions'});
   assert.equal(h.state.status.phase,'connected');
   h.privacySettings[name].override({value:unsafe,levelOfControl:'not_controllable'});
   assert.deepEqual(await chrome.declarativeNetRequest.getSessionRules(),[],'revocation initiated directly in privacy callback');
   await h.waitFor(()=>h.state.status.phase==='error');
   assert.match(h.state.status.error,new RegExp(name));
  } finally {h.restore();}
 });
}


for (const name of ['webRTCIPHandlingPolicy','networkPredictionEnabled']) {
 test('successful privacy set with unsafe effective override never admits a candidate: '+name, async()=>{
  const h=await backgroundHarness({}, {privacySilentOverride:({name:setting,route})=>setting===name&&route?.rules?.proxyForHttp?.host===candidate.host});
  try {
   assert.equal((await h.send({action:'connect',country:'SE'})).ok,true);
   const start=h.nativeMessages.at(-1);
   h.emitRaw({type:'status',phase:'connected',id:start.id,country:'SE',proxy:{...candidate,country:'SE'},feedbackProtocol:1,attempt:1});
   await h.waitFor(()=>h.state.status.phase==='error');
   assert.match(h.state.status.error,new RegExp(name));
   assert.deepEqual(await chrome.declarativeNetRequest.getSessionRules(),[]);
   assert.equal(h.state.status.proxy,null);
  } finally {h.restore();}
 });
}


test('worker wake revokes admission before the first storage read, including read failure',async()=>{
 for(const failure of [false,true]) {
  const gate=dnrFixture({session:[{id:710005,priority:3,action:{type:'allow'},condition:{regexFilter:'^https?://'}}]});
  let first=true;
  const h=await backgroundHarness({}, {gate,beforeStorage:async()=>{
   if(!first)return;first=false;
   assert.equal(gate.state.calls[0]?.kind,'session','revoke must be issued before storage');
   assert.deepEqual(gate.state.session,[],'old admission removed even before initial read completes');
   if(failure)throw Error('first storage read denied');
  }});
  try {
   assert.deepEqual(gate.state.session,[]);
   assert.equal(h.state.status.phase,failure?'error':'off');
   if(failure)assert.match(h.state.status.error,/first storage read denied/);
  } finally {h.restore();}
 }
});

for(const action of ['connect','disconnect']) {
 test('late emergency proxy protection settles before explicit '+action,async()=>{
  let delay=false;const entered=Promise.withResolvers(),finish=Promise.withResolvers();
  const h=await backgroundHarness({}, {beforeProxyWrite:async value=>{
   if(delay&&value.rules?.proxyForHttp?.port===9){delay=false;entered.resolve();await finish.promise;}
  }});
  try {
   await h.connect('SE');delay=true;
   h.privacySettings.networkPredictionEnabled.override({value:true,levelOfControl:'not_controllable'});
   await entered.promise;
   const changing=h.send(action==='connect'?{action,country:'NO'}:{action});
   await new Promise(resolve=>setImmediate(resolve));
   assert.notEqual(h.state.status.phase,'off');
   finish.resolve();const result=await changing;
   if(action==='disconnect') {
    assert.equal(result.ok,true);assert.equal(h.route,null);assert.equal(h.state.status.phase,'off');
   } else {
    // Unsafe foreign privacy still prevents a new connection, but no late old
    // protective write may run after this newer transition's cleanup/proof.
    assert.equal(result.ok,false);assert.equal(h.state.status.phase,'error');assert.deepEqual(h.route,BLOCKED);
   }
  } finally {h.restore();}
 });
}

test('unsafe notification publishes non-green while DNR revoke remains unresolved',async()=>{
 const gate=dnrFixture();const h=await backgroundHarness({}, {gate});
 const update=gate.api.updateSessionRules;const finish=Promise.withResolvers();let delay=true;
 try {
  await h.connect('SE');
  gate.api.updateSessionRules=async changes=>{
   if(delay&&!changes.addRules){delay=false;await finish.promise;}
   return update(changes);
  };
  h.privacySettings.networkPredictionEnabled.override({value:true,levelOfControl:'not_controllable'});
  await h.waitFor(()=>h.state.status.phase==='error');
  await h.waitFor(()=>h.route.rules?.proxyForHttp?.port===9);
  assert.match(h.state.status.error,/не подтверждена/);
  const stopping=h.send({action:'disconnect'});finish.resolve();await stopping;
  assert.equal(h.state.status.phase,'off');assert.deepEqual(gate.state.session,[]);
 } finally {finish.resolve();h.restore();}
});


for(const resume of [false,true]) {
 test('ordered intent writes keep Stop durable over an old pending Start; newer Start wins='+resume,async()=>{
  let intercept=false;const saveEntered=Promise.withResolvers(),saveFinish=Promise.withResolvers();
  const gate=dnrFixture();const h=await backgroundHarness({}, {gate,beforeStorageWrite:async values=>{
   if(intercept&&values.enabled===true&&values.selected==='NO'){
    intercept=false;saveEntered.resolve();await saveFinish.promise;
   }
  }});
  const guardFinish=Promise.withResolvers();
  try {
   await h.connect('SE');intercept=true;
   const oldStart=h.send({action:'connect',country:'NO'});await saveEntered.promise;
   const update=gate.api.updateSessionRules;let delay=true;
   gate.api.updateSessionRules=async changes=>{
    if(delay&&!changes.addRules){delay=false;await guardFinish.promise;}
    return update(changes);
   };
   const stopping=h.send({action:'disconnect'});
   saveFinish.resolve();
   await h.waitFor(()=>h.state.enabled===false&&h.state.status.phase==='stopping');
   const latest=resume?h.send({action:'connect',country:'EE'}):null;
   guardFinish.resolve();await oldStart;await stopping;if(latest)await latest;
   assert.equal(h.state.enabled,resume);
   assert.equal(h.state.status.phase,resume?'searching':'off');
   if(resume)assert.equal(h.state.selected,'EE');
  } finally {saveFinish.resolve();guardFinish.resolve();h.restore();}
 });
}
