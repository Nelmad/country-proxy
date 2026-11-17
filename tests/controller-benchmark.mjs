// Offline measurement of the actual Controller. The injected probe is NOT Chrome/HTTPS evidence.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
export const CONTRACT = Object.freeze({schemaVersion: 1, probeDelayMs: 10, trialDeadlineMs: 2000,
  repeats: 20, clock: 'one-process monotonic performance.now',
  evidence: 'actual Controller with injected API and probe; no browser or network',
  countries: ['EE', 'NO', 'PL']});

export function summary(trials) {
  const values = trials.filter(t => t.outcome === 'success').map(t => t.elapsedMs).sort((a,b)=>a-b);
  const percentile = fraction => values.length ? values[Math.ceil(values.length*fraction)-1] : null;
  return {total: trials.length, successes: values.length,
    failures: trials.filter(t=>t.outcome==='failure').length,
    timeouts: trials.filter(t=>t.outcome==='timeout').length,
    successfulLatencyMs: {n: values.length, median: percentile(.5), p95: percentile(.95),
      max: values.length ? values.at(-1) : null},
    percentileScope: 'successful trials only; timeouts are right-censored and are not latency samples'};
}

function harness(Controller, probe) {
  const events=[], routes=[], commands=[];
  const api = {save: async()=>{}, block: async()=>routes.push({type:'blocked'}),
    apply: async config=>{
      assert.equal(config.mode,'fixed_servers');
      assert.deepEqual(config.rules.proxyForHttp,config.rules.proxyForHttps);
      assert.deepEqual(config.rules.proxyForHttps,config.rules.fallbackProxy);
      assert.deepEqual(config.rules.bypassList,['<-loopback>']);
      routes.push({type:'proxy',server:structuredClone(config.rules.proxyForHttps)});
    }, clear: async()=>routes.push({type:'released'}),
    publish: async e=>events.push({at:performance.now(),phase:e.phase}),
    startNative: async()=>{}, stopNative:()=>commands.push('stop'), rotate:()=>commands.push('rotate')};
  return {controller:new Controller(api,probe),events,routes,commands};
}
const proxy = (host,country='NO') => ({scheme:'http',host,port:3128,country,exitIp:host,latencyMs:1,checkedAt:1});
const status = (c,p) => ({id:c.id,countries:[...CONTRACT.countries],country:p.country,phase:'connected',proxy:p});

export async function runTrial(Controller, scenario) {
  let calls=0, activeProbes=0, cancelled=0;
  let enteredResolve;
  const entered=new Promise(resolve=>{enteredResolve=resolve;});
  const h=harness(Controller,async (_selection,signal)=>{
    calls++;activeProbes++;enteredResolve();
    try {
      if(scenario==='stop_inflight') {
        await new Promise(resolve=>{
          if(signal.aborted)resolve(); else signal.addEventListener('abort',resolve,{once:true});
        });
        cancelled++;return {ok:false,reason:'cancelled'};
      }
      await sleep(CONTRACT.probeDelayMs);
      if(scenario==='reject_then_next' && calls===1)return {ok:false,reason:'transport'};
      return {ok:true,country:'NO',ip:calls===1?'8.8.8.8':'1.1.1.1'};
    } finally {activeProbes--;}
  });
  const c=h.controller;await c.start([...CONTRACT.countries]);
  let started=performance.now(), observation;
  try {
    if(scenario==='stop_inflight') {
      const pending=c.status(status(c,proxy('8.8.8.8')));await entered;
      started=performance.now();await c.stop();await pending;
      assert.equal(c.enabled,false);assert.equal(h.events.at(-1).phase,'off');
      assert.equal(h.routes.at(-1).type,'released');
      assert.equal(h.commands.filter(x=>x==='stop').length,1);
      assert.equal(cancelled,1);observation='stop command to released route with cancelled injected probe';
    } else if(scenario==='outside_set') {
      await c.status(status(c,proxy('8.8.8.8','US')));
      assert.equal(c.active,null);assert.equal(calls,0);assert.equal(h.routes.at(-1).type,'blocked');
      assert.deepEqual(h.routes.map(x=>x.type),['blocked','blocked']);
      assert.equal(h.commands.filter(x=>x==='rotate').length,1);observation='outside-set route rejected without applying';
    } else {
      await c.status(status(c,proxy('8.8.8.8')));
      if(scenario==='reject_then_next') {
        assert.equal(h.routes.at(-1).type,'blocked');assert.equal(c.active,null);
        await c.status(status(c,proxy('1.1.1.1')));
        assert.equal(calls,2);assert.equal(c.active.host,'1.1.1.1');
        assert.equal(h.commands.filter(x=>x==='rotate').length,1);
        assert.deepEqual(h.routes.map(x=>x.type),['blocked','proxy','blocked','proxy']);
      } else {
        assert.equal(scenario,'confirmed_route');assert.equal(calls,1);
        assert.deepEqual(h.routes.map(x=>x.type),['blocked','proxy']);
        assert.equal(h.commands.length,0);
      }
      const applied=h.routes.filter(x=>x.type==='proxy');
      assert.deepEqual(applied.map(x=>x.server),
        (scenario==='reject_then_next'?['8.8.8.8','1.1.1.1']:['8.8.8.8'])
          .map(host=>({scheme:'http',host,port:3128})));
      assert.equal(h.events.at(-1).phase,'connected');
      observation='native connected event to Controller confirmation through injected probe';
    }
    assert.equal(activeProbes,0);
    return {outcome:'success',elapsedMs:performance.now()-started,observation,
      probeCalls:calls,cancelled,routes:structuredClone(h.routes),phases:h.events.map(e=>e.phase),
      stageOffsetsMs:h.events.filter(e=>e.at>=started).map(e=>({phase:e.phase,ms:e.at-started}))};
  } finally {await c.stop();}
}

async function main() {
  const args=process.argv.slice(2);const options={};
  for(let i=0;i<args.length;i+=2){assert.ok(['--root','--output','--repeats'].includes(args[i]));options[args[i]]=args[i+1];}
  assert.ok(options['--root'] && options['--output'],'--root and --output are required');
  const repeats=Number(options['--repeats']??CONTRACT.repeats);assert.ok(Number.isInteger(repeats)&&repeats>0&&repeats<=100);
  const filename=path.resolve(options['--root'],'extension/controller.js');
  const before=await fs.readFile(filename);const {Controller}=await import(pathToFileURL(filename));
  const report={schemaVersion:1,contract:CONTRACT,repeats,controllerSha256:sha(before),
    harnessSha256:sha(await fs.readFile(fileURLToPath(import.meta.url))),scenarios:{},result:'PASS'};
  for(const scenario of ['confirmed_route','reject_then_next','stop_inflight','outside_set']) {
    const trials=[];
    for(let i=0;i<repeats;i++) {
      let timer;
      try {
        trials.push(await Promise.race([runTrial(Controller,scenario),new Promise((_,reject)=>{
          timer=setTimeout(()=>reject(Object.assign(Error('trial deadline'),{code:'TRIAL_TIMEOUT'})),CONTRACT.trialDeadlineMs);
        })]));
      } catch(error) {
        trials.push({outcome:error.code==='TRIAL_TIMEOUT'?'timeout':'failure',
          ...(error.code==='TRIAL_TIMEOUT'?{censoredAfterMs:CONTRACT.trialDeadlineMs}:{error:error.message})});
        report.result='FAIL';
        // Stop this process after an incomplete trial; never overlap it with another trial.
        report.scenarios[scenario]={summary:summary(trials),trials};
        await fs.writeFile(options['--output'],JSON.stringify(report,null,2)+'\n');
        process.exit(1);
      } finally {clearTimeout(timer);}
    }
    report.scenarios[scenario]={summary:summary(trials),trials};
  }
  assert.equal(sha(await fs.readFile(filename)),report.controllerSha256,'source changed while measuring');
  await fs.writeFile(options['--output'],JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({result:report.result,evidence:CONTRACT.evidence,repeats,
    scenarios:Object.fromEntries(Object.entries(report.scenarios).map(([k,v])=>[k,v.summary]))}));
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) await main();
