// Exercise the installed popup with a local helper that records Start and never supplies an address.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {BLOCKED, matchesEffectiveRoute} from '../extension/controller.js';

const filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(filename), '..');
const countries = ['AT', 'EE', 'NO'];
const groupKey = 'savedCountryGroups';

async function fixture(journal) {
  const greeting = Buffer.from(JSON.stringify({type:'hello', feedbackProtocol:1}));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(greeting.length);
  process.stdout.write(Buffer.concat([prefix, greeting]));
  let buffered = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const size = buffered.readUInt32LE(0);
      if (size > 65536) throw Error('Unexpected native frame size');
      if (buffered.length < 4+size) break;
      const message = JSON.parse(buffered.subarray(4, 4+size));
      buffered = buffered.subarray(4+size);
      if (message.command === 'stop') return;
      if (message.command === 'start') {
        await fs.appendFile(journal, JSON.stringify(message.countries)+'\n', {mode:0o600});
      }
    }
  }
}

async function register(profile, directory, id) {
  const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const journal = path.join(directory,'starts.jsonl');
  const launcher = path.join(directory,'helper');
  await fs.writeFile(journal, '', {mode:0o600});
  const args = [process.execPath, filename, '--fixture', journal].map(quote);
  await fs.writeFile(launcher, '#!/bin/sh\nexec ' + args.join(' ') + '\n', {mode:0o700});
  const registry = path.join(profile, 'NativeMessagingHosts');
  await fs.mkdir(registry, {recursive:true});
  await fs.writeFile(path.join(registry, 'local.country_proxy.json'), JSON.stringify({
    name:'local.country_proxy', description:'Offline group selection test',
    type:'stdio', path:launcher, allowed_origins:[`chrome-extension://${id}/`]
  }), {mode:0o600});
  return async () => (await fs.readFile(journal, 'utf8')).trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));
}

async function expectStarts(read, count, expected = Array.from({length:count}, () => countries)) {
  for (let i = 0; i < 100; i++) {
    const actual = await read();
    if (actual.length >= count) {
      assert.deepEqual(actual, expected);
      return;
    }
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.fail('The offline helper did not receive Start with the selected group');
}

async function run() {
  const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const ext = path.join(root,'extension');
  const manifest = JSON.parse(await fs.readFile(path.join(ext,'manifest.json')));
  const id = createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32)
    .replace(/[a-f0-9]/g,c=>String.fromCharCode(97+parseInt(c,16)));
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'country-group-ui-'));
  const profile = path.join(scratch,'profile');
  const out = path.join(root,'.runtime/ui-candidate');
  const report = {at:new Date().toISOString(), result:'FAIL', checks:[], screenshots:{}, profileRemoved:false};
  let context;
  try {
    await fs.mkdir(out, {recursive:true});
    const starts = await register(profile,scratch,id);
    context = await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,
      viewport:{width:390,height:600}, locale:'ru-RU',timezoneId:'Europe/Moscow',
      ignoreDefaultArgs:['--disable-extensions'],args:[
        '--disable-extensions-except='+ext, '--load-extension='+ext,
        '--disable-background-networking','--disable-quic','--host-resolver-rules=MAP * ~NOTFOUND',
        '--proxy-server=http://127.0.0.1:9'
      ]});
    report.chrome = context.browser().version();
    const popup = await context.newPage();
    popup.setDefaultTimeout(6000);
    const errors = [];
    popup.on('pageerror', error=>errors.push(error.message));
    await popup.goto('chrome-extension://'+id+'/popup.html');
    const $ = selector=>popup.locator(selector);
    const state = ()=>popup.evaluate(async()=>chrome.storage.local.get(['enabled','selectionMode','selectedCountries','savedCountryGroups','status']));
    async function waitForState(check, description) {
      const until = Date.now()+6000;
      do {
        const value = await state();
        if (check(value)) return;
        await new Promise(resolve=>setTimeout(resolve,40));
      } while (Date.now() < until);
      assert.fail('Timed out waiting for ' + description);
    }
    const expectStatus = phase => waitForState(s => s.status?.phase===phase, phase);
    const ready = ()=>popup.waitForFunction(()=>document.querySelector('#phase').textContent !== 'Загрузка…' &&
      !!document.querySelector('#saved-groups summary') && !document.querySelector('#saved-groups').hidden);
    const savedOpen = async()=>{
      const summary = $('#saved-groups summary');
      if (!await summary.evaluate(el=>el.parentElement.open)) await summary.click();
    };
    const checkWidth = async()=>{
      const dimensions=await popup.evaluate(()=>({width:innerWidth,content:document.documentElement.scrollWidth}));
      assert.ok(dimensions.content <= dimensions.width, 'Popup horizontal overflow '+JSON.stringify(dimensions));
    };
    const snap = async (name, evidence)=>{
      await checkWidth();
      await popup.screenshot({path:path.join(out,name+'.png'),animations:'disabled'});
      report.screenshots[name+'.png']=evidence;
    };
    await ready();
    assert.equal((await state()).enabled,false);
    await snap('empty','New profile before any country selection');
    await savedOpen();
    const draftCountry = async (country, selected) => {
      await $('#group-country-search').fill(country);
      await $(`[data-group-country="${country}"]`).setChecked(selected);
    };
    const waitForGroups = expected => waitForState(state => {
      const saved = state[groupKey] || [];
      return saved.length===expected.length && saved.every((row,i)=>
        row.name===expected[i].name && JSON.stringify(row.countries)===JSON.stringify(expected[i].countries));
    }, 'saved groups');
    
    // A fresh profile can prepare a group entirely offline.
    await $('#group-add').click();
    await $('#group-name').fill('Черновая');
    await draftCountry('PL',true);
    await $('#group-country-search').press('Escape');
    assert.equal(await popup.evaluate(()=>document.activeElement.id),'group-country-summary');
    await $('#group-save').click();
    await waitForGroups([{name:'Черновая',countries:['PL']}]);
    assert.deepEqual(await starts(),[]);
    assert.equal((await state()).enabled,false);
    await $('[data-edit-group]').click();
    await $('#group-delete').click();
    await $('#group-keep').click();
    assert.equal((await state())[groupKey].length,1);
    await $('#group-delete').click();
    await $('#group-delete-now').click();
    await waitForGroups([]);
    assert.deepEqual(await starts(),[]);
    report.checks.push('create before first connection, edit with keyboard, cancel and confirm deletion');
    await $('#saved-groups summary').click();

    await $('#mode-multiple').click();
    const modal = $('#country-picker');
    await modal.waitFor({state:'visible'});
    assert.equal(await $('#country-search').evaluate(el=>document.activeElement===el),true);
    await popup.keyboard.press('Escape');
    await modal.waitFor({state:'hidden'});
    await $('#mode-multiple').click();
    for (const cc of ['NO','EE','AT']) {
      await $('#country-search').fill(cc);
      await $(`[data-select-country="${cc}"]`).check();
    }
    await $('#country-search').fill('');
    assert.ok(await $('#selection-apply').isEnabled());
    // Tabbing must stay inside a long chooser even when choices are scrolled.
    const last = modal.locator('button:visible:not(:disabled),input:visible:not(:disabled)').last();
    await last.focus();
    await popup.keyboard.press('Tab');
    assert.ok(await modal.evaluate(el=>el.contains(document.activeElement)));
    await $('#country-search').focus();
    for (const width of [380,400,390]) {
      await popup.setViewportSize({width,height:600});
      await checkWidth();
      const box = await $('#selection-apply').boundingBox();
      assert.ok(box && box.y>=0 && box.y+box.height <= 601, 'Chooser action outside visible viewport: '+JSON.stringify(box));
    }
    await snap('chooser','Genuine unapplied NO/EE/AT selection');
    await $('#selection-apply').click();
    await modal.waitFor({state:'hidden'});
    await expectStarts(starts,1);
    assert.deepEqual((await state()).selectedCountries,countries);
    await $('#disconnect').click();
    await expectStatus('off');
    await savedOpen();
    await $('#group-add').click();
    assert.equal(await $('#group-name').evaluate(el=>document.activeElement===el),true);
    await $('#group-name').fill('Европа');
    await $('#group-save').click();
    await $('[data-connect-group]').waitFor();
    const group = (await state())[groupKey][0];
    assert.equal(group.name,'Европа');
    assert.deepEqual(group.countries,countries);
    assert.equal((await state()).enabled,false);
    await popup.reload();
    await ready();
    await savedOpen();
    assert.deepEqual((await state())[groupKey],[group]);
    const savedButton = $('[data-connect-group]');
    assert.match(await savedButton.getAttribute('aria-label'),/Европа/);
    await snap('saved','Persisted named group, disconnected');
    await savedButton.click();
    await expectStarts(starts,2);
    const active = await state();
    assert.equal(active.enabled,true);
    assert.equal(active.selectionMode,'multiple');
    assert.deepEqual(active.selectedCountries,countries);
    assert.equal(active.status.phase,'searching');
    const route = ()=>popup.evaluate(()=>chrome.proxy.settings.get({incognito:false}));
    assert.ok(matchesEffectiveRoute(await route(),BLOCKED),'Expect extension-owned blocked route while searching');
    await $('#saved-groups summary').click();
    await popup.evaluate(()=>scrollTo(0,0));
    await snap('searching','Actual Start from saved group, inert test helper');
    report.checks.push('chooser keyboard, three viewport widths and visible apply button',
      'stored country set persists after popup reload; explicit connect reaches real controller and offline native host');

    await savedOpen();
    await $('[data-edit-group]').click();
    const changedCountries = ['AT','NO','PL'];
    // A second popup can rename the same group while the first has an older draft.
    const other = await context.newPage();
    try {
      await other.goto(popup.url());
      await other.locator('[data-edit-group]').click();
      await other.locator('#group-name').fill('Второе окно');
      await other.locator('#group-save').click();
      await waitForGroups([{name:'Второе окно',countries}]);
      assert.equal((await state())[groupKey][0].name,'Второе окно');
      await other.getByText('Группа сохранена.', {exact:true}).waitFor();
    } finally {
      await other.close();
    }
    assert.equal((await state())[groupKey][0].name,'Второе окно');
    assert.equal(await $('#group-name').inputValue(),'Европа');
    await $('#group-name').fill('Устаревшее изменение');
    await $('#group-save').click();
    try {
      await popup.getByText('Группа изменилась. Откройте её для редактирования ещё раз.').waitFor();
    } catch (error) {
      const message = await $('#group-message').textContent();
      throw Error('Expected stale edit feedback. Message: '+message+'; group: '+JSON.stringify((await state())[groupKey]));
    }
    await $('#group-cancel').click();
    await $('[data-edit-group]').click();
    await $('#group-name').fill('Три страны');
    await $('#group-country-summary').click();
    await draftCountry('EE',false);
    await draftCountry('PL',true);
    await $('#group-save').click();
    await waitForGroups([{name:'Три страны',countries:changedCountries}]);
    await popup.reload(); await ready(); await savedOpen();
    assert.deepEqual((await state())[groupKey],[{...group,name:'Три страны',countries:changedCountries}]);
    assert.deepEqual((await state()).selectedCountries,countries);
    assert.ok(matchesEffectiveRoute(await route(),BLOCKED));
    await expectStarts(starts,2);
    await $('[data-connect-group]').click();
    await expectStarts(starts,3,[countries,countries,changedCountries]);
    assert.deepEqual((await state()).selectedCountries,changedCountries);
    report.checks.push('independent popup rename survives stale draft save',
      'editing membership during an active session preserves its country set until explicit connection');
    await $('[data-edit-group]').click();
    await $('#group-delete').click();
    await $('#group-delete-now').click();
    await waitForGroups([]);
    await popup.reload(); await ready(); await savedOpen();
    assert.equal(await $('[data-connect-group]').count(),0);
    assert.equal((await state()).enabled,true);
    assert.deepEqual((await state()).selectedCountries,changedCountries);
    await expectStarts(starts,3,[countries,countries,changedCountries]);
    await $('#disconnect').click(); await expectStatus('off');
    assert.equal((await state()).enabled,false);
    report.checks.push('rename/delete survive reload, preserve current selection and start no further connection');

    // Only this screenshot uses synthetic display state and documentation-only IP addresses.
    await popup.evaluate(async countries=>{
      const now=Date.now();
      await chrome.storage.local.set({enabled:true,selectionMode:'multiple',selectedCountries:countries,
        pool:{countries,count:1,expiresAt:now+60000},status:{phase:'connected',updatedAt:now,
          proxy:{country:'EE',host:'192.0.2.10',port:8080,scheme:'http'},
          browser:{ok:true,country:'EE',exitIp:'203.0.113.23',checkedAt:now,latencyMs:230}}});
    },countries);
    await popup.waitForFunction(()=>document.getElementById('phase').textContent==='Подключено');
    await $('#saved-groups summary').click();
    await popup.evaluate(()=>scrollTo(0,0));
    await snap('connected-example','Seeded UI example with documentation-only addresses. No real network route.');
    assert.deepEqual(errors,[]);
    report.result='PASS';
  } catch(error) {
    report.failure=error.message;
    throw error;
  } finally {
    if (context) await context.close();
    await fs.rm(scratch,{recursive:true,force:true});
    await assert.rejects(fs.access(scratch),{code:'ENOENT'});
    report.profileRemoved=true;
    await fs.writeFile(path.join(out,'saved-groups.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  }
}

if (process.argv[2]==='--fixture') await fixture(process.argv[3]);
else await run();
