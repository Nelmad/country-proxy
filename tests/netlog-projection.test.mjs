import test from 'node:test';
import assert from 'node:assert/strict';
import {projectNetLog} from './netlog-projection.mjs';

const nonce = 1794600000000, url = 'https://www.cloudflare.com/cdn-cgi/trace?t='+nonce;
const constants = {logEventTypes:{URL_REQUEST_START_JOB:1,NEW_SOCKET_RELATION:2,HTTP_TRANSACTION_SEND_TUNNEL_HEADERS:3,
  HTTP_TRANSACTION_READ_TUNNEL_RESPONSE_HEADERS:4,SSL_CONNECT:5,SSL_HANDSHAKE_MESSAGE_SENT:6,'private.example':7,REQUEST_ALIVE:8},
  logSourceType:{URL_REQUEST:1,SOCKET:2},logEventPhase:{PHASE_BEGIN:1,PHASE_NONE:0,PHASE_END:2},
  netError:{ERR_CONNECTION_CLOSED:-100,ERR_ABORTED:-3},clientInfo:{ip:'198.51.100.1'}};
function record(id,type,phase,params) {
  return {time:'100',source:{id,type:id===1?1:2,ip:'198.51.100.1'},type,phase,params};
}
const rows = [
  record(1,1,1,{method:'GET',url,host:'private.example'}),
  record(1,2,0,{source_dependency:{id:2,type:2,host:'private.example'},cookie:'private'}),
  record(2,3,0,{line:'CONNECT www.cloudflare.com:443 HTTP/1.1\r\n',headers:['secret']}),
  record(2,4,0,{headers:['HTTP/1.1 200 private.example','Cookie: secret']}),
  record(2,5,2,{version:'TLS 1.3',peer:'private.example'}),
  record(2,6,0,{type:1,bytes:'secret'}),
  record(3,5,2,{version:'TLS 1.2'}),
  record(2,7,0,{words:'secret'}),
  record(1,1,2,{net_error:-100})];

test('keeps the numeric dependency graph and only explicit, reconstructed request details',()=>{
  const out = projectNetLog({constants,events:rows},[nonce]);
  assert.deepEqual(out.events.map(e=>e.source.id),[1,1,2,2,2,2,1]);
  assert.deepEqual(out.events[3].params.headers,['HTTP/1.1 200 Redacted']);
  assert.deepEqual(out.events[4].params,{version:'TLS 1.3'});
  assert.deepEqual(out.constants.netError,{ERR_CONNECTION_CLOSED:-100});
  assert.doesNotMatch(JSON.stringify(out),/secret|private|198\.51|TLS 1\.2/);
});
test('refuses duplicate, missing, cancelled and open requests',()=>{
  for (const events of [[rows[0],...rows],rows.slice(0,-1),
      [rows[0],record(1,1,1,{method:'GET',url:'https://private.example/'}),rows.at(-1)],
      [...rows.slice(0,-1),record(1,1,2,{net_error:-3})]]) {
    assert.deepEqual(projectNetLog({constants,events},[nonce]).events,[]);
  }
  assert.deepEqual(projectNetLog({constants,events:rows},[nonce+1]).events,[]);
});

test('gated requests remain replayable without persisting the gate capability',()=>{
  const capability='d'.repeat(32);
  const gated=rows.map((row,i)=>i===0?{...row,params:{...row.params,url:url+'&gate='+capability}}:row);
  const out=projectNetLog({constants,events:gated},[nonce]);
  assert.equal(out.events[0].params.url,url);
  assert.equal(out.events.length,7);
  assert.ok(!JSON.stringify(out).includes(capability));
  const duplicate=[rows[0],...gated];
  assert.deepEqual(projectNetLog({constants,events:duplicate},[nonce]).events,[]);
});

test('captures an addressed body error after successful response start',()=>{
  const events = [...rows.slice(0,-1),record(1,1,2,{}),record(1,8,2,{net_error:-100})];
  const out = projectNetLog({constants,events},[nonce]);
  assert.equal(out.events.at(-1).type,8);
  assert.equal(out.events.at(-1).params.net_error,-100);
});
