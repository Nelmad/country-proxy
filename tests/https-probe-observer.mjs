// Test-only observer for the installed extension worker's two HTTPS controls.
// No headers, full URLs, IPs, response bodies or unrelated requests are retained.
const controls = new Map([
  ['https://www.cloudflare.com/cdn-cgi/trace', 'trace'],
  ['https://www.google.com/generate_204', 'target']
]);
const requestLimit = 512;
const finite = Number.isFinite;
const offsetNames = ['proxyStart','proxyEnd','dnsStart','dnsEnd','connectStart','connectEnd',
  'sslStart','sslEnd','sendStart','sendEnd','receiveHeadersStart','receiveHeadersEnd'];
const duration = value => typeof value === 'number' && finite(value) && value >= 0 && value <= 120000
  ? Math.round(value * 1000) / 1000 : null;

// CDP ResourceTiming offsets are milliseconds relative to requestTime (seconds).
// Connect includes TLS; these overlapping intervals must never be summed.
// https://chromedevtools.github.io/devtools-protocol/tot/Network/#type-ResourceTiming
export function resourceTiming(value) {
  if (!value || typeof value !== 'object') return null;
  const offsets = Object.fromEntries(offsetNames.map(name => [name,duration(value[name])]));
  const span = (a,b) => offsets[a] !== null && offsets[b] !== null
    ? duration(offsets[b]-offsets[a]) : null;
  return {offsetsMs:offsets, intervalsMs:{proxyResolution:span('proxyStart','proxyEnd'),
    dns:span('dnsStart','dnsEnd'),connect:span('connectStart','connectEnd'),tls:span('sslStart','sslEnd'),
    send:span('sendStart','sendEnd'),waitingForHeaders:span('sendEnd','receiveHeadersStart'),
    receivingHeaders:span('receiveHeadersStart','receiveHeadersEnd')}};
}

// Accept the gate capability only in its exact suffix position and discard it.
// Diagnostic correlation continues to use the timestamp and bounded ordinal.
export function canonicalControlUrl(value) {
  if (typeof value !== 'string') return null;
  for (const [url, endpoint] of controls) {
    const prefix = url + '?t=';
    if (!value.startsWith(prefix)) continue;
    const match = /^([1-9][0-9]{12})(?:&attempt=(2))?(?:&gate=[a-f0-9]{32})?$/.exec(value.slice(prefix.length));
    if (match) return prefix + match[1] + (match[2] ? '&attempt=2' : '');
  }
  return null;
}

function control(request) {
  if (request?.method !== 'GET') return null;
  const url = canonicalControlUrl(request.url);
  if (!url) return null;
  const parsed = new URL(url);
  return {endpoint: controls.get(parsed.origin + parsed.pathname),
    nonce: Number(parsed.searchParams.get('t')), ordinal: parsed.searchParams.has('attempt') ? 2 : 1};
}

function httpStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function enumValue(value) {
  return typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,80}$/.test(value) ? value : null;
}

// Only the primary and one explicit bounded hedge are valid. Legacy fixtures omit ordinal.
export function requestOrdinal(row) { return row.ordinal === undefined ? 1 : [1,2].includes(row.ordinal) ? row.ordinal : null; }
export function uniqueProbeAttempts(rows) {
  return rows.length <= 4 && rows.every(row => ['trace','target'].includes(row.endpoint) && requestOrdinal(row) !== null) &&
    new Set(rows.map(row=>row.endpoint+':'+requestOrdinal(row))).size === rows.length;
}

// Returns one request group, never the nearest arbitrary Network.loadingFailed.
export function joinProbeRequests(snapshot, {verifyingAt, checkedAt, latencyMs}) {
  const none = {attribution: 'unobserved', nonce: null, requests: []};
  if (!finite(verifyingAt) || !finite(checkedAt) || checkedAt < verifyingAt) return none;
  const groups = new Map();
  for (const row of snapshot.requests) {
    if (row.nonce < verifyingAt || row.nonce > checkedAt) continue;
    if (!groups.has(row.nonce)) groups.set(row.nonce, []);
    groups.get(row.nonce).push(row);
  }
  // probe.js samples latency and checkedAt in two consecutive Date.now() calls.
  // A lone timestamp in the interval suffices only when the timing evidence agrees.
  if (!finite(latencyMs) || latencyMs < 0) return none;
  const start = checkedAt - latencyMs;
  const matches = [...groups].filter(([nonce]) => start - nonce >= 0 && start - nonce <= 1);
  const ambiguous = {attribution: 'ambiguous', nonce: null, requests: []};
  if (matches.length !== 1) return matches.length || groups.size > 1 ? ambiguous : none;
  const [nonce, requests] = matches[0];
  if (!uniqueProbeAttempts(requests)) return ambiguous;
  return {attribution: 'matched', nonce, requests};
}

export async function attachProbeObserver(context, workerUrl) {
  if (!/^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(workerUrl)) {
    throw Error('Expected the installed test extension worker URL');
  }
  const cdp = await context.browser().newBrowserCDPSession();
  const pending = new Map(), active = new Map(), requests = [];
  let sequence = 0;
  let sessionId, available = false, limited = false, closed = false;

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error('Worker CDP command timed out: ' + method));
      }, 5000);
      pending.set(id, {timer, resolve, reject});
      cdp.send('Target.sendMessageToTarget', {sessionId, message: JSON.stringify({id, method, params})})
        .catch(() => {
          if (pending.delete(id)) {
            clearTimeout(timer);
            reject(Error('Worker CDP command delivery failed: ' + method));
          }
        });
    });
  }

  function onMessage(event) {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    if (message.id) {
      const command = pending.get(message.id);
      if (command) {
        pending.delete(message.id);
        clearTimeout(command.timer);
        if (message.error) command.reject(Error('Worker CDP command rejected'));
        else command.resolve(message.result);
      }
      return;
    }
    if (!message.method?.startsWith('Network.')) return;
    const p = message.params;
    const live = active.get(p.requestId);
    if (message.method === 'Network.requestWillBeSent') {
      if (live && p.redirectResponse) {
        live.row.outcome = 'redirected';
        live.row.httpStatus = httpStatus(p.redirectResponse.status);
        if (finite(p.timestamp)) live.row.elapsedMs = Math.round((p.timestamp-live.start) * 1000);
        active.delete(p.requestId);
        return;
      }
      const matched = control(p.request);
      if (!matched || typeof p.requestId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(p.requestId)) return;
      if (requests.length >= requestLimit) { limited = true; return; }
      const row = {...matched, requestId: p.requestId, method: 'GET',
        startWallMs: finite(p.wallTime) ? Math.round(p.wallTime * 1000) : null,
        elapsedMs: null, outcome: 'pending', httpStatus: null, error: null,
        canceled: false, blockedReason: null, corsError: null,
        headersElapsedMs:null, timing:null, connectionReused:null, protocol:null};
      active.set(p.requestId, {start: p.timestamp, row});
      requests.push(row);
      return;
    }
    if (!live) return;
    const {row, start} = live;
    if (message.method === 'Network.responseReceived') {
      row.httpStatus = httpStatus(p.response?.status);
      row.outcome = 'headers';
      row.headersElapsedMs = finite(start) && finite(p.timestamp) ? duration((p.timestamp-start)*1000) : null;
      row.timing = resourceTiming(p.response?.timing);
      row.connectionReused = typeof p.response?.connectionReused === 'boolean' ? p.response.connectionReused : null;
      row.protocol = ['http/1.0','http/1.1','h2','h3'].includes(p.response?.protocol) ? p.response.protocol : null;
    } else if (message.method === 'Network.loadingFinished') {
      row.outcome = 'completed';
      active.delete(p.requestId);
    } else if (message.method === 'Network.loadingFailed') {
      row.error = typeof p.errorText === 'string' ? p.errorText.match(/^net::ERR_[A-Z0-9_]+\b/)?.[0] || null : null;
      row.canceled = p.canceled === true;
      row.outcome = row.canceled || row.error === 'net::ERR_ABORTED' ? 'cancelled' : 'failed';
      row.blockedReason = enumValue(p.blockedReason);
      row.corsError = enumValue(p.corsErrorStatus?.corsError);
      active.delete(p.requestId);
    } else return;
    if (finite(start) && finite(p.timestamp)) row.elapsedMs = Math.round((p.timestamp-start) * 1000);
  }

  function onDetach(event) {
    if (event.sessionId !== sessionId) return;
    available = false;
    for (const {timer, reject} of pending.values()) {
      clearTimeout(timer);
      reject(Error('Worker CDP target detached'));
    }
    pending.clear();
  }

  async function close() {
    if (closed) return;
    closed = true;
    if (sessionId) {
      onDetach({sessionId});
      await cdp.send('Target.detachFromTarget', {sessionId}).catch(() => {});
    }
    cdp.off('Target.receivedMessageFromTarget', onMessage);
    cdp.off('Target.detachedFromTarget', onDetach);
    await cdp.detach().catch(() => {});
  }

  try {
    const {targetInfos} = await cdp.send('Target.getTargets');
    const targets = targetInfos.filter(t => t.type === 'service_worker' && t.url === workerUrl);
    if (targets.length !== 1) throw Error('Expected one matching service worker in isolated Chrome');
    ({sessionId} = await cdp.send('Target.attachToTarget', {targetId: targets[0].targetId, flatten: false}));
    cdp.on('Target.receivedMessageFromTarget', onMessage);
    cdp.on('Target.detachedFromTarget', onDetach);
    await send('Network.enable', {maxPostDataSize: 0});
    available = true;
    return {snapshot: () => ({available, limited, requests: requests.map(row => ({...row}))}), close};
  } catch (error) {
    await close();
    throw error;
  }
}
