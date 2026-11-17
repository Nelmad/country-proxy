// Browser verification uses the same two HTTPS origins as the native checker.
// Keep this independent of chrome.* so failures can be checked without a live proxy.
const TRACE = 'https://www.cloudflare.com/cdn-cgi/trace';
const TARGET = 'https://www.google.com/generate_204';
function validIp(value) {
  if (typeof value !== 'string' || !value) return false;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) {
    return value.split('.').every(part => Number(part) <= 255 && String(Number(part)) === part);
  }
  if (!/^[\da-f:]+$/i.test(value) || !value.includes(':')) return false;
  try { return new URL(`http://[${value}]/`).hostname.startsWith('['); } catch { return false; }
}
export async function probeBrowser(country, signal, {fetcher = fetch, timeoutMs = 50000, hedgeDelayMs = 5000} = {}) {
  const started = Date.now();
  const timeout = AbortSignal.timeout(timeoutMs);
  const cleanup = new AbortController();
  const combined = AbortSignal.any([signal, timeout, cleanup.signal]);
  const query = '?t=' + started;
  const outcome = values => ({...values, latencyMs: Date.now() - started, checkedAt: Date.now()});
  const statuses = {};
  const verifiedRequests = {};
  function request(url, endpoint, expected) {
    return new Promise((resolve, reject) => {
      let settled = false, timer;
      const owners = [];
      const abortReason = () => signal.aborted ? 'cancelled' : timeout.aborted ? 'timeout' : 'cancelled';
      function finish(value, failure, attempt) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        combined.removeEventListener('abort', aborted);
        // Cancel unneeded requests before the controller can change routes.
        for (const owner of owners) owner.abort();
        if (failure) reject(failure);
        else { verifiedRequests[endpoint] = attempt; resolve(value); }
      }
      function aborted() { finish(null, {reason: abortReason(), endpoint}); }
      async function launch(attempt) {
        if (settled || combined.aborted) return;
        const owner = new AbortController();
        owners.push(owner);
        const requestSignal = AbortSignal.any([combined, owner.signal]);
        let response, body;
        try {
          response = await fetcher(url + query + (attempt === 2 ? '&attempt=2' : ''),
            {signal: requestSignal, cache: 'no-store', credentials: 'omit', redirect: 'error'});
          if (settled || combined.aborted) return;
          statuses[endpoint] = response.status;
          if (response.status !== expected) throw {reason: 'http', endpoint, statuses: {...statuses}};
          if (endpoint === 'trace') {
            body = await response.text();
            if (settled || combined.aborted) return;
            if (body.length > 16384) throw {reason: 'invalid_trace', endpoint};
            const data = Object.fromEntries(body.trim().split('\n').filter(line => line.includes('='))
              .map(line => { const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)]; }));
            if (!/^[A-Z]{2}$/.test(data.loc || '') || !validIp(data.ip)) throw {reason: 'invalid_trace', endpoint};
            if (!(Array.isArray(country) ? country : [country]).includes(data.loc)) {
              throw {reason: 'country', endpoint, country: data.loc, exitIp: data.ip};
            }
            finish({country: data.loc, exitIp: data.ip}, null, attempt);
          } else finish(undefined, null, attempt);
        } catch (error) {
          if (settled) return;
          const semantic = ['country', 'invalid_trace', 'http'].includes(error?.reason);
          const failure = semantic ? error : {reason: combined.aborted ? abortReason()
            : error?.name === 'TimeoutError' ? 'timeout' : 'transport', endpoint};
          // Preserve the original fast-failure rule. An optional connection
          // failing alone must not reject a still-working primary request.
          if (attempt === 1 || semantic || combined.aborted) finish(null, failure);
        }
      }
      if (combined.aborted) { aborted(); return; }
      combined.addEventListener('abort', aborted, {once: true});
      // One extra attempt for a pending origin; never renew the shared deadline.
      if (Number.isFinite(hedgeDelayMs) && hedgeDelayMs >= 0 && hedgeDelayMs < timeoutMs) {
        timer = setTimeout(() => { void launch(2); }, hedgeDelayMs);
      }
      void launch(1);
    });
  }
  try {
    const [trace] = await Promise.all([request(TRACE, 'trace', 200), request(TARGET, 'target', 204)]);
    if (combined.aborted) return outcome({ok: false, reason: signal.aborted ? 'cancelled' : 'timeout'});
    return outcome({ok: true, ...trace, verifiedRequests: {...verifiedRequests}});
  } catch (failure) {
    return outcome({ok: false, ...failure});
  } finally {
    // Promise.all may reject while the other request is still in flight.
    cleanup.abort();
  }
}
