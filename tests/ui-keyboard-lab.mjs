// Keyboard and accessibility-tree acceptance in an offline, disposable Chrome for Testing.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const extension = path.join(root, 'extension');
const out = path.join(root, '.runtime/keyboard-qa');
const {key} = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json')));
const id = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)
  .replace(/[a-f0-9]/g, c => String.fromCharCode(97 + Number.parseInt(c, 16)));
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'country-keyboard-'));
const baseline = process.argv.includes('--baseline');
const report = {at: new Date().toISOString(), baseline, checks: [], profileRemoved: false};
let context;
async function check(name, fn, results = report.checks) {
  try {
    await fn();
    results.push({name, result: 'PASS'});
  } catch (err) {
    results.push({name, result: 'FAIL', detail: err.message.split('\n')[0]});
  }
}
const press = (p, key) => p.keyboard.press(key);
const focusIs = (p, selector) => p.evaluate(s => document.activeElement?.matches(s), selector);
async function open(p, trigger = '#mode-multiple') {
  if (await p.locator('#country-picker').isVisible()) await press(p, 'Escape');
  await p.locator(trigger).focus();
  await press(p, 'Enter');
  await p.locator('#country-search').waitFor({state:'visible'});
}
async function namedNodes(p) {
  const cdp = await context.newCDPSession(p);
  try {
    const {nodes} = await cdp.send('Accessibility.getFullAXTree');
    return nodes.filter(n => !n.ignored).map(n => ({role:n.role?.value, name:n.name?.value}));
  } finally { await cdp.detach(); }
}
try {
  context = await chromium.launchPersistentContext(profile, {channel:'chromium', headless:true, locale:'ru-RU',
    viewport:{width:390,height:600},ignoreDefaultArgs:['--disable-extensions'],
    args:['--disable-extensions-except='+extension,'--load-extension='+extension,'--disable-background-networking',
      '--disable-quic','--host-resolver-rules=MAP * ~NOTFOUND','--proxy-server=http://127.0.0.1:9']});
  report.chrome = context.browser().version();
  const popup = await context.newPage();
  popup.setDefaultTimeout(3500);
  const extensionUrl = 'chrome-extension://' + id;
  await popup.goto(extensionUrl+'/popup.html');
  await popup.waitForFunction(() => document.querySelector('#phase').textContent === 'Отключено');
  await check('Both picker entry points restore their own focus after Escape', async () => {
    for (const selector of ['#country', '#mode-multiple']) {
      await open(popup,selector);
      assert.ok(await focusIs(popup,'#country-search'),'Search must receive initial focus');
      await press(popup,'Escape');
      assert.ok(await focusIs(popup,selector), 'Focus should return to ' + selector);
    }
  });
  await check('Modal rejects focus outside, exposes a named dialog and named controls in the AX tree', async () => {
    await open(popup);
    await popup.evaluate(() => document.getElementById('settings').focus());
    assert.ok(await focusIs(popup,'#country-picker *'),'Background took focus inside a modal session');
    const nodes=await namedNodes(popup);
    assert.ok(nodes.some(n=>n.role==='dialog' && n.name==='Выберите страны'));
    assert.ok(nodes.some(n=>n.role==='searchbox' && n.name));
    assert.ok(nodes.some(n=>n.role==='checkbox' && /Норвегия/.test(n.name)));
    assert.ok(nodes.filter(n=>['button','checkbox'].includes(n.role)).every(n=>n.name?.trim()));
    assert.ok(!nodes.some(n=>n.role==='button' && ['Настройки','Избранное'].includes(n.name)));
  });
  await check('Apply is reachable within eight Tabs in a full catalogue and large draft', async () => {
    await popup.evaluate(() => chrome.storage.local.set({selectionMode:'multiple',selectedCountries:
      ['AT','AU','AZ','BE','BG','BR','CA','CH','CN','DE','EE','ES','FI','FR','GB','JP','NO','PL','US']}));
    await popup.waitForFunction(()=>document.getElementById('country-name').textContent.includes('19'));
    await open(popup);
    const results=popup.locator('[data-select-country]');
    assert.equal(await results.count(),249);
    await press(popup,'ArrowDown');
    assert.ok(await focusIs(popup,'[data-select-country]'));
    const first=await popup.evaluate(()=>document.activeElement.dataset.selectCountry);
    await press(popup,'End');
    assert.ok(await focusIs(popup,'[data-select-country]') && await popup.evaluate(()=>document.activeElement.dataset.selectCountry)!==first,'End should jump to last country');
    await press(popup,'Home');
    assert.equal(await popup.evaluate(()=>document.activeElement.dataset.selectCountry),first);
    let tabs=0;
    while (tabs < 8 && !await focusIs(popup,'#selection-apply')) { await press(popup,'Tab'); tabs++; }
    assert.ok(await focusIs(popup,'#selection-apply'),'Tab did not reach Apply in eight presses');
    report.tabsToApply=tabs;
    await press(popup,'Tab'); assert.ok(await focusIs(popup,'#country-picker *'));
  });
  await check('Removing a draft chip keeps keyboard focus in the draft', async () => {
    await open(popup);
    const chips=popup.locator('[data-remove-country]');
    assert.ok(await chips.count() >= 2);
    await chips.first().focus();
    await press(popup,'Enter');
    assert.ok(await focusIs(popup,'[data-remove-country]'),'Removing a chip dropped keyboard focus');
  });
  await check('Favoriting a filtered result retains the star and its updated pressed state', async () => {
    await open(popup); await popup.locator('#country-search').fill('Норвегия');
    const star=popup.locator('[data-favorite="NO"]');
    const before=await star.getAttribute('aria-pressed');
    await star.focus(); await press(popup,'Space');
    await popup.waitForFunction(previous=>document.querySelector('[data-favorite="NO"]')?.getAttribute('aria-pressed')!==previous,before);
    assert.ok(await focusIs(popup,'[data-favorite="NO"]'),'Focus left the activated star');
  });
  await check('An empty search stays cancellable, and the status heading only announces a changed phase', async () => {
    await open(popup); await popup.locator('#country-search').fill('xxxxdomaintestxxxx');
    assert.equal(await popup.locator('#country-results input,#country-results button').count(),0);
    await press(popup,'Escape');
    assert.ok(!await popup.locator('#country-picker').isVisible(),'First Escape must dismiss a search with text');
    await popup.evaluate(() => {
      const heading=document.getElementById('phase'); window.phaseChanges=0;
      window.phaseWatch=new MutationObserver(()=>window.phaseChanges++);
      window.phaseWatch.observe(heading,{childList:true,subtree:true,characterData:true});
      return chrome.storage.local.set({status:{phase:'empty'}});
    });
    await popup.waitForFunction(()=>window.phaseChanges===1);
    await popup.evaluate(()=>chrome.storage.local.set({status:{phase:'empty',updatedAt:Date.now()}}));
    await popup.waitForTimeout(1100);
    assert.equal(await popup.evaluate(()=>window.phaseChanges),1);
    await popup.evaluate(()=>window.phaseWatch.disconnect());
  });
  const options=await context.newPage();
  options.setDefaultTimeout(3500);
  await popup.evaluate(async()=>{
    const {countries=[]}=await chrome.storage.local.get('countries');
    const reply=await chrome.runtime.sendMessage({action:'settings',add:['NO','EE'],remove:countries.filter(code=>!['NO','EE'].includes(code))});
    if(!reply?.ok)throw Error(reply?.error||'Favorite setup failed');
  });
  await options.goto(extensionUrl+'/options.html');
  await options.locator('#countries button').first().waitFor();
  await check('Removing favorite rows retains focus, including removal of the last favorite', async () => {
    const rows=options.locator('#countries button');
    await rows.first().focus(); await press(options,'Enter');
    assert.ok(await focusIs(options,'#countries button'),'Removing a row dropped focus instead of moving to its neighbor');
    await press(options,'Enter');
    assert.equal(await rows.count(),0);
    assert.ok(await focusIs(options,'#save'),'The last removal should focus the pending save');
  });
  await check('The settings catalogue allows arrow navigation, keyboard toggles and one Tab to leave 249 countries', async () => {
    await options.locator('#country-search').focus(); await press(options,'ArrowDown');
    assert.ok(await focusIs(options,'[data-add-country]'),'ArrowDown did not enter the settings catalogue');
    const first=await options.evaluate(()=>document.activeElement.dataset.addCountry);
    await press(options,'End');
    const last=await options.evaluate(()=>document.activeElement.dataset.addCountry);
    assert.notEqual(last,first,'End did not reach the last settings country');
    const before=await options.evaluate(()=>document.activeElement.getAttribute('aria-pressed'));
    await press(options,'Space');
    assert.equal(await options.evaluate(()=>document.activeElement.dataset.addCountry),last);
    assert.notEqual(await options.evaluate(()=>document.activeElement.getAttribute('aria-pressed')),before);
    await press(options,'Home');
    assert.equal(await options.evaluate(()=>document.activeElement.dataset.addCountry),first);
    await press(options,'Tab');
    assert.equal(await focusIs(options,'[data-add-country]'),false);
  });
  report.statusChecks = [];
  await check('Searching explains the waiting tabs only while Chrome owns the blocking route', async () => {
    await popup.evaluate(async () => {
      const {BLOCKED}=await import(chrome.runtime.getURL('controller.js'));
      await chrome.proxy.settings.set({value:BLOCKED,scope:'regular'});
      await chrome.storage.local.set({enabled:true,status:{phase:'searching'},pool:null});
    });
    await popup.waitForFunction(()=>document.querySelector('#reserve').innerText.includes('Вкладки ждут прокси'));
    assert.ok(await popup.locator('#disconnect').isVisible());
    await popup.evaluate(()=>chrome.proxy.settings.clear({scope:'regular'}));
    await popup.waitForFunction(()=>document.getElementById('reserve').hidden);
    assert.equal(await popup.locator('#reserve').textContent(),'');
  }, report.statusChecks);
  await check('A Chrome-confirmed route with no reserve remains usable; stale route evidence loses that label', async () => {
    // Presentation fixture. Chrome applies the loopback route, no external socket is used.
    await popup.evaluate(async () => {
      const {proxyConfig}=await import(chrome.runtime.getURL('controller.js'));
      const proxy={scheme:'http',host:'127.0.0.1',port:18999,country:'EE',exitIp:'203.0.113.4'};
      await chrome.proxy.settings.set({value:proxyConfig(proxy),scope:'regular'});
      await chrome.storage.local.set({enabled:true,selectedCountries:['EE'],pool:{countries:['EE'],count:0,checking:true},
        status:{phase:'connected',proxy,browser:{ok:true,country:'EE',exitIp:proxy.exitIp,checkedAt:Date.now()}}});
    });
    await popup.waitForFunction(()=>document.querySelector('#reserve').innerText==='Подключение работает. Ищем запасной адрес.');
    await popup.evaluate(()=>chrome.storage.local.set({pool:{countries:['EE'],count:0,checking:false}}));
    await popup.waitForFunction(()=>document.querySelector('#reserve').innerText.includes('Запасного адреса пока нет'));
    await popup.evaluate(()=>chrome.proxy.settings.clear({scope:'regular'}));
    await popup.waitForFunction(()=>document.getElementById('reserve').hidden);
  }, report.statusChecks);
  report.result = [...report.checks,...report.statusChecks].every(c => c.result==='PASS') ? 'PASS' : 'FAIL';
} finally {
  if (context) await context.close();
  await fs.rm(profile,{recursive:true,force:true});
  await assert.rejects(fs.access(profile),{code:'ENOENT'});
  report.profileRemoved=true;
  await fs.mkdir(out,{recursive:true});
  await fs.writeFile(path.join(out,baseline?'baseline.json':'result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
}
console.log(JSON.stringify(report));
if (!baseline && report.result!=='PASS') process.exitCode=1;
