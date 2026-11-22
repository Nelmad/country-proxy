// Real isolated Chrome worker + storage/DNR/native APIs; transparent startup
// storage rejection/timing injection before importing unchanged production code.
// Foreign ownership comes from a separate actual owned extension, not an API mock.
// Run with explicit CHROME_TEST_EXECUTABLE, PLAYWRIGHT_MODULE and TEST_PYTHON.
// --source-root selects the immutable executable snapshot, --output the receipt.
// --expect-red is for the defective baseline only; unexpected recovery fails.
// GREEN includes pending Connect -> Stop -> fresh Connect; native sink offers
// no proxy. The preconfirm --startup-double-failure matrix adds TLS/Chrome proof.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {inspectRuntime} from './chrome-runtime.mjs';

const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const source = path.resolve(arg('--source-root', root));
const output = path.resolve(arg('--output', path.join(root, '.runtime/runtime-startup/report.json')));
const expectRed = process.argv.includes('--expect-red');
const executablePath = process.env.CHROME_TEST_EXECUTABLE;
assert.ok(executablePath?.includes('Google Chrome for Testing'), 'Explicit Chrome for Testing required');
const python = process.env.TEST_PYTHON || 'python3';
const countries = ['AT', 'EE', 'NO'];
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const bounded = async (promise, ms, label) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), ms); })]); }
  finally { clearTimeout(timer); }
};
async function until(read, label, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const result = await read(); if (result) return result; await pause(30); }
  throw Error('Timed out: ' + label);
}
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'country-proxy-startup-'));
const mainRegistration = path.join(os.homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts/local.country_proxy.json');
async function snapshot(file) {
  try { const [body, stat] = await Promise.all([fs.readFile(file), fs.stat(file)]); return {sha256: sha(body), ino: stat.ino, mtimeMs: stat.mtimeMs, mode: stat.mode, size: stat.size}; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const originalRegistration = await snapshot(mainRegistration);
const productionHashes = {};
for (const name of await fs.readdir(path.join(source, 'extension'))) {
  const file = path.join(source, 'extension', name);
  if ((await fs.stat(file)).isFile()) productionHashes[name] = sha(await fs.readFile(file));
}
const manifest = JSON.parse(await fs.readFile(path.join(source, 'extension/manifest.json')));
const id = sha(Buffer.from(manifest.key, 'base64')).slice(0, 32).replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
const report = {result: 'FAIL', expectRed, publicTraffic: false, countries, cases: [], executed: [], cleanupErrors: [],
  faultModel: 'One rejected enabled storage read, and controlled await points on initial read/catalog. All remaining Chrome APIs are actual; foreign owner is a second actual owned extension.'};
let context, watchdog;
async function launch(name, options, foreign = false) {
  const directory = path.join(scratch, name), profile = path.join(directory, 'profile'), home = path.join(directory, 'home');
  const extension = path.join(directory, 'extension'), journal = path.join(directory, 'native.jsonl');
  await fs.mkdir(home, {recursive: true});
  await fs.cp(path.join(source, 'extension'), extension, {recursive: true});
  const fixtureOptions = {saved: {enabled: options.enabled ?? false,
    selectedCountries: countries, selectionMode: 'multiple', countries, selected: null}, ...options};
  await fs.writeFile(path.join(extension, 'runtime-startup-injection.js'), 'const options = ' + JSON.stringify(fixtureOptions) + ';\n' +
    await fs.readFile(path.join(root, 'tests/runtime-startup-fixture.js'), 'utf8'));
  await fs.writeFile(path.join(extension, 'runtime-startup-fixture.js'),
    "import './runtime-startup-injection.js';\nimport './background.js';\nglobalThis.__runtimeFixture.imported = true;\n");
  await fs.writeFile(path.join(extension, 'manifest.json'), JSON.stringify({...manifest,
    background: {...manifest.background, service_worker: 'runtime-startup-fixture.js'}}));
  for (const [file, digest] of Object.entries(productionHashes)) if (file !== 'manifest.json') {
    assert.equal(sha(await fs.readFile(path.join(extension, file))), digest, 'Production bytes preserved: ' + file);
  }
  const launcher = path.join(directory, 'native');
  await fs.writeFile(launcher, '#!/bin/sh\nexec ' + [python, '-I', '-B', path.join(root, 'tests/runtime_startup_fixture.py'), journal].map(quote).join(' ') + '\n', {mode: 0o700});
  const registration = path.join(profile, 'NativeMessagingHosts');
  await fs.mkdir(registration, {recursive: true});
  await fs.writeFile(path.join(registration, 'local.country_proxy.json'), JSON.stringify({name: 'local.country_proxy',
    description: 'Owned startup regression native sink', path: launcher, type: 'stdio', allowed_origins: ['chrome-extension://' + id + '/']}), {mode: 0o600});
  const extensions = [extension];
  if (foreign) {
    const owner = path.join(directory, 'foreign-owner'); await fs.mkdir(owner);
    await fs.writeFile(path.join(owner, 'owner.js'), "chrome.proxy.settings.set({scope:'regular',value:{mode:'direct'}}).then(()=>{globalThis.ownerReady=true;});", 'utf8');
    await fs.writeFile(path.join(owner, 'manifest.json'), JSON.stringify({manifest_version: 3, name: 'Owned startup proxy conflict fixture', version: '1.0', permissions: ['proxy'], background: {service_worker: 'owner.js', type: 'module'}}));
    extensions.push(owner);
  }
  context = await chromium.launchPersistentContext(profile, {executablePath, headless: true, env: {...process.env, HOME: home},
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--disable-background-networking', '--disable-quic',
      '--load-extension=' + extensions.join(','), '--disable-extensions-except=' + extensions.join(','),
      '--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE 127.0.0.1', '--proxy-server=http://127.0.0.1:9']});
  report.browser = context.browser().version();
  const workerURL = 'chrome-extension://' + id + '/runtime-startup-fixture.js';
  const worker = context.serviceWorkers().find(w => w.url() === workerURL) || await context.waitForEvent('serviceworker', {predicate: w => w.url() === workerURL, timeout: 10000});
  await until(() => worker.evaluate(() => globalThis.__runtimeFixture?.prepared), 'fixture prepared');
  const popup = await context.newPage(); await popup.goto('chrome-extension://' + id + '/popup.html');
  const state = () => popup.evaluate(async () => ({...await chrome.storage.local.get(['enabled', 'status', 'selectedCountries']),
    route: await chrome.proxy.settings.get({incognito: false}), dynamic: await chrome.declarativeNetRequest.getDynamicRules(), session: await chrome.declarativeNetRequest.getSessionRules()}));
  const cmd = message => popup.evaluate(value => chrome.runtime.sendMessage(value), message);
  const frames = async () => (await fs.readFile(journal, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const starts = async () => (await frames()).filter(row => row.command === 'start');
  const fixture = () => worker.evaluate(() => {
    const {start, releaseRead, releaseCatalog, ...state} = globalThis.__runtimeFixture; return state;
  });
  const start = () => worker.evaluate(() => globalThis.__runtimeFixture.start());
  const finishReady = async () => {
    await until(() => worker.evaluate(() => globalThis.__runtimeFixture.imported), 'production import');
    assert.equal((await cmd({action: 'sourceQuality', country: 'NO'})).ok, true);
    report.executed.push({name, ...await inspectRuntime(context, source, {workerName: 'runtime-startup-fixture.js',
      names: ['background.js', 'controller.js', 'traffic-gate.js', 'privacy-guard.js', 'special-destinations.js']})});
  };
  let owner;
  if (foreign) {
    owner = context.serviceWorkers().find(w => w.url().endsWith('/owner.js')) || await context.waitForEvent('serviceworker', {predicate: w => w.url().endsWith('/owner.js'), timeout: 10000});
    await until(() => owner.evaluate(() => globalThis.ownerReady), 'real foreign owner ready');
    const ownership = await popup.evaluate(() => chrome.proxy.settings.get({incognito: false}));
    assert.equal(ownership.levelOfControl, 'controlled_by_other_extensions', 'Actual foreign ownership before production bootstrap');
  }
  const releaseOwner = async () => {
    await owner.evaluate(() => chrome.proxy.settings.clear({scope: 'regular'}));
    await until(async () => (await state()).route.levelOfControl !== 'controlled_by_other_extensions', 'actual owner released');
  };
  const stop = async () => {
    assert.equal((await cmd({action: 'disconnect'})).ok, true);
    const stopped = await state();
    assert.equal(stopped.enabled, false); assert.equal(stopped.status.phase, 'off');
    assert.equal(stopped.dynamic.length, 0); assert.equal(stopped.session.length, 0);
    assert.notEqual(stopped.route.levelOfControl, 'controlled_by_this_extension');
  };
  return {name, worker, popup, state, cmd, fixture, start, finishReady, starts, releaseOwner, stop,
    close: async () => { await bounded(context.close(), 10000, 'case browser close timeout'); context = null; }};
}
async function assertStart(h) {
  const start = await until(async () => (await h.starts()).at(-1), 'native start recorded');
  assert.deepEqual(start.countries, countries);
  const s = await h.state(); assert.deepEqual(s.selectedCountries, countries);
  assert.equal(s.enabled, true); assert.equal(s.status.phase, 'searching');
  assert.equal(s.session.filter(rule => rule.action.type === 'allow').length, 0);
  return start;
}
async function assertBlocked(h) {
  const page = await context.newPage();
  try { await assert.rejects(page.goto('https://ordinary.test/startup-proof', {timeout: 3000}), /ERR_BLOCKED_BY_CLIENT/); }
  finally { await page.close(); }
  assert.equal((await h.state()).session.filter(rule => rule.action.type === 'allow').length, 0);
}
async function storageCase({enabled, stopFirst = false, stopDuringRetry = false}) {
  const name = 'storage-retry-' + (enabled ? 'enabled' : 'disabled') + (stopFirst ? '-stop-first' : '') + (stopDuringRetry ? '-stop-during-retry' : '');
  const h = await launch(name, {enabled, rejectInitialRead: true, holdCatalog: stopDuringRetry});
  await h.start(); await h.finishReady();
  const initial = await h.state();
  assert.equal(initial.status.phase, 'error'); assert.equal((await h.fixture()).storageRejected, 1);
  assert.equal((await h.starts()).length, 0);
  const row = {name, initial, injectedStorageRejections: 1}; report.cases.push(row);
  if (stopFirst) await h.stop();
  if (expectRed) {
    const reply = await h.cmd({action: 'connect', countries});
    assert.equal(reply.ok, false); assert.match(reply.error, /стран/);
    assert.equal((await h.starts()).length, 0);
    Object.assign(row, {result: 'RED_REPRODUCED', reply, nativeStarts: 0});
  } else {
    if (enabled && !stopFirst) {
      assert.equal(initial.status.lastFailure?.stage, 'local', 'Startup error exposes explicit Retry');
      await until(() => h.popup.locator('#connect').isVisible(), 'popup Retry visible');
      assert.match(await h.popup.locator('#connect').innerText(), /Повторить/);
    }
    if (stopDuringRetry) {
      const pending = h.cmd({action: 'connect', countries});
      await until(async () => (await h.fixture()).catalogPending, 'retry waits for catalog');
      await h.stop();
      await h.worker.evaluate(() => globalThis.__runtimeFixture.releaseCatalog());
      assert.equal((await pending).ok, true);
      await pause(100);
      assert.equal((await h.starts()).length, 0, 'Stop cancels the older pending Connect');
      assert.equal((await h.state()).enabled, false);
      assert.equal((await h.cmd({action: 'connect', countries})).ok, true);
    } else if (enabled && !stopFirst) {
      await h.popup.locator('#connect').click();
    } else assert.equal((await h.cmd({action: 'connect', countries})).ok, true);
    row.start = await assertStart(h); await assertBlocked(h);
    row.result = 'PASS'; row.nativeStarts = (await h.starts()).length;
  }
  await h.stop(); await h.close();
}
async function ownerCase(timing) {
  const h = await launch('foreign-owner-' + timing, {enabled: true, holdInitialRead: timing === 'before-initial', holdCatalog: timing === 'during-catalog'}, true);
  await h.start();
  if (timing === 'before-initial') {
    await until(async () => { const f = await h.fixture(); return f.initialReadPending && f.routeReads.includes('controlled_by_other_extensions') && f.proxyClears; }, 'foreign ownership observed before initial read resolves');
    await h.releaseOwner();
    await h.worker.evaluate(() => globalThis.__runtimeFixture.releaseRead());
  } else if (timing === 'during-catalog') {
    await until(async () => (await h.fixture()).catalogPending, 'catalog hold with foreign ownership');
    await h.releaseOwner();
    await h.worker.evaluate(() => globalThis.__runtimeFixture.releaseCatalog());
  }
  await h.finishReady();
  const initial = await h.state(), before = await h.starts();
  const row = {name: 'foreign-owner-' + timing, initial, beforeExplicitRetry: before.length, fixture: await h.fixture(), actualForeignExtension: true};
  report.cases.push(row);
  if (expectRed && timing === 'before-initial') {
    await assertStart(h); row.beforeExplicitRetry = (await h.starts()).length;
    assert.equal(row.beforeExplicitRetry, 1); row.result = 'RED_REPRODUCED';
  } else {
    assert.equal(before.length, 0, 'Observed bootstrap conflict cannot auto-start after foreign release');
    assert.equal(initial.status.phase, 'error'); assert.equal(initial.status.lastFailure?.stage, 'local');
    await assertBlocked(h);
    if (timing === 'after-ready') await h.releaseOwner();
    await pause(100); assert.equal((await h.starts()).length, 0, 'Owner release does not implicitly Retry');
    assert.equal((await h.cmd({action: 'connect', countries})).ok, true);
    row.explicitRetryStart = await assertStart(h); row.result = 'PASS';
  }
  await h.stop(); await h.close();
}
try {
  watchdog = setTimeout(() => { void context?.close(); }, 150000);
  await storageCase({enabled: true});
  await storageCase({enabled: false, stopFirst: true});
  if (!expectRed) await storageCase({enabled: true, stopDuringRetry: true});
  for (const timing of ['before-initial', 'during-catalog', 'after-ready']) await ownerCase(timing);
  const fresh = await launch('fresh-worker-control', {enabled: false});
  await fresh.start(); await fresh.finishReady();
  assert.equal((await fresh.state()).status.phase, 'off');
  assert.equal((await fresh.cmd({action: 'connect', countries})).ok, true);
  const freshStart = await assertStart(fresh); await assertBlocked(fresh); await fresh.stop(); await fresh.close();
  report.cases.push({name: 'fresh-worker-control', result: 'PASS', freshStart});
  report.result = expectRed ? 'RED_REPRODUCED' : 'PASS';
} catch (error) { report.result = 'FAIL'; report.error = error.stack || String(error); }
finally {
  clearTimeout(watchdog);
  if (context) try { await bounded(context.close(), 10000, 'browser close timeout'); } catch (error) { report.cleanupErrors.push(error.message); }
  for (let i = 0; i < 50; i++) {
    report.ownedProcessesRemaining = execFileSync('ps', ['-axo', 'pid=,command='], {encoding: 'utf8'})
      .split('\n').filter(line => line.includes(scratch));
    if (!report.ownedProcessesRemaining.length) break;
    await pause(100);
  }
  if (report.ownedProcessesRemaining.length) report.cleanupErrors.push('Owned browser/native processes remain after context close');
  await fs.rm(scratch, {recursive: true, force: true});
  report.scratchRemoved = !(await fs.stat(scratch).catch(() => null));
  report.mainRegistrationUnchanged = JSON.stringify(originalRegistration) === JSON.stringify(await snapshot(mainRegistration));
  report.changedExtension = [];
  for (const [name, digest] of Object.entries(productionHashes)) if (sha(await fs.readFile(path.join(source, 'extension', name))) !== digest) report.changedExtension.push(name);
  report.extensionSHA256 = productionHashes;
  report.fixtureSHA256 = sha(await fs.readFile(path.join(root, 'tests/runtime-startup-fixture.js')));
  report.limits = 'Actual CfT worker, popup Retry, DNR, proxy ownership and native frames. Storage failure is an injected Promise rejection, not an observed Chrome disk failure. Catalog/read pauses are injected timing points. Native sink never offers a proxy; tests native Start intent and request denial, not successful proxy validation/TLS. No public traffic, personal profiles or main registration.';
  if (report.error || report.cleanupErrors.length || !report.scratchRemoved || !report.mainRegistrationUnchanged || report.changedExtension.length) report.result = 'FAIL';
  await fs.mkdir(path.dirname(output), {recursive: true});
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
  console.log(JSON.stringify({result: report.result, cases: report.cases.map(row => ({name: row.name, result: row.result})),
    error: report.error, cleanupErrors: report.cleanupErrors, scratchRemoved: report.scratchRemoved,
    mainRegistrationUnchanged: report.mainRegistrationUnchanged, changedExtension: report.changedExtension, output}));
  if (!['PASS', 'RED_REPRODUCED'].includes(report.result) || report.error || report.cleanupErrors.length || !report.scratchRemoved || !report.mainRegistrationUnchanged || report.changedExtension.length) process.exitCode = 1;
}
