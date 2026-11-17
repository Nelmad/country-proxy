import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {attachProbeObserver, joinProbeRequests,resourceTiming,canonicalControlUrl} from './https-probe-observer.mjs';
import {summarizeConnectionPhases} from './browser-latency-netlog.mjs';

const epoch = 1794500000000;
const workerUrl = 'chrome-extension://' + 'a'.repeat(32) + '/background.js';
const traceUrl = 'https://www.cloudflare.com/cdn-cgi/trace';
const targetUrl = 'https://www.google.com/generate_204';

test('gate capability is validated then removed from diagnostic URL identity', () => {
  const capability = 'a'.repeat(32);
  for (const url of [traceUrl, targetUrl]) {
    for (const ordinal of ['', '&attempt=2']) {
      const canonical = url + '?t=' + epoch + ordinal;
      assert.equal(canonicalControlUrl(canonical + '&gate=' + capability), canonical);
      assert.equal(canonicalControlUrl(canonical), canonical);
      for (const suffix of ['&gate=short', '&gate=' + capability + '&gate=' + capability,
        '&gate=' + capability + '&extra=1', '&gate=' + capability.toUpperCase()]) {
        assert.equal(canonicalControlUrl(canonical + suffix), null);
      }
    }
  }
  assert.equal(canonicalControlUrl(traceUrl + '?gate=' + capability + '&t=' + epoch), null);
  assert.equal(canonicalControlUrl('https://foreign.example/cdn-cgi/trace?t=' + epoch + '&gate=' + capability), null);
});

test('successful NetLog timing follows only the typed assigned job/socket, not speculative peers',()=>{
  const eventNames=['URL_REQUEST_START_JOB','HTTP_STREAM_REQUEST_BOUND_TO_JOB','SOCKET_POOL_BOUND_TO_CONNECT_JOB',
    'SOCKET_POOL_BOUND_TO_SOCKET','SOCKET_ALIVE','TCP_CONNECT','SOCKS_CONNECT','SSL_CONNECT','SOCKET_BYTES_SENT','SOCKET_BYTES_RECEIVED'];
  const types={URL_REQUEST:1,HTTP_STREAM_JOB:2,CONNECT_JOB:3,SOCKET:4};
  const constants={logEventTypes:Object.fromEntries(eventNames.map((name,i)=>[name,i+1])),logSourceType:types,logEventPhase:{PHASE_NONE:0,PHASE_BEGIN:1,PHASE_END:2}};
  const row=(event,time,type,id,phase=0,params={})=>({type:constants.logEventTypes[event],time:String(time),source:{id,type:types[type]},phase,params});
  const dep=(type,id)=>({source_dependency:{id,type:types[type]}});
  const events=[row('URL_REQUEST_START_JOB',1000,'URL_REQUEST',1,1,{method:'GET',url:traceUrl+'?t='+epoch}),
    row('HTTP_STREAM_REQUEST_BOUND_TO_JOB',1001,'URL_REQUEST',1,0,dep('HTTP_STREAM_JOB',2)),
    row('SOCKET_POOL_BOUND_TO_CONNECT_JOB',1002,'HTTP_STREAM_JOB',2,0,dep('CONNECT_JOB',3)),
    row('SOCKET_POOL_BOUND_TO_SOCKET',19000,'HTTP_STREAM_JOB',2,0,dep('SOCKET',4)),
    row('SOCKET_ALIVE',1003,'SOCKET',4,1,dep('CONNECT_JOB',3)),
    row('TCP_CONNECT',1003,'SOCKET',4,1,{address:'PRIVATE'}),row('TCP_CONNECT',1100,'SOCKET',4,2),
    row('SOCKS_CONNECT',1100,'SOCKET',4,1),row('SOCKET_BYTES_SENT',1102,'SOCKET',4,0,{byte_count:9,bytes:'PRIVATE'}),
    row('SOCKET_BYTES_RECEIVED',18000,'SOCKET',4,0,{byte_count:8,bytes:'PRIVATE'}),row('SOCKS_CONNECT',18000,'SOCKET',4,2),
    row('SSL_CONNECT',18000,'SOCKET',4,1),row('SSL_CONNECT',18100,'SOCKET',4,2,{certificate:'PRIVATE'}),
    // Unbound speculative socket and reused numeric id with another source type.
    row('SOCKS_CONNECT',1000,'SOCKET',5,1),row('SOCKS_CONNECT',20000,'SOCKET',5,2),
    row('SOCKS_CONNECT',1000,'CONNECT_JOB',4,1),row('SOCKS_CONNECT',20000,'CONNECT_JOB',4,2)];
  const run=raw=>summarizeConnectionPhases(raw,{nonce:epoch,endpoint:'trace',elapsedMs:20000});
  const result=run({constants,events});
  assert.equal(result.attribution,'bound_chain');assert.equal(result.sockets.length,1);
  assert.deepEqual(result.sockets[0].intervals.map(x=>[x.event,x.durationMs]),[['TCP_CONNECT',97],['SOCKS_CONNECT',16900],['SSL_CONNECT',100]]);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  const duplicate=[...events,row('URL_REQUEST_START_JOB',1000,'URL_REQUEST',6,1,{method:'GET',url:traceUrl+'?t='+epoch})];
  assert.equal(run({constants,events:duplicate}).reason,'ambiguous_request');
  const ambiguous=[...events,row('SOCKET_POOL_BOUND_TO_CONNECT_JOB',1003,'HTTP_STREAM_JOB',2,0,dep('CONNECT_JOB',7))];
  assert.equal(run({constants,events:ambiguous}).reason,'connect_binding_not_unique');
  assert.equal(summarizeConnectionPhases({constants,events},{nonce:epoch,endpoint:'trace',elapsedMs:20000,ordinal:2}).reason,'missing_request');
  const hedged=events.map((r,i)=>i===0?{...r,params:{...r.params,url:traceUrl+'?t='+epoch+'&attempt=2'}}:r);
  const second=summarizeConnectionPhases({constants,events:hedged},{nonce:epoch,endpoint:'trace',elapsedMs:20000,ordinal:2});
  assert.equal(second.attribution,'bound_chain');assert.equal(second.ordinal,2);
  assert.equal(run({constants,events:hedged}).reason,'missing_request');
  const gated=events.map((r,i)=>i===0?{...r,params:{...r.params,url:r.params.url+'&gate='+'b'.repeat(32)}}:r);
  const gatedResult=run({constants,events:gated});
  assert.equal(gatedResult.attribution,'bound_chain');
  assert.ok(!JSON.stringify(gatedResult).includes('b'.repeat(32)));
});

test('ResourceTiming keeps bounded millisecond intervals without summing overlapping TLS/connect',()=>{
  const timing=resourceTiming({requestTime:123,dnsStart:1,dnsEnd:3,connectStart:3,connectEnd:20003,
    sslStart:10003,sslEnd:20003,sendStart:20004,sendEnd:20005,receiveHeadersStart:20040,receiveHeadersEnd:20042,
    proxyStart:-1,proxyEnd:-1,headers:'PRIVATE',ip:'PRIVATE'});
  assert.equal(timing.intervalsMs.connect,20000);
  assert.equal(timing.intervalsMs.tls,10000);
  assert.equal(timing.intervalsMs.waitingForHeaders,35);
  assert.equal(timing.intervalsMs.proxyResolution,null);
  assert.ok(!JSON.stringify(timing).includes('PRIVATE'));
  const invalid=resourceTiming({dnsStart:5,dnsEnd:4,sslStart:'0',sslEnd:999999,sendStart:NaN,sendEnd:Infinity});
  assert.equal(invalid.intervalsMs.dns,null);
  assert.equal(invalid.intervalsMs.tls,null);
  assert.equal(invalid.intervalsMs.send,null);
});

test('successful request retains exact safe connection phases and header/body boundary',async()=>{
  const cdp=new EventEmitter(),sessionId='timing-worker';
  const emit=message=>cdp.emit('Target.receivedMessageFromTarget',{sessionId,message:JSON.stringify(message)});
  cdp.send=async(method,params)=>{
    if(method==='Target.getTargets')return{targetInfos:[{targetId:'w',type:'service_worker',url:workerUrl}]};
    if(method==='Target.attachToTarget')return{sessionId};
    if(method==='Target.sendMessageToTarget')emit({id:JSON.parse(params.message).id,result:{}});
    return{};
  };cdp.detach=async()=>{};
  const observer=await attachProbeObserver({browser:()=>({newBrowserCDPSession:async()=>cdp})},workerUrl);
  try{
    emit({method:'Network.requestWillBeSent',params:{requestId:'slow',wallTime:epoch/1000,timestamp:10,request:{method:'GET',url:targetUrl+'?t='+epoch}}});
    emit({method:'Network.responseReceived',params:{requestId:'slow',timestamp:30,response:{status:204,connectionReused:false,protocol:'h2',remoteIPAddress:'PRIVATE',headers:{private:'PRIVATE'},timing:{connectStart:1,connectEnd:100,sslStart:50,sslEnd:100,sendStart:101,sendEnd:102,receiveHeadersStart:20000,receiveHeadersEnd:20000}}}});
    emit({method:'Network.loadingFinished',params:{requestId:'slow',timestamp:30.005}});
    const row=observer.snapshot().requests[0];
    assert.equal(row.outcome,'completed');assert.equal(row.elapsedMs,20005);assert.equal(row.headersElapsedMs,20000);
    assert.equal(row.timing.intervalsMs.waitingForHeaders,19898);assert.equal(row.connectionReused,false);
    assert.ok(!JSON.stringify(row).includes('PRIVATE'));
  }finally{await observer.close();}
});

test('nonce from extension timing separates adjacent attempts and refuses duplicate endpoints', () => {
  const a = {endpoint:'trace', nonce:epoch};
  const b = {endpoint:'trace', nonce:epoch+40};
  const options = {verifyingAt:epoch, latencyMs:60, checkedAt:epoch+101};
  const match = rows => joinProbeRequests({requests:rows}, options);
  assert.deepEqual(match([a,b]).requests,[b]);
  assert.equal(match([b,{...b,requestId:'duplicate'}]).attribution,'ambiguous');
  assert.equal(match([a]).attribution,'unobserved');
  assert.equal(match([{...b,nonce:b.nonce+1},b]).attribution,'ambiguous');
});

test('nonce groups admit only two distinct ordinals per endpoint and keep hedge failures separate',()=>{
  const options={verifyingAt:epoch,checkedAt:epoch+6000,latencyMs:6000};
  const primary={endpoint:'trace',nonce:epoch,ordinal:1,outcome:'pending'};
  const hedge={...primary,ordinal:2,outcome:'completed'};
  const target={endpoint:'target',nonce:epoch,ordinal:1,outcome:'completed'};
  const join=rows=>joinProbeRequests({requests:rows},options);
  assert.equal(join([primary,hedge,target]).attribution,'matched');
  for(const rows of [[primary,{...primary}], [primary,hedge,{...hedge}],
    [primary,{...hedge,ordinal:3}], [primary,{...hedge,ordinal:null}],
    [primary,hedge,{...target,endpoint:'foreign'}]])assert.equal(join(rows).attribution,'ambiguous');
});

test('filters foreign traffic and exposes the primary net error independently of a sibling abort', async () => {
  const cdp = new EventEmitter();
  const sessionId='test-worker';
  const emit = (message, target=sessionId) =>
    cdp.emit('Target.receivedMessageFromTarget', {sessionId:target,message:JSON.stringify(message)});
  cdp.send = async (method,params) => {
    if (method==='Target.getTargets') return {targetInfos:[{targetId:'w',type:'service_worker',url:workerUrl}]};
    if (method==='Target.attachToTarget') return {sessionId};
    if (method==='Target.sendMessageToTarget') emit({id:JSON.parse(params.message).id,result:{}});
    return {};
  };
  cdp.detach=async () => {};
  const observer=await attachProbeObserver({browser:()=>({newBrowserCDPSession:async()=>cdp})},workerUrl);
  try {
    const start=(requestId,url,target=sessionId) => emit({method:'Network.requestWillBeSent',params:{
      requestId,request:{method:'GET',url,headers:{'Cookie':'must-stay-private'}},wallTime:epoch/1000,timestamp:10
    }},target);
    start('a',traceUrl+'?t='+epoch);
    start('b',targetUrl+'?t='+epoch);
    start('hedge',traceUrl+'?t='+epoch+'&attempt=2');
    start('gated',targetUrl+'?t='+epoch+'&attempt=2&gate='+'c'.repeat(32));
    start('badgate',traceUrl+'?t='+epoch+'&gate=short');
    start('badordinal',traceUrl+'?t='+epoch+'&attempt=1');
    start('extra',traceUrl+'?t='+epoch+'&attempt=2&secret=must-stay-private');
    start('x',traceUrl+'?t='+epoch+'&secret=must-stay-private');
    start('y','https://unknown.example/cdn-cgi/trace?t='+epoch);
    start('z',targetUrl+'?t='+epoch,'foreign-worker');
    emit({method:'Network.loadingFailed',params:{requestId:'a',timestamp:10.1,canceled:false,
      errorText:'net::ERR_FAILED',blockedReason:'origin',corsErrorStatus:{corsError:'DisallowedByMode',failedParameter:'must-stay-private'}}});
    emit({method:'Network.loadingFailed',params:{requestId:'b',timestamp:10.2,canceled:true,errorText:'net::ERR_ABORTED'}});
    const snapshot=observer.snapshot();
    assert.equal(snapshot.requests.length,4);
    assert.equal(snapshot.requests[0].ordinal,1);assert.equal(snapshot.requests[2].ordinal,2);
    assert.equal(snapshot.requests[0].corsError,'DisallowedByMode');
    assert.equal(snapshot.requests[0].error,'net::ERR_FAILED');
    assert.equal(snapshot.requests[0].outcome,'failed');
    assert.equal(snapshot.requests[1].outcome,'cancelled');
    assert.ok(!JSON.stringify(snapshot).includes('must-stay-private'));
    assert.ok(!JSON.stringify(snapshot).includes('c'.repeat(32)));
  } finally { await observer.close(); }
});
