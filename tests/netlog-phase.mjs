// Read DEFAULT-mode Chromium NetLog in the disposable profile. Only explicitly
// selected event names, numeric metadata and an enumerated protocol leave here.
import {canonicalControlUrl} from './https-probe-observer.mjs';
const origin = 'https://www.cloudflare.com/cdn-cgi/trace?t=';
const requestStart = 'URL_REQUEST_START_JOB';
const streamBinding = 'HTTP_STREAM_REQUEST_BOUND_TO_JOB';
const connectionBinding = 'SOCKET_POOL_BOUND_TO_CONNECT_JOB';
const socketLinks = new Set(['SOCKET_POOL_BOUND_TO_SOCKET', 'CONNECT_JOB_SET_SOCKET',
  'TRANSPORT_CONNECT_JOB_CONNECT_ATTEMPT', 'TCP_CONNECT_JOB_CONNECTOR_CONNECT_START']);
const sendHeaders = new Set(['HTTP_TRANSACTION_SEND_REQUEST_HEADERS', 'HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS']);
const retry = new Set(['HTTP_TRANSACTION_RESTART_AFTER_ERROR', 'HTTP_TRANSACTION_RESTART_MISDIRECTED_REQUEST',
  'URL_REQUEST_REDIRECTED', 'SSL_CONNECT_JOB_RESTART_WITH_ECH_CONFIG_LIST']);
const useful = new Set([requestStart, streamBinding, connectionBinding, ...socketLinks, ...sendHeaders, ...retry,
  'SOCKET_ALIVE', 'CONNECT_JOB_TIMED_OUT', 'HTTP_PROXY_CONNECT_JOB_CONNECT', 'HTTP_TRANSACTION_SEND_TUNNEL_HEADERS', 'HTTP_TRANSACTION_TUNNEL_SEND_REQUEST',
  'HTTP_TRANSACTION_TUNNEL_READ_HEADERS', 'HTTP_TRANSACTION_READ_TUNNEL_RESPONSE_HEADERS',
  'SSL_CONNECT', 'SSL_HANDSHAKE_ERROR', 'SSL_READ_ERROR', 'SSL_WRITE_ERROR',
  'SSL_HANDSHAKE_MESSAGE_SENT', 'SSL_HANDSHAKE_MESSAGE_RECEIVED', 'SSL_ALERT_RECEIVED',
  'TCP_CONNECT', 'TCP_CONNECT_ATTEMPT', 'SOCKS_CONNECT', 'SOCKS5_CONNECT',
  'HTTP_TRANSACTION_READ_HEADERS', 'HTTP_TRANSACTION_READ_RESPONSE_HEADERS', 'HTTP_TRANSACTION_READ_BODY',
  'REQUEST_ALIVE', 'FAILED']);
const connectJobTypes = new Set(['CONNECT_JOB','SSL_CONNECT_JOB','HTTP_PROXY_CONNECT_JOB','SOCKS_CONNECT_JOB','TRANSPORT_CONNECT_JOB','TCP_CONNECT_JOB']);
const schemes = new Set(['http','https','socks4','socks5']);
const tlsVersions = new Set(['TLS 1.0','TLS 1.1','TLS 1.2','TLS 1.3']);
const invert = table => new Map(Object.entries(table || {}).map(([name, value]) => [value, name]));
const unique = values => [...new Set(values)];
const negative = code => Number.isInteger(code) && code < 0;
const dependency = row => row.params?.source_dependency?.id;
const statusLine = headers => Array.isArray(headers) && typeof headers[0] === 'string'
  ? Number(/^HTTP\/\d+(?:\.\d+)? ([1-5]\d{2})(?:\s|$)/.exec(headers[0])?.[1]) || null : null;

// A typed link to the job that was actually assigned may only appear when
// the job finishes. Following all source_dependency edges would also reach
// speculative jobs, DNS lookups and other requests sharing the socket pool.
export function diagnoseNetLog(raw, {nonce, scheme, error} = {}) {
  const report = {stage:'unknown', reason:'invalid_input', requestSourceId:null, evidence:[]};
  const result = (stage, reason) => ({...report, stage, reason});
  if (!raw?.constants || !Array.isArray(raw.events) || !/^[1-9][0-9]{12}$/.test(String(nonce))
      || !schemes.has(scheme) || !/^net::ERR_[A-Z_0-9]+$/.test(error || '')) return report;
  const maps = raw.constants;
  const errorCode = maps.netError?.[error.slice(5)] ?? maps.netError?.[error];
  if (!negative(errorCode) || error === 'net::ERR_ABORTED') return result('unknown','unusable_error');
  const names = invert(maps.logEventTypes), types = invert(maps.logSourceType), phases = invert(maps.logEventPhase);
  const rows = [], bySource = new Map();
  for (const event of raw.events) {
    const name = names.get(event.type), id = event.source?.id;
    if (!useful.has(name) || !Number.isSafeInteger(id) || id <= 0) continue;
    const row = {name, id, type:types.get(event.source.type), phase:phases.get(event.phase),
      time:Number(event.time), params:event.params || {}, order:rows.length};
    if (!Number.isSafeInteger(row.time)) continue;
    rows.push(row);
    if (!bySource.has(id)) bySource.set(id, []);
    bySource.get(id).push(row);
  }
  const starts = rows.filter(r => r.name === requestStart && r.phase === 'PHASE_BEGIN' && r.type === 'URL_REQUEST'
    && r.params.method === 'GET' && canonicalControlUrl(r.params.url) === origin + nonce);
  if (starts.length !== 1) return result('unknown',starts.length ? 'ambiguous_request' : 'request_missing');
  const start = starts[0], request = bySource.get(start.id);
  report.requestSourceId = start.id;
  const end = request.find(r => r.name === requestStart && r.phase === 'PHASE_END' && r.params.net_error === errorCode)
    || request.find(r => r.name === 'REQUEST_ALIVE' && r.phase === 'PHASE_END' && r.params.net_error === errorCode);
  if (!end || end.order <= start.order) return result('unknown','terminal_error_unmatched');
  const within = rs => rs.filter(r => r.order >= start.order && r.order <= end.order);
  const interval = within(request);
  const chain = new Set([start.id]);
  const save = () => {
    const chosen = rows.filter(r => chain.has(r.id) && r.order >= start.order && r.order <= end.order
      && (r.name !== 'SOCKET_ALIVE' || r.phase === 'PHASE_BEGIN'));
    // Never hide a bounded tail containing the actual error.
    report.omittedEvents = Math.max(0,chosen.length - 64);
    const displayed = report.omittedEvents ? [...chosen.slice(0,32), ...chosen.slice(-32)] : chosen;
    report.evidence = displayed.map(r => {
      const item = {event:r.name, sourceId:r.id, ms:r.time-start.time,
        phase:({PHASE_BEGIN:'begin',PHASE_END:'end',PHASE_NONE:'none'})[r.phase]};
      if (negative(r.params.net_error)) item.netError = r.params.net_error;
      if ((socketLinks.has(r.name) || [streamBinding,connectionBinding,'SOCKET_ALIVE'].includes(r.name))
          && Number.isSafeInteger(dependency(r)) && chain.has(dependency(r))) item.dependency = dependency(r);
      if (r.name === 'HTTP_TRANSACTION_READ_TUNNEL_RESPONSE_HEADERS' || r.name === 'HTTP_TRANSACTION_READ_RESPONSE_HEADERS') {
        const status = statusLine(r.params.headers);
        if (status) item.status = status;
      }
      if (r.name === 'SSL_CONNECT' && tlsVersions.has(r.params.version)) item.version = r.params.version;
      if (r.name.startsWith('SSL_HANDSHAKE_MESSAGE_') && Number.isInteger(r.params.type)
        && r.params.type >= 0 && r.params.type <= 255) item.messageType = r.params.type;
      return item;
    });
  };
  const finish = (stage, reason) => { save(); return result(stage, reason); };
  if (interval.filter(r => r.name === requestStart && r.phase === 'PHASE_BEGIN').length !== 1
      || interval.some(r => retry.has(r.name))) return finish('unknown','request_retried');
  const links = (events, names, type) => unique(events.filter(r => names.has(r.name)
    && (typeof type === 'string' ? types.get(r.params?.source_dependency?.type) === type : type.has(types.get(r.params?.source_dependency?.type)))).map(dependency).filter(Number.isSafeInteger));
  const jobs = links(interval,new Set([streamBinding]),'HTTP_STREAM_JOB');
  if (jobs.length > 1) return finish('unknown','multiple_bound_jobs');
  const job = within(bySource.get(jobs[0]) || []);
  const connections = links(job,new Set([connectionBinding]),connectJobTypes);
  const sent = interval.some(r => sendHeaders.has(r.name));
  if (jobs.length) chain.add(jobs[0]);
  if (connections.length > 1) return finish('unknown','multiple_bound_connections');
  if (connections.length) chain.add(connections[0]);
  const connectJob = within(bySource.get(connections[0]) || []);
  const sockets = unique([...links([...job,...connectJob],socketLinks,'SOCKET'),
    ...rows.filter(r => connections.length && r.type === 'SOCKET' && r.name === 'SOCKET_ALIVE'
      && r.phase === 'PHASE_BEGIN' && r.order >= start.order && r.order <= end.order
      && dependency(r) === connections[0] && connectJobTypes.has(types.get(r.params?.source_dependency?.type))).map(r => r.id)]);
  for (const id of sockets) chain.add(id);
  // The final HTTP transaction can prove it sent origin headers even when
  // Chrome reused an H2 session and no socket establishment is captured.
  if (sent) return finish('after_tls','origin_request_headers_sent');
  if (!sockets.length) return finish('unknown','no_bound_socket');
  // A job-wide timer is unambiguous only on a single assigned socket.
  const checkTimeout = sockets.length === 1 && error === 'net::ERR_TIMED_OUT';
  const attempts = sockets.map(id => ({sourceId:id,
    ...socketPhase(within(bySource.get(id) || []), scheme, errorCode, connectJob, checkTimeout)}));
  report.socketAttempts = attempts.slice(0,8);
  if (attempts.length > 8) return finish('unknown','socket_attempt_limit');
  // Chromium can repeat an origin handshake on a second TCP socket. A single
  // phase is supported if every linked attempt independently demonstrates it.
  if (attempts.some(r => r.reason !== attempts[0].reason || r.stage !== attempts[0].stage))
    return finish('unknown','different_socket_outcomes');
  return finish(attempts[0].stage,attempts[0].reason);
}

// A timed-out composite CONNECT job also contains TCP and TLS work. Prove the
// specific outstanding operation when its timer fired from the socket events.
function awaitingTunnelResponse(socket, connect, connectJob, errorCode) {
  const timers = connectJob.filter(r => r.name === 'CONNECT_JOB_TIMED_OUT');
  const proxy = connectJob.filter(r => r.name === 'HTTP_PROXY_CONNECT_JOB_CONNECT');
  if (timers.length !== 1 || proxy.length !== 2) return false;
  const timer = timers[0], [begin,end] = proxy;
  if (begin.phase !== 'PHASE_BEGIN' || begin.order >= connect.order
      || end.phase !== 'PHASE_END' || end.order < timer.order || end.params.net_error !== errorCode) return false;
  const writes = socket.filter(r => r.name === 'HTTP_TRANSACTION_TUNNEL_SEND_REQUEST'
    && r.order > connect.order && r.phase === 'PHASE_END' && !negative(r.params.net_error));
  const reads = socket.filter(r => r.name === 'HTTP_TRANSACTION_TUNNEL_READ_HEADERS' && r.order > connect.order);
  return writes.length === 1 && reads.length === 1 && reads[0].phase === 'PHASE_BEGIN'
    && writes[0].order < reads[0].order && reads[0].order < timer.order;
}

function socketPhase(socket, scheme, errorCode, connectJob, checkTimeout) {
  const verdict = (stage,reason) => ({stage,reason});
  const connects = socket.filter(r => r.name === 'HTTP_TRANSACTION_SEND_TUNNEL_HEADERS');
  if (connects.length > 1) return verdict('unknown','tunnel_retried');
  const connect = connects[0];
  if (connect && !/^CONNECT www\.cloudflare\.com:443 HTTP\/1\.[01](?:\r\n)?$/.test(connect.params.line))
    return verdict('unknown','different_tunnel_authority');
  const isHttp = scheme === 'http' || scheme === 'https';
  if (!isHttp && connect) return verdict('unknown','unexpected_proxy_scheme');
  if (!isHttp && socket.some(r => ['SOCKS_CONNECT','SOCKS5_CONNECT'].includes(r.name)
      && r.phase === 'PHASE_END' && r.params.net_error === errorCode))
    return verdict('connect','socks_handshake_failed');
  const responses = socket.filter(r => r.name === 'HTTP_TRANSACTION_READ_TUNNEL_RESPONSE_HEADERS'
    && connect && r.order > connect.order);
  const status = responses.length === 1 ? statusLine(responses[0].params.headers) : null;
  const tunnelError = socket.find(r => ['HTTP_TRANSACTION_TUNNEL_READ_HEADERS', 'HTTP_TRANSACTION_TUNNEL_SEND_REQUEST'].includes(r.name)
    && r.phase === 'PHASE_END' && negative(r.params.net_error) && connect && r.order >= connect.order);
  const tls = socket.filter(r => r.name === 'SSL_CONNECT' && r.phase === 'PHASE_BEGIN');
  const inner = isHttp ? tls.filter(r => connect && status === 200 && r.order > responses[0].order) : tls;
  if (inner.length > 1) return verdict('unknown','tls_retried');
  if (inner.length === 1) {
    const tlsEnd = socket.find(r => r.name === 'SSL_CONNECT' && r.phase === 'PHASE_END' && r.order > inner[0].order);
    if (tlsEnd?.params.net_error === errorCode) return verdict('tls','origin_tls_handshake_failed');
    if (tlsEnd && !negative(tlsEnd.params.net_error) && tlsVersions.has(tlsEnd.params.version))
      return verdict('after_tls','origin_tls_negotiated');
    return verdict('unknown','inner_tls_end_unproven');
  }
  if (isHttp && connect && (tunnelError || (status !== null && status !== 200)))
    return verdict('connect',tunnelError ? 'tunnel_io_failed' : 'tunnel_rejected');
  if (isHttp && connect && checkTimeout && responses.length === 0 && !tls.some(r => r.order > connect.order)
      && awaitingTunnelResponse(socket, connect, connectJob, errorCode)) return verdict('connect','tunnel_response_timeout');
  if (!connect && scheme === 'https' && tls.length === 1) {
    const tlsEnd = socket.find(r => r.name === 'SSL_CONNECT' && r.phase === 'PHASE_END'
      && r.order > tls[0].order && r.params.net_error === errorCode);
    // A missing CONNECT on this socket alone is ambiguous, e.g. HTTP/2 proxy
    // tunnels can use a separate stream/session. Establish the outer handshake
    // was running while the connect job was establishing the proxy connection.
    const proxyJob = connectJob.filter(r => r.name === 'HTTP_PROXY_CONNECT_JOB_CONNECT');
    const active = proxyJob.findLast(r => r.order < tls[0].order);
    const completed = tlsEnd && proxyJob.find(r => r.order > tlsEnd.order);
    if (active?.phase === 'PHASE_BEGIN' && completed?.phase === 'PHASE_END' && negative(completed.params.net_error))
      return verdict('before_connect','proxy_tls_handshake_failed');
  }
  if (!connect && !tls.length && socket.some(r => r.name === 'TCP_CONNECT' && r.phase === 'PHASE_END'
      && r.params.net_error === errorCode)) return verdict('before_connect','proxy_tcp_connect_failed');
  return verdict('unknown','phase_unproven');
}
