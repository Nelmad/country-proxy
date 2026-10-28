import test from 'node:test';
import assert from 'node:assert/strict';
import {Controller, normalizeCountries, proxyConfig, BLOCKED} from '../extension/controller.js';
const candidate = {scheme:'http',host:'8.8.8.8',port:3128,country:'SE'};
function setup(probe=async()=>true) {
  const calls=[];
  const api=Object.fromEntries(['save','block','apply','publish','startNative','stopNative','clear','rotate'].map(k=>[k,async x=>{calls.push([k,x]);}]));
  return {calls,c:new Controller(api,probe)};
}
test('countries configured independently of defaults',()=>{
 assert.deepEqual(normalizeCountries(['se','JP','SE'],['SE','JP']),['SE','JP']);
 assert.throws(()=>normalizeCountries([],['SE']));
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
 assert.ok(calls.some(([k,v])=>k==='save' && v.enabled===false && v.pool===null));
});
test('country switch clears reserve and requires Chrome verification for a replacement',async()=>{
 let probes=0;const {c,calls}=setup(async()=>{probes++;return true;});await c.start('SE');
 await c.status({id:c.id,country:'SE',phase:'connected',proxy:candidate});
 await c.status({id:c.id,country:'SE',phase:'reserve',proxy:null});assert.equal(c.active,null);
 await c.status({id:c.id,country:'SE',phase:'connected',proxy:{...candidate,host:'1.1.1.1'}});
 assert.equal(probes,2);await c.start('NO');
 assert.ok(calls.some(([k,v])=>k==='save' && v.selected==='NO' && v.pool===null));
});
