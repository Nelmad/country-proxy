import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnoseNetLog} from './netlog-phase.mjs';

const nonce = 1794500000000;
const trace = 'https://www.cloudflare.com/cdn-cgi/trace?t='+nonce;
const rejected = {nonce,scheme:'http',error:'net::ERR_CONNECTION_CLOSED'};
const closed = {net_error:-100};

function fixture() {
  const log = {constants:{logEventTypes:{},logSourceType:{URL_REQUEST:1,HTTP_STREAM_JOB:2,CONNECT_JOB:3,SOCKET:4},
    logEventPhase:{PHASE_NONE:0,PHASE_BEGIN:1,PHASE_END:2},
    netError:{ERR_CONNECTION_CLOSED:-100,ERR_TUNNEL_CONNECTION_FAILED:-111}},events:[]};
  const ids = {request:1,job:2,connection:3,socket:4};
  const source = id => ({id,type:id % 10 || 1});
  const add = (id,name,phase,params={}) => {
    const enums = log.constants.logEventTypes;
    enums[name] ??= Object.keys(enums).length;
    log.events.push({time:String(123+log.events.length),source:source(id),type:enums[name],phase,params});
  };
  const start = (base=0,url=trace) => add(base+ids.request,'URL_REQUEST_START_JOB',1,{url,method:'GET'});
  const link = (base=0) => {
    add(base+ids.connection,'CONNECT_JOB_SET_SOCKET',0,{source_dependency:source(base+ids.socket)});
    add(base+ids.job,'SOCKET_POOL_BOUND_TO_CONNECT_JOB',0,{source_dependency:source(base+ids.connection)});
    add(base+ids.request,'HTTP_STREAM_REQUEST_BOUND_TO_JOB',0,{source_dependency:source(base+ids.job)});
  };
  const tunnel = (socket=ids.socket, host='www.cloudflare.com') => {
    add(socket,'HTTP_TRANSACTION_SEND_TUNNEL_HEADERS',0,{line:'CONNECT '+host+':443 HTTP/1.1\r\n',headers:['Cookie: secret_cookie']});
    add(socket,'HTTP_TRANSACTION_TUNNEL_READ_HEADERS',1);
  };
  const status = (value,socket=ids.socket) => {
    add(socket,'HTTP_TRANSACTION_TUNNEL_READ_HEADERS',2);
    add(socket,'HTTP_TRANSACTION_READ_TUNNEL_RESPONSE_HEADERS',0,{headers:['HTTP/1.1 '+value+' secret_reason','Cookie: secret_cookie']});
  };
  const end = (base=0,code=-100) => add(base+ids.request,'URL_REQUEST_START_JOB',2,{net_error:code});
  return {log,add,start,link,tunnel,status,end};
}

test('joins only assigned sources even when a concurrent Google job negotiates TLS', () => {
  const f = fixture();
  f.start(); f.start(10,'https://www.google.com/generate_204?t='+nonce);
  f.tunnel(); f.tunnel(14,'www.google.com'); f.status(200,14);
  f.add(14,'SSL_CONNECT',1); f.add(14,'SSL_CONNECT',2,{version:'TLS 1.3'}); f.link(10); f.end(10,-3);
  f.add(4,'HTTP_TRANSACTION_TUNNEL_READ_HEADERS',2,closed); f.link(); f.end();
  const report = diagnoseNetLog(f.log,rejected);
  assert.equal(report.stage,'connect'); assert.equal(report.reason,'tunnel_io_failed');
  assert.deepEqual(new Set(report.evidence.map(r=>r.sourceId)),new Set([1,2,3,4]));
  assert.doesNotMatch(JSON.stringify(report),/https?:|secret|Cookie:|www\./);
  const gated = structuredClone(f.log);
  const marker = 'e'.repeat(32);
  gated.events[0].params.url += '&gate='+marker;
  const gatedReport = diagnoseNetLog(gated,rejected);
  assert.equal(gatedReport.stage,'connect');
  assert.equal(gatedReport.reason,'tunnel_io_failed');
  assert.doesNotMatch(JSON.stringify(gatedReport),new RegExp(marker));
  gated.events[0].params.url += '&unexpected=1';
  assert.equal(diagnoseNetLog(gated,rejected).stage,'unknown');
});

test('CONNECT 200 then ClientHello then SSL_CONNECT error is an origin handshake failure',() => {
  const f = fixture(); f.start(); f.tunnel(); f.status(200);
  f.add(4,'SSL_CONNECT',1); f.add(4,'SSL_HANDSHAKE_MESSAGE_SENT',0,{type:1,bytes:'secret'}); f.add(4,'SSL_CONNECT',2,closed);
  f.link(); f.end();
  const r = diagnoseNetLog(f.log,rejected); assert.equal(r.stage,'tls');
  assert.deepEqual(r.evidence.filter(e=>e.status || e.messageType).map(e=>e.status || e.messageType),[200,1]);
  assert.doesNotMatch(JSON.stringify(r),/secret/);
});

test('successful inner handshake followed by read error is after TLS, including reused origin streams',() => {
  const f = fixture(); f.start(); f.tunnel(); f.status(200); f.add(4,'SSL_CONNECT',1); f.add(4,'SSL_CONNECT',2,{version:'TLS 1.3'});
  f.add(4,'SSL_READ_ERROR',0,closed); f.link(); f.end();
  assert.equal(diagnoseNetLog(f.log,rejected).stage,'after_tls');
  const reused = fixture(); reused.start();
  reused.add(1,'HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS',0,{headers:[':path: secret']}); reused.end();
  assert.equal(diagnoseNetLog(reused.log,rejected).reason,'origin_request_headers_sent');
});

test('outer TLS failures have a distinct phase, parsed headers alone never prove a working tunnel',() => {
  const f = fixture(); f.start(); f.add(3,'HTTP_PROXY_CONNECT_JOB_CONNECT',1);
  f.add(4,'SSL_CONNECT',1); f.add(4,'SSL_CONNECT',2,closed);
  f.add(3,'HTTP_PROXY_CONNECT_JOB_CONNECT',2,closed); f.link(); f.end();
  assert.equal(diagnoseNetLog(f.log,{...rejected,scheme:'https'}).reason,'proxy_tls_handshake_failed');
  const ambiguous = fixture(); ambiguous.start(); ambiguous.add(4,'SSL_CONNECT',1);
  ambiguous.add(4,'SSL_CONNECT',2,closed); ambiguous.link(); ambiguous.end();
  assert.equal(diagnoseNetLog(ambiguous.log,{...rejected,scheme:'https'}).stage,'unknown');
  const g = fixture(); g.start(); g.tunnel(); g.add(4,'HTTP_TRANSACTION_TUNNEL_READ_HEADERS',2); g.link(); g.end();
  assert.equal(diagnoseNetLog(g.log,rejected).stage,'unknown');
  const h = fixture(); h.start(); h.tunnel(); h.status(502); h.link(); h.end(0,-111);
  assert.equal(diagnoseNetLog(h.log,{...rejected,error:'net::ERR_TUNNEL_CONNECTION_FAILED'}).reason,'tunnel_rejected');
});

test('retries, unbound sockets, a mismatched terminal error and duplicate nonces stay unassigned',() => {
  for (const bad of ['retry','unbound','mismatch','duplicate','multipleSockets']) {
    const f = fixture(); f.start(); f.tunnel(); f.status(200); f.add(4,'SSL_CONNECT',1); f.add(4,'SSL_CONNECT',2,closed);
    if (bad==='retry') f.add(1,'HTTP_TRANSACTION_RESTART_AFTER_ERROR',0,closed);
    if (bad==='duplicate') f.start(10);
    if (bad!=='unbound') f.link();
    if (bad==='multipleSockets') f.add(3,'TRANSPORT_CONNECT_JOB_CONNECT_ATTEMPT',0,{source_dependency:{id:14,type:4}});
    f.end(0,bad==='mismatch' ? -3 : -100);
    assert.equal(diagnoseNetLog(f.log,rejected).stage,'unknown',bad);
  }
});

test('two sockets assigned to an SSL_CONNECT_JOB can independently prove the same TLS failure',() => {
  const f = fixture(); f.log.constants.logSourceType.SSL_CONNECT_JOB = 3;
  delete f.log.constants.logSourceType.CONNECT_JOB; f.start();
  for (const id of [4,14]) {
    f.add(3,'TRANSPORT_CONNECT_JOB_CONNECT_ATTEMPT',0,{source_dependency:{id,type:4}});
    f.tunnel(id); f.status(200,id); f.add(id,'SSL_CONNECT',1); f.add(id,'SSL_CONNECT',2,closed);
  }
  f.link(); f.end();
  const r = diagnoseNetLog(f.log,rejected);
  assert.equal(r.stage,'tls'); assert.deepEqual(r.socketAttempts.map(a=>a.sourceId),[4,14]);
});


test('labels the stage and the actual SOCKS handshake separately from HTTP CONNECT',() => {
  const f = fixture(); f.start(); f.add(4,'SOCKS5_CONNECT',1); f.add(4,'SOCKS5_CONNECT',2,closed); f.link(); f.end();
  const socks = diagnoseNetLog(f.log,{...rejected,scheme:'socks5'});
  assert.equal(socks.stage,'connect'); assert.equal(socks.reason,'socks_handshake_failed');
  const second = fixture(); second.start(); second.add(4,'SOCKS5_CONNECT',1); second.add(4,'SOCKS5_CONNECT',2);
  second.add(4,'SSL_CONNECT',1); second.add(4,'SSL_CONNECT',2,closed); second.link(); second.end();
  assert.equal(diagnoseNetLog(second.log,{...rejected,scheme:'socks5'}).stage,'tls');
});


test('assigns a job timer to CONNECT only while the same socket awaits its tunnel response', () => {
  for (const mode of ['pending','headers','completed','otherJob','differentError','extraSocket','tlsBegan']) {
    const f = fixture();
    f.log.constants.netError.ERR_TIMED_OUT = -7;
    f.start(); f.add(3,'HTTP_PROXY_CONNECT_JOB_CONNECT',1);
    f.add(4,'HTTP_TRANSACTION_SEND_TUNNEL_HEADERS',0,{line:'CONNECT www.cloudflare.com:443 HTTP/1.1'});
    f.add(4,'HTTP_TRANSACTION_TUNNEL_SEND_REQUEST',2); f.add(4,'HTTP_TRANSACTION_TUNNEL_READ_HEADERS',1);
    if (mode === 'headers') f.status(200);
    if (mode === 'completed') f.add(4,'HTTP_TRANSACTION_TUNNEL_READ_HEADERS',2);
    if (mode === 'extraSocket') f.add(3,'CONNECT_JOB_SET_SOCKET',0,{source_dependency:{id:14,type:4}});
    if (mode === 'tlsBegan') f.add(4,'SSL_CONNECT',1);
    f.add(mode === 'otherJob' ? 13 : 3,'CONNECT_JOB_TIMED_OUT',0);
    f.add(3,'HTTP_PROXY_CONNECT_JOB_CONNECT',2,{net_error:mode === 'differentError' ? -100 : -7});
    f.link(); f.end(0,-7);
    const r = diagnoseNetLog(f.log,{...rejected,error:'net::ERR_TIMED_OUT'});
    if (mode === 'pending') {
      assert.equal(r.stage,'connect'); assert.equal(r.reason,'tunnel_response_timeout');
    } else assert.equal(r.stage,'unknown',mode);
  }
});
