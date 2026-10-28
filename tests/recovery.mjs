// Restart and native-host loss in the isolated test profile, never the main Chrome profile.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {inspectRuntime} from './chrome-runtime.mjs';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=path.resolve(import.meta.dirname,'..');
const profile=path.join(root,'.runtime/chrome-test');
const registration=path.join(profile,'NativeMessagingHosts/local.country_proxy.json');
let browser;
async function open() {
 browser=await chromium.launchPersistentContext(profile,{headless:true,channel:'chromium',ignoreDefaultArgs:['--disable-extensions'],
   args:[`--disable-extensions-except=${root}/extension`,`--load-extension=${root}/extension`]});
 const worker=browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
 (report.runtimes ??= []).push(await inspectRuntime(browser,root));
 const id=worker.url().split('/')[2];
 const page=await browser.newPage();await page.goto(`chrome-extension://${id}/popup.html`);return page;
}
async function status(page, phase, deadline=120000) {
 const end=Date.now()+deadline;
 while(Date.now()<end) {
  const state=await page.evaluate(async()=> (await chrome.storage.local.get('status')).status);
  if(state?.phase===phase)return state;
  await new Promise(r=>setTimeout(r,500));
 }
 throw Error('Status timeout: '+phase);
}
const report={at:new Date().toISOString()};
let backup;
try {
 let page=await open();
 await page.evaluate(()=>chrome.runtime.sendMessage({action:'connect',country:'EE'}));
 await status(page,'connected');console.log('Initial EE connected');
 await browser.close();
 page=await open();
 await status(page,'connected');report.restart=true;console.log('Restart resumed and verified');
 await browser.close();
 backup=await fs.readFile(registration);await fs.rename(registration,registration+'.disabled');
 page=await open();
 await status(page,'helper',20000);report.missingHelper=true;
 const probe=await browser.newPage();let failed=false;
 try {await probe.goto('https://example.com/?recovery='+Date.now(),{timeout:12000});}catch {failed=true;}
 assert.ok(failed);report.missingHelperBlocks=true;console.log('Missing helper blocks network');
 await fs.rename(registration+'.disabled',registration);backup=null;
 await status(page,'connected',150000);report.automaticReconnect=true;console.log('Helper restored: automatically reconnected');
 await page.evaluate(()=>chrome.runtime.sendMessage({action:'disconnect'}));
 const settings=await page.evaluate(async()=>({proxy:await chrome.proxy.settings.get({incognito:false}),
   rtc:await chrome.privacy.network.webRTCIPHandlingPolicy.get({}),prediction:await chrome.privacy.network.networkPredictionEnabled.get({})}));
 for(const x of Object.values(settings))assert.notEqual(x.levelOfControl,'controlled_by_this_extension');
 report.restoredPrivacy=true;
} finally {
 if(backup)await fs.rename(registration+'.disabled',registration);
 if(browser)await browser.close();
 await fs.writeFile(path.join(root,'.runtime/recovery-report.json'),JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify(report));
