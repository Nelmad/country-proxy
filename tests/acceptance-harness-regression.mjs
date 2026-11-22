// Execute exact trusted acceptance code with injected I/O; no Chrome/network/install.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const root=path.resolve(process.argv[2] || path.join(import.meta.dirname,'..'));
const onlyZIP=process.argv.includes('--zip-only');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const lifecycle=await fs.readFile(path.join(root,'tests/install-lifecycle.mjs'),'utf8');
const start=lifecycle.indexOf('  if(cc && proxy){');
const end=lifecycle.indexOf("  stage.result='PASS';",start);
assert.ok(start>0 && end>start,'Exact lifecycle phase markers');
const snippet=lifecycle.slice(start,end+"  stage.result='PASS';".length);
for(const injection of onlyZIP?[]:['none','bypass-omitted','bypass-unexpected','bypass-null','legacy-bypass','legacy-bypass-omitted','legacy-bypass-unexpected','connect','helper','route','country','navigation','disconnect','disconnect-rejected','restore']){
 const stage={},commands=[];
 const hits=[];
 let disconnected=false;
 const route={levelOfControl:'controlled_by_this_extension',value:{mode:'fixed_servers',rules:{proxyForHttp:{host:'127.0.0.1',port:12345,scheme:'http'},proxyForHttps:{host:'127.0.0.1',port:12345,scheme:'http'},fallbackProxy:{host:'127.0.0.1',port:12345},bypassList:[]}}};
 if(injection.endsWith('bypass-omitted'))delete route.value.rules.bypassList;
 if(injection.endsWith('bypass-unexpected'))route.value.rules.bypassList=['example.com'];
 if(injection==='bypass-null')route.value.rules.bypassList=null;
 if(injection==='legacy-bypass')route.value.rules.bypassList=['<-loopback>'];
 const popup={evaluate:async fn=>{
  const text=String(fn);
  if(text.includes('storage.local.get'))return {selected:'NO',enabled:true,status:{phase:injection==='helper'?'helper':'connected',country:'NO',proxy:{port:12345}}};
  if(text.includes('proxy.settings.get'))return disconnected?{levelOfControl:injection==='restore'?'controlled_by_this_extension':'controllable_by_this_extension'}:injection==='route'?{...route,levelOfControl:'not_controllable'}:route;
 }};
 const command=async action=>{commands.push(action);if(action==='disconnect'){disconnected=true;if(injection==='disconnect')throw Error('Injected disconnect failure');}return {ok:!((action==='connect' && injection==='connect') || (action==='disconnect' && injection==='disconnect-rejected'))};};
 const trace={goto:async()=>{if(injection==='navigation')throw Error('net::ERR_PROXY_CONNECTION_FAILED');hits.push({target:'www.cloudflare.com:443',sentBytes:1,receivedBytes:1});},locator:()=>({innerText:async()=>injection==='country'?'loc=JP\n':'loc=NO\n'}),close:async()=>{}};
 const env={cc:'NO',proxy:{port:12345,hits},stage,path,app:'/owned/app',fs:{writeFile:async()=>{},readFile:async()=> injection.startsWith('legacy-')?'bypassList: ["<-loopback>"]':'bypassList: []'},quote:JSON.stringify,fixtureScript:'/owned/fixture.py',command,popup,assert,
 registration:{path:'/owned/host'},registrationFile:'/owned/registration.json',preservedSelection:{selected:'NO'},installedRegistration:Buffer.from('{}'),sha,productHashes:async()=>({same:true}),snapshot:'/owned/snapshot',optionalHTTPS:true,browser:{newPage:async()=>trace},waitFor:async fn=>fn()};
 let failure;
 try{await new AsyncFunction(...Object.keys(env),snippet)(...Object.values(env));}catch(error){failure=error;}
 if(['none','bypass-omitted','legacy-bypass'].includes(injection)){assert.ifError(failure);assert.equal(stage.result,'PASS');assert.equal(stage.optionalHTTPS.result,'PASS');continue;}
 assert.ok(failure,`${injection}: deterministic phase failure must reject`);
 assert.equal(stage.result,'FAIL',`${injection}: failed phase must mark stage FAIL`);
 assert.notEqual(stage.optionalHTTPS?.result,'INCONCLUSIVE',`${injection}: product/controlled-route failure is not external availability`);
 assert.ok(commands.includes('disconnect'),`${injection}: cleanup Stop attempted`);
}

const prerequisiteStart=lifecycle.indexOf(' if(optionalHTTPS){');
const prerequisiteEnd=lifecycle.indexOf(" const countries=['AT','EE','NO'];",prerequisiteStart);
assert.ok(prerequisiteStart>0 && prerequisiteEnd>prerequisiteStart,'Exact external prerequisite markers');
const prerequisite=lifecycle.slice(prerequisiteStart,prerequisiteEnd);
for(const injection of onlyZIP?[]:['none','http','timeout','spawn','signal','malformed','listener']){
 const env={optionalHTTPS:true,cc:null,proxy:null,report:{},assert,
  exec:async()=>{if(['http','timeout','spawn','signal'].includes(injection))throw Object.assign(Error('Injected prerequisite failure'),{code:{http:22,timeout:28,spawn:'ENOENT',signal:null}[injection]});return {stdout:injection==='malformed'?'loc=??\n':'loc=NO\n'};},
  listenProxy:async()=>{if(injection==='listener')throw Error('Injected fixture listener failure');return {port:12345};}};
 let value,failure;
 try{value=await new AsyncFunction(...Object.keys(env),prerequisite+'\nreturn {cc,proxy,report};')(...Object.values(env));}catch(error){failure=error;}
 if(['spawn','signal','malformed','listener'].includes(injection))assert.ok(failure,`${injection}: prerequisite implementation error must fail`);
 else{assert.ifError(failure);if(injection==='none'){assert.equal(value.cc,'NO');assert.equal(value.proxy.port,12345);}else{assert.equal(value.cc,null);assert.equal(value.report.optionalHTTPSPreflight.result,'INCONCLUSIVE');}}
}

const fresh=await fs.readFile(path.join(root,'tests/fresh-install.mjs'),'utf8');
const freshStart=fresh.indexOf('async function run(){');
const freshEnd=fresh.indexOf('  scratch=await',freshStart);
assert.ok(freshStart>0 && freshEnd>freshStart,'Exact pre-extraction gate markers');
const preflight=fresh.slice(freshStart+'async function run(){'.length,freshEnd);
for(const [expected,code] of [[undefined,'EXPECTED_ZIP_SHA256_REQUIRED'],['bad','EXPECTED_ZIP_SHA256_REQUIRED'],['0'.repeat(64),'ZIP_APPROVAL_MISMATCH'],[sha(Buffer.from('fixture ZIP')),'SCRATCH_BOUNDARY']]){
 const report={},env={process:{platform:'darwin',env:{TEST_INSTALL_ZIP:'/owned/approved.zip',TEST_PYTHON:'/python',TEST_INSTALL_ZIP_SHA256:expected}},assert,path,root:'/trusted',report,sha,
 fs:{mkdir:async()=>{},mkdtemp:async()=>'/receipt',chmod:async()=>{},realpath:async p=>p,lstat:async()=>({isFile:()=>true,size:11}),readFile:async()=>Buffer.from('fixture ZIP')},receipt:undefined};
 await assert.rejects(new AsyncFunction(...Object.keys(env),preflight+"\nthrow Error('SCRATCH_BOUNDARY');")(...Object.values(env)),error=>error.message.split('\n')[0]===code,`ZIP gate ${String(expected)}`);
 if(code==='SCRATCH_BOUNDARY'){assert.equal(report.expectedZipSHA256,expected);assert.equal(report.zipSHA256,expected);assert.equal(report.zipApprovalMatched,true);}
}
if (!onlyZIP) await import('./runtime-harness-regression.mjs');
console.log(JSON.stringify({result:'PASS',exactLifecycleSnippetSHA256:sha(snippet),lifecycleInjections:12,lifecycleSuccessControl:3,externalPrerequisiteCases:7,zipApprovalCases:4,chrome:false,network:false}));
