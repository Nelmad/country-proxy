// One bounded public confirmation, no injected failure or manual rotation.
// Only numeric phases of an exactly bound successful request leave the profile.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {inspectRuntime} from './chrome-runtime.mjs';
import {attachProbeObserver,joinProbeRequests,canonicalControlUrl} from './https-probe-observer.mjs';
import {confirmationProofs,readOfferSessions} from './failover-evidence.mjs';

const controls={trace:'https://www.cloudflare.com/cdn-cgi/trace',target:'https://www.google.com/generate_204'};
const connectionTypes=new Set(['CONNECT_JOB','SSL_CONNECT_JOB','HTTP_PROXY_CONNECT_JOB','SOCKS_CONNECT_JOB','TRANSPORT_CONNECT_JOB','TCP_CONNECT_JOB']);
const socketLinks=new Set(['SOCKET_POOL_BOUND_TO_SOCKET','CONNECT_JOB_SET_SOCKET','TRANSPORT_CONNECT_JOB_CONNECT_ATTEMPT','TCP_CONNECT_JOB_CONNECTOR_CONNECT_START']);
const useful=new Set(['TCP_CONNECT','TCP_CONNECT_ATTEMPT','SOCKS_CONNECT','SOCKS5_CONNECT','SSL_CONNECT',
  'HOST_RESOLVER_MANAGER_REQUEST','HOST_RESOLVER_MANAGER_CACHE_HIT','HOST_RESOLVER_MANAGER_HOSTS_HIT',
  'SOCKET_BYTES_SENT','SOCKET_BYTES_RECEIVED','HTTP_TRANSACTION_TUNNEL_SEND_REQUEST','HTTP_TRANSACTION_TUNNEL_READ_HEADERS']);
const id=v=>Number.isSafeInteger(v)&&v>0&&v<=0xffffffff;
const invert=table=>new Map(Object.entries(table||{}).filter(([name,n])=>/^[A-Z][A-Z0-9_]{0,95}$/.test(name)&&Number.isSafeInteger(n)).map(([name,n])=>[n,name]));

export function summarizeConnectionPhases(raw,{nonce,endpoint,elapsedMs,ordinal=1}) {
  const result={endpoint,ordinal,attribution:'unknown',reason:'invalid_input',bindings:[],sockets:[]};
  if(!raw?.constants||!Array.isArray(raw.events)||raw.events.length>500000||!controls[endpoint]||
      ![1,2].includes(ordinal)||!Number.isSafeInteger(nonce)||!Number.isFinite(elapsedMs)||elapsedMs<0||elapsedMs>60000)return result;
  const names=invert(raw.constants.logEventTypes),types=invert(raw.constants.logSourceType),phases=invert(raw.constants.logEventPhase);
  const rows=[];
  for(const [index,e] of raw.events.entries()){
    if(!id(e.source?.id)||!types.has(e.source.type)||!names.has(e.type)||!phases.has(e.phase)||!Number.isSafeInteger(Number(e.time)))continue;
    rows.push({index,name:names.get(e.type),type:types.get(e.source.type),id:e.source.id,time:Number(e.time),phase:phases.get(e.phase),params:e.params||{}});
  }
  const starts=rows.filter(r=>r.type==='URL_REQUEST'&&r.name==='URL_REQUEST_START_JOB'&&r.phase==='PHASE_BEGIN'&&r.params.method==='GET'&&canonicalControlUrl(r.params.url)===controls[endpoint]+'?t='+nonce+(ordinal===2?'&attempt=2':''));
  if(starts.length!==1)return {...result,reason:starts.length?'ambiguous_request':'missing_request'};
  const start=starts[0],endTime=start.time+Math.ceil(elapsedMs)+100;
  const within=rows.filter(r=>r.index>=start.index&&r.time>=start.time&&r.time<=endTime);
  if(within.length>30000)return {...result,reason:'event_limit'};
  const source=(type,number)=>within.filter(r=>r.type===type&&r.id===number);
  const bound=(list,event,allowed)=>{
    const values=list.filter(r=>(typeof event==='string'?r.name===event:event.has(r.name))&&id(r.params.source_dependency?.id)&&
      allowed.has(types.get(r.params.source_dependency.type))).map(r=>({type:types.get(r.params.source_dependency.type),id:r.params.source_dependency.id}));
    return [...new Map(values.map(v=>[v.type+':'+v.id,v])).values()];
  };
  const request=source('URL_REQUEST',start.id);
  const streams=bound(request,'HTTP_STREAM_REQUEST_BOUND_TO_JOB',new Set(['HTTP_STREAM_JOB']));
  if(streams.length!==1)return {...result,reason:'stream_binding_not_unique'};
  const stream=streams[0],streamRows=source(stream.type,stream.id);
  const connects=bound(streamRows,'SOCKET_POOL_BOUND_TO_CONNECT_JOB',connectionTypes);
  if(connects.length!==1)return {...result,reason:'connect_binding_not_unique',bindings:[stream]};
  const connect=connects[0],connectionRows=source(connect.type,connect.id);
  const direct=bound([...streamRows,...connectionRows],socketLinks,new Set(['SOCKET']));
  const births=within.filter(r=>r.type==='SOCKET'&&r.name==='SOCKET_ALIVE'&&r.phase==='PHASE_BEGIN'&&
    r.params.source_dependency?.id===connect.id&&types.get(r.params.source_dependency.type)===connect.type).map(r=>({type:'SOCKET',id:r.id}));
  const sockets=[...new Map([...direct,...births].map(s=>[s.type+':'+s.id,s])).values()];
  result.bindings=[{type:'URL_REQUEST',id:start.id},stream,connect];
  if(!sockets.length||sockets.length>8)return {...result,reason:'socket_binding_missing_or_ambiguous'};
  for(const socket of sockets){
    const events=source(socket.type,socket.id).filter(r=>useful.has(r.name));
    if(events.length>256)return {...result,reason:'socket_event_limit'};
    const projected=events.map(r=>{
      const row={event:r.name,ms:r.time-start.time,phase:r.phase.replace('PHASE_','').toLowerCase()};
      if(Number.isInteger(r.params.net_error)&&r.params.net_error>=-65535&&r.params.net_error<=0)row.netError=r.params.net_error;
      if(['SOCKET_BYTES_SENT','SOCKET_BYTES_RECEIVED'].includes(r.name)&&Number.isSafeInteger(r.params.byte_count)&&r.params.byte_count>=0&&r.params.byte_count<=2000000)row.byteCount=r.params.byte_count;
      return row;
    });
    const intervals=[];const pending=new Map();
    for(const r of projected){
      if(r.phase==='begin'){if(!pending.has(r.event))pending.set(r.event,[]);pending.get(r.event).push(r);}
      else if(r.phase==='end'&&pending.get(r.event)?.length){
        const begin=pending.get(r.event).pop();intervals.push({event:r.event,startMs:begin.ms,endMs:r.ms,durationMs:r.ms-begin.ms,netError:r.netError??0});
      }
    }
    result.sockets.push({...socket,events:projected,intervals});
  }
  return {...result,attribution:'bound_chain',reason:'numeric_transport_phases'};
}

async function main(){
  const root=path.resolve(import.meta.dirname,'..'),windowMs=90000,physicalChecks=120,countries=['AT','EE','NO'];
  const python=process.env.TEST_PYTHON||path.join(root,'.venv/bin/python');
  const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
  const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
  const quote=s=>"'"+s.replaceAll("'","'\"'\"'")+"'";
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  await fs.mkdir(path.join(root,'.runtime'),{recursive:true});
  const out=await fs.mkdtemp(path.join(root,'.runtime/browser-netlog-'));
  const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'cp-browser-netlog-')),profile=path.join(scratch,'profile');
  const rawPath=path.join(scratch,'netlog.json'),receipt=path.join(out,'report.json');
  const report={result:'INCONCLUSIVE',countries,limits:{windowMs,physicalChecks,netlogMiB:16},faultInjected:false,manualRotations:0};
  let chrome,popup,observer,command,watchdog,started,confirmation,network;
  async function bounded(promise,ms){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('operation timeout')),ms);})]);}finally{clearTimeout(timer);}}
  async function sourceHashes(){const values={};for(const directory of ['native','extension'])for(const file of (await fs.readdir(path.join(root,directory),{withFileTypes:true})).filter(x=>x.isFile()).sort((a,b)=>a.name.localeCompare(b.name)))values[directory+'/'+file.name]=hash(await fs.readFile(path.join(root,directory,file.name)));return values;}
  console.log('receipt',receipt);
  try{
    report.sourceHashes=await sourceHashes();
    const manifest=JSON.parse(await fs.readFile(path.join(root,'extension/manifest.json')));
    const extensionId=hash(Buffer.from(manifest.key,'base64')).slice(0,32).replace(/[a-f0-9]/g,c=>String.fromCharCode(97+parseInt(c,16)));
    const extensionURL='chrome-extension://'+extensionId,launcher=path.join(scratch,'host');
    await fs.writeFile(launcher,'#!/bin/sh\nexec '+[python,'-I','-B',path.join(root,'tests/public_group_host.py'),scratch,String(physicalChecks)].map(quote).join(' ')+'\n',{mode:0o700});
    await fs.mkdir(path.join(profile,'NativeMessagingHosts'),{recursive:true});
    await fs.writeFile(path.join(profile,'NativeMessagingHosts/local.country_proxy.json'),JSON.stringify({name:'local.country_proxy',description:'Bounded confirmation timing',path:launcher,type:'stdio',allowed_origins:[extensionURL+'/']}),{mode:0o600});
    chrome=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,timeout:20000,ignoreDefaultArgs:['--disable-extensions'],args:[
      '--disable-background-networking','--disable-quic','--disable-extensions-except='+root+'/extension','--load-extension='+root+'/extension',
      '--log-net-log='+rawPath,'--net-log-capture-mode=Default','--net-log-max-size-mb=16']});
    report.browser=chrome.browser().version();report.runtime=await inspectRuntime(chrome,root);
    observer=await attachProbeObserver(chrome,extensionURL+'/background.js');
    popup=await chrome.newPage();await popup.goto(extensionURL+'/popup.html');
    command=(action,extra={})=>popup.evaluate(m=>chrome.runtime.sendMessage(m),{action,...extra});
    await popup.evaluate(allowed=>{
      let pending=null;window.qaConfirmation=null;window.qaUnexpectedRoute=false;window.qaEnabled=false;
      chrome.storage.onChanged.addListener((c,area)=>{
        const s=area==='local'&&c.status?.newValue;if(!s)return;
        if(s.phase==='verifying')pending={attempt:s.attempt,checkedAt:s.proxy?.checkedAt,initialCheckedAt:s.proxy?.checkedAt,verifyingAt:s.updatedAt};
        else if(s.phase==='connected'&&s.browser?.ok&&pending&&s.attempt===pending.attempt){
          const {checkedAt,latencyMs,verifiedRequests}=s.browser;
          window.qaConfirmation={offer:pending,browser:{checkedAt,latencyMs,verifiedRequests},connectedAt:s.updatedAt,country:s.browser.country,scheme:s.proxy?.scheme,inGroup:allowed.includes(s.browser.country)};pending=null;
        }else if(['replacing','searching','off','error','helper','reserve'].includes(s.phase))pending=null;
      });
      chrome.proxy.settings.onChange.addListener(r=>{if(window.qaEnabled&&(r.value.mode!=='fixed_servers'||r.levelOfControl!=='controlled_by_this_extension'))window.qaUnexpectedRoute=true;});
    },countries);
    started=Date.now();report.startedAt=new Date(started).toISOString();
    watchdog=setTimeout(()=>chrome?.close().catch(()=>{}),windowMs+8000);
    assert.equal((await command('connect',{countries})).ok,true);await popup.evaluate(()=>{window.qaEnabled=true;});
    while(Date.now()-started<windowMs){
      const s=await popup.evaluate(async()=>({...await chrome.storage.local.get(['enabled','selectedCountries','status']),confirmation:window.qaConfirmation,unexpectedRoute:window.qaUnexpectedRoute}));
      assert.equal(s.enabled,true);assert.deepEqual(s.selectedCountries,countries);assert.equal(s.unexpectedRoute,false);
      if(['error','helper'].includes(s.status?.phase))throw Error('SESSION_'+s.status.phase.toUpperCase());
      if(s.confirmation){confirmation=s.confirmation;assert.equal(confirmation.inGroup,true);report.result='OBSERVED';break;}
      await pause(100);
    }
    report.elapsedMs=Date.now()-started;network=observer.snapshot();
    if(confirmation){
      report.confirmation=confirmationProofs([confirmation],network,await readOfferSessions(scratch))[0];
      report.country=confirmation.country;report.scheme=confirmation.scheme;
    }else report.reason='NO_CONFIRMATION_IN_BOUNDED_WINDOW';
    assert.deepEqual(await sourceHashes(),report.sourceHashes);
  }catch(error){report.result='FAIL';report.reason=error.message.split('\n')[0];}
  finally{
    clearTimeout(watchdog);const cleanup=[];
    if(popup&&!popup.isClosed()){try{await bounded(popup.evaluate(()=>{window.qaEnabled=false;}),3000);await bounded(command('disconnect'),6000);}catch{cleanup.push('disconnect');}}
    if(observer){try{await bounded(observer.close(),5000);}catch{cleanup.push('observer');}}
    let closed=!chrome;
    if(chrome){try{await bounded(chrome.close(),12000);closed=true;}catch{cleanup.push('chrome');}}
    if(closed&&confirmation&&report.result==='OBSERVED'){
      try{
        const stat=await fs.stat(rawPath);assert.ok(stat.isFile()&&stat.size>0&&stat.size<=18*1024*1024);
        const raw=JSON.parse(await fs.readFile(rawPath,'utf8'));
        const match=joinProbeRequests(network,{verifyingAt:confirmation.offer.verifyingAt,...confirmation.browser});
        assert.equal(match.attribution,'matched');
        report.netlog={captureMode:'Default',cases:match.requests.map(row=>summarizeConnectionPhases(raw,{nonce:match.nonce,endpoint:row.endpoint,ordinal:row.ordinal??1,elapsedMs:confirmation.browser.latencyMs}))};
      }catch{cleanup.push('netlog-analysis');}
    }
    report.startedPhysicalChecks=Number(await fs.readFile(path.join(scratch,'started'),'utf8').catch(()=>'0'));
    report.budgetReached=await fs.access(path.join(scratch,'budget-reached')).then(()=>true,()=>false);
    if(closed){await fs.rm(scratch,{recursive:true,force:true});report.profileRemoved=true;report.rawNetlogRemoved=true;}
    if(cleanup.length){report.cleanupErrors=cleanup;report.result='FAIL';}
    await fs.writeFile(receipt,JSON.stringify(report,null,2)+'\n',{mode:0o600});
    console.log('result',report.result,report.reason||'CONFIRMATION_PHASES');
  }
  if(report.result!=='OBSERVED')process.exitCode=report.result==='INCONCLUSIVE'?2:1;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)await main();
