// Run with a local Playwright installation and Chrome for Testing. Both HTTPS
// origins resolve to a loopback server using a one-run test certificate.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {inspectRuntime} from './chrome-runtime.mjs';

const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const run = await fs.mkdtemp(path.join(os.tmpdir(), 'country-proxy-route-truth-'));
const profile = path.join(run, 'profile');
const reserveDiagnostics = process.argv.includes('--reserve-diagnostics');
const httpsDiagnosis = process.argv.includes('--https-diagnosis');
const earlyVerdict = process.argv.includes('--early-verdict');
const releaseReserve = path.join(run, 'offer-independent');
const rival = path.join(run, 'rival');
const journal = path.join(run, 'commands.jsonl');
const loopback = '127.0.0.1';
const hosts = ['www.cloudflare.com', 'www.google.com'];
const expectedExit = '192.0.2.11';
const report = {scenarios: [], result: 'FAIL'};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeout = 6500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(50);
  }
  throw Error('Timed out: ' + label);
}

function watchSockets(server) {
  const sockets = new Set();
  server.on('connection', s => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.on('error', () => {});
  });
  return () => { for (const socket of sockets) socket.destroy(); };
}
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, loopback, () => resolve(server.address().port));
});
const keyfile = path.join(run, 'local-test.key');
const certfile = path.join(run, 'local-test.crt');
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
let hold = false;
let tunnelFault;
let slowPair;
const pending = [], requests = [], tunnels = [];
const proxies = [];
let origin, resetOrigin, browser, worker, popup, rivalPage, rivalId;

async function prepare() {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=www.cloudflare.com', '-addext', 'subjectAltName=' + hosts.map(h => 'DNS:' + h).join(','),
    '-keyout', keyfile, '-out', certfile], {stdio: 'ignore'});
  const key = await fs.readFile(keyfile);
  const spki = crypto.createPublicKey(key).export({type: 'spki', format: 'der'});
  const fingerprint = crypto.createHash('sha256').update(spki).digest('base64');
  origin = https.createServer({key, cert: await fs.readFile(certfile)}, (request, response) => {
    const url = new URL(request.url, 'https://' + request.headers.host);
    const trace = url.hostname === hosts[0] && url.pathname === '/cdn-cgi/trace';
    if (!trace && !(url.hostname === hosts[1] && url.pathname === '/generate_204')) {
      response.writeHead(404).end(); return;
    }
    requests.push(url.hostname);
    if (slowPair) {
      const test = slowPair;
      if (trace) {
        test.traceReached();
        response.once('close', () => test.traceClosed());
      } else {
        void test.traceStarted.then(() => {
          slowPair = null;  // The next address reaches both healthy HTTPS origins.
          test.failureAt = Date.now();
          response.writeHead(503, {'Cache-Control': 'no-store'}).end();
        });
      }
      return;
    }
    const answer = () => response.writeHead(trace ? 200 : 204, {'Cache-Control': 'no-store',
      'Content-Type': 'text/plain'}).end(trace ? 'loc=NO\nip=' + expectedExit + '\n' : undefined);
    if (tunnelFault && tunnelFault.host !== url.hostname) {
      if (!tunnelFault.holdPeer) answer();
      tunnelFault.peerReached();
    } else if (hold && pending.length < 2) pending.push(answer);
    else answer();
  });
  resetOrigin = watchSockets(origin);
  const originPort = await listen(origin);
  const startProxy = async () => {
    const proxy = http.createServer((_req, res) => res.writeHead(405).end());
    const reset = watchSockets(proxy);
    proxies.push({proxy, reset});
    proxy.on('connect', (request, client, head) => {
      if (!hosts.some(host => request.url === host + ':443')) { client.destroy(); return; }
      tunnels.push({port: proxy.address().port, target: request.url});
      const fault = tunnelFault;
      if (fault && request.url === fault.host + ':443') {
        fault.tunnelRequests++;
        // Wait for an actual normal TLS request to the sibling origin before failing this CONNECT.
        void fault.ready.then(async () => {
          await delay(100);
          if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        });
        return;
      }
      const upstream = net.connect(originPort, loopback, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy());
      upstream.on('close', () => client.destroy());
      client.on('close', () => upstream.destroy());
    });
    return listen(proxy);
  };
  const [proxyPort, alternatePort] = await Promise.all([startProxy(), startProxy()]);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'extension/manifest.json')));
  const id = crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex')
    .slice(0, 32).replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
  const registration = path.join(profile, 'NativeMessagingHosts');
  await fs.mkdir(registration, {recursive: true});
  const launcher = path.join(run, 'native');
  const hostArgs = reserveDiagnostics
    ? [path.join(root, 'tests/reserve_diagnostics_fixture.py'), String(proxyPort), releaseReserve]
    : [path.join(root, 'tests/route_truth_host.py'), String(proxyPort), String(alternatePort), journal, ...(earlyVerdict ? ['--after-reject'] : [])];
  await fs.writeFile(launcher, '#!/bin/sh\nexec python3 -I -B ' +
    hostArgs.map(quote).join(' ') + '\n', {mode: 0o700});
  await fs.writeFile(path.join(registration, 'local.country_proxy.json'), JSON.stringify({
    name: 'local.country_proxy', description: 'Route acceptance fixture', path: launcher,
    type: 'stdio', allowed_origins: ['chrome-extension://' + id + '/']
  }));
  await fs.mkdir(rival);
  await fs.writeFile(path.join(rival, 'manifest.json'), JSON.stringify({manifest_version: 3,
    name: 'Test proxy owner', version: '1.0', permissions: ['proxy', 'privacy']}));
  await fs.writeFile(path.join(rival, 'settings.html'), '<!doctype html><title>Test proxy owner</title>');
  return {fingerprint, originPort, proxyPort, alternatePort, id};
}

async function launch(settings, restart = false) {
  const ext = path.join(root, 'extension');
  browser = await chromium.launchPersistentContext(profile, {channel: 'chromium', headless: true,
    ignoreDefaultArgs: ['--disable-extensions'], args: [
      '--enable-unsafe-extension-debugging', '--disable-quic',
      '--host-resolver-rules=' + hosts.map(h => 'MAP ' + h + ' ' + loopback + ':' + settings.originPort).concat('MAP * ~NOTFOUND', 'EXCLUDE 127.0.0.1').join(','),
      '--ignore-certificate-errors-spki-list=' + settings.fingerprint,
      '--load-extension=' + (restart ? [ext, rival].join(',') : ext)
    ]});
  report.browser = browser.browser().version();
  report.executed = await inspectRuntime(browser, root);
  worker = browser.serviceWorkers().find(w => w.url().startsWith('chrome-extension://' + settings.id + '/'));
  popup = await browser.newPage();
  await popup.goto('chrome-extension://' + settings.id + '/popup.html');
  if (!restart) {
    const devtools = await browser.browser().newBrowserCDPSession();
    try { ({id: rivalId} = await devtools.send('Extensions.loadUnpacked', {path: rival})); }
    finally { await devtools.detach(); }
  }
  rivalPage = await browser.newPage();
  await rivalPage.goto('chrome-extension://' + rivalId + '/settings.html');
}

const snapshot = () => popup.evaluate(async () => {
  const [data, proxy, rtc, prediction, alarm, badge] = await Promise.all([
    chrome.storage.local.get(['status', 'enabled']), chrome.proxy.settings.get({incognito: false}),
    chrome.privacy.network.webRTCIPHandlingPolicy.get({}), chrome.privacy.network.networkPredictionEnabled.get({}),
    chrome.alarms.get('reconnect'), chrome.action.getBadgeText({})]);
  return {data, proxy, rtc, prediction, alarm: !!alarm, badge};
});
const command = m => popup.evaluate(msg => chrome.runtime.sendMessage(msg), m);
const phases = () => popup.evaluate(() => window.phases);
const nativeCommands = async () => (await fs.readFile(journal, 'utf8')).trim().split('\n').map(s => JSON.parse(s).command);
async function competitorDirect() {
  await rivalPage.evaluate(() => chrome.proxy.settings.set({value: {mode: 'direct'}, scope: 'regular'}));
  const s = await snapshot();
  assert.equal(s.proxy.value.mode, 'direct');
  assert.equal(s.proxy.levelOfControl, 'controlled_by_other_extensions');
}
async function clearRival() {
  await rivalPage.evaluate(() => chrome.proxy.settings.clear({scope: 'regular'}));
}
async function connected(proxyPort, connect = true) {
  if (connect) assert.equal((await command({action: 'connect', country: 'NO'})).ok, true);
  const s = await until(async () => {
    const s = await snapshot();
    if (s.data.status?.phase === 'error') throw Error(s.data.status.error);
    return s.data.status?.phase === 'connected' && s.badge === 'NO' && s;
  }, 'browser verifies local NO exit');
  assert.equal(s.proxy.value.rules.proxyForHttps.port, proxyPort);
  assert.equal(s.proxy.levelOfControl, 'controlled_by_this_extension');
  assert.equal(s.data.status.browser.exitIp, expectedExit);
  assert.equal(s.data.status.browser.country, 'NO');
  assert.ok(hosts.every(h => tunnels.some(t => t.target === h + ':443' && t.port === proxyPort)));
  await until(async () => (await popup.locator('#proxy').innerText()).includes('Выход сейчас: ' + expectedExit), 'confirmed exit in popup');
  return s;
}

async function pendingOffer() {
  hold = true;
  const start = requests.length;
  assert.equal((await command({action: 'connect', country: 'NO'})).ok, true);
  await until(async () => (await snapshot()).data.status?.phase === 'verifying' &&
    hosts.every(h => requests.slice(start).includes(h)) && pending.length === 2, 'both pending HTTPS responses');
  const details = await popup.locator('#proxy').innerText();
  assert.match(details, /Выход по проверке помощника: 192\.0\.2\.10/);
  assert.doesNotMatch(details, /Выход сейчас/);
}
async function ownership(settings, slow) {
  const cmdStart = await fs.readFile(journal, 'utf8').then(text => text.trim().split('\n').length, () => 0);
  if (slow) await pendingOffer();
  else await connected(settings.proxyPort);
  const start = Date.now();
  await competitorDirect();
  const lost = await until(async () => {
    const s = await snapshot();
    return s.data.status?.phase === 'error' && s.badge !== 'NO' && s;
  }, 'detect competing direct route' + (slow ? ' before held HTTPS completes' : ' after connected'));
  assert.equal(lost.data.enabled, true);
  assert.equal(lost.data.status.proxy, null);
  assert.equal(lost.proxy.levelOfControl, 'controlled_by_other_extensions');
  assert.equal(lost.proxy.value.mode, 'direct');
  const elapsedMs = Date.now() - start, phaseCount = (await phases()).length;
  const retry = popup.getByRole('button', {name: 'Повторить подключение', exact: true});
  await retry.waitFor({state: 'visible', timeout: 2500});
  hold = false; pending.splice(0).forEach(reply => reply());
  // Proxy ownership is foreign, but our enabled intent retains the independent
  // request gate until explicit Stop. This must not become a DIRECT escape.
  const direct = await browser.newPage();
  try {
    await assert.rejects(direct.goto('https://' + hosts[0] + '/cdn-cgi/trace?direct', {timeout: 5000}), /ERR_BLOCKED_BY_CLIENT/);
  } finally { await direct.close(); }
  await delay(160);
  assert.equal((await snapshot()).data.status.phase, 'error');
  assert.ok(!(await phases()).slice(phaseCount).includes('connected'));
  const commands = (await nativeCommands()).slice(cmdStart);
  assert.ok(!commands.includes('reject'));
  if (slow) assert.ok(!commands.includes('confirm'));
  else assert.ok(commands.includes('confirm'));
  await clearRival();
  const restored = await snapshot();
  assert.equal(restored.data.status.phase, 'error');
  assert.notEqual(restored.proxy.value.rules?.proxyForHttps?.port, settings.proxyPort);
  assert.notEqual(restored.proxy.levelOfControl, 'controlled_by_this_extension');
  if (!slow) {
    await retry.click();
    await connected(settings.proxyPort, false);
  }
  report.scenarios.push({name: slow ? 'competing-owner-during-probe' : 'competing-owner-while-connected',
    elapsedMs, ordinaryDirectBlocked: true, commands, staleProxyAfterRelease: false, manualRetryTested: !slow});
  assert.equal((await command({action: 'disconnect'})).ok, true);
}

async function rapidOwnership(settings) {
  const cmdStart = (await nativeCommands()).length;
  const eventStart = (await phases()).length;
  await pendingOffer();
  await rivalPage.evaluate(async () => {
    await chrome.proxy.settings.set({value: {mode: 'direct'}, scope: 'regular'});
    await chrome.proxy.settings.clear({scope: 'regular'});
  });
  const lost = await until(async () => {
    const s = await snapshot();
    return s.data.status.phase === 'error' && !s.data.status.proxy && s;
  }, 'notice temporary owner before pending requests return');
  assert.ok(lost.proxy.levelOfControl !== 'controlled_by_this_extension' ||
    lost.proxy.value.rules?.proxyForHttps?.port === 9);
  hold = false; pending.splice(0).forEach(reply => reply());
  await delay(160);
  assert.equal((await snapshot()).data.status.phase, 'error');
  assert.ok(!(await phases()).slice(eventStart).includes('connected'));
  const commands = (await nativeCommands()).slice(cmdStart);
  assert.ok(!commands.includes('confirm') && !commands.includes('reject'));
  report.scenarios.push({name: 'short-competing-owner', commands, ownerAfterRelease: lost.proxy.levelOfControl,
    blockedAfterRelease: lost.proxy.value.rules?.proxyForHttps?.port === 9});
  assert.equal((await command({action: 'disconnect'})).ok, true);
}

async function withdrawDuringProbe(settings) {
  const start = (await nativeCommands()).length;
  const eventStart = (await phases()).length;
  await pendingOffer();
  assert.equal((await command({action: 'rotate'})).ok, true);
  const beforeRelease = await connected(settings.alternatePort, false);
  assert.equal(beforeRelease.data.status.attempt, 2);
  assert.equal(pending.length, 2);
  hold = false; pending.splice(0).forEach(reply => reply());
  await delay(160);
  assert.equal((await snapshot()).data.status.proxy.port, settings.alternatePort);
  const greens = await popup.evaluate(startAt => window.ports.slice(startAt).filter(Boolean), eventStart);
  assert.deepEqual(greens, [settings.alternatePort]);
  const events = (await fs.readFile(journal, 'utf8')).trim().split('\n').slice(start).map(s => JSON.parse(s));
  assert.deepEqual(events.filter(e => e.command === 'confirm').map(e => e.attempt), [2]);
  assert.ok(!events.some(e => e.command === 'reject'));
  report.scenarios.push({name: 'withdraw-held-offer', confirmedAttempt: 2, offersConfirmed: greens.length,
    country: beforeRelease.data.status.browser.country});
  assert.equal((await command({action: 'disconnect'})).ok, true);
}

async function explainReserve() {
  hold = true;
  assert.equal((await command({action: 'connect', countries: ['NO', 'EE', 'AT']})).ok, true);
  const details = popup.locator('#reserve-diagnostics');
  await details.locator('summary').click({timeout: 6500});
  const state = () => popup.evaluate(() => chrome.storage.local.get(['selectedCountries', 'pool', 'status', 'reserveDiagnostics']));
  const gated = await until(async () => {
    const s = await state();
    return pending.length === 2 && s.reserveDiagnostics?.state === 'awaitingBrowser' && s;
  }, 'waiting for Chrome confirmation before refill');
  assert.deepEqual(gated.selectedCountries, ['AT', 'EE', 'NO']);
  const waitingText = await details.innerText();
  assert.match(waitingText, /Chrome/);
  hold = false;
  pending.splice(0).forEach(reply => reply());
  const count = async name => Number(await details.locator('dd[data-counter="' + name + '"]').innerText({timeout: 600}));
  const duplicates = await until(async () => {
    const s = await state();
    const c = s.reserveDiagnostics?.counts;
    if (s.status?.phase !== 'connected' || s.pool?.count !== 0 || !c?.sameHost || !c?.sameExit || !s.reserveDiagnostics?.failures?.country) return false;
    return (await count('sameHost')) > 0 && (await count('sameExit')) > 0 && s;
  }, 'empty reserve explained by host and exit duplicates');
  assert.match(await popup.locator('#reserve-failures').innerText(), /страна выхода вне набора/i);
  await fs.writeFile(releaseReserve, '');
  const ready = await until(async () => {
    const s = await state();
    return s.pool?.count === 1 && s.reserveDiagnostics?.counts.added === 1 && (await count('added')) === 1 && s;
  }, 'independent result accepted into reserve and shown in popup');
  assert.deepEqual(ready.selectedCountries, gated.selectedCountries);
  assert.equal(ready.status.browser.country, 'NO');
  report.scenarios.push({name: 'explain-empty-then-admit-independent', countries: ready.selectedCountries,
    waiting: gated.reserveDiagnostics, empty: duplicates.reserveDiagnostics, ready: ready.reserveDiagnostics});
  assert.equal((await command({action: 'disconnect'})).ok, true);
  await until(async () => (await state()).reserveDiagnostics == null && !(await details.isVisible()), 'clear reserve diagnostics on Stop');
}

async function diagnoseProbeRequests() {
  const {attachProbeObserver, joinProbeRequests} = await import('./https-probe-observer.mjs');
  const monitor = await attachProbeObserver(browser, worker.url());
  const countries = ['AT', 'EE', 'NO'];
  try {
    await popup.evaluate(() => {
      window.probeStates = [];
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.status) return;
        const s = changes.status.newValue;
        if (s.phase === 'verifying') window.probeStates.push({phase: s.phase, at: s.updatedAt, attempt: s.attempt});
        if (s.phase === 'replacing' && s.diagnostic?.stage === 'browser') {
          const {reason, endpoint, checkedAt, latencyMs} = s.diagnostic;
          window.probeStates.push({phase: s.phase, reason, endpoint, checkedAt, latencyMs});
        }
      });
    });
    for (const [step, failing] of ['target', 'trace'].entries()) {
      const attempt = step + 1;
      const first = step === 0;
      const host = failing === 'target' ? hosts[1] : hosts[0];
      const peer = failing === 'target' ? 'trace' : 'target';
      const {promise, resolve} = Promise.withResolvers();
      tunnelFault = {host, holdPeer: !first, ready: promise, peerReached: resolve, tunnelRequests: 0};
      const action = first ? {action: 'connect', countries} : {action: 'rotate'};
      assert.equal((await command(action)).ok, true);
      const states = await until(async () => {
        const rows = await popup.evaluate(() => window.probeStates);
        const index = rows.findIndex(s => s.phase === 'verifying' && s.attempt === attempt);
        return index >= 0 && rows[index + 1]?.phase === 'replacing' && rows.slice(index,index + 2);
      }, 'worker rejection for the controlled tunnel');
      const [offer, diagnostic] = states;
      assert.equal(diagnostic.reason, 'transport');
      assert.equal(diagnostic.endpoint, failing);
      assert.ok(tunnelFault.tunnelRequests > 0);
      const joined = await until(() => {
        const result = joinProbeRequests(monitor.snapshot(), {
          verifyingAt: offer.at, checkedAt: diagnostic.checkedAt, latencyMs: diagnostic.latencyMs
        });
        if (result.attribution !== 'matched' || result.requests.length !== 2) return false;
        return result.requests.every(row => ['failed','cancelled','completed'].includes(row.outcome)) && result;
      }, 'CDP request and sibling terminal events');
      const failed = joined.requests.find(row => row.endpoint === failing);
      const sibling = joined.requests.find(row => row.endpoint === peer);
      assert.equal(failed.error, 'net::ERR_TUNNEL_CONNECTION_FAILED');
      assert.equal(failed.outcome, 'failed');
      if (first) {
        assert.equal(sibling.httpStatus, 200);
        // Chrome can cancel an unread trace body after its 200 headers arrived.
        assert.ok(sibling.outcome === 'completed' ||
          (sibling.outcome === 'cancelled' && sibling.error === 'net::ERR_ABORTED'));
      } else {
        assert.equal(sibling.outcome, 'cancelled');
        assert.equal(sibling.error, 'net::ERR_ABORTED');
      }
      const feedback = (await fs.readFile(journal, 'utf8')).trim().split('\n').map(row => JSON.parse(row));
      assert.ok(feedback.some(row => row.command === 'reject' && row.attempt === attempt));
      report.scenarios.push({name: 'reject-' + failing + '-tunnel', attempt, diagnostic, requests: joined.requests});
    }
    assert.deepEqual(await popup.evaluate(async () => (await chrome.storage.local.get('selectedCountries')).selectedCountries), countries);
    await command({action:'disconnect'});
  } finally {
    tunnelFault?.peerReached();
    tunnelFault = null;
    // The aborted sibling may have an origin socket idle until shutdown.
    await monitor.close();
  }
}

async function recoverFromDefinitiveHttpFailure(settings) {
  const trace = Promise.withResolvers();
  const closed = Promise.withResolvers();
  const test = {traceReached: trace.resolve, traceStarted: trace.promise, traceClosed: closed.resolve};
  slowPair = test;
  await popup.evaluate(() => {
    window.rejection = null;
    chrome.storage.onChanged.addListener((changes, area) => {
      const diagnostic = changes.status?.newValue?.diagnostic;
      if (area === 'local' && diagnostic?.stage === 'browser') {
        window.rejection = {reason: diagnostic.reason, endpoint: diagnostic.endpoint, http: diagnostic.statuses?.target};
      }
    });
  });
  const countries = ['AT', 'EE', 'NO'];
  assert.equal((await command({action:'connect', countries})).ok, true);
  const accepted = await connected(settings.alternatePort, false);
  const rejection = await popup.evaluate(() => window.rejection);
  assert.deepEqual(rejection, {reason:'http', endpoint:'target', http:503});
  assert.ok(test.failureAt);
  let timedOut;
  try {
    await Promise.race([closed.promise, new Promise((_, reject) => {
      timedOut = setTimeout(() => reject(Error('Held HTTPS request was not cancelled')), 3000);
    })]);
  } finally { clearTimeout(timedOut); }
  const commands = (await fs.readFile(journal, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(commands.some(c => c.command === 'reject' && c.attempt === 1));
  assert.ok(commands.some(c => c.command === 'confirm' && c.attempt === 2));
  assert.deepEqual(accepted.data.status.countries, countries);
  const tab = await browser.newPage();
  const response = await tab.goto('https://www.cloudflare.com/cdn-cgi/trace', {timeout:5000});
  assert.equal(response.status(), 200);
  assert.match(await tab.locator('body').innerText(), /loc=NO/);
  report.scenarios.push({name:'reject-503-with-stalled-peer-and-recover', rejection, nextConfirmedAttempt:2,
    heldRequestCancelled:true, tabConfirmed:true, from503ToTabMs:Date.now()-test.failureAt});
}

async function interruptedStop(settings, hidden) {
  const state = await connected(settings.proxyPort);
  assert.equal(state.rtc.levelOfControl, 'controlled_by_this_extension');
  assert.equal(state.prediction.levelOfControl, 'controlled_by_this_extension');
  await worker.evaluate(() => {
    const save = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = async data => {
      await save(data);
      // Simulate termination immediately after the durable disable intent, before cleanup.
      if (data.enabled === false) return new Promise(() => {});
    };
  });
  await popup.evaluate(() => { void chrome.runtime.sendMessage({action: 'disconnect'}).catch(() => {}); });
  await until(async () => (await snapshot()).data.enabled === false, 'durable Stop intent');
  let interrupted = await snapshot();
  assert.equal(interrupted.proxy.levelOfControl, 'controlled_by_this_extension');
  assert.notEqual(interrupted.data.status.phase, 'off');
  if (hidden) {
    // Hide our residual proxy under a newer owner and preserve its privacy setting, too.
    await competitorDirect();
    await rivalPage.evaluate(() => chrome.privacy.network.webRTCIPHandlingPolicy.set({
      value: 'default_public_interface_only', scope: 'regular'}));
    // Legacy profiles can already have stale "off" in storage and no stop marker.
    await popup.evaluate(() => chrome.storage.local.set({status: {phase: 'off', proxy: null}}));
    interrupted = await snapshot();
  }
  assert.ok(interrupted.alarm);
  await browser.close(); browser = null;
  await launch(settings, true);
  await command({action: 'sourceQuality', country: 'NO'}); // waits for startup reconciliation
  const after = await until(async () => {
    const s = await snapshot();
    return s.data.enabled === false && s.data.status?.phase === 'off' && s.badge === '' && s;
  }, 'disabled startup completes');
  assert.equal(after.alarm, false);
  assert.notEqual(after.proxy.levelOfControl, 'controlled_by_this_extension');
  assert.notEqual(after.rtc.levelOfControl, 'controlled_by_this_extension');
  assert.notEqual(after.prediction.levelOfControl, 'controlled_by_this_extension');
  const requestRules = await popup.evaluate(async () => ({dynamic: await chrome.declarativeNetRequest.getDynamicRules(),
    session: await chrome.declarativeNetRequest.getSessionRules()}));
  assert.equal(requestRules.dynamic.length, 0);
  assert.equal(requestRules.session.length, 0);
  if (hidden) {
    assert.equal(after.proxy.value.mode, 'direct');
    assert.equal(after.proxy.levelOfControl, 'controlled_by_other_extensions');
    assert.equal(after.rtc.value, 'default_public_interface_only');
    assert.equal(after.rtc.levelOfControl, 'controlled_by_other_extensions');
    const direct = await browser.newPage();
    try {
      const response = await direct.goto('https://' + hosts[0] + '/cdn-cgi/trace?stopped', {timeout: 5000});
      assert.equal(response.status(), 200);
      assert.match(await direct.locator('body').innerText(), /loc=NO/);
    } finally { await direct.close(); }
    await clearRival();
    await rivalPage.evaluate(() => chrome.privacy.network.webRTCIPHandlingPolicy.clear({scope: 'regular'}));
    const revealed = await snapshot();
    assert.notEqual(revealed.proxy.levelOfControl, 'controlled_by_this_extension');
    assert.notEqual(revealed.rtc.levelOfControl, 'controlled_by_this_extension');
  }
  report.scenarios.push({name: hidden ? 'interrupted-stop-under-other-owner' : 'interrupted-stop',
    after: {proxyOwner: after.proxy.levelOfControl, rtcOwner: after.rtc.levelOfControl,
      predictionOwner: after.prediction.levelOfControl, alarm: after.alarm, phase: after.data.status.phase}});
}

try {
  const settings = await prepare();
  await launch(settings);
  await until(async () => (await snapshot()).data.status?.phase === 'off', 'initial off');
  await popup.evaluate(() => {
    window.phases = []; window.ports = [];
    chrome.storage.onChanged.addListener((c, area) => {
      if (area === 'local' && c.status) {
        window.phases.push(c.status.newValue.phase);
        window.ports.push(c.status.newValue.phase === 'connected' && c.status.newValue.proxy?.port);
      }
    });
  });
  if (earlyVerdict) {
    await recoverFromDefinitiveHttpFailure(settings);
  } else if (httpsDiagnosis) {
    await diagnoseProbeRequests();
  } else if (reserveDiagnostics) {
    await explainReserve();
  } else {
    if (!process.argv.includes('--stop-only')) {
      await ownership(settings, false);
      await ownership(settings, true);
      await rapidOwnership(settings);
      await withdrawDuringProbe(settings);
    }
    await interruptedStop(settings, false);
    await interruptedStop(settings, true);
  }
  report.result = 'PASS';
} catch (error) {
  report.error = error.stack || String(error);
  report.tunnels = tunnels; report.requests = requests;
  if (popup) report.lastState = await snapshot().catch(() => null);
} finally {
  if (browser) await browser.close();
  for (const {proxy, reset} of proxies) { reset(); await new Promise(resolve => proxy.close(resolve)); }
  if (origin) { resetOrigin(); await new Promise(resolve => origin.close(resolve)); }
  await fs.rm(run, {recursive: true, force: true});
}
const reportName = earlyVerdict ? 'early-verdict' : httpsDiagnosis ? 'https-diagnosis-lab' : reserveDiagnostics ? 'reserve-diagnostics' : 'route-truth';
const receipts = path.join(root, '.runtime', reportName);
await fs.mkdir(receipts, {recursive: true});
await fs.writeFile(path.join(receipts, 'latest.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (report.result !== 'PASS') process.exitCode = 1;
