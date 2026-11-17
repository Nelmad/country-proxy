// Local-only acceptance of ordinary-request gating before Chrome confirmation.
// Synthetic native offers and GeoIP; real unchanged extension, CONNECT and TLS.
// --baseline runs the same decisive probe against an exact older extension.
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
const app = path.resolve(arg('--source-root', root));
const upgradeFrom = arg('--upgrade-from', null);
const output = path.resolve(arg('--output', path.join(root, '.runtime/preconfirm-traffic/report.json')));
const executablePath = process.env.CHROME_TEST_EXECUTABLE;
assert.ok(executablePath?.includes('Google Chrome for Testing'), 'Explicit Chrome for Testing executable required');
const python = process.env.TEST_PYTHON || 'python3';
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'country-proxy-preconfirm-'));
const profile = path.join(scratch, 'profile');
const journal = path.join(scratch, 'native-commands.jsonl');
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
let epoch = 0, queryNumber = 0;
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
  await fs.writeFile(launcher, '#!/bin/sh\nexec ' + [python, '-I', '-B', path.join(root, 'tests/preconfirm_host.py'), ...ports.map(String), journal].map(quote).join(' ') + '\n', {mode: 0o700});
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
  context = await chromium.launchPersistentContext(profile, {executablePath, headless: true,
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
  const hasGate = !!(await fs.stat(path.join(sourceRoot, 'extension/traffic-gate.js')).catch(() => null));
  report.executed.push(await inspectRuntime(context, sourceRoot, {names: ['background.js', 'controller.js', 'probe.js',
    ...(hasGate ? ['traffic-gate.js'] : [])]}));
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
async function held() {
  return until(async () => {
    const s = await state();
    if (s.status?.phase === 'error') throw Error(s.status.error);
    if (!(s.status?.phase === 'verifying' && pending.some(row => row.epoch === epoch) &&
      requests.some(r => r.epoch === epoch && r.host === hosts[1] && r.url.startsWith('/generate_204')))) return false;
    assert.notEqual(s.status.browser?.ok, true, 'pending offer has no Chrome confirmation');
    const rows = await commands(), start = rows.findLastIndex(row => ['start', 'rotate'].includes(row.command));
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
  await disconnect(); report.result = 'PASS';
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
    await until(async () => (await state()).status?.phase === 'off', 'initial disabled state');
    if (!baseline) await preloadOrdinaryPages();
    if (baseline) await baselineProbe(); else await fullMatrix();
  }
} catch (error) {
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
  await fs.mkdir(path.dirname(output), {recursive: true});
  await fs.writeFile(output, JSON.stringify(report, (_key, value) => typeof value === 'string' ? redact(value) : value, 2) + '\n', {mode: 0o600});
  console.log(JSON.stringify({result: report.result, scenarios: report.scenarios, blocked: report.blockedRequests.length,
    error: report.error, cleanupErrors: report.cleanupErrors, scratchRemoved: report.scratchRemoved,
    mainRegistrationUnchanged: report.mainRegistrationUnchanged, changedExtension: report.changedExtension, output}));
  if (!['PASS', 'RED_REPRODUCED', 'DEVELOPMENT_SMOKE_PASS'].includes(report.result) || report.cleanupErrors.length || !report.mainRegistrationUnchanged || report.changedExtension.length) process.exitCode = 1;
}
