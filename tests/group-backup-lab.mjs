// Local JSON round trip through the real settings page in two independent profiles.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const ext = path.join(root, 'extension');
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const manifest = JSON.parse(await fs.readFile(path.join(ext, 'manifest.json')));
const id = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0,32)
  .replace(/[0-9a-f]/g, hex => String.fromCharCode(97 + parseInt(hex,16)));
const tmp = await fs.mkdtemp(path.join(os.tmpdir(),'cp-group-backup-'));
const report = {checks:[], profileCleanup:false};
let context;
async function openSettings(profile) {
  context = await chromium.launchPersistentContext(path.join(tmp,profile),{
    channel:'chromium', headless:true, ignoreDefaultArgs:['--disable-extensions'],
    args:['--disable-extensions-except='+ext,'--load-extension='+ext,
      '--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND']});
  const page = await context.newPage();
  await page.goto('chrome-extension://'+id+'/options.html');
  await page.waitForFunction(() => !document.getElementById('import-groups').disabled);
  return page;
}
const backups = 'savedCountryGroups';
const read = async page => page.evaluate(async key => (await chrome.storage.local.get(key))[key],backups);
async function importText(page, text, resultText) {
  // Use the public import button and the browser file chooser, as in the UI.
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#import-groups').click();
  await (await chooser).setFiles({name:'groups.json',mimeType:'application/json',buffer:Buffer.from(text)});
  await page.waitForFunction(expected => document.getElementById('backup-result').textContent.includes(expected), resultText);
}
try {
  const page = await openSettings('source');
  await page.evaluate(async key => chrome.storage.local.set({[key]:[
    {id:'source-id',name:'Запасные страны',countries:['NO','EE','AT']},
    {id:'source-id-2',name:'Канада',countries:['CA']}] }),backups);
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#export-groups').click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(),'country-proxy-groups.json');
  const file = path.join(tmp,'download.json'); await download.saveAs(file);
  const exported = await fs.readFile(file,'utf8');
  assert.deepEqual(JSON.parse(exported).groups,[
    {name:'Запасные страны',countries:['AT','EE','NO']},{name:'Канада',countries:['CA']}]);
  report.checks.push('export contains only named country selections');
  await context.close(); context=null;
  const target = await openSettings('destination');
  const routing = page => page.evaluate(async () => {
    const s = await chrome.storage.local.get(['enabled','selectedCountries']);
    return {selection:s,route:(await chrome.proxy.settings.get({incognito:false})).value};
  });
  const before = await routing(target);
  await importText(target,exported,'Добавлено групп: 2.');
  const restored=await read(target); assert.equal(restored.length,2); assert.notEqual(restored[0].id,'source-id');
  await importText(target,exported,'Уже есть с таким составом: 2.');assert.deepEqual(await read(target),restored);
  const conflict=JSON.parse(exported);conflict.groups=[{name:'канада',countries:['DK']}];
  await importText(target,JSON.stringify(conflict),'совпадения названия: 1.');assert.deepEqual(await read(target),restored);
  const invalid=JSON.parse(exported);invalid.groups=[{name:'Новая',countries:['FR']},{name:'Ошибка',countries:['XX']}];
  await importText(target,JSON.stringify(invalid),'стран');assert.deepEqual(await read(target),restored);
  await importText(target,'{broken','Не удалось прочитать JSON');assert.deepEqual(await read(target),restored);
  assert.deepEqual(await routing(target),before);
  report.checks.push('import round trip into independent profile; duplicate/conflicting and malformed files preserve previous groups and route');
  report.browser=context.browser().version();report.result='PASS';
} finally {
  if(context)await context.close();
  await fs.rm(tmp,{recursive:true,force:true});report.profileCleanup=true;
  const out=path.join(root,'.runtime/group-backup');
  await fs.mkdir(out,{recursive:true});
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
}
console.log(report.result);
