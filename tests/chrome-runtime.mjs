// Inspect code actually executing in an isolated Chromium worker, not a fresh fetch of disk files.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
export async function inspectRuntime(context, root, {verify=true}={}) {
 const manifest=JSON.parse(await fs.readFile(path.join(root,'extension/manifest.json')));
 const id=crypto.createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
 const url=`chrome-extension://${id}/background.js`;
 const worker=context.serviceWorkers().find(w=>w.url()===url) || await context.waitForEvent('serviceworker',{predicate:w=>w.url()===url,timeout:20000});
 const cdp=await context.browser().newBrowserCDPSession();let sessionId;
 try {
  const {targetInfos}=await cdp.send('Target.getTargets');
  const target=targetInfos.find(t=>t.type==='service_worker' && t.url===url);assert.ok(target,'extension worker target missing');
  ({sessionId}=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:false}));
  let sequence=0;const pending=new Map(), scripts=[];
  cdp.on('Target.receivedMessageFromTarget',e=>{
   if(e.sessionId!==sessionId)return;const m=JSON.parse(e.message);
   if(m.method==='Debugger.scriptParsed')scripts.push(m.params);
   const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);if(m.error)p.reject(Error(m.error.message));else p.resolve(m.result);}
  });
  const send=(method,params={})=>new Promise((resolve,reject)=>{
   const n=++sequence;const timer=setTimeout(()=>{pending.delete(n);reject(Error('Debugger timeout: '+method));},10000);
   pending.set(n,{resolve,reject,timer});
   cdp.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id:n,method,params})}).catch(error=>{clearTimeout(timer);pending.delete(n);reject(error);});
  });
  await send('Debugger.enable');const result={version:await worker.evaluate(()=>chrome.runtime.getManifest().version),scripts:[]};
  for(const name of ['background.js','controller.js']){
   const parsed=scripts.find(s=>s.url===`chrome-extension://${id}/${name}`);assert.ok(parsed,'missing executed '+name);
   const {scriptSource}=await send('Debugger.getScriptSource',{scriptId:parsed.scriptId});
   const disk=await fs.readFile(path.join(root,'extension',name),'utf8');const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
   result.scripts.push({name,executedSHA:sha(scriptSource),diskSHA:sha(disk),equal:scriptSource===disk});
  }
  if(verify)assert.ok(result.scripts.every(s=>s.equal),'Chrome executes stale extension code: reload this test extension before testing');
  return result;
 } finally {
  if(sessionId)await cdp.send('Target.detachFromTarget',{sessionId}).catch(()=>{});
  await cdp.detach();
 }
}
