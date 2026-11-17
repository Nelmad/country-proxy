// Render production extension pages in an isolated, offline Chrome. Fixtures only seed UI state.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const baseline = process.argv.includes('--baseline');
const extension = path.join(root, baseline ? '.runtime/layout-original/extension' : 'extension');
const out = path.join(root, '.runtime/layout-qa', baseline ? 'baseline' : 'final');
const all = JSON.parse(await fs.readFile(path.join(extension, 'countries.json')));
const names = new Intl.DisplayNames('ru', {type:'region'});
const longest = all.toSorted((a,b) => names.of(b).length - names.of(a).length)[0];
const groups = [
  {id:'all', name:'Ш'.repeat(48), countries:all},
  ...all.slice(0,11).map(c => ({id:c, name:'Регион ' + c, countries:[c]}))
];
const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json')));
const id = createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32)
  .replace(/[0-9a-f]/g,c=>String.fromCharCode(97 + parseInt(c,16)));
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const sizes = [[320,360,16],[360,460,16],[390,600,16],[400,600,16],[320,360,32],[360,460,32],[390,600,32]];
const report = {mode:baseline?'baseline':'final',font:'Chrome default font size, 16/32px',cases:[],screenshots:[]};
const errors = [];
const profile = await fs.mkdtemp(path.join(os.tmpdir(),'country-layout-'));
await fs.mkdir(out,{recursive:true});
let chrome;
async function shot(page, name) {
  await page.screenshot({path:path.join(out,name+'.png'),animations:'disabled'});
  report.screenshots.push(name+'.png');
}
async function measure(page, step, controls) {
  const geometry = await page.evaluate(() => {
    const root = document.documentElement;
    const overflows = [];
    for (const el of document.querySelectorAll('main, header, button, input[type=search], select, th, td, h1, h2, #country-name, #group-list, .group-title, #country-results, #selection-summary, #reserve-counts, #countries li span')) {
      if (!el.clientWidth || getComputedStyle(el).display==='inline') continue;
      if (el.closest('details:not([open])') && !el.closest('summary')) continue;
      const style=getComputedStyle(el);
      if (el.scrollWidth > el.clientWidth+2 && style.overflowX !== 'scroll') {
        overflows.push({element:el.id || el.className || el.tagName, by:el.scrollWidth-el.clientWidth});
      }
    }
    return {outerOverflow:Math.max(0,root.scrollWidth-innerWidth),overflows:overflows.slice(0,8)};
  });
  const missed=[];
  for (const selector of controls) {
    const loc = page.locator(selector).first();
    const accessible=await loc.evaluate(el=>{
      el.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
      const r=el.getBoundingClientRect(), x=(r.left+r.right)/2, y=(r.top+r.bottom)/2;
      return Boolean(r.width && r.height && r.left>=-1 && r.right<=innerWidth+1 && el.contains(document.elementFromPoint(x,y)));
    });
    if (!accessible) missed.push(selector);
  }
  const dimensions=page.viewportSize();
  report.cases.push({step,...dimensions,font:report.fontSize,...geometry,missed});
}
async function setFrame(page,cdp,[width,height,fontSize]) {
  report.fontSize=fontSize;
  await page.setViewportSize({width,height});
  await cdp.send('Page.setFontSizes',{fontSizes:{standard:fontSize,fixed:fontSize-2}});
}
async function go(page, name) {
  await page.goto('chrome-extension://'+id+'/'+name+'.html');
  if (name==='popup') await page.waitForFunction(()=>document.getElementById('phase').textContent !== 'Загрузка…'
    && !document.getElementById('saved-groups').hidden);
  else await page.waitForSelector('#country-results button');
}
async function seed(page, values) { await page.evaluate(v=>chrome.storage.local.set(v),values); }
try {
  chrome=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,locale:'ru-RU',
    ignoreDefaultArgs:['--disable-extensions'],args:['--disable-background-networking','--disable-quic',
    '--host-resolver-rules=MAP * ~NOTFOUND','--proxy-server=http://127.0.0.1:9','--disable-extensions-except='+extension,'--load-extension='+extension]});
  report.chrome=chrome.browser().version();
  const worker=chrome.serviceWorkers()[0] || await chrome.waitForEvent('serviceworker');
  await worker.evaluate(()=>chrome.action.openPopup());
  const host=await chrome.browser().newBrowserCDPSession();
  const {targetInfos}=await host.send('Target.getTargets');
  const action=targetInfos.find(info=>info.url==='chrome-extension://'+id+'/popup.html');
  assert(action,'Toolbar action popup must exist');
  const {sessionId}=await host.send('Target.attachToTarget',{targetId:action.targetId});
  const nativeSize=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Native popup measurement timed out')),8000);
    const handler=event=>{
      if(event.sessionId!==sessionId)return;
      const message=JSON.parse(event.message);
      if(message.id!==1)return;
      clearTimeout(timer);host.off('Target.receivedMessageFromTarget',handler);resolve(message.result.result.value);
    };
    host.on('Target.receivedMessageFromTarget',handler);
  });
  await host.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id:1,method:'Runtime.evaluate',params:{
    expression:'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({width:innerWidth,height:innerHeight,contentWidth:document.documentElement.scrollWidth}))))',
    awaitPromise:true,returnByValue:true}})});
  report.nativePopup=await nativeSize;
  assert(report.nativePopup.width>=320 && report.nativePopup.width<=400 && report.nativePopup.contentWidth<=report.nativePopup.width+1,
    'Native popup has wrong intrinsic size '+JSON.stringify(report.nativePopup));
  await host.send('Target.closeTarget',{targetId:action.targetId});
  await host.detach();
  const page=await chrome.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  const cdp=await chrome.newCDPSession(page);
  await go(page,'popup');
  await seed(page,{countries:all,selected:longest,selectionMode:'single',selectedCountries:[longest],
    enabled:false,status:{phase:'off'},savedCountryGroups:groups});
  await page.waitForFunction(c=>document.getElementById('country-name').textContent.includes(c),longest);
  const savedSummary=page.locator('#saved-groups summary').first();
  if (!await savedSummary.evaluate(el=>el.parentElement.open)) await savedSummary.click();
  for(const size of sizes) {
    await setFrame(page,cdp,size);
    await measure(page,'single-longest',['#country','#pin-selected','#connect','[data-connect-group="all"]','[data-edit-group="all"]']);
    if(size[0]===320 && size[2]===32) {
      await page.locator('#country').evaluate(el=>el.scrollIntoView({block:'center'}));
      await shot(page,'long-country-200');
    }
    if(size[0]===390) {
      const font=await page.locator('#country-name').evaluate(el=>parseFloat(getComputedStyle(el).fontSize));
      (report.renderedFont ||= {})[size[2]]=font;
    }
  }

  await seed(page,{selectedCountries:all,selectionMode:'multiple',enabled:true,
    status:{phase:'error',error:'Ошибка проверки соединения. ' + 'О'.repeat(90),
    lastFailure:{stage:'local'},diagnostics:{attempts:999999,passed:9999,failures:{connect:998,timeout:900}}},
    reserveDiagnostics:{state:'refilling',counts:{checked:999999,sameExit:99999,roundsWithSourceWarnings:9999},failures:{timeout:998},limited:true}});
  await page.waitForFunction(()=>!document.getElementById('source-quality').hidden);
  // The offline helper cannot return remote source data. Exercise the production table
  // markup with a representative long provider name and numeric shares.
  await page.evaluate(async()=>{
    for(const id of ['reserve-diagnostics','source-quality']) document.getElementById(id).open=true;
  });
  await page.waitForFunction(()=>document.getElementById('source-message').textContent.includes('недоступна'));
  await page.evaluate(()=>{
    document.getElementById('source-table').hidden=false;
    const row=document.createElement('tr');
    for(const s of ['UpstreamSourceWithLongIdentifier'.repeat(2),'9 999,125','8 888,015']) {
      const cell=document.createElement('td');cell.textContent=s;row.append(cell);
    }
    document.getElementById('source-rows').replaceChildren(row);
  });
  for(const size of sizes) {
    await setFrame(page,cdp,size);
    await measure(page,'error-diagnostics',['#disconnect','#connect','#source-country','#refresh-sources','#reserve-diagnostics summary']);
  }
  await seed(page,{enabled:false,status:{phase:'off'}});
  await page.waitForFunction(()=>document.getElementById('phase').textContent==='Отключено');
  for(const size of sizes) {
    await setFrame(page,cdp,size);
    await page.locator('#mode-multiple').click();
    await page.waitForSelector('#country-picker:not([hidden])');
    assert.equal(await page.locator('#selection-draft-chips button').count(),all.length);
    await measure(page,'picker-all',['#selection-cancel','#country-search','[data-select-country="'+longest+'"]','#selection-apply']);
    if(size[0]===320 && size[2]===32) {
      await page.locator('#selection-apply').evaluate(el=>el.scrollIntoView({block:'center'}));
      await shot(page,'chooser-200');
    }
    await page.locator('#country-search').fill('ZZZxxxxx');
    await page.waitForSelector('#country-results .no-results');
    await measure(page,'picker-empty-search',['#country-search','#selection-cancel','#selection-apply']);
    await page.locator('#selection-cancel').click();
    await page.waitForSelector('#country-picker',{state:'hidden'});
  }
  if (!baseline) {
    const groupsPanel=page.locator('#saved-groups details').first();
    if (!await groupsPanel.evaluate(el=>el.open)) await groupsPanel.locator('summary').first().click();
    await page.locator('[data-edit-group="all"]').click();
    await page.locator('#group-country-summary').click();
    await page.locator('#group-country-search').fill(longest);
    for(const size of sizes) {
      await setFrame(page,cdp,size);
      await measure(page,'group-editor',['#group-name','#group-selected-only','[data-group-country="'+longest+'"]','#group-save','#group-cancel']);
    }
  }
  await go(page,'options');
  assert.equal(await page.locator('#countries li').count(),all.length);
  for(const size of sizes) {
    await setFrame(page,cdp,size);
    await measure(page,'options-all',['#countries li:last-child button','#save','#country-search','[data-add-country="'+longest+'"]']);
    await page.locator('#country-search').fill('ZZZxxxxx');
    await page.waitForSelector('.no-results');
    await measure(page,'options-empty-search',['#country-search','#save']);
    if(size[0]===320 && size[2]===32) {await page.locator('#country-count').scrollIntoViewIfNeeded();await shot(page,'options-200');}
    await page.locator('#country-search').fill('');
  }
  const failures=report.cases.filter(c=>c.outerOverflow>1 || c.overflows.length || c.missed.length);
  report.failedCases=failures.length;
  report.textDoubles=report.renderedFont[32] >= 1.95 * report.renderedFont[16];
  assert(!errors.length,JSON.stringify(errors));
  if(!baseline) assert(!failures.length && report.textDoubles, JSON.stringify({failures:failures.slice(0,2),fonts:report.renderedFont}));
} finally {
  try {await chrome?.close();} finally {
    await fs.rm(profile,{recursive:true,force:true});
    report.profileRemoved=true;delete report.fontSize;
    await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
    console.log(JSON.stringify({cases:report.cases.length,failed:report.failedCases,fonts:report.renderedFont,output:out}));
  }
}
