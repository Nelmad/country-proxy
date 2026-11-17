// Opt-in REAL Chrome/TLS/Geo acceptance. Run only in the isolated stage4 copy:
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright node tests/history-lab.mjs
// Uses a temporary profile, explicit owned data-dir and one loopback CONNECT
// listener. Cooldown is the real production 60s; no fake clocks/check outcomes.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {inspectRuntime} from './chrome-runtime.mjs';

const exec = promisify(execFile);
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const python = process.env.HISTORY_LAB_PYTHON || path.join(root, '.venv/bin/python');
const allowed = new Set(['www.cloudflare.com:443', 'www.google.com:443', 'example.com:443']);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const report = {at: new Date().toISOString(), result: 'FAIL', kind: 'isolated-persistent-history',
  mainChromeTouched: false, productionIntervals: true, realCooldownSeconds: 60,
  provesDifferentPublicIP: false, fixtureAllowances: ['one specifically owned loopback endpoint admitted by injected history validator',
    'owned-source discovery replaces public feeds; TLS results and actual country are real'], checks: {}};
let directory, browser, popup, page, worker, listener, config, profile, historyFile, id;
let originalHistoryMode = null;

async function bounded(operation, ms, label) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('Timed out: ' + label)), ms);
  })]); } finally { clearTimeout(timer); }
}
async function waitFor(fn, label, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(150); }
  throw Error('Timed out: ' + label);
}
async function events() {
  try { return (await fs.readFile(path.join(directory, 'native-events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function hashes() {
  const result = {};
  for (const folder of ['native', 'extension']) {
    async function walk(at) {
      for (const entry of (await fs.readdir(at, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) continue;
        const file = path.join(at, entry.name);
        if (entry.isDirectory()) await walk(file); else if (entry.isFile()) result[path.relative(root, file)] = sha(await fs.readFile(file));
      }
    }
    await walk(path.join(root, folder));
  }
  return result;
}
async function proxy() {
  const sockets = new Set(), state = {accept: false, attempts: [], hits: [], denied: [], bytes: {}};
  const server = http.createServer((_request, response) => { response.writeHead(405); response.end(); });
  function track(socket) {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.setTimeout(65000, () => socket.destroy());
  }
  server.on('connection', track);
  server.on('connect', (request, client, head) => {
    state.attempts.push({at: Date.now(), target: request.url, accepting: state.accept});
    if (!allowed.has(request.url)) {
      state.denied.push(request.url); client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); return;
    }
    if (!state.accept) { client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); return; }
    const [host, port] = request.url.split(':'), upstream = net.connect({host, port: Number(port)});
    track(upstream);
    const bytes = state.bytes[request.url] ??= {toOrigin: 0, fromOrigin: 0};
    client.on('data', chunk => { bytes.toOrigin += chunk.length; });
    upstream.on('data', chunk => { bytes.fromOrigin += chunk.length; });
    upstream.on('connect', () => {
      if (client.destroyed) { upstream.destroy(); return; }
      state.hits.push({at: Date.now(), target: request.url});
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) { bytes.toOrigin += head.length; upstream.write(head); }
      client.pipe(upstream); upstream.pipe(client);
    });
    client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy());
    upstream.on('error', () => client.destroy());
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  state.port = server.address().port;
  state.close = async () => { const closed = new Promise(resolve => server.close(resolve)); for (const socket of sockets) socket.destroy(); await closed; };
  return state;
}
async function launch() {
  browser = await chromium.launchPersistentContext(profile, {headless: true, channel: 'chromium', timeout: 45000,
    ignoreDefaultArgs: ['--disable-extensions'], args: [`--disable-extensions-except=${root}/extension`,
      `--load-extension=${root}/extension`, '--disable-quic'], viewport: {width: 640, height: 650}});
  worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker', {timeout: 20000});
  report.browser = browser.browser().version(); report.executable = chromium.executablePath();
  (report.runtimes ??= []).push(await inspectRuntime(browser, root));
  popup = await browser.newPage(); await popup.goto(`chrome-extension://${id}/popup.html`);
  page = await browser.newPage();
}
const command = (action, extra = {}) => bounded(() => popup.evaluate(message => chrome.runtime.sendMessage(message), {action, ...extra}), 5000, action);
const state = () => bounded(() => popup.evaluate(async () => ({...await chrome.storage.local.get(['status', 'enabled', 'selected', 'selectedCountries']),
  route: await chrome.proxy.settings.get({incognito: false})})), 5000, 'state');
function route(value, port) {
  assert.equal(value.mode, 'fixed_servers');
  for (const name of ['proxyForHttp', 'proxyForHttps', 'fallbackProxy']) {
    assert.equal(value.rules[name].host, '127.0.0.1'); assert.equal(value.rules[name].port, port);
  }
  assert.ok(value.rules.bypassList.includes('<-loopback>'));
}
async function blocked(label) {
  const before = await state(); assert.equal(before.enabled, true); route(before.route.value, 9);
  let succeeded = false;
  try { await page.goto('https://example.com/?history-blocked=' + label + Date.now(), {timeout: 6000, waitUntil: 'domcontentloaded'}); succeeded = true; }
  catch (error) { (report.blockedRequests ??= []).push({label, error: error.message}); }
  assert.equal(succeeded, false, 'ordinary HTTPS must fail closed during quarantine');
  route((await state()).route.value, 9);
}
async function ordinary(label) {
  const before = {...(listener.bytes['example.com:443'] || {toOrigin: 0, fromOrigin: 0})};
  route((await state()).route.value, listener.port);
  const response = await page.goto('https://example.com/?history=' + label + Date.now(), {timeout: 25000, waitUntil: 'domcontentloaded'});
  assert.equal(response?.status(), 200); assert.ok((await page.locator('body').innerText()).length > 0);
  route((await state()).route.value, listener.port);
  const after = {...listener.bytes['example.com:443']};
  assert.ok(after.toOrigin > before.toOrigin && after.fromOrigin > before.fromOrigin,
    'independent ordinary browser TLS must transfer through the chosen listener');
  return {status: response.status(), port: listener.port, before, after};
}
async function nativeExited(pid) {
  await waitFor(async () => (await events()).some(event => event.event === 'exit' && event.pid === pid), 'native final flush/exit', 12000);
}
async function closeBrowser() {
  const current = browser; browser = null;
  if (current) await bounded(() => current.close(), 12000, 'close owned Chrome');
}
async function emptyAfter(offset) {
  return waitFor(async () => (await events()).slice(offset).find(event => event.event === 'status' && event.status.phase === 'empty'), 'fresh empty search');
}
async function connected() {
  return waitFor(async () => {
    const current = await state();
    if (['helper', 'error'].includes(current.status?.phase)) throw Error(JSON.stringify(current.status));
    if (current.status?.phase !== 'connected') return false;
    assert.equal(current.status.proxy.port, listener.port);
    assert.equal(current.status.country, report.baseline.country);
    assert.equal(current.status.browser.country, report.baseline.country);
    route(current.route.value, listener.port); return current;
  }, 'real native and independent Chrome recovery', 90000);
}

const sourceHashes = await hashes();
try {
  const base = path.join(root, '.runtime/stage4-history'); await fs.mkdir(base, {recursive: true});
  directory = await fs.mkdtemp(path.join(base, 'run-')); report.directory = directory;
  profile = path.join(directory, 'profile'); config = path.join(directory, 'config.json');
  const dataDir = path.join(directory, 'history'); await fs.mkdir(dataDir, {mode: 0o700});
  historyFile = path.join(dataDir, 'endpoint-history.json');
  const baselineCode = `import asyncio,json,sys\nsys.path.insert(0,${JSON.stringify(path.join(root, 'native'))})\nfrom core import curl,TRACE,TARGET,country_code\nasync def main():\n a,b=await asyncio.gather(curl(TRACE,slow=True),curl(TARGET,slow=True))\n if a[0] or b[0] or a[1]!='200' or b[1]!='204':raise RuntimeError('Real HTTPS baseline unavailable')\n fields=dict(x.split('=',1) for x in a[2].splitlines() if '=' in x)\n print(json.dumps({'country':country_code(fields.get('loc')),'exitIp':fields.get('ip')}))\nasyncio.run(main())`;
  report.baseline = JSON.parse((await exec(python, ['-I', '-B', '-c', baselineCode], {timeout: 50000})).stdout);
  listener = await proxy(); report.listenerPort = listener.port;
  await fs.writeFile(config, JSON.stringify({country: report.baseline.country, port: listener.port}), {mode: 0o600});
  const launcher = path.join(directory, 'host');
  await fs.writeFile(launcher, '#!/bin/sh\nexec ' + quote(python) + ' -I -B ' + quote(path.join(root, 'tests/history_fixture.py')) + ' ' + quote(config) + '\n', {mode: 0o700});
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'extension/manifest.json')));
  id = sha(Buffer.from(manifest.key, 'base64')).slice(0, 32).replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
  const registration = path.join(profile, 'NativeMessagingHosts'); await fs.mkdir(registration, {recursive: true});
  await fs.writeFile(path.join(registration, 'local.country_proxy.json'), JSON.stringify({name: 'local.country_proxy',
    description: 'Disposable stage4 history', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${id}/`]}), {mode: 0o600});
  report.profile = profile; report.dataDir = dataDir; report.registration = registration;
  await launch();
  assert.equal((await command('connect', {country: report.baseline.country})).ok, true);
  const first = await waitFor(async () => (await events()).find(event => event.event === 'logical-outcome' && !event.ok), 'one terminal logical failure');
  await emptyAfter(0);
  assert.equal(first.reason, 'transport'); assert.equal(first.history.streak, 0); assert.equal(first.history.eligible, false);
  const cooldownEnd = first.history.cooldownUntilWall * 1000;
  const starts = (await events()).filter(event => event.event === 'checker-start');
  assert.deepEqual(starts.map(event => event.slow), [false, true], 'fast and slow remain one logical unknown attempt');
  assert.equal((await events()).filter(event => event.event === 'logical-outcome').length, 1);
  assert.ok(listener.attempts.length >= 4); report.checks.initialLogicalFailure = {first, starts};
  const attemptsBefore = listener.attempts.length;
  for (let iteration = 0; iteration < 2; iteration++) {
    const offset = (await events()).length;
    assert.equal((await command('connect', {country: report.baseline.country})).ok, true);
    await emptyAfter(offset);
    assert.equal(listener.attempts.length, attemptsBefore);
    assert.equal((await events()).filter(event => event.event === 'checker-start').length, 2);
  }
  await blocked('fresh-discovery'); report.checks.freshDiscoveryNoProbe = true;
  // Closing without disconnect keeps enabled intent for the SAME temporary
  // profile's next startup. EOF must flush the real helper's leased cache.
  const firstPid = first.pid;
  await closeBrowser(); await nativeExited(firstPid);
  const persisted = JSON.parse(await fs.readFile(historyFile, 'utf8'));
  assert.ok(persisted.records.some(row => row.port === listener.port && row.streak === 0));
  report.checks.flushedAtRestart = {records: persisted.records.length, bytes: (await fs.stat(historyFile)).size};
  // An unrelated cache-only endpoint has no listener and is never offered by
  // discovery. Only its retention timestamp is synthetic; the real listener's
  // persisted cooldown and timestamps remain untouched.
  const dummyPort = listener.port === 65535 ? listener.port - 1 : listener.port + 1;
  const dummy = structuredClone(persisted.records.find(row => row.port === listener.port));
  Object.assign(dummy, {port: dummyPort, firstSeen: persisted.savedAt - (7 * 24 * 3600 + 1),
    lastSeen: persisted.savedAt - (7 * 24 * 3600 + 1), lastSuccess: null, ewmaMs: null,
    cooldownUntil: null, streak: 0, countryHint: null});
  persisted.records.push(dummy);
  await fs.writeFile(historyFile, JSON.stringify(persisted), {mode: 0o600});
  report.fixtureAllowances.push('one unrelated cache-only expired dummy uses synthetic seven-day-old timestamps');
  assert.ok(Date.now() < cooldownEnd - 5000, 'restart must genuinely finish before real cooldown expiry');
  const reopenOffset = (await events()).length;
  await launch(); await emptyAfter(reopenOffset);
  assert.equal(listener.attempts.length, attemptsBefore);
  const reopened = (await events()).slice(reopenOffset), hello = reopened.find(event => event.event === 'hello');
  assert.ok(hello); assert.notEqual(hello.pid, firstPid); assert.equal(hello.message.history.mode, 'persistent');
  assert.equal(hello.message.history.records, 1, 'expired unrelated cache entry must be removed before hello');
  assert.equal(reopened.filter(event => event.event === 'checker-start').length, 0);
  await blocked('restarted-profile'); report.checks.restartNoProbe = {pid: hello.pid, hello: hello.message};
  report.checks.expirySevenDays = {dummyPort, prunedOnLoad: true, realQuarantineUnchanged: true};
  const recoveryOffset = (await events()).length;
  listener.accept = true;
  while (Date.now() < cooldownEnd) {
    await delay(Math.min(500, cooldownEnd - Date.now()));
    if (Date.now() < cooldownEnd) assert.equal(listener.attempts.length, attemptsBefore,
      'quarantine must suppress all checks before expiry');
  }
  // No connect/rotate/check command is issued here. The existing Session's real
  // production retry timer must discover and recheck the healed listener itself.
  report.recovered = await connected(); report.ordinaryRecovered = await ordinary('recovered');
  await waitFor(async () => (await events()).slice(recoveryOffset).some(event => event.event === 'feedback' && event.command === 'confirm' && event.accepted),
    'addressed independent Chrome confirmation');
  const recoveredEvents = (await events()).slice(recoveryOffset);
  const recoveryStarts = recoveredEvents.filter(event => event.event === 'checker-start');
  assert.ok(recoveryStarts.length >= 1);
  assert.ok(recoveryStarts.every(event => event.at * 1000 >= cooldownEnd - 1),
    'no physical native checker may start before persisted cooldown expiry');
  assert.ok(listener.attempts.slice(attemptsBefore).every(event => event.at >= cooldownEnd - 1));
  report.checks.unattendedRetry = {noRecoveryCommand: true, cooldownEnd, recoveryStarts};
  const success = recoveredEvents.find(event => event.event === 'logical-outcome' && event.ok);
  assert.ok(success); assert.equal(success.history.streak, 0); assert.equal(success.history.cooldownUntilWall, null);
  assert.ok(success.history.lastSuccess !== null && success.history.ewmaMs >= 0);
  assert.ok(recoveredEvents.some(event => event.event === 'feedback' && event.command === 'confirm' && event.accepted));
  report.checks.recoveredAfterRealExpiry = success;
  await page.goto('https://www.cloudflare.com/cdn-cgi/trace?history=' + Date.now(), {timeout: 25000, waitUntil: 'domcontentloaded'});
  const fields = Object.fromEntries((await page.locator('body').innerText()).trim().split('\n').filter(line => line.includes('=')).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
  assert.equal(fields.loc, report.baseline.country); assert.equal(fields.ip, report.recovered.status.proxy.exitIp);
  report.browserTrace = {country: fields.loc, exitIp: fields.ip};
  // A corrupt owned cache causes a cold fresh check, preserving real route
  // validation and blocked startup rather than crashing or trusting old success.
  await closeBrowser(); await nativeExited(hello.pid);
  await fs.writeFile(historyFile, '{broken cache', {mode: 0o600});
  const corruptionOffset = (await events()).length;
  await launch(); await connected(); report.ordinaryAfterCorruption = await ordinary('corrupt-cache');
  assert.ok((await events()).slice(corruptionOffset).some(event => event.event === 'checker-result' && event.report.ok));
  report.checks.corruptionColdRecovery = true;
  // Change only this owned cache file's permissions. The real periodic writer
  // must encounter the actual invalid permissions; its I/O is not substituted.
  originalHistoryMode = (await fs.stat(historyFile)).mode & 0o777;
  assert.equal(originalHistoryMode, 0o600);
  const failureOffset = (await events()).length;
  await fs.chmod(historyFile, 0o400);
  try {
    const unavailable = await waitFor(async () => (await events()).slice(failureOffset).find(event =>
      event.event === 'history-status' && event.history?.mode === 'unavailable' &&
      event.phase === 'connected' && event.port === listener.port),
    'actual periodic disk failure with healthy native status', 80000);
    report.ordinaryDuringDiskFailure = await ordinary('disk-write-failure');
    report.checks.diskFailureKeepsHealthyRoute = {unavailable, actualFileMode: 0o400};
  } finally {
    await fs.chmod(historyFile, originalHistoryMode);
    assert.equal((await fs.stat(historyFile)).mode & 0o777, originalHistoryMode);
    originalHistoryMode = null;
    report.checks.diskFilePermissionsRestored = true;
  }
  report.result = 'PASS';
} catch (error) { report.error = error.stack || error.message; }
finally {
  const cleanup = {errors: [], browserClosed: false, nativeExited: true, listenerClosed: false, profileRemoved: false};
  const attempt = async (label, fn) => { try { await bounded(fn, 15000, label); return true; } catch (error) { cleanup.errors.push({label, error: error.message}); return false; } };
  if (historyFile && originalHistoryMode !== null) await attempt('restore owned history permissions', async () => {
    await fs.chmod(historyFile, originalHistoryMode);
    assert.equal((await fs.stat(historyFile)).mode & 0o777, originalHistoryMode);
    originalHistoryMode = null;
  });
  if (browser && popup) await attempt('disconnect', () => command('disconnect'));
  cleanup.browserClosed = await attempt('close owned browser', closeBrowser);
  if (directory) {
    const all = await events();
    for (const started of all.filter(event => event.event === 'start')) {
      const alive = () => { try { process.kill(started.pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
      if (!alive()) continue;
      const ok = await attempt('owned helper ' + started.pid, async () => {
        const line = (await exec('/bin/ps', ['-p', String(started.pid), '-o', 'command='], {timeout: 3000})).stdout;
        assert.ok(line.includes(path.join(root, 'tests/history_fixture.py')) && line.includes(config), 'helper PID ownership mismatch');
        process.kill(started.pid, 'SIGTERM'); await waitFor(() => !alive(), 'owned helper exit', 10000);
      });
      cleanup.nativeExited &&= ok;
    }
    report.nativeEvents = await events();
  }
  if (listener) { cleanup.listenerClosed = await attempt('close owned listener', () => listener.close());
    report.listener = {port: listener.port, attempts: listener.attempts, hits: listener.hits, denied: listener.denied, bytes: listener.bytes}; }
  if (profile && cleanup.browserClosed) cleanup.profileRemoved = await attempt('remove owned test profile', () => fs.rm(profile, {recursive: true, force: true}));
  report.cleanup = cleanup; report.productUnchanged = JSON.stringify(sourceHashes) === JSON.stringify(await hashes());
  if (cleanup.errors.length || !report.productUnchanged) { report.result = 'FAIL'; report.error ??= 'Cleanup failure or changed product sources'; }
  if (directory) {
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    await fs.writeFile(path.join(path.dirname(directory), 'latest.json'), JSON.stringify({result: report.result, report: path.join(directory, 'report.json')}) + '\n');
  }
}
console.log(JSON.stringify({result: report.result, report: directory && path.join(directory, 'report.json'), error: report.error}, null, 2));
if (report.result !== 'PASS') process.exitCode = 1;
