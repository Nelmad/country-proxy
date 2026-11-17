// Local protocol oracle for the sanitized NetLog classifier, using one fresh profile per fault.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash, createPublicKey} from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {attachProbeObserver} from './https-probe-observer.mjs';

const root = path.resolve(import.meta.dirname, '..');
const host = 'www.cloudflare.com';
const loopback = '127.0.0.1';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, loopback, () => resolve(server.address().port));
  });
}
function trackConnections(server) {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  return () => new Promise(resolve => {
    for (const socket of sockets) socket.destroy();
    server.close(resolve);
  });
}

async function scenario(chromium, directory, expected, credentials, spki, diagnose) {
  const nonce = Date.now();
  const route = '/cdn-cgi/trace?t=' + nonce;
  const oracle = {connect: 0, clientHello: 0, originGet: 0};
  // The only upstream dial is the loopback origin below.
  const origin = https.createServer(credentials, (request, response) => {
    if (request.method !== 'GET' || request.url !== route || request.headers.host !== host) {
      response.writeHead(404).end();
      return;
    }
    oracle.originGet++;
    request.socket.end();
  });
  const proxy = http.createServer((_request, response) => response.writeHead(403).end());
  const closeOrigin = trackConnections(origin), closeProxy = trackConnections(proxy);
  let chrome, observer;
  try {
    const originPort = await listen(origin);
    proxy.on('connect', (request, client, head) => {
      if (request.url !== host + ':443') {
        client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      oracle.connect++;
      if (expected === 'connect') {
        client.end();
        return;
      }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (expected === 'tls') {
        let prefix = head.subarray(0, 6);
        const inspectHello = bytes => {
          // The socket can split the five-byte TLS record header across reads.
          prefix = Buffer.concat([prefix, bytes.subarray(0, 6 - prefix.length)]);
          if (prefix.length < 6) return;
          client.off('data', inspectHello);
          if (prefix[0] === 22 && prefix[5] === 1) oracle.clientHello++;
          client.end();
        };
        client.on('data', inspectHello);
        inspectHello(Buffer.alloc(0));
        return;
      }
      const upstream = net.connect(originPort, loopback, () => {
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
    });
    const proxyPort = await listen(proxy);
    const rawFile = path.join(directory, expected + '.json');
    const extension = path.join(root, 'extension');
    const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'));
    const extensionId = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)
      .replace(/[0-9a-f]/g, c => String.fromCharCode(97 + Number.parseInt(c, 16)));
    const workerUrl = 'chrome-extension://' + extensionId + '/background.js';
    chrome = await chromium.launchPersistentContext(path.join(directory, expected + '-profile'), {
      headless: true, channel: 'chromium', timeout: 20000, ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--disable-background-networking', '--disable-quic', '--disable-extensions-except=' + extension,
        '--load-extension=' + extension, '--proxy-server=http://' + loopback + ':' + proxyPort,
        '--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE 127.0.0.1',
        '--ignore-certificate-errors-spki-list=' + spki, '--log-net-log=' + rawFile]
    });
    const browser = chrome.browser().version();
    const predicate = worker => worker.url() === workerUrl;
    const worker = chrome.serviceWorkers().find(predicate) ||
      await chrome.waitForEvent('serviceworker', {predicate, timeout: 10000});
    observer = await attachProbeObserver(chrome, workerUrl);
    await worker.evaluate(async url => {
      try {
        const response = await fetch(url, {cache: 'no-store', credentials: 'omit', redirect: 'error',
          signal: AbortSignal.timeout(10000)});
        await response.arrayBuffer();
      } catch { /* The failure is recorded independently in CDP and NetLog. */ }
    }, 'https://' + host + route);
    let row;
    for (let i = 0; i < 50 && !row; i++) {
      row = observer.snapshot().requests.find(r => r.nonce === nonce && r.endpoint === 'trace' && r.outcome === 'failed');
      if (!row) await delay(20);
    }
    assert.ok(row?.error, 'Expected a CDP failure for the exact Cloudflare fixture URL');
    assert.ok(oracle.connect >= 1);
    if (expected === 'tls') assert.ok(oracle.clientHello >= 1, 'Expected TLS ClientHello before the fixture closed');
    if (expected === 'after_tls') assert.ok(oracle.originGet >= 1, 'Expected a decrypted GET before the fixture closed');
    await observer.close();
    observer = null;
    await chrome.close();
    chrome = null;
    const raw = JSON.parse(await fs.readFile(rawFile, 'utf8'));
    const result = diagnose(raw, {nonce, scheme: 'http', error: row.error});
    return {expected, browser, oracle, error: row.error, result};
  } finally {
    try {
      if (observer) await observer.close();
    } finally {
      try {
        if (chrome) await chrome.close();
      } finally {
        await Promise.all([closeOrigin(), closeProxy()]);
      }
    }
  }
}

export async function runNetlogLab(diagnose) {
  const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'netlog-phase-lab-'));
  try {
    const key = path.join(directory, 'test.key'), cert = path.join(directory, 'test.crt');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=' + host, '-addext', 'subjectAltName=DNS:' + host, '-keyout', key, '-out', cert], {stdio: 'ignore'});
    const credentials = {key: await fs.readFile(key), cert: await fs.readFile(cert)};
    const spki = createHash('sha256').update(createPublicKey(credentials.key).export({type: 'spki', format: 'der'})).digest('base64');
    const cases = [];
    for (const expected of ['connect', 'tls', 'after_tls']) {
      cases.push(await scenario(chromium, directory, expected, credentials, spki, diagnose));
    }
    return cases;
  } finally {
    await fs.rm(directory, {recursive: true, force: true});
    await assert.rejects(fs.access(directory), {code: 'ENOENT'});
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const {diagnoseNetLog} = await import('./netlog-phase.mjs');
  const {projectNetLog} = await import('./netlog-projection.mjs');
  const cases = await runNetlogLab((raw, query) => {
    const original = diagnoseNetLog(raw, query);
    const saved = JSON.parse(JSON.stringify(projectNetLog(raw, [query.nonce])));
    const projected = diagnoseNetLog(saved, query);
    assert.deepEqual(projected, original, 'Saved projection must preserve the full diagnosis');
    return projected;
  });
  const passed = cases.every(c => c.result.stage === c.expected);
  const directory = path.join(root, '.runtime');
  await fs.mkdir(directory, {recursive: true});
  const out = await fs.mkdtemp(path.join(directory, 'netlog-lab-'));
  const file = path.join(out, 'observations.json');
  await fs.writeFile(file, JSON.stringify({passed, profileRemoved: true, projectionRoundTrip: true, cases}, null, 2) + '\n', {mode: 0o600});
  console.log(file);
  assert.ok(passed, 'NetLog diagnosis must agree with all three independent fixture events');
}
