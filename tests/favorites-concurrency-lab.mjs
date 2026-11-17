// Offline real-extension favorites acceptance. Every profile is temporary; no helper registration.
// QA-only storage adapters below delay/fail the next favorites write in the isolated worker.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';

const root=path.resolve(process.env.FAVORITES_QA_ROOT || path.join(import.meta.dirname,'..'));
const out=path.resolve(process.env.FAVORITES_QA_OUT || path.join(root,'.runtime/favorites-qa'));
const baseline=process.argv.includes('--baseline');
const executablePath=process.env.CHROME_TEST_EXECUTABLE;
assert.ok(executablePath?.includes('Google Chrome for Testing.app/'),'Explicit Chrome for Testing executable required');
const ext=path.join(root,'extension');
const manifest=JSON.parse(await fs.readFile(path.join(ext,'manifest.json'),'utf8'));
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const id=sha(Buffer.from(manifest.key,'base64')).slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
const base=`chrome-extension://${id}`;
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
await fs.mkdir(out,{recursive:true});
const profile=await fs.mkdtemp('/private/tmp/cp-favorites-profile-');
const report={at:new Date().toISOString(),harnessSHA256:sha(await fs.readFile(new URL(import.meta.url))),mode:baseline?'baseline RED':'frozen acceptance GREEN',root,extensionId:id,
  network:'DNS * NOTFOUND; public proxy 127.0.0.1:9; background networking disabled; no native host registered',
  checks:[],runtime:[],qaAdapter:baseline?'None; real UI, worker and Chrome storage only':'Worker API wrappers for controlled delay/failure and side-effect observation; source files unchanged; injected failure is synthetic, not a Chrome disk-failure claim',
  consoleErrors:[],profileRemoved:false};
let context,worker;
const pages=new Set();
const pageDebuggers=new Map();
const selected=['AT','EE','NO'];
const expectedSelection={selected:null,selectedCountries:selected,selectionMode:'multiple',enabled:false};
async function launch(){
  context=await chromium.launchPersistentContext(profile,{executablePath,headless:true,locale:'ru-RU',
    viewport:{width:390,height:700},ignoreDefaultArgs:['--disable-extensions'],args:[
      '--disable-extensions-except='+ext,'--load-extension='+ext,'--disable-background-networking',
      '--disable-component-update','--disable-quic','--host-resolver-rules=MAP * ~NOTFOUND','--proxy-server=http://127.0.0.1:9']});
  report.chrome=context.browser().version();
  worker=context.serviceWorkers().find(w=>w.url()===base+'/background.js') || await context.waitForEvent('serviceworker',{predicate:w=>w.url()===base+'/background.js',timeout:15000});
  const ready=await context.newPage();
  await ready.goto(base+'/popup.html');
  await ready.waitForFunction(()=>document.getElementById('phase')?.textContent==='Отключено');
  await ready.close();
}
async function page(kind){
  const p=await context.newPage();pages.add(p);p.setDefaultTimeout(5000);
  p.on('pageerror',e=>report.consoleErrors.push({page:kind,message:e.message}));
  const cdp=await context.newCDPSession(p),scripts=[];cdp.on('Debugger.scriptParsed',s=>scripts.push(s));await cdp.send('Debugger.enable');pageDebuggers.set(p,{cdp,scripts});
  await p.goto(base+'/'+kind+'.html');
  if(kind==='options')await p.waitForFunction(()=>document.getElementById('country-count')?.textContent.includes('249'));
  else await p.waitForFunction(()=>document.getElementById('phase')?.textContent==='Отключено');
  return p;
}
async function closePages(){for(const p of pages)if(!p.isClosed())await p.close();pages.clear();}
const storage=()=>worker.evaluate(()=>chrome.storage.local.get(null));
async function waitFavorites(codes){
  await worker.evaluate(async expected=>{
    const until=Date.now()+5000;
    do {const actual=(await chrome.storage.local.get('countries')).countries;
      if(JSON.stringify(actual?.slice().sort())===JSON.stringify(expected.slice().sort()))return;
      await new Promise(r=>setTimeout(r,20));
    }while(Date.now()<until);
    throw Error('favorites mismatch: '+JSON.stringify((await chrome.storage.local.get('countries')).countries)+' expected '+JSON.stringify(expected));
  },codes);
}
async function optionsToggle(p,code){
  await p.locator('#country-search').fill(code);
  await p.locator(`[data-add-country="${code}"]`).click();
}
async function optionPressed(p,code,pressed){
  await p.locator('#country-search').fill(code);
  await p.waitForFunction(({code,pressed})=>document.querySelector(`[data-add-country="${code}"]`)?.getAttribute('aria-pressed')===String(pressed),{code,pressed});
}
async function popupPicker(p){
  if(!await p.locator('#country-picker').isVisible())await p.locator('#country').click();
  await p.locator('#country-search').waitFor({state:'visible'});
}
async function popupToggle(p,code){
  await popupPicker(p);await p.locator('#country-search').fill(code);
  await p.locator(`[data-favorite="${code}"]`).click();
}
async function popupPressed(p,code,pressed){
  await p.locator('#country-search').fill(code);
  await p.waitForFunction(({code,pressed})=>{const b=document.querySelector(`[data-favorite="${code}"]`);return b?.getAttribute('aria-pressed')===String(pressed)&&b.getAttribute('aria-disabled')!=='true';},{code,pressed});
}
async function save(p){await p.locator('#save').click();await p.waitForFunction(()=>document.getElementById('message').textContent.startsWith('Сохранено.'));}
async function installAdapter(){
  await worker.evaluate(()=>{
    globalThis.__favoritesQA={events:[],gate:null,fail:false};
    chrome.runtime.onMessage.addListener(message=>{if(message?.action==='settings')globalThis.__favoritesQA.events.push({type:'request',add:message.add,remove:message.remove,legacyCountries:message.countries});});
    const q=globalThis.__favoritesQA;
    const original=chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set=async values=>{
      if(Object.hasOwn(values,'countries')){
        q.events.push({type:'favorites-write',countries:[...values.countries]});
        if(q.fail){q.fail=false;q.events.push({type:'injected-failure'});throw Error('QA injected favorites write failure');}
        if(q.gate){const g=q.gate;q.gate=null;q.pending=g;q.events.push({type:'gate-entered'});await new Promise(resolve=>{g.release=resolve;});q.pending=null;q.events.push({type:'gate-released'});}
      }
      return original(values);
    };
    const watch=(object,name,label)=>{const original=object[name].bind(object);object[name]=(...args)=>{q.events.push({type:label});return original(...args);};};
    watch(chrome.proxy.settings,'set','proxy.set');watch(chrome.proxy.settings,'clear','proxy.clear');
    watch(chrome.declarativeNetRequest,'updateDynamicRules','dnr.dynamic');watch(chrome.declarativeNetRequest,'updateSessionRules','dnr.session');
    watch(chrome.runtime,'connectNative','native.connect');
  });
}
async function reset(countries){
  await closePages();
  await worker.evaluate(async ({countries,selection})=>{
    if(globalThis.__favoritesQA?.pending)throw Error('unreleased QA gate');
    await chrome.storage.local.set({countries,...selection});
    if(globalThis.__favoritesQA)globalThis.__favoritesQA.events=[];
  },{countries,selection:expectedSelection});
}
async function connectionSnapshot(){return worker.evaluate(async()=>({
  settings:await chrome.storage.local.get(['selected','selectedCountries','selectionMode','enabled','status']),
  proxy:await chrome.proxy.settings.get({incognito:false}),dynamic:await chrome.declarativeNetRequest.getDynamicRules(),
  session:await chrome.declarativeNetRequest.getSessionRules()
}));}
async function check(name,fn){
  const before=await connectionSnapshot();
  const start=Date.now();
  try{const detail=await fn();assert.deepEqual(await connectionSnapshot(),before,'favorites changed connection/group/status');
    const events=await worker.evaluate(()=>globalThis.__favoritesQA?.events || []);
    assert.ok(!events.some(e=>/^(proxy\.|dnr\.|native\.)/.test(e.type)),'connection-side effect called');
    report.checks.push({name,result:'PASS',elapsedMs:Date.now()-start,detail,sideEffectEvents:events.filter(e=>!e.type.startsWith('favorites-'))});
  }catch(e){report.checks.push({name,result:'FAIL',elapsedMs:Date.now()-start,error:e.stack});throw e;}
}
async function armGate(){await worker.evaluate(()=>{globalThis.__favoritesQA.gate={};});}
async function waitGate(){await worker.evaluate(async()=>{const until=Date.now()+5000;while(!globalThis.__favoritesQA.pending?.release){if(Date.now()>until)throw Error('QA gate not reached');await new Promise(r=>setTimeout(r,10));}});}
async function releaseGate(){await worker.evaluate(()=>{const p=globalThis.__favoritesQA.pending;if(!p?.release)throw Error('no gate');p.release();});}
async function screenshot(p,name){const file=path.join(out,name+'.png');await p.screenshot({path:file,fullPage:true});return path.basename(file);}
async function inspectPage(p,names){
  const {cdp,scripts}=pageDebuggers.get(p);
  try{const result=[];
    for(const name of names){const parsed=scripts.find(s=>s.url===base+'/'+name);assert.ok(parsed,'missing executed page module '+name+'; seen='+JSON.stringify(scripts.map(s=>s.url))); 
      const {scriptSource}=await cdp.send('Debugger.getScriptSource',{scriptId:parsed.scriptId});const disk=await fs.readFile(path.join(ext,name),'utf8');
      assert.equal(scriptSource,disk,'stale page script '+name);result.push({name,executedSHA:sha(scriptSource),diskSHA:sha(disk),equal:true});}
    return result;
  }finally{}
}
async function inspectWorker(names){
  const cdp=await context.browser().newBrowserCDPSession();let sessionId;
  try{const {targetInfos}=await cdp.send('Target.getTargets');const target=targetInfos.find(t=>t.type==='service_worker'&&t.url===base+'/background.js');assert.ok(target);
    ({sessionId}=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:false}));let n=0;const pending=new Map(),scripts=[];
    cdp.on('Target.receivedMessageFromTarget',e=>{if(e.sessionId!==sessionId)return;const m=JSON.parse(e.message);if(m.method==='Debugger.scriptParsed')scripts.push(m.params);const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
    const send=(method,params={})=>new Promise((resolve,reject)=>{const seq=++n;const timer=setTimeout(()=>{pending.delete(seq);reject(Error('CDP timeout '+method));},5000);pending.set(seq,{resolve,reject,timer});cdp.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id:seq,method,params})}).catch(reject);});
    await send('Debugger.enable');const result=[];
    for(const name of names){const parsed=scripts.find(s=>s.url===base+'/'+name);assert.ok(parsed,'missing executed worker module '+name);const {scriptSource}=await send('Debugger.getScriptSource',{scriptId:parsed.scriptId});const disk=await fs.readFile(path.join(ext,name),'utf8');assert.equal(scriptSource,disk,'stale worker module '+name);result.push({name,executedSHA:sha(scriptSource),diskSHA:sha(disk),equal:true});}
    return result;
  }finally{if(sessionId)await cdp.send('Target.detachFromTarget',{sessionId}).catch(()=>{});await cdp.detach();}
}
async function baselineRed(){
  await reset(['NO']);const o=await page('options'),p=await page('popup');
  await optionsToggle(o,'AT');await popupToggle(p,'EE');await waitFavorites(['NO','EE']);
  await screenshot(o,'baseline-options-draft-before-save');await screenshot(p,'baseline-popup-before-options-save');
  const before=await storage();await o.locator('#save').click();await waitFavorites(['NO','AT']);
  await o.waitForFunction(()=>document.getElementById('message').textContent.startsWith('Сохранено.'));
  report.baseline={initial:['NO'],optionsDraftAdds:'AT',popupAdds:'EE',beforeSave:before.countries,afterSave:(await storage()).countries,
    lostConcurrentFavorite:'EE',screenshots:[await screenshot(o,'baseline-options-after-save'),await screenshot(p,'baseline-popup-after-save')]};
  assert.ok(!report.baseline.afterSave.includes('EE'),'baseline must demonstrate lost popup addition');
  report.runtime.push({target:'options',scripts:await inspectPage(o,['options.js','country-catalog.js'])},{target:'popup',scripts:await inspectPage(p,['popup.js','country-catalog.js'])},{target:'worker',scripts:await inspectWorker(['background.js','controller.js'])});
  report.checks.push({name:'Real options draft AT + popup EE -> options Save loses EE',result:'EXPECTED RED',detail:report.baseline});
}
async function waitRequests(count){await worker.evaluate(async count=>{
  const until=Date.now()+5000;while(globalThis.__favoritesQA.events.filter(e=>e.type==='request').length<count){
    if(Date.now()>until)throw Error('settings message boundary not reached');await new Promise(r=>setTimeout(r,10));
  }
},count);}
async function expectDirty(p,dirty=true){await p.waitForFunction(dirty=>document.getElementById('save').disabled===!dirty,dirty);}
async function finalGreen(){
  await reset(['NO']);
  await check('Real options local AT + popup EE keeps both independent additions',async()=>{
    const o=await page('options'),p=await page('popup');await optionsToggle(o,'AT');
    await popupToggle(p,'EE');await waitFavorites(['NO','EE']);await popupPressed(p,'EE',true);
    await optionPressed(o,'AT',true);await optionPressed(o,'EE',true);await expectDirty(o);
    await save(o);await waitFavorites(['NO','EE','AT']);
    report.runtime.push({target:'options',scripts:await inspectPage(o,['options.js','favorites.js','country-catalog.js'])},
      {target:'popup',scripts:await inspectPage(p,['popup.js','country-catalog.js'])},
      {target:'worker',scripts:await inspectWorker(['background.js','favorites.js','controller.js','traffic-gate.js','probe.js'])});
    return {countries:(await storage()).countries,screenshots:[await screenshot(o,'green-independent-additions-options'),await screenshot(p,'green-independent-additions-popup')]};
  });

  await reset(['NO','EE','AT']);
  await check('Options removes AT while popup removes EE; neither removal is resurrected',async()=>{
    const o=await page('options'),p=await page('popup');await optionsToggle(o,'AT');await popupToggle(p,'EE');
    await waitFavorites(['NO','AT']);await optionPressed(o,'EE',false);await optionPressed(o,'AT',false);await save(o);await waitFavorites(['NO']);
    return {countries:(await storage()).countries};
  });

  await reset(['NO','EE']);
  await check('Untouched remotely removed EE remains removed when stale options adds PL',async()=>{
    const o=await page('options'),p=await page('popup');await optionsToggle(o,'PL');await popupToggle(p,'EE');await waitFavorites(['NO']);
    await optionPressed(o,'PL',true);await optionPressed(o,'EE',false);await save(o);await waitFavorites(['NO','PL']);
    return {countries:(await storage()).countries};
  });

  await reset(['NO']);
  await check('Two options windows with different unsaved drafts merge through serialized Save',async()=>{
    const a=await page('options'),b=await page('options');await optionsToggle(a,'AT');await optionsToggle(b,'EE');
    await armGate();await a.locator('#save').click();await waitGate();await b.locator('#save').click();await waitRequests(2);
    const blocked=await worker.evaluate(()=>globalThis.__favoritesQA.events.filter(e=>e.type==='favorites-write').length);assert.equal(blocked,1,'second writer read/wrote before first completed');
    await releaseGate();await waitFavorites(['NO','AT','EE']);
    await a.waitForFunction(()=>document.getElementById('message').textContent.startsWith('Сохранено.'));
    await b.waitForFunction(()=>document.getElementById('message').textContent.startsWith('Сохранено.'));
    await optionPressed(a,'EE',true);await optionPressed(b,'AT',true);await expectDirty(a,false);await expectDirty(b,false);
    return {countries:(await storage()).countries,boundary:'second request received while first storage.set held; no second write before release'};
  });

  for(const [name,initial,one,two,expected] of [
    ['Concurrent popup additions at delayed background write',['NO'],'EE','AT',['NO','EE','AT']],
    ['Concurrent popup removals at delayed background write',['NO','EE','AT'],'EE','AT',['NO']]
  ]){
    await reset(initial);await check(name,async()=>{
      const a=await page('popup'),b=await page('popup');await popupPicker(a);await popupPicker(b);
      await armGate();await popupToggle(a,one);await waitGate();await popupToggle(b,two);await waitRequests(2);
      assert.equal(await worker.evaluate(()=>globalThis.__favoritesQA.events.filter(e=>e.type==='favorites-write').length),1);
      await releaseGate();await waitFavorites(expected);await popupPressed(a,one,expected.includes(one));await popupPressed(b,two,expected.includes(two));
      return {countries:(await storage()).countries,boundary:'both real popup requests reached worker before release'};
    });
  }

  await reset(['NO']);
  await check('Same-country double removal is idempotent across stale popup views',async()=>{
    const a=await page('popup'),b=await page('popup');await popupPicker(a);await popupPicker(b);
    await armGate();await popupToggle(a,'NO');await waitGate();await popupToggle(b,'NO');await waitRequests(2);await releaseGate();await waitFavorites([]);
    await popupPressed(a,'NO',false);await popupPressed(b,'NO',false);return {countries:(await storage()).countries};
  });

  await reset(['NO']);
  await check('Same-country last explicit Save removal wins after remote remove and re-add',async()=>{
    const o=await page('options'),p=await page('popup');await optionsToggle(o,'NO');
    await popupToggle(p,'NO');await waitFavorites([]);await popupPressed(p,'NO',false);
    await popupToggle(p,'NO');await waitFavorites(['NO']);await popupPressed(p,'NO',true);
    await optionPressed(o,'NO',false);await expectDirty(o);await save(o);await waitFavorites([]);
    return {policy:'last committed explicit membership operation wins',countries:(await storage()).countries};
  });

  await reset(['NO']);
  await check('Same-country last explicit Save addition wins after remote add and remove',async()=>{
    const o=await page('options'),p=await page('popup');await optionsToggle(o,'EE');
    await popupToggle(p,'EE');await waitFavorites(['NO','EE']);await popupPressed(p,'EE',true);
    await popupToggle(p,'EE');await waitFavorites(['NO']);await popupPressed(p,'EE',false);
    await optionPressed(o,'EE',true);await expectDirty(o);await save(o);await waitFavorites(['NO','EE']);
    return {policy:'last committed explicit membership operation wins',countries:(await storage()).countries};
  });

  await reset(['NO']);
  await check('New unrelated option edit during pending Save stays dirty and saves on retry',async()=>{
    const o=await page('options');await optionsToggle(o,'AT');await armGate();await o.locator('#save').click();await waitGate();
    assert.equal(await o.locator('#save').isDisabled(),true);await optionsToggle(o,'EE');await releaseGate();await waitFavorites(['NO','AT']);
    await expectDirty(o);await optionPressed(o,'EE',true);await save(o);await waitFavorites(['NO','AT','EE']);
    return {countries:(await storage()).countries,adapter:'delayed first favorites storage.set only'};
  });

  for(const [name,initial,code,expectedCommitted,expectedFinal] of [
    ['Undo pending addition remains a newer explicit removal',['NO'],'AT',['NO','AT'],['NO']],
    ['Undo pending removal remains a newer explicit addition',['NO','AT'],'AT',['NO'],['NO','AT']]
  ]){
    await reset(initial);await check(name,async()=>{
      const o=await page('options');await optionsToggle(o,code);await armGate();await o.locator('#save').click();await waitGate();
      await optionsToggle(o,code);await releaseGate();await waitFavorites(expectedCommitted);await expectDirty(o);
      await optionPressed(o,code,initial.includes(code));await save(o);await waitFavorites(expectedFinal);
      return {committedSnapshot:expectedCommitted,afterNewerIntent:(await storage()).countries,adapter:'delayed favorites write'};
    });
  }

  await reset(['NO']);
  await check('Options favorites write failure preserves dirty draft and connection state; retry succeeds',async()=>{
    const o=await page('options');await optionsToggle(o,'AT');await worker.evaluate(()=>{globalThis.__favoritesQA.fail=true;});
    await o.locator('#save').click();await o.waitForFunction(()=>document.getElementById('message').textContent.includes('QA injected favorites write failure'));
    await expectDirty(o);await optionPressed(o,'AT',true);await waitFavorites(['NO']);
    const failedScreenshot=await screenshot(o,'green-options-injected-failure');await save(o);await waitFavorites(['NO','AT']);
    return {countries:(await storage()).countries,screenshot:failedScreenshot,adapter:'one rejected worker favorites storage.set; real runtime response and UI retry'};
  });

  await reset(['NO']);
  await check('Popup favorites write failure leaves membership unchanged and permits retry',async()=>{
    const p=await page('popup');await worker.evaluate(()=>{globalThis.__favoritesQA.fail=true;});await popupToggle(p,'EE');
    await p.waitForFunction(()=>document.getElementById('error').textContent.includes('QA injected favorites write failure'));
    await popupPressed(p,'EE',false);await waitFavorites(['NO']);await popupToggle(p,'EE');await waitFavorites(['NO','EE']);await popupPressed(p,'EE',true);
    return {countries:(await storage()).countries,adapter:'one rejected worker favorites storage.set'};
  });

  await reset(['NO']);
  await check('Legacy whole-list and invalid deltas reject without changing favorites or connection',async()=>{
    const p=await page('options');
    const results=await p.evaluate(async()=>{
      const messages=[{action:'settings',countries:['EE']},{action:'settings',add:['EE'],remove:['EE']},{action:'settings',add:['ZZ'],remove:[]}];
      return Promise.all(messages.map(m=>chrome.runtime.sendMessage(m)));
    });
    assert.ok(results.every(r=>r?.ok===false));await waitFavorites(['NO']);return {results};
  });

  await reset(['NO']);
  await check('Remote storage refresh preserves options dirty draft, search, catalog focus and scroll',async()=>{
    const o=await page('options'),p=await page('popup');await optionsToggle(o,'AT');await o.locator('#country-search').fill('NO');
    await o.locator('#country-search').press('ArrowDown');assert.equal(await o.evaluate(()=>document.activeElement?.dataset.addCountry),'NO');
    await popupToggle(p,'EE');await waitFavorites(['NO','EE']);await o.waitForFunction(()=>!!document.querySelector('[data-remove-favorite="EE"]'));
    assert.equal(await o.locator('#country-search').inputValue(),'NO');assert.equal(await o.evaluate(()=>document.activeElement?.dataset.addCountry),'NO');
    await optionPressed(o,'AT',true);await expectDirty(o);
    await o.locator('#country-search').fill('');await o.locator('#country-search').press('ArrowDown');await o.keyboard.press('End');
    const focused=await o.evaluate(()=>document.activeElement?.dataset.addCountry),scroll=await o.locator('#country-results').evaluate(e=>e.scrollTop);assert.ok(scroll>0);
    await popupToggle(p,'EE');await waitFavorites(['NO']);await o.waitForFunction(()=>!document.querySelector('[data-remove-favorite="EE"]'));
    assert.equal(await o.evaluate(()=>document.activeElement?.dataset.addCountry),focused);
    assert.ok(Math.abs(await o.locator('#country-results').evaluate(e=>e.scrollTop)-scroll)<2);
    await save(o);await waitFavorites(['NO','AT']);return {focusedCode:focused,scrollTop:scroll,countries:(await storage()).countries};
  });

  await reset(['NO']);
  await check('Keyboard search/activation retain focus and 360/390 px favorites views avoid horizontal overflow',async()=>{
    const o=await page('options'),p=await page('popup');await popupPicker(p);
    for(const [pg,selector,code] of [[o,'[data-add-country="AT"]','AT'],[p,'[data-favorite="EE"]','EE']]){
      await pg.locator('#country-search').fill(code);await pg.locator(selector).focus();await pg.keyboard.press('Space');
      await pg.waitForFunction(s=>document.querySelector(s)?.getAttribute('aria-pressed')==='true',selector);
      assert.ok(await pg.evaluate(s=>document.activeElement?.matches(s),selector),'keyboard action lost focused country');
    }
    await waitFavorites(['NO','EE']);await optionPressed(o,'AT',true);await save(o);await waitFavorites(['NO','EE','AT']);
    const measurements=[];
    for(const width of [360,390])for(const [kind,pg] of [['options',o],['popup',p]]){
      await pg.setViewportSize({width,height:700});await pg.locator('#country-search').fill('');
      const measure=await pg.evaluate(()=>({viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,
        resultsWidth:document.getElementById('country-results').scrollWidth,resultsClient:document.getElementById('country-results').clientWidth}));
      assert.ok(measure.documentWidth<=width+1 && measure.bodyWidth<=width+1 && measure.resultsWidth<=measure.resultsClient+1,JSON.stringify(measure));
      measurements.push({kind,width,...measure,screenshot:await screenshot(pg,`green-${kind}-${width}`)});
    }
    return measurements;
  });

  await reset(['NO']);
  await check('Empty favorites saves and remains empty in open popup and options',async()=>{
    const o=await page('options'),p=await page('popup');await optionsToggle(o,'NO');await save(o);await waitFavorites([]);
    await p.waitForFunction(()=>document.getElementById('favorites-section').hidden);
    assert.equal(await o.locator('#empty-favorites').isVisible(),true);await expectDirty(o,false);
    return {countries:(await storage()).countries,screenshots:[await screenshot(o,'green-empty-options'),await screenshot(p,'green-empty-popup')]};
  });

  const beforeRestart=await connectionSnapshot();await closePages();await context.close();context=null;
  await launch();
  await check('Actual Chrome cold restart persists empty favorites and equal selected group',async()=>{
    await waitFavorites([]);const s=await storage();for(const [key,value] of Object.entries(expectedSelection))assert.deepEqual(s[key],value);
    assert.deepEqual((await connectionSnapshot()).proxy,beforeRestart.proxy);assert.deepEqual((await connectionSnapshot()).dynamic,beforeRestart.dynamic);assert.deepEqual((await connectionSnapshot()).session,beforeRestart.session);
    const o=await page('options'),p=await page('popup');assert.equal(await o.locator('#empty-favorites').isVisible(),true);assert.equal(await p.locator('#favorites-section').isVisible(),false);
    report.runtime.push({target:'restarted-worker',scripts:await inspectWorker(['background.js','favorites.js'])});
    return {countries:s.countries,selection:Object.fromEntries(Object.keys(expectedSelection).map(k=>[k,s[k]])),profile:'same temporary profile, actual process close and relaunch'};
  });
}
try{
  await launch();
  const names=(await fs.readdir(ext)).filter(n=>/\.(js|json|html|css)$/.test(n)).sort();
  report.extensionInventory=[];for(const name of names)report.extensionInventory.push({name,sha256:sha(await fs.readFile(path.join(ext,name)))});
  report.extensionInventorySHA=sha(JSON.stringify(report.extensionInventory));
  if(baseline)await baselineRed();else{await installAdapter();await finalGreen();}
  assert.deepEqual(report.consoleErrors,[]);report.result=baseline?'EXPECTED RED confirmed':'PASS';
}catch(e){report.result='FAIL';report.error=e.stack;process.exitCode=1;
}finally{
  if(context)await context.close().catch(e=>report.closeError=e.message);
  await fs.rm(profile,{recursive:true,force:true});report.profileRemoved=true;
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({result:report.result,checks:report.checks.map(({name,result})=>({name,result})),report:path.join(out,'report.json'),profileRemoved:report.profileRemoved,error:report.error?.split('\n')[0]},null,2));
}
