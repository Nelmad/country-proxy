// Local-only acceptance of ordinary-request gating before Chrome confirmation.
// Synthetic native offers and GeoIP; real unchanged extension, CONNECT and TLS.
// --baseline runs the same decisive probe against an exact older extension.
// --paired-health derives both HTTPS completion orders from real Session + host.status_message serializer.
// --startup-double-failure rejects one initial storage read + error-status write.
// --ui-truth checks real connected/revoked admission against current popup claims.
// --startup-old-proof adds a stale connected proof to --startup-double-failure.
// --expect-ui-truth-red accepts only the immutable popup defect for either UI case.
// --stop-double-failure rejects owned proxy.clear + stopError writes after a real Start; popup Retry Stop must remain usable.
// Add --expect-paired-red / --expect-startup-red only for immutable defective
// --source-root baselines; an unexpected baseline pass fails these modes.
// Explicit CHROME_TEST_EXECUTABLE, PLAYWRIGHT_MODULE and TEST_PYTHON are supported.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {inspectRuntime} from './chrome-runtime.mjs';

const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
}
const baseline = process.argv.includes('--baseline');
const developmentSmoke = process.argv.includes('--smoke');
const healthNegative = process.argv.includes('--health-negative');
const pairedHealth = process.argv.includes('--paired-health');
const startupDoubleFailure = process.argv.includes('--startup-double-failure');
const stopDoubleFailure = process.argv.includes('--stop-double-failure');
const uiTruth = process.argv.includes('--ui-truth');
const startupOldProof = process.argv.includes('--startup-old-proof');
assert.ok(!startupOldProof || startupDoubleFailure, '--startup-old-proof requires --startup-double-failure');
const expectUiTruthRed = process.argv.includes('--expect-ui-truth-red');
assert.ok(!expectUiTruthRed || uiTruth || startupOldProof, '--expect-ui-truth-red requires a UI truth case');
const expectStopRed = process.argv.includes('--expect-stop-red');
assert.ok(!expectStopRed || stopDoubleFailure, '--expect-stop-red requires --stop-double-failure');
const expectStartupRed = process.argv.includes('--expect-startup-red');
assert.ok(!expectStartupRed || startupDoubleFailure, '--expect-startup-red requires --startup-double-failure');
const expectPairedRed = process.argv.includes('--expect-paired-red');
assert.ok(!expectPairedRed || pairedHealth, '--expect-paired-red requires --paired-health');
assert.ok([expectStopRed, expectStartupRed, expectPairedRed, expectUiTruthRed].filter(Boolean).length <= 1, 'Choose one target-specific expected RED mode');
const app = path.resolve(arg('--source-root', root));
const upgradeFrom = arg('--upgrade-from', null);
assert.ok([healthNegative, pairedHealth, startupDoubleFailure, stopDoubleFailure, uiTruth].filter(Boolean).length <= 1, 'Choose one targeted runtime matrix');
assert.ok(!(pairedHealth || startupDoubleFailure || stopDoubleFailure || uiTruth) || (!baseline && !developmentSmoke && !upgradeFrom), 'Targeted runtime matrices cannot use baseline/smoke/upgrade modes');
const output = path.resolve(arg('--output', path.join(root, '.runtime/preconfirm-traffic/report.json')));
const executablePath = process.env.CHROME_TEST_EXECUTABLE;
assert.ok(executablePath?.includes('Google Chrome for Testing'), 'Explicit Chrome for Testing executable required');
const python = process.env.TEST_PYTHON || 'python3';
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'country-proxy-preconfirm-'));
const profile = path.join(scratch, 'profile');
const journal = path.join(scratch, 'native-commands.jsonl');
const healthControl = path.join(scratch, 'synthetic-health.json');
const countries = ['AT', 'EE', 'NO'];
const hosts = ['www.cloudflare.com', 'www.google.com', 'ordinary.test'];
const sha = body => crypto.createHash('sha256').update(body).digest('hex');
const redact = text => text.replace(/gate=[a-f0-9]{32}/g, 'gate=<redacted>');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = s => "'" + s.replaceAll("'", "'\"'\"'") + "'";
const bounded = async (promise, ms, label) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), ms); })]); }
  finally { clearTimeout(timer); }
};
const report = {result: 'FAIL', baseline, developmentSmoke, upgradeLifecycle: !!upgradeFrom, publicTraffic: false, syntheticNativeOffer: true,
  syntheticGeoip: true, countries, scenarios: [], blockedRequests: [], executed: [], cleanupErrors: []};
const mainRegistration = path.join(os.homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts/local.country_proxy.json');
async function registrationSnapshot() {
  try {
    const [body, stat] = await Promise.all([fs.readFile(mainRegistration), fs.stat(mainRegistration)]);
    return {sha: sha(body), ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size, mode: stat.mode};
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const beforeRegistration = await registrationSnapshot();
const extensionFiles = {};
for (const name of await fs.readdir(path.join(app, 'extension'))) {
  const file = path.join(app, 'extension', name);
  if ((await fs.stat(file)).isFile()) extensionFiles[name] = sha(await fs.readFile(file));
}
const closes = [], connections = [], pending = [], requests = [], tunnels = [];
let context, popup, client, spoofClient, fingerprint, originPort, badOriginPort, id, ports, watchdog;
let epoch = 0, queryNumber = 0, localPort, localHits = 0;
const controls = {trace: 'hold', target: 'ok', country: 'EE'};
function watch(server) {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket); socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  const reset = () => { for (const socket of sockets) socket.destroy(); };
  connections.push(reset);
  closes.push(async () => { reset(); await new Promise(resolve => server.close(resolve)); });
}
async function listen(server) {
  watch(server);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function until(read, label, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await read(); if (value) return value; await pause(40); }
  throw Error('Timed out: ' + label);
}
const cmd = message => popup.evaluate(value => chrome.runtime.sendMessage(value), message);
const state = () => popup.evaluate(async () => ({...await chrome.storage.local.get(['enabled', 'status', 'selectedCountries']),
  route: await chrome.proxy.settings.get({incognito: false}),
  dynamic: chrome.declarativeNetRequest ? await chrome.declarativeNetRequest.getDynamicRules() : [],
  session: chrome.declarativeNetRequest ? await chrome.declarativeNetRequest.getSessionRules() : []}));
const commands = async () => (await fs.readFile(journal, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
function endPending() { pending.splice(0).forEach(row => row.response.destroy()); }
function releasePending() {
  controls.trace = controls.target = 'ok';
  pending.splice(0).forEach(row => { if (row.epoch === epoch) row.answer(); else row.response.destroy(); });
}
function recordRequest(host, url, secure) {
  const row = {epoch, host, url, secure, at: Date.now()}; requests.push(row); return row;
}
function serve(request, response, secure) {
  const url = new URL(request.url, (secure ? 'https://' : 'http://') + request.headers.host);
  recordRequest(url.hostname, url.pathname + url.search, secure);
  const trace = url.hostname === hosts[0] && url.pathname === '/cdn-cgi/trace';
  const target = url.hostname === hosts[1] && url.pathname === '/generate_204';
  if (!trace && !target) {
    response.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*'});
    response.end('<!doctype html><title>Ordinary HTTPS fixture</title><p>ORDINARY_LOCAL_ORIGIN</p>'); return;
  }
  const mode = controls[trace ? 'trace' : 'target'];
  const answer = () => response.writeHead(mode === 'http' ? 503 : trace ? 200 : 204,
    {'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*'})
    .end(trace ? 'loc=' + controls.country + '\nip=8.8.4.11\n' : undefined);
  if (mode === 'hold') pending.push({response, epoch, answer});
  else answer();
}
async function prepare() {
  localPort = await listen(http.createServer((_q, r) => { localHits++; r.writeHead(200, {'Content-Type': 'text/plain'}).end('OWNED_LOCAL_LISTENER'); }));
  const manifest = JSON.parse(await fs.readFile(path.join(app, 'extension/manifest.json')));
  id = sha(Buffer.from(manifest.key, 'base64')).slice(0, 32).replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
  // DNR initiatorDomains compares host names. A controlled ordinary HTTPS page
  // with this host tests that the unguessable per-hold capability is also required.
  hosts.push(id);
  const certificate = async name => {
    const keyfile = path.join(scratch, name + '.key'), certfile = path.join(scratch, name + '.crt');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=www.cloudflare.com', '-addext', 'subjectAltName=' + hosts.map(h => 'DNS:' + h).join(','),
      '-keyout', keyfile, '-out', certfile], {stdio: 'ignore'});
    return {key: await fs.readFile(keyfile), cert: await fs.readFile(certfile)};
  };
  const good = await certificate('one-run-trusted'), bad = await certificate('untrusted');
  fingerprint = sha(crypto.createPublicKey(good.key).export({type: 'spki', format: 'der'}));
  fingerprint = Buffer.from(fingerprint, 'hex').toString('base64');
  originPort = await listen(https.createServer(good, (q, s) => serve(q, s, true)));
  badOriginPort = await listen(https.createServer(bad, (q, s) => serve(q, s, true)));
  const proxy = async () => {
    const server = http.createServer((q, s) => {
      let target; try { target = new URL(q.url); } catch { s.writeHead(400).end(); return; }
      if (target.protocol !== 'http:' || !hosts.includes(target.hostname)) { s.writeHead(403).end(); return; }
      serve(q, s, false);
    });
    server.on('connect', (q, client, head) => {
      if (!hosts.some(h => q.url === h + ':443')) { client.destroy(); return; }
      tunnels.push({epoch, port: server.address().port, host: q.url});
      const target = controls.trace === 'tls' && q.url === hosts[0] + ':443' ? badOriginPort : originPort;
      const upstream = net.connect(target, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
      upstream.on('close', () => client.destroy()); client.on('close', () => upstream.destroy());
    });
    return listen(server);
  };
  ports = [await proxy(), await proxy()];
  const launcher = path.join(scratch, 'native');
  await fs.writeFile(launcher, '#!/bin/sh\nexec ' + [python, '-I', '-B', path.join(root, 'tests/preconfirm_host.py'), ...ports.map(String), journal,
    ...(healthNegative || pairedHealth ? [healthControl] : [])].map(quote).join(' ') + '\n', {mode: 0o700});
  const registration = path.join(profile, 'NativeMessagingHosts');
  await fs.mkdir(registration, {recursive: true});
  await fs.writeFile(path.join(registration, 'local.country_proxy.json'), JSON.stringify({name: 'local.country_proxy',
    description: 'Local preconfirmation acceptance', path: launcher, type: 'stdio', allowed_origins: ['chrome-extension://' + id + '/']}), {mode: 0o600});
}
async function setOwnedExtensionEnabled(enabled) {
  // The documented unpacked lifecycle requires Developer mode and the real
  // enable switch. runtime.reload() otherwise disables this test extension as
  // unsupportedDeveloperExtension, leaving no replacement worker to inspect.
  const manager = await context.newPage();
  try {
    await manager.goto('chrome://extensions');
    const developerMode = manager.locator('extensions-toolbar #devMode');
    if (!(await developerMode.evaluate(element => element.checked))) await developerMode.click();
    assert.equal(await developerMode.evaluate(element => element.checked), true);
    const toggle = manager.locator('extensions-item[id="' + id + '"] #enableToggle');
    if ((await toggle.evaluate(element => element.checked)) !== enabled) await toggle.click();
    const info = await until(async () => {
      const row = await manager.evaluate(async id => (await chrome.developerPrivate.getExtensionsInfo({
        includeDisabled: true, includeTerminated: true})).find(item => item.id === id), id);
      return row?.state === (enabled ? 'ENABLED' : 'DISABLED') && row;
    }, 'owned extension ' + (enabled ? 'enabled' : 'disabled'));
    assert.equal(info.disableReasons.unsupportedDeveloperExtension, false);
    (report.extensionLifecycle ||= []).push({enabled, state: info.state, developerMode: true,
      unsupportedDeveloperExtension: info.disableReasons.unsupportedDeveloperExtension});
  } finally { await manager.close(); }
}
async function launch(sourceRoot = app, extension = path.join(sourceRoot, 'extension'), {reload = false} = {}) {
  if (startupDoubleFailure || stopDoubleFailure) {
    extension = path.join(scratch, 'startup-extension');
    await fs.cp(path.join(sourceRoot, 'extension'), extension, {recursive: true});
    const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json')));
    await fs.writeFile(path.join(extension, 'manifest.json'), JSON.stringify({...manifest,
      background: {...manifest.background, service_worker: 'runtime-startup-fixture.js'}}));
    const options = {saved: {enabled: !stopDoubleFailure, selectedCountries: countries, countries,
      selectionMode: 'multiple', selected: null, ...(startupOldProof ? {status: {phase: 'connected', countries,
        proxy: {scheme: 'http', host: '127.0.0.1', port: ports[0], country: 'EE', exitIp: '8.8.4.11'},
        browser: {ok: true, country: 'EE', exitIp: '8.8.4.11', checkedAt: Date.now()}}} : {})}, rejectInitialRead: startupDoubleFailure, rejectFirstErrorWrite: startupDoubleFailure};
    await fs.writeFile(path.join(extension, 'runtime-startup-injection.js'), 'const options = ' + JSON.stringify(options) + ';\n' +
      await fs.readFile(path.join(root, 'tests/runtime-startup-fixture.js'), 'utf8'));
    await fs.writeFile(path.join(extension, 'runtime-startup-fixture.js'),
      "import './runtime-startup-injection.js';\nimport './background.js';\nglobalThis.__runtimeFixture.imported = true;\n");
    if (stopDoubleFailure) {
      // No product status/route is fabricated: public Connect installs both
      // protections; only a later owned API Promise is rejected on demand.
      await fs.appendFile(path.join(extension, 'runtime-startup-injection.js'), `
const stopFixture = globalThis.__stopFixture = {clearFailures: 0, statusFailures: 0,
  clearRejected: 0, statusRejected: 0, statusAttempts: 0};
const stopClear = chrome.proxy.settings.clear.bind(chrome.proxy.settings);
const stopSet = chrome.storage.local.set.bind(chrome.storage.local);
chrome.proxy.settings.clear = async (...args) => {
  if (stopFixture.clearFailures > 0) { --stopFixture.clearFailures; ++stopFixture.clearRejected;
    throw Error('Injected owned proxy.clear rejection'); }
  return stopClear(...args);
};
chrome.storage.local.set = async values => {
  if (values.status?.phase === 'stopError') {
    ++stopFixture.statusAttempts;
    if (stopFixture.statusFailures > 0) { --stopFixture.statusFailures; ++stopFixture.statusRejected;
      throw Error('Injected stopError publication rejection'); }
  }
  return stopSet(values);
};
`);
    }
    for (const [name, digest] of Object.entries(extensionFiles)) if (name !== 'manifest.json') {
      assert.equal(sha(await fs.readFile(path.join(extension, name))), digest, 'Unchanged production module: ' + name);
    }
  }
  const ownedHome = path.join(scratch, 'home');
  await fs.mkdir(ownedHome, {recursive: true});
  context = await chromium.launchPersistentContext(profile, {executablePath, headless: true, env: {...process.env, HOME: ownedHome},
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--disable-background-networking', '--disable-quic',
      '--load-extension=' + extension, '--disable-extensions-except=' + extension,
      '--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE 127.0.0.1', '--proxy-server=http://127.0.0.1:9',
      '--ignore-certificate-errors-spki-list=' + fingerprint]});
  report.browser = context.browser().version();
  if (upgradeFrom) await setOwnedExtensionEnabled(true);
  if (reload) {
    // After re-enabling in Developer mode, follow the documented unpacked
    // Reload: a browser restart can keep the previous same-version script cache.
    // Reload preserves its worker registration, storage, and DNR rules.
    const workerURL = 'chrome-extension://' + id + '/background.js';
    const oldWorker = context.serviceWorkers().find(worker => worker.url() === workerURL) ||
      await context.waitForEvent('serviceworker', {predicate: worker => worker.url() === workerURL, timeout: 10000});
    const reloadPage = await context.newPage();
    await reloadPage.goto('chrome-extension://' + id + '/popup.html');
    const newWorker = context.waitForEvent('serviceworker', {predicate: worker => worker.url() === workerURL && worker !== oldWorker, timeout: 10000});
    await Promise.all([newWorker, reloadPage.evaluate(() => chrome.runtime.reload()).catch(error => {
      if (!/context.*destroyed|Target.*closed|page.*closed/i.test(error.message)) throw error;
    })]);
    await reloadPage.close().catch(() => {});
    report.explicitReloads = (report.explicitReloads || 0) + 1;
  }
  if (startupDoubleFailure || stopDoubleFailure) {
    const workerURL = 'chrome-extension://' + id + '/runtime-startup-fixture.js';
    const worker = context.serviceWorkers().find(w => w.url() === workerURL) ||
      await context.waitForEvent('serviceworker', {predicate: w => w.url() === workerURL, timeout: 10000});
    await until(() => worker.evaluate(() => globalThis.__runtimeFixture?.prepared), 'double failure fixture prepared');
    await worker.evaluate(() => globalThis.__runtimeFixture.start());
  }
  const hasGate = !!(await fs.stat(path.join(sourceRoot, 'extension/traffic-gate.js')).catch(() => null));
  report.executed.push(await inspectRuntime(context, sourceRoot, {workerName: startupDoubleFailure || stopDoubleFailure ? 'runtime-startup-fixture.js' : 'background.js', names: ['background.js', 'controller.js', 'probe.js',
    ...(hasGate ? ['traffic-gate.js'] : []),
    ...(await fs.stat(path.join(sourceRoot, 'extension/privacy-guard.js')).catch(() => null) ? ['privacy-guard.js', 'special-destinations.js'] : [])]}));
  popup = await context.newPage(); await popup.goto('chrome-extension://' + id + '/popup.html');
  client = await context.newPage(); await client.setContent('<!doctype html><title>Existing ordinary tab</title>');
}
async function preloadOrdinaryPages() {
  // Fixture setup occurs while the product is off, in this isolated profile.
  // It establishes real ordinary web origins before the product owns the route.
  const s = await state(); assert.equal(s.enabled, false); assert.equal(s.status.phase, 'off');
  await popup.evaluate(port => chrome.proxy.settings.set({scope: 'regular', value: {mode: 'fixed_servers', rules: {
    proxyForHttp: {scheme: 'http', host: '127.0.0.1', port},
    proxyForHttps: {scheme: 'http', host: '127.0.0.1', port},
    fallbackProxy: {scheme: 'http', host: '127.0.0.1', port}, bypassList: ['<-loopback>']}}}), ports[0]);
  const ordinary = await client.goto('https://' + hosts[2] + '/preloaded', {timeout: 5000});
  assert.equal(ordinary.status(), 200);
  spoofClient = await context.newPage();
  const spoof = await spoofClient.goto('https://' + id + '/preloaded', {timeout: 5000});
  assert.equal(spoof.status(), 200);
  await disconnect();
  report.preload = {ordinaryWebOrigin: true, extensionIdHostWebOrigin: true, localTLS: true,
    explicitFixtureRouteWhileOff: true, fixtureRouteReleasedBeforeConnect: true};
}
async function disconnect() {
  assert.equal((await cmd({action: 'disconnect'})).ok, true);
  const s = await state();
  assert.equal(s.enabled, false); assert.equal(s.status.phase, 'off');
  assert.notEqual(s.route.levelOfControl, 'controlled_by_this_extension');
  assert.equal(s.dynamic.length, 0); assert.equal(s.session.length, 0);
}
async function begin({trace = 'hold', target = 'ok', country = 'EE'} = {}) {
  await disconnect(); endPending();
  connections.forEach(reset => reset());
  epoch++; Object.assign(controls, {trace, target, country});
  assert.equal((await cmd({action: 'connect', countries})).ok, true);
  return Date.now();
}
async function held(commandOffset = null) {
  return until(async () => {
    const s = await state();
    if (s.status?.phase === 'error') throw Error(s.status.error);
    if (!(s.status?.phase === 'verifying' && pending.some(row => row.epoch === epoch) &&
      requests.some(r => r.epoch === epoch && r.host === hosts[1] && r.url.startsWith('/generate_204')))) return false;
    assert.notEqual(s.status.browser?.ok, true, 'pending offer has no Chrome confirmation');
    const rows = await commands(), start = commandOffset ?? rows.findLastIndex(row => ['start', 'rotate'].includes(row.command));
    assert.ok(!rows.slice(start).some(row => row.command === 'confirm'), 'native confirm before browser verdict');
    return s;
  }, 'both service HTTPS checks reach controlled origins while trace waits');
}
async function connected(gated = true) {
  const s = await until(async () => { const s = await state(); return s.status?.phase === 'connected' && s.status.browser?.ok && s; }, 'Chrome confirms allowed country');
  assert.deepEqual(s.selectedCountries, countries); assert.ok(countries.includes(s.status.browser.country));
  if (gated) {
    assert.ok(s.dynamic.some(rule => rule.action.type === 'block'));
    assert.ok(s.session.some(rule => rule.action.type === 'allow'));
  }
  return s;
}
function requestURL(host = hosts[2], {plain = false, probe = false} = {}) {
  const tag = String(Date.now() * 1000 + (++queryNumber));
  return (plain ? 'http://' : 'https://') + host + (probe ? host === hosts[0] ? '/cdn-cgi/trace?t=' : '/generate_204?t=' : '/ordinary-proof?audit=') + tag;
}
async function blocked(label, url, fetch = false) {
  const parsed = new URL(url), requestPath = parsed.pathname + parsed.search;
  const before = requests.filter(r => r.host === parsed.hostname && r.url === requestPath).length;
  let error, response;
  if (fetch) {
    const source = fetch === true ? client : fetch;
    const result = await source.evaluate(async url => {
      try { const r = await fetch(url, {mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(4500)}); return {ok: true, status: r.status}; }
      catch (e) { return {ok: false, error: e.message, name: e.name}; }
    }, url);
    assert.equal(result.ok, false, label + ': ordinary fetch unexpectedly allowed'); error = result.error;
    assert.equal(result.name, 'TypeError', label + ': request must fail at gate, not hang until the harness deadline');
  } else {
    const page = await context.newPage();
    try { response = await page.goto(url, {timeout: 4500}); }
    catch (e) { error = redact(e.message.split('\n')[0]); }
    finally { await page.close(); }
    assert.ok(error && !response, label + ': ordinary navigation unexpectedly allowed');
    assert.match(error, /ERR_BLOCKED_BY_CLIENT/, label + ': must be gate rejection, not incidental network failure');
  }
  await pause(50);
  assert.equal(requests.filter(r => r.host === parsed.hostname && r.url === requestPath).length, before, label + ': request reached origin');
  report.blockedRequests.push({label, method: fetch ? 'fetch' : 'navigation', host: parsed.hostname, error, originReached: false});
}
async function specialDestinationsBlocked(label) {
  // Exercise actual Chromium URL canonicalization/DNR, not a JS regex mirror.
  // The protocol check and ERR_BLOCKED_BY_CLIENT distinguish the persistent
  // guard from DNS failure, unavailable local services, or a proxy refusal.
  const literals = ['localhost', 'localhost.', 'sub.localhost', '.localhost', '.localhost.',
    '127.0.0.1', '127.255.255.254', '127.1', '2130706433', '0x7f000001',
    '0177.0.0.1', '169.254.0.1', '169.254.255.254', '0.0.0.0', '0',
    '[::]', '[0:0:0:0:0:0:0:1]', '[::1]', '[::ffff:0.0.0.0]',
    '[::ffff:127.0.0.1]', '[::ffff:127.255.255.254]', '[::ffff:169.254.0.1]',
    '[::ffff:169.254.255.254]', '[fe80::1]', '[fe9f::abcd]', '[fea0::1]', '[febf::1]'];
  for (const host of literals) {
    for (const scheme of ['http', 'https']) {
      await blocked(label + ' ' + scheme + ' ' + host, scheme + '://' + host + ':43761/special-destination');
    }
  }
  await blocked(label + ' live local service', 'http://127.0.0.1:' + localPort + '/local-service');
  assert.equal(localHits, 0, 'Active special guard must not contact the local listener');
  report.scenarios.push({name: label, literals: literals.length, protocols: ['http', 'https'],
    actualBrowserCanonicalization: true, expected: 'ERR_BLOCKED_BY_CLIENT'});
}
async function ordinaryOK(label) {
  const page = await context.newPage();
  try {
    const response = await page.goto(requestURL(), {timeout: 5000});
    assert.equal(response.status(), 200); assert.match(await page.locator('body').innerText(), /ORDINARY_LOCAL_ORIGIN/);
    return {label, status: 200, phase: (await state()).status.phase};
  } finally { await page.close(); }
}
async function reject(reason, timeout = 10000) {
  const s = await until(async () => {
    const s = await state(); return s.status?.lastFailure?.reason === reason && s.status.phase === 'replacing' && s;
  }, 'reject ' + reason, timeout);
  assert.equal(s.route.value.rules.proxyForHttps.port, 9);
  assert.equal(s.session.filter(rule => rule.action.type === 'allow' && !rule.condition.initiatorDomains).length, 0);
  assert.ok((await commands()).some(row => row.command === 'reject' && row.reason === reason));
  return s;
}
async function baselineProbe() {
  await begin(); const s = await held();
  assert.equal(s.status.browser?.ok, undefined);
  const before = (await commands()).length;
  const ordinary = await ordinaryOK('baseline: ordinary HTTPS before browser confirmation');
  assert.equal(ordinary.phase, 'verifying');
  assert.ok(!(await commands()).slice(0, before).some(row => row.command === 'confirm'));
  report.scenarios.push({name: 'baseline-preconfirmation-window', expectedForFix: 'blocked', actual: ordinary});
  report.result = 'RED_REPRODUCED';
}
async function fullMatrix() {
  await begin(); const pendingState = await held();
  assert.equal(pendingState.session.filter(rule => rule.action.type === 'allow' && !rule.condition.initiatorDomains).length, 0);
  await blocked('same Cloudflare exact probe path navigation', requestURL(hosts[0], {probe: true}));
  await blocked('same Google exact probe path navigation', requestURL(hosts[1], {probe: true}));
  await blocked('third host navigation', requestURL());
  await blocked('existing tab same Cloudflare probe fetch', requestURL(hosts[0], {probe: true}), true);
  await blocked('existing tab third host fetch', requestURL(), true);
  await blocked('ordinary HTTPS origin with extension-ID hostname, no capability', requestURL(hosts[0], {probe: true}), spoofClient);
  const admitted = requests.find(row => row.epoch === epoch && row.host === hosts[0] &&
    row.url.startsWith('/cdn-cgi/trace?') && new URL(row.url, 'https://' + row.host).searchParams.has('gate'));
  assert.ok(admitted, 'actual admitted Chrome service URL observed');
  // Exercise type/initiator enforcement even when a test knows the capability.
  // The value remains in memory and is never saved in a receipt or error URL.
  const admittedURL = 'https://' + admitted.host + admitted.url;
  await blocked('ordinary navigation to current admitted service URL', admittedURL);
  await blocked('ordinary web-origin fetch of current admitted service URL', admittedURL, true);
  await blocked('ordinary HTTP navigation', requestURL(hosts[2], {plain: true}));
  releasePending(); const first = await connected();
  const firstOrdinary = await ordinaryOK('allowed after both HTTPS and EE proof');
  assert.equal(first.status.browser.country, 'EE');
  await specialDestinationsBlocked('special-destinations-after-verified-admission');
  report.scenarios.push({name: 'pending-to-allowed', serviceOriginsReached: hosts.slice(0, 2), ordinary: firstOrdinary});

  controls.trace = 'hold'; controls.country = 'AT'; epoch++;
  assert.equal((await cmd({action: 'rotate'})).ok, true); const replacing = await held();
  assert.equal(replacing.route.value.rules.proxyForHttps.port, ports[1]);
  await blocked('replacement candidate pending', requestURL());
  releasePending(); const second = await connected(); assert.equal(second.status.browser.country, 'AT');
  report.scenarios.push({name: 'second-candidate-reblocks', ordinary: await ordinaryOK('AT after replacement proof')});
  if (developmentSmoke) { await disconnect(); report.result = 'DEVELOPMENT_SMOKE_PASS'; return; }

  await begin({country: 'US'}); await held();
  await blocked('before foreign-country verdict', requestURL()); releasePending(); await reject('country');
  await blocked('after foreign-country rejection', requestURL());
  report.scenarios.push({name: 'foreign-country-rejected', reason: 'country'});

  await begin({trace: 'hold', target: 'http'}); await reject('http');
  await blocked('HTTP503 with pending sibling', requestURL());
  report.scenarios.push({name: 'http503-rejected', reason: 'http'});

  await begin({trace: 'tls'}); await reject('transport');
  await blocked('untrusted TLS certificate', requestURL());
  report.scenarios.push({name: 'untrusted-tls-rejected', reason: 'transport', badSPKIAllowed: false});

  const started = await begin({trace: 'hold', target: 'hold'}); await held();
  await blocked('start of actual probe deadline', requestURL());
  await reject('timeout', 55000);
  const elapsedMs = Date.now() - started; assert.ok(elapsedMs >= 49000 && elapsedMs < 57000);
  await blocked('after actual probe deadline', requestURL());
  report.scenarios.push({name: 'production-50-second-deadline', elapsedMs, timeoutOverridden: false});

  await begin(); await held(); const late = pending.splice(0);
  await disconnect(); controls.trace = controls.target = 'ok'; late.forEach(row => row.answer());
  await pause(200); const stopped = await state();
  assert.equal(stopped.status.phase, 'off'); assert.equal(stopped.session.length, 0); assert.equal(stopped.dynamic.length, 0);
  report.scenarios.push({name: 'stop-before-late-response', off: true, ownRulesRemoved: true});

  await begin(); await held(); releasePending(); await connected();
  controls.trace = 'hold'; epoch++;
  const cdp = await context.browser().newBrowserCDPSession();
  const {targetInfos} = await cdp.send('Target.getTargets');
  const target = targetInfos.find(t => t.type === 'service_worker' && t.url === 'chrome-extension://' + id + '/background.js');
  assert.ok(target); const closed = await cdp.send('Target.closeTarget', {targetId: target.targetId});
  assert.equal(closed.success, true); await cdp.detach();
  await cmd({action: 'sourceQuality', country: 'NO'}); await held();
  await blocked('worker restarted and revalidating', requestURL());
  releasePending(); await connected();
  report.scenarios.push({name: 'worker-restart-recloses', ordinary: await ordinaryOK('after worker reprobe')});

  controls.trace = 'hold'; epoch++;
  await context.close(); context = null; endPending();
  await launch(); await held();
  assert.equal((await state()).session.filter(rule => rule.action.type === 'allow' && !rule.condition.initiatorDomains).length, 0);
  await blocked('browser restart with durable dynamic block', requestURL());
  releasePending(); const restarted = await connected(); assert.deepEqual(restarted.selectedCountries, countries);
  report.scenarios.push({name: 'browser-restart-recloses', ordinary: await ordinaryOK('after browser reprobe')});
  await specialDestinationsBlocked('special-destinations-after-browser-restart');
  await disconnect();
  const localPage = await context.newPage();
  try { const localResponse = await localPage.goto('http://127.0.0.1:' + localPort + '/after-stop');
    assert.equal(localResponse.status(), 200); assert.equal(await localPage.locator('body').innerText(), 'OWNED_LOCAL_LISTENER');
  } finally { await localPage.close(); }
  assert.ok(localHits > 0);
  report.scenarios.push({name: 'stop-restores-local-service-access', liveListener: true});
  report.result = 'PASS';
}
async function healthMatrix() {
  await begin({trace: 'ok', country: 'NO'});
  const first = await connected(); assert.equal(first.status.browser.country, 'NO');
  await ordinaryOK('NO before negative health');
  controls.country = 'JP'; epoch++;
  await fs.writeFile(healthControl, JSON.stringify({sequence: 1, phase: 'confirming',
    health: {ok: false, reason: 'country', country: 'JP', endpoint: 'trace'}}));
  const warning = await until(async () => { const s = await state(); return s.status.phase === 'confirming' && s; }, 'country-negative consumed');
  assert.equal(warning.status.browser, null, 'old browser country proof must be invalidated');
  assert.equal(warning.session.filter(rule => rule.action.type === 'allow').length, 0);
  await until(async () => /Трафик заблокирован/.test(await popup.locator('#exit-address').innerText()), 'popup shows rejected health country');
  assert.match(await popup.locator('#exit-location').innerText(), /Япония/);
  await blocked('country-negative ordinary Cloudflare request', requestURL(hosts[0], {probe: true}));
  await blocked('country-negative ordinary third host', requestURL());
  report.scenarios.push({name: 'country-negative-revokes-admission', countries,
    syntheticNativeHealth: true, syntheticGeoip: true, previousBrowserCountry: 'NO', rejectedCountry: 'JP'});

  // A native success for the same endpoint cannot reuse the earlier NO proof.
  controls.country = 'EE'; controls.trace = 'hold'; epoch++;
  const beforeRecovery = (await commands()).length;
  await fs.writeFile(healthControl, JSON.stringify({sequence: 2, phase: 'connected', health: {ok: true}}));
  await held(beforeRecovery);
  await blocked('native recovery waits for new Chrome proof', requestURL());
  releasePending(); const recovered = await connected();
  assert.equal(recovered.status.browser.country, 'EE');
  assert.deepEqual(recovered.selectedCountries, countries);
  report.scenarios.push({name: 'same-endpoint-recovery-requires-fresh-chrome',
    country: recovered.status.browser.country, ordinary: await ordinaryOK('EE after fresh proof')});
  await disconnect(); report.result = 'PASS';
}
async function popupTruth() {
  return popup.evaluate(() => ({phase: document.getElementById('phase').textContent,
    green: document.getElementById('dot').classList.contains('online'),
    currentIP: document.getElementById('exit-address').textContent,
    proxyHidden: document.getElementById('proxy').hidden,
    stopVisible: !document.getElementById('disconnect').hidden}));
}
async function uiTruthMatrix() {
  await popup.setViewportSize({width: 390, height: 600});
  await begin(); await held(); releasePending();
  const active = await connected();
  assert.equal(active.status.browser.country, 'EE');
  assert.deepEqual(active.selectedCountries, countries);
  await until(async () => { const ui = await popupTruth(); return ui.green && ui.phase === 'Подключено' && ui; }, 'actual confirmed route is green');
  const liveUI = await popupTruth();
  assert.match(liveUI.currentIP, /^Выход сейчас: /);
  assert.ok(liveUI.currentIP.includes(active.status.browser.exitIp));
  assert.equal(liveUI.proxyHidden, false); assert.equal(liveUI.stopVisible, true);
  await fs.mkdir(path.dirname(output), {recursive: true});
  const connectedScreenshot = path.join(path.dirname(output), 'popup-connected-' + (expectUiTruthRed ? 'red' : 'green') + '.png');
  await popup.screenshot({path: connectedScreenshot});
  const ordinary = await ordinaryOK('real connected EE popup admits ordinary HTTPS');
  // Obtain canonical product rules in Chrome, including its actual
  // readback representation. Do not substitute a hand-built admission fixture.
  const normalized = await popup.evaluate(async () => {
    const {gateRules} = await import(chrome.runtime.getURL('traffic-gate.js'));
    const wanted = gateRules(chrome.runtime.id, '0'.repeat(32)).session;
    const actual = await chrome.declarativeNetRequest.getSessionRules();
    const selected = actual.filter(rule => wanted.some(row => row.id === rule.id));
    if (selected.length !== wanted.length) throw Error('Both canonical session rules required');
    await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: wanted.map(rule => rule.id)});
    return selected.map(rule => ({id: rule.id, priority: rule.priority, action: rule.action.type,
      resourceTypes: rule.condition.resourceTypes}));
  });
  const revoked = await state();
  assert.deepEqual(revoked.status, active.status, 'Admission-only revocation preserves saved connected proof');
  assert.deepEqual(revoked.route, active.route, 'Admission-only revocation preserves the actual route');
  assert.deepEqual(revoked.session, []);
  await blocked('same confirmed route with revoked admission', requestURL());
  // A negative control must inspect a fresh render, never the green render
  // from before revocation. Keep GREEN poll-only to exercise live refresh.
  if (expectUiTruthRed) {
    await popup.reload();
    await until(async () => (await popupTruth()).phase !== 'Загрузка…', 'fresh revoked-admission popup render');
  }
  // Popup polls Chrome readback without relying on a storage event.
  await until(async () => { const ui = await popupTruth(); return (expectUiTruthRed ? ui.green : !ui.green) && ui; }, 'popup reflects live session admission');
  const revokedUI = await popupTruth();
  if (expectUiTruthRed) {
    assert.equal(revokedUI.phase, 'Подключено'); assert.equal(revokedUI.green, true);
    assert.ok(revokedUI.currentIP.includes(active.status.browser.exitIp));
    assert.equal(revokedUI.proxyHidden, false);
  } else {
    assert.equal(revokedUI.phase, 'Подключение не подтверждено'); assert.equal(revokedUI.green, false);
    assert.equal(revokedUI.currentIP, ''); assert.equal(revokedUI.proxyHidden, true);
  }
  assert.equal(revokedUI.stopVisible, true);
  const revokedScreenshot = path.join(path.dirname(output), 'popup-revoked-' + (expectUiTruthRed ? 'red' : 'green') + '.png');
  await popup.screenshot({path: revokedScreenshot});
  report.scenarios.push({name: 'popup-truth-real-connected-and-admission-only-revocation', countries,
    actualBrowserCountry: active.status.browser.country, normalizedSession: normalized, liveUI, ordinary, revokedUI,
    screenshots: [connectedScreenshot, revokedScreenshot],
    savedConnectedProofUnchanged: true, effectiveRouteUnchanged: true, revokedOrdinaryBlocked: true});
  await popup.locator('#disconnect').click();
  await until(async () => { const s = await state(); return !s.enabled && s.status.phase === 'off'; }, 'revoked route actual popup Stop');
  await disconnect();
  report.result = expectUiTruthRed ? 'RED_REPRODUCED' : 'PASS';
}
async function startupDoubleFailureMatrix() {
  const worker = context.serviceWorkers().find(w => w.url() === 'chrome-extension://' + id + '/runtime-startup-fixture.js');
  await until(() => worker.evaluate(() => globalThis.__runtimeFixture.storageRejected === 1 &&
    globalThis.__runtimeFixture.errorWriteRejected === 1), 'initial read and diagnostic write both rejected once');
  const instrumentation = await worker.evaluate(() => ({storageRejected: globalThis.__runtimeFixture.storageRejected,
    errorWriteRejected: globalThis.__runtimeFixture.errorWriteRejected}));
  const row = {name: 'startup-read-plus-error-write-rejection', instrumentation,
    faultModel: 'Exactly one enabled read and the first error-status write reject; all subsequent Chrome storage operations are real and healthy.'};
  report.scenarios.push(row);
  if (expectStartupRed) {
    const reply = await cmd({action: 'connect', countries}); row.reply = reply;
    assert.equal(reply.ok, false);
    assert.equal((await commands()).filter(row => row.command === 'start').length, 0);
    row.nativeStarts = 0;
  } else {
    if (startupOldProof) {
      await popup.setViewportSize({width: 390, height: 600});
      const saved = await state();
      assert.equal(saved.status.phase, 'connected'); assert.equal(saved.status.browser.ok, true);
      assert.deepEqual(saved.selectedCountries, countries); assert.equal(saved.session.length, 0);
      assert.equal(await popup.evaluate(async () => {
        const {proxyConfig, matchesEffectiveRoute} = await import(chrome.runtime.getURL('controller.js'));
        const {status} = await chrome.storage.local.get('status');
        return matchesEffectiveRoute(await chrome.proxy.settings.get({incognito: false}), proxyConfig(status.proxy));
      }), false, 'Startup fault has no matching owned route for old connected proof');
      if (expectUiTruthRed) {
        await popup.reload();
        await until(async () => (await popupTruth()).phase !== 'Загрузка…', 'fresh startup old-proof popup render');
      }
      await until(async () => { const ui = await popupTruth(); return (expectUiTruthRed ? ui.green : !ui.green) && ui; }, 'startup stale proof UI settles');
      row.oldConnectedUI = await popupTruth();
      assert.equal(row.oldConnectedUI.stopVisible, true);
      if (expectUiTruthRed) {
        assert.equal(row.oldConnectedUI.phase, 'Подключено'); assert.equal(row.oldConnectedUI.green, true);
        assert.match(row.oldConnectedUI.currentIP, /^Выход сейчас: /);
      } else {
        assert.equal(row.oldConnectedUI.phase, 'Подключение не подтверждено'); assert.equal(row.oldConnectedUI.green, false);
        assert.equal(row.oldConnectedUI.currentIP, ''); assert.equal(row.oldConnectedUI.proxyHidden, true);
      }
      await fs.mkdir(path.dirname(output), {recursive: true});
      row.screenshot = path.join(path.dirname(output), 'popup-startup-old-proof-' + (expectUiTruthRed ? 'red' : 'green') + '.png');
      await popup.screenshot({path: row.screenshot});
    }
    // A failed diagnostic write cannot promise that popup Retry is visible.
    // Exercise the still-accessible real user path: Stop, then Connect.
    await until(() => popup.locator('#disconnect').isVisible(), 'double failure popup Stop visible');
    await popup.locator('#disconnect').click();
    await until(async () => { const s = await state(); return !s.enabled && s.status?.phase === 'off'; }, 'double failure popup Stop completes');
    row.actualStopReachedOff = true;
    await until(() => popup.locator('#connect').isVisible(), 'double failure popup Connect visible');
    await popup.locator('#connect').click();
    row.recoveryAction = 'Actual popup Stop then Connect';
    await held();
    await blocked('startup double failure awaits first Chrome proof', requestURL());
    releasePending();
    const active = await connected();
    assert.equal(active.status.browser.country, 'EE');
    row.browserCountry = active.status.browser.country;
    row.ordinary = await ordinaryOK('ordinary HTTPS after double storage failure recovery');
    assert.deepEqual((await commands()).filter(row => row.command === 'start').length, 1);
  }
  await disconnect();
  report.result = expectStartupRed || expectUiTruthRed ? 'RED_REPRODUCED' : 'PASS';
  report.startupInjection = {productionModulesUnchanged: true, ephemeralManifestWorkerOverride: true,
    fixtureSHA256: sha(await fs.readFile(path.join(root, 'tests/runtime-startup-fixture.js')))};
}
async function stopDoubleFailureMatrix() {
  const worker = context.serviceWorkers().find(w => w.url() === 'chrome-extension://' + id + '/runtime-startup-fixture.js');
  for (const failures of [0, 1, 100]) {
    await begin(); await held();
    await blocked('owned pending route remains gated before failed Stop', requestURL());
    releasePending();
    const initialConnected = await connected();
    assert.equal(initialConnected.status.browser.country, 'EE');
    assert.deepEqual(initialConnected.selectedCountries, countries);
    const ordinaryBeforeStop = await ordinaryOK('confirmed ordinary HTTPS before failed Stop');
    const initial = await state();
    assert.equal(initial.route.levelOfControl, 'controlled_by_this_extension');
    assert.ok(initial.dynamic.some(rule => rule.action.type === 'block'));
    await worker.evaluate(failures => Object.assign(globalThis.__stopFixture, {clearFailures: 1,
      statusFailures: failures, clearRejected: 0, statusRejected: 0, statusAttempts: 0}), failures);
    await until(() => popup.locator('#disconnect').isVisible(), 'initial Stop visible');
    await popup.locator('#disconnect').click();
    await until(() => popup.locator('#error').textContent().then(Boolean), 'failed Stop reply displayed');
    const failed = await state();
    const ui = await popup.evaluate(() => ({stopHidden: document.getElementById('disconnect').hidden,
      stopText: document.getElementById('disconnect').textContent, error: document.getElementById('error').textContent}));
    const instrumentation = await worker.evaluate(() => ({...globalThis.__stopFixture}));
    assert.equal(instrumentation.clearRejected, 1);
    assert.equal(instrumentation.statusRejected, Math.min(failures, expectStopRed ? 1 : 2), 'Diagnostic rejection really executed');
    assert.equal(failed.enabled, false); assert.notEqual(failed.status.phase, 'off');
    assert.equal(failed.route.levelOfControl, 'controlled_by_this_extension');
    assert.ok(failed.dynamic.some(rule => rule.action.type === 'block')); assert.equal(failed.session.length, 0);
    await blocked('cleanup and diagnostic rejection keep ordinary requests blocked', requestURL());
    const row = {name: 'failed-stop-' + failures + '-diagnostic-rejections', instrumentation,
      phase: failed.status.phase, ui, initialConnectedCountry: initialConnected.status.browser.country,
      ordinaryBeforeStop, cleanupIncomplete: true, ordinaryBlocked: true,
      faultModel: 'One owned proxy.clear rejection; zero, one or persistent stopError storage rejection. Real Chrome APIs otherwise unchanged.'};
    report.scenarios.push(row);
    if (expectStopRed && failures > 0) {
      assert.equal(failed.status.phase, 'error'); assert.equal(ui.stopHidden, true);
      assert.match(ui.error, /Injected stopError publication rejection/);
      // Baseline recovery control uses the public command because its popup
      // has lost Stop. A successful next Stop proves cleanup can be retried.
      await worker.evaluate(() => { globalThis.__stopFixture.statusFailures = 0; });
      await disconnect(); row.recovery = 'Command Stop succeeds; actual popup Stop is hidden (defect)';
    } else {
      assert.equal(failed.status.phase, failures > 1 ? 'stopping' : 'stopError');
      assert.equal(ui.stopHidden, false); assert.equal(ui.stopText, 'Повторить отключение');
      assert.match(ui.error, /Повторите отключение/);
      assert.ok(instrumentation.statusAttempts <= 2, 'No unbounded diagnostic persistence loop');
      await worker.evaluate(() => { globalThis.__stopFixture.statusFailures = 0; });
      await popup.locator('#disconnect').click();
      await until(async () => { const s = await state(); return !s.enabled && s.status?.phase === 'off'; }, 'popup Retry Stop completes');
      const stopped = await state();
      assert.notEqual(stopped.route.levelOfControl, 'controlled_by_this_extension');
      assert.equal(stopped.dynamic.length, 0); assert.equal(stopped.session.length, 0);
      row.recovery = 'Actual popup Retry Stop releases owned proxy/privacy/DNR';
      assert.equal(await popup.locator('#disconnect').isVisible(), false);
    }
    const privacy = await popup.evaluate(async () => Promise.all([chrome.privacy.network.webRTCIPHandlingPolicy,
      chrome.privacy.network.networkPredictionEnabled].map(setting => setting.get({incognito: false}))));
    assert.ok(privacy.every(setting => setting.levelOfControl !== 'controlled_by_this_extension'), 'Retry Stop releases owned privacy settings');
    row.privacyReleased = true;
    // Every scenario independently proves strict admission after retrying Stop,
    // with the same equal AT/EE/NO set and both certificate-validated HTTPSs.
    await begin(); await held();
    await blocked('post-Stop reconnect still waits for Chrome HTTPS/country proof', requestURL());
    releasePending(); const recovered = await connected();
    assert.equal(recovered.status.browser.country, 'EE');
    assert.deepEqual(recovered.selectedCountries, countries);
    row.reconnectedCountry = recovered.status.browser.country;
    row.ordinary = await ordinaryOK('after failed Stop recovery');
    await disconnect();
  }
  await disconnect();
  report.result = expectStopRed ? 'RED_REPRODUCED' : 'PASS';
  report.stopInjection = {productionModulesUnchanged: true, ephemeralManifestWorkerOverride: true,
    source: 'Owned proxy.clear and stopError storage.set promise wrappers injected only into scratch copy'};
}
async function pairedHealthMatrix() {
  // Run production Session + host.status_message serializer with deterministic transfers.
  // The framed browser fixture remaps only endpoint and generation to its local
  // CONNECT server. No discovery/curl public result is claimed by this test.
  const fixture = path.join(root, 'tests/paired_health_fixture.py');
  const native = JSON.parse(execFileSync(python, ['-I', '-B', fixture, '--source-root', app], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 65536}));
  report.pairedNativeFixture = native;
  assert.deepEqual(native.countries, countries);
  let reproduced = 0;
  let sequence = 0;
  for (const row of native.cases) {
    await fs.rm(healthControl, {force: true});
    await begin({trace: 'ok', target: 'ok', country: 'NO'});
    const first = await connected();
    assert.equal(first.status.browser.country, 'NO');
    await ordinaryOK('NO before paired health');
    controls.country = 'JP'; epoch++;
    await fs.writeFile(healthControl, JSON.stringify({sequence: ++sequence,
      phase: row.warning.phase, health: row.warning.health}));
    const warning = await until(async () => {
      const s = await state();
      return s.status.phase === 'confirming' && s.status.health?.reason === row.warning.health.reason && s;
    }, 'Session-derived paired warning consumed');
    const sessionAllows = warning.session.filter(rule => rule.action.type === 'allow').length;
    const observation = {name: 'paired-health-' + row.completionOrder.join('-'),
      completionOrder: row.completionOrder, nativeHealth: row.warning.health, sessionAllows,
      browserCountry: warning.status.browser?.country ?? null};
    report.scenarios.push(observation);
    if (expectPairedRed && row.completionOrder[0] === 'target') {
      assert.equal(row.warning.health.reason, 'timeout');
      assert.equal(sessionAllows, 2);
      assert.equal(warning.status.browser.country, 'NO');
      const page = await context.newPage();
      try {
        const response = await page.goto(requestURL(hosts[0], {probe: true}), {timeout: 5000});
        assert.equal(response.status(), 200);
        assert.match(await page.locator('body').innerText(), /loc=JP/);
      } finally { await page.close(); }
      Object.assign(observation, {ordinaryHTTP: 200, ordinarySyntheticCountry: 'JP'});
      reproduced++;
    } else {
      assert.equal(row.warning.health.reason, 'country', 'Known foreign country survives either completed-result order');
      assert.equal(row.warning.health.country, 'JP');
      assert.equal(sessionAllows, 0);
      assert.equal(warning.status.browser, null);
      await blocked('paired health ' + row.completionOrder.join('/') + ' revokes ordinary Cloudflare', requestURL(hosts[0], {probe: true}));
      await blocked('paired health ' + row.completionOrder.join('/') + ' revokes ordinary third host', requestURL());

      // Reusing this endpoint still needs fresh Chrome proof after revocation.
      controls.country = 'EE'; controls.trace = 'hold'; epoch++;
      const offset = (await commands()).length;
      await fs.writeFile(healthControl, JSON.stringify({sequence: ++sequence,
        phase: row.recovered.phase, health: row.recovered.health}));
      await held(offset);
      await blocked('paired health recovery waits for fresh Chrome proof', requestURL());
      releasePending();
      const recovery = await connected();
      assert.equal(recovery.status.browser.country, 'EE');
      observation.recovery = {browserCountry: recovery.status.browser.country,
        ordinary: await ordinaryOK('EE after paired health reprobe')};
    }
    await disconnect();
  }
  if (expectPairedRed) assert.equal(reproduced, 1, 'Baseline must reproduce target-first admission defect');
  report.nativeIntegration = 'Production core.Session + host.status_message serializer with synthetic discovery/curl responses. Browser native command/event loop is preconfirm_host.py fixture, remapping endpoint/generation. Production host event loop is not exercised; no simultaneous public Session/browser validation.';
  report.observationWindow = 'Immediate before the next periodic Chrome recheck';
  report.result = expectPairedRed ? 'RED_REPRODUCED' : 'PASS';
}
async function upgradeMatrix() {
  const old = path.resolve(upgradeFrom), live = path.join(scratch, 'active-extension');
  const oldManifest = JSON.parse(await fs.readFile(path.join(old, 'extension/manifest.json')));
  const newManifest = JSON.parse(await fs.readFile(path.join(app, 'extension/manifest.json')));
  assert.equal(oldManifest.key, newManifest.key, 'stable extension identity');
  assert.ok(!oldManifest.permissions.includes('declarativeNetRequest'));
  assert.ok(newManifest.permissions.includes('declarativeNetRequest'));
  const installCopy = async source => {
    await fs.rm(live, {recursive: true, force: true});
    await fs.cp(path.join(source, 'extension'), live, {recursive: true});
    for (const name of await fs.readdir(path.join(source, 'extension'))) {
      const original = path.join(source, 'extension', name);
      if ((await fs.stat(original)).isFile()) assert.equal(sha(await fs.readFile(path.join(live, name))), sha(await fs.readFile(original)));
    }
  };
  await installCopy(old); await launch(old, live);
  await until(async () => (await state()).status?.phase === 'off', 'legacy initial off');
  await begin({trace: 'ok', country: 'NO'}); await connected(false);
  const oldOrdinary = await ordinaryOK('old snapshot before update');
  await disconnect();
  controls.trace = 'hold'; epoch++;
  await setOwnedExtensionEnabled(false);
  await context.close(); context = null; endPending();

  await installCopy(app); await launch(app, live, {reload: true});
  await until(async () => (await state()).status?.phase === 'off', 'updated snapshot keeps documented Stop');
  assert.deepEqual((await state()).selectedCountries, countries);
  await begin(); await held();
  const permissions = await popup.evaluate(() => chrome.runtime.getManifest().permissions);
  assert.ok(permissions.includes('declarativeNetRequest'));
  await blocked('after unpacked update, before fresh Chrome proof', requestURL());
  releasePending(); await connected();
  const newOrdinary = await ordinaryOK('new snapshot after Chrome proof');
  await disconnect(); const clean = await state();
  assert.equal(clean.dynamic.length, 0); assert.equal(clean.session.length, 0);
  await setOwnedExtensionEnabled(false);
  await context.close(); context = null; endPending();

  await installCopy(old); await launch(old, live, {reload: true});
  await until(async () => (await state()).status?.phase === 'off', 'rollback keeps explicit off');
  assert.deepEqual((await state()).selectedCountries, countries);
  await begin({trace: 'ok', country: 'NO'}); await connected(false);
  const rolledBackOrdinary = await ordinaryOK('old snapshot after Stop and rollback');
  await disconnect();
  report.scenarios.push({name: 'unpacked-old-new-old-permission-and-rule-lifecycle',
    versions: [oldManifest.version, newManifest.version, oldManifest.version], sameExtensionId: true,
    selectedCountriesPreserved: true, stoppedBeforeUpdate: true, explicitReloads: report.explicitReloads, ownedRulesClearedBeforeDowngrade: true,
    oldOrdinary, newOrdinary, rolledBackOrdinary,
    scope: 'Documented Developer mode, Stop, disable, owned unpacked-folder replacement, re-enable and explicit extension Reload; no installer/dependency migration or Web Store permission UI claim.'});
  report.result = 'PASS';
}
try {
  await prepare();
  watchdog = setTimeout(() => { void context?.close(); }, 210000);
  if (upgradeFrom) await upgradeMatrix();
  else {
    await launch();
    if (!startupDoubleFailure) await until(async () => (await state()).status?.phase === 'off', 'initial disabled state');
    if (!baseline && !startupDoubleFailure) await preloadOrdinaryPages();
    if (startupDoubleFailure) await startupDoubleFailureMatrix(); else if (uiTruth) await uiTruthMatrix(); else if (stopDoubleFailure) await stopDoubleFailureMatrix(); else if (pairedHealth) await pairedHealthMatrix(); else if (healthNegative) await healthMatrix(); else if (baseline) await baselineProbe(); else await fullMatrix();
  }
} catch (error) {
  report.result = 'FAIL';
  report.error = redact(error.stack || String(error));
  const failedState = popup ? await state().catch(() => null) : null;
  if (failedState) {
    const summary = rules => rules.map(rule => ({id: rule.id, priority: rule.priority, action: rule.action.type}));
    report.lastState = {...failedState, dynamic: summary(failedState.dynamic), session: summary(failedState.session)};
  }
} finally {
  clearTimeout(watchdog);
  if (context) try { await bounded(context.close(), 10000, 'browser close timeout'); } catch (error) { report.cleanupErrors.push(error.message); }
  endPending();
  for (const close of closes.reverse()) try { await bounded(close(), 3000, 'server close timeout'); } catch (error) { report.cleanupErrors.push(error.message); }
  for (let i = 0; i < 50; i++) {
    report.ownedProcessesRemaining = execFileSync('ps', ['-axo', 'pid=,command='], {encoding: 'utf8'})
      .split('\n').filter(line => line.includes(scratch));
    if (!report.ownedProcessesRemaining.length) break;
    await pause(100);
  }
  if (report.ownedProcessesRemaining.length) report.cleanupErrors.push('Owned browser/native processes remain after context close');
  await fs.rm(scratch, {recursive: true, force: true});
  report.scratchRemoved = !(await fs.stat(scratch).catch(() => null));
  report.mainRegistrationUnchanged = JSON.stringify(beforeRegistration) === JSON.stringify(await registrationSnapshot());
  report.changedExtension = [];
  for (const [name, digest] of Object.entries(extensionFiles)) if (sha(await fs.readFile(path.join(app, 'extension', name))) !== digest) report.changedExtension.push(name);
  report.extensionSHA256 = extensionFiles;
  report.limits = 'Local CONNECT/TLS origins and per-run SPKI trust; synthetic native offers/GeoIP. Tests new ordinary requests, not already transmitted or in-flight data, public availability, OS traffic, or browser-internal privileged traffic.';
  report.originRequests = requests.map(({url, ...row}) => {
    const parsed = new URL(url, 'https://' + row.host);
    return {...row, path: parsed.pathname, queryKeys: [...new Set(parsed.searchParams.keys())]};
  });
  report.tunnels = tunnels;
  if (report.error || report.cleanupErrors.length || !report.scratchRemoved || !report.mainRegistrationUnchanged || report.changedExtension.length) report.result = 'FAIL';
  await fs.mkdir(path.dirname(output), {recursive: true});
  await fs.writeFile(output, JSON.stringify(report, (_key, value) => typeof value === 'string' ? redact(value) : value, 2) + '\n', {mode: 0o600});
  console.log(JSON.stringify({result: report.result, scenarios: report.scenarios, blocked: report.blockedRequests.length,
    error: report.error, cleanupErrors: report.cleanupErrors, scratchRemoved: report.scratchRemoved,
    mainRegistrationUnchanged: report.mainRegistrationUnchanged, changedExtension: report.changedExtension, output}));
  if (!['PASS', 'RED_REPRODUCED', 'DEVELOPMENT_SMOKE_PASS'].includes(report.result) || report.error || report.cleanupErrors.length || !report.scratchRemoved || !report.mainRegistrationUnchanged || report.changedExtension.length) process.exitCode = 1;
}
