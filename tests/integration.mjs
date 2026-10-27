// Explicit live smoke. Isolated profile only; never uses the user's Chrome profile.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {BLOCKED} = await import('../extension/controller.js');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=path.resolve(import.meta.dirname,'..');
const manifest=JSON.parse(await fs.readFile(path.join(root,'extension/manifest.json')));
const id=crypto.createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
const profile=path.join(root,'.runtime/chrome-test');
const browser=await chromium.launchPersistentContext(profile,{
 headless:true, channel:'chromium', ignoreDefaultArgs:['--disable-extensions'],
 args:[`--disable-extensions-except=${root}/extension`,`--load-extension=${root}/extension`, '--disable-quic'],
 viewport:{width:640,height:650}
});
const report={at:new Date().toISOString(), browser:browser.browser()?.version(), countries:{}};
try {
 const worker=browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker',{timeout:20000});
 console.log('worker:',worker.url());
 worker.on('console',msg=>console.log('WORKER',msg.text()));
 const popup=await browser.newPage();
 await popup.goto(`chrome-extension://${id}/popup.html`);
 const command=(action,extra={})=>popup.evaluate(message=>chrome.runtime.sendMessage(message),{action,...extra});
 await command('disconnect');
 assert.equal((await command('settings',{countries:['NO','EE','AT','SE']})).ok,true);
 const settings=await browser.newPage();await settings.goto(`chrome-extension://${id}/options.html`);
 assert.ok((await settings.locator('#countries').innerText()).includes('SE'));
 await settings.screenshot({path:path.join(root,'.runtime/options.png')});
 await command('settings',{countries:['NO','EE','AT']});
 for(const cc of (process.env.TEST_COUNTRIES || 'NO,EE,AT').split(',')) {
   await command('connect',{country:cc});
   let state, last='', deadline=Date.now()+210000;
   while(Date.now()<deadline) {
     state=await popup.evaluate(async()=> (await chrome.storage.local.get('status')).status);
     if(state?.phase!==last) {last=state?.phase;console.log(cc,last,state?.total || '',state?.error || '');}
     if(state?.phase==='connected' || ['empty','helper','error'].includes(state?.phase)) break;
     await new Promise(r=>setTimeout(r,1000));
   }
   report.countries[cc]=state;
   await popup.screenshot({path:path.join(root,`.runtime/popup-${cc}.png`)});
   if(state?.phase==='connected') {
     const page=await browser.newPage();
     try {
       await page.goto('https://www.cloudflare.com/cdn-cgi/trace?t='+Date.now(),{timeout:55000,waitUntil:'domcontentloaded'});
       const trace=await page.locator('body').innerText();
       assert.ok(trace.includes(`loc=${cc}`),trace);
       report.countries[cc].pageConfirmed=true;
       console.log(cc,'PAGE CONFIRMED',state.proxy.scheme,state.proxy.host+':'+state.proxy.port);
     } catch(error) { report.countries[cc].pageError=error.message; }
     await page.close();
   }
   await command('disconnect');
 }
 // Fail-closed behavior with the actual Chromium network stack.
 await worker.evaluate(value=>chrome.proxy.settings.set({value,scope:'regular'}),BLOCKED);
 const blocked=await browser.newPage();let failed=false;
 try {await blocked.goto('https://example.com/?country-proxy-test='+Date.now(),{timeout:15000});}
 catch {failed=true;}
 assert.ok(failed,'blocked proxy unexpectedly allowed direct internet');report.blockedRoute=true;
 await command('disconnect');
 const clean=await popup.evaluate(()=>chrome.proxy.settings.get({incognito:false}));
 assert.notEqual(clean.levelOfControl,'controlled_by_this_extension');report.disconnectRestores=true;
 await popup.screenshot({path:path.join(root,'.runtime/popup-off.png')});
} finally {
 await fs.writeFile(path.join(root,'.runtime/live-report.json'),JSON.stringify(report,null,2)+'\n');
 await browser.close();
}
console.log(JSON.stringify(report,null,2));
