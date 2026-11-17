// Keep a small replayable slice of a disposable NetLog. The raw log can include
// arbitrary network-controlled strings, even in DEFAULT mode. Never spread it.
import {canonicalControlUrl} from './https-probe-observer.mjs';
const tracePrefix = 'https://www.cloudflare.com/cdn-cgi/trace?t=';
const maxInput = 500000, maxWindow = 30000, maxOutput = 12000;
const maxSources = 1024, maxRequests = 8;
const phases = new Set(['PHASE_BEGIN','PHASE_END','PHASE_NONE']);
const tlsVersions = new Set(['TLS 1.0','TLS 1.1','TLS 1.2','TLS 1.3']);
const enumName = /^[A-Z][A-Z0-9_]{0,95}$/;
const errorName = /^(?:net::)?ERR_[A-Z0-9_]{1,90}$/;
const numericId = value => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;
const empty = () => ({constants:{logEventTypes:{},logSourceType:{},logEventPhase:{},netError:{}},events:[]});

function enumMap(table, allowed, min, max) {
  const out = new Map();
  if (!table || typeof table !== 'object' || Array.isArray(table)) return out;
  const entries = Object.entries(table);
  if (entries.length > 4096) return out;
  for (const [key,num] of entries) {
    if (allowed(key) && Number.isInteger(num) && num >= min && num <= max) out.set(num,key);
  }
  return out;
}

function projectParams(event, name, requested, types) {
  const input = event.params || {}, params = {};
  if (Number.isInteger(input.net_error) && input.net_error >= -65535 && input.net_error <= 0) {
    params.net_error = input.net_error;
  }
  const dep = input.source_dependency;
  if (numericId(dep?.id) && types.has(dep.type)) params.source_dependency = {id:dep.id,type:dep.type};
  if (name === 'URL_REQUEST_START_JOB' && input.method === 'GET' && requested.has(canonicalControlUrl(input.url))) {
    params.method = 'GET';
    params.url = canonicalControlUrl(input.url);
  }
  if (name === 'HTTP_TRANSACTION_SEND_TUNNEL_HEADERS') {
    params.line = typeof input.line === 'string' && /^CONNECT www\.cloudflare\.com:443 HTTP\/1\.[01](?:\r\n)?$/.test(input.line)
      ? 'CONNECT www.cloudflare.com:443 HTTP/1.1\r\n' : 'other';
  }
  if (name === 'HTTP_TRANSACTION_READ_TUNNEL_RESPONSE_HEADERS' || name === 'HTTP_TRANSACTION_READ_RESPONSE_HEADERS') {
    const first = Array.isArray(input.headers) ? input.headers[0] : null;
    const status = typeof first === 'string' && /^HTTP\/\d+(?:\.\d+)? ([1-5]\d{2})(?:\s|$)/.exec(first)?.[1];
    if (status) params.headers = ['HTTP/1.1 '+status+' Redacted'];
  }
  if (name === 'SSL_CONNECT' && tlsVersions.has(input.version)) params.version = input.version;
  if ((name === 'SSL_HANDSHAKE_MESSAGE_SENT' || name === 'SSL_HANDSHAKE_MESSAGE_RECEIVED')
      && Number.isInteger(input.type) && input.type >= 0 && input.type <= 255) params.type = input.type;
  return params;
}

// Call only with nonces already attributed to addressed rejects by the CDP
// observer. A duplicate start, aborted request or unfinished window is omitted.
export function projectNetLog(raw, nonces) {
  const result = empty();
  if (!raw?.constants || !Array.isArray(raw.events) || raw.events.length > maxInput
      || !(Array.isArray(nonces) || nonces instanceof Set)) return result;
  const requested = new Set();
  for (const nonce of nonces) {
    if (requested.size >= maxRequests || !Number.isSafeInteger(nonce) || !/^[1-9][0-9]{12}$/.test(String(nonce))) return result;
    requested.add(tracePrefix+nonce);
  }
  if (!requested.size) return result;
  const {logEventTypes,logSourceType,logEventPhase,netError} = raw.constants;
  const events = enumMap(logEventTypes,s=>enumName.test(s),0,65535);
  const types = enumMap(logSourceType,s=>enumName.test(s),0,65535);
  const phase = enumMap(logEventPhase,s=>phases.has(s),0,16);
  const errors = enumMap(netError,s=>errorName.test(s),-65535,-1);
  const starts = new Map();
  for (const [i,e] of raw.events.entries()) {
    if (events.get(e?.type) !== 'URL_REQUEST_START_JOB' || phase.get(e.phase) !== 'PHASE_BEGIN'
        || types.get(e.source?.type) !== 'URL_REQUEST' || !numericId(e.source.id)
        || e.params?.method !== 'GET' || !requested.has(canonicalControlUrl(e.params.url))) continue;
    const url = canonicalControlUrl(e.params.url);
    starts.set(url, starts.has(url) ? null : i);
  }

  const selected = new Set();
  for (const start of starts.values()) {
    if (start === null) continue;
    const root = raw.events[start].source, from = Number(raw.events[start].time);
    if (!Number.isSafeInteger(from)) continue;
    let end = -1;
    for (let i = start+1; i < Math.min(start+maxWindow,raw.events.length); i++) {
      const e = raw.events[i];
      if (e?.source?.id !== root.id || e.source.type !== root.type) continue;
      const name = events.get(e.type);
      if (name !== 'REQUEST_ALIVE' && name !== 'URL_REQUEST_START_JOB') continue;
      if (name === 'URL_REQUEST_START_JOB' && phase.get(e.phase) === 'PHASE_BEGIN') break;
      if (phase.get(e.phase) !== 'PHASE_END') continue;
      const code = e.params?.net_error;
      if (Number.isInteger(code) && code < 0 && code !== -3 && errors.has(code)) { end = i; break; }
      if (Number.isInteger(code) && code < 0) break;
      // URL_REQUEST_START_JOB can succeed when headers arrive and the request
      // can subsequently fail while reading the response body.
    }
    if (end < 0) continue;
    const until = Number(raw.events[end].time);
    if (!Number.isSafeInteger(until) || until < from || until-from > 60000) continue;

    const graph = new Map(), rows = [];
    const addEdge = (a,b) => {
      if (!graph.has(a)) graph.set(a,new Set());
      graph.get(a).add(b);
    };
    for (let i=start; i<=end; i++) {
      const e = raw.events[i], s = e?.source, d = e?.params?.source_dependency;
      if (!numericId(s?.id) || !types.has(s.type) || !events.has(e.type) || !phase.has(e.phase)
          || (types.get(s.type) === 'URL_REQUEST' && s.id !== root.id)) continue;
      rows.push(i);
      if (!numericId(d?.id) || !types.has(d.type) || (types.get(d.type) === 'URL_REQUEST' && d.id !== root.id)) continue;
      addEdge(s.id,d.id);
      addEdge(d.id,s.id);
    }
    const connected = new Set([root.id]);
    for (const id of connected) {
      for (const dep of graph.get(id) || []) connected.add(dep);
      if (connected.size > maxSources) return empty();
    }
    for (const i of rows) {
      if (connected.has(raw.events[i].source.id)) selected.add(i);
      if (selected.size > maxOutput) return empty();
    }
  }

  for (const i of [...selected].sort((a,b)=>a-b)) {
    const e = raw.events[i], name = events.get(e.type), time = Number(e.time);
    if (!Number.isSafeInteger(time) || time < 0) continue;
    const params = projectParams(e,name,requested,types);
    const constants = result.constants;
    constants.logEventTypes[name] = e.type;
    constants.logSourceType[types.get(e.source.type)] = e.source.type;
    constants.logEventPhase[phase.get(e.phase)] = e.phase;
    if (params.source_dependency) constants.logSourceType[types.get(params.source_dependency.type)] = params.source_dependency.type;
    if (errors.has(params.net_error)) constants.netError[errors.get(params.net_error)] = params.net_error;
    result.events.push({time:String(time),source:{id:e.source.id,type:e.source.type},type:e.type,phase:e.phase,params});
  }
  return result;
}
