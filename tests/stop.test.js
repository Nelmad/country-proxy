import {dnrFixture} from './dnr-fixture.js';
import {gateRules} from '../extension/traffic-gate.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Controller, restoreCountrySettings} from '../extension/controller.js';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import vm from 'node:vm';
import {validFavorites} from '../extension/country-catalog.js';
import {statusDetail, hasRejectedHealthCountry} from '../extension/popup-status.js';

const slots = ['proxy', 'webRTC', 'prediction'];

async function loadDisabledWorker({own, saved, denied, overlay = false, gate = dnrFixture()}) {
  const calls = [];
  const listeners = {};
  const event = name => ({addListener: handler => { listeners[name] = handler; }});
  const settings = Object.fromEntries(slots.map(name => [name, {
    onChange: event(name + 'Change'),
    async get() {
      const level = overlay ? 'controlled_by_other_extensions' : own.has(name)
        ? 'controlled_by_this_extension' : 'controllable_by_this_extension';
      return {levelOfControl: level, value: overlay ? 'other' : own.has(name) ? 'own' : 'user'};
    },
    async clear({scope}) {
      assert.equal(scope, 'regular');
      calls.push('clear ' + name);
      if (denied === name) throw Error('clear denied for ' + name);
      own.delete(name);
    }
  }]));
  const alarmNames = new Set(['reconnect', 'unrelated']);
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const writes = [];
  globalThis.chrome = {
    declarativeNetRequest: gate.api,
    proxy: {settings: settings.proxy, onProxyError: event('proxyError')},
    privacy: {network: {webRTCIPHandlingPolicy: settings.webRTC, networkPredictionEnabled: settings.prediction}},
    runtime: {id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', getURL: name => 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/' + name,
      onStartup: event('startup'), onMessage: event('message')},
    storage: {local: {get: async () => structuredClone(saved), set: async values => {
      Object.assign(saved, structuredClone(values));
      if (values.status) {
        writes.push({values: structuredClone(values), own: [...own], reconnect: alarmNames.has('reconnect')});
      }
    }}},
    alarms: {onAlarm: event('alarm'), clear: async name => alarmNames.delete(name)},
    action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}}
  };
  globalThis.fetch = async url => {
    assert.equal(url, 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/countries.json');
    return {json: async () => ['EE', 'NO']};
  };
  try {
    await import('../extension/background.js?stop=' + crypto.randomUUID());
    // Message handling awaits the service worker's complete startup path.
    const reply = await new Promise(resolve => listeners.message(
      {action: 'sourceQuality', country: 'NO'}, {id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'}, resolve));
    assert.equal(reply.ok, true);
    assert.ok(alarmNames.has('unrelated'));
    const visibleProxy = await settings.proxy.get();
    return {writes, calls, visibleProxy, gate};
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
}

test('disabled worker resumes an interrupted Stop after any subset of settings were cleared', async () => {
  for (let mask = 0; mask < 8; mask++) {
    const own = new Set(slots.filter((name, idx) => mask & (1 << idx)));
    const saved = {enabled: false, selected: 'NO', countries: ['EE'], status: {phase: 'connected'}};
    const {writes, calls, visibleProxy} = await loadDisabledWorker({own, saved});
    assert.equal(writes[0].values.enabled, false);
    assert.equal(writes[0].values.status.phase, 'stopping');
    assert.equal(writes.at(-1).values.status.phase, 'off');
    assert.deepEqual(writes.at(-1).own, []);
    assert.equal(writes.at(-1).reconnect, false);
    assert.deepEqual([...new Set(calls)].sort(), slots.map(slot => 'clear ' + slot).sort());
    assert.equal(visibleProxy.value, 'user');
    assert.equal(saved.selected, 'NO');
    assert.deepEqual(saved.countries, ['EE']);
  }
});

test('disabled worker clears its masked settings while another extension remains effective', async () => {
  const own = new Set(slots);
  const saved = {enabled: false, status: {phase: 'off'}};
  const {visibleProxy} = await loadDisabledWorker({own, saved, overlay: true});
  assert.equal(own.size, 0);
  assert.deepEqual(visibleProxy, {levelOfControl: 'controlled_by_other_extensions', value: 'other'});
  assert.equal(saved.status.phase, 'off');
});

test('after a partial cleanup error other settings are released and a fresh worker retries', async () => {
  const own = new Set(slots);
  const saved = {enabled: false};
  const {writes} = await loadDisabledWorker({own, saved, denied: 'webRTC'});
  assert.deepEqual([...own], ['webRTC']);
  assert.equal(saved.enabled, false);
  assert.equal(saved.status.phase, 'stopError');
  assert.equal(writes.some(w => w.values.status.phase === 'off'), false);
  await loadDisabledWorker({own, saved});
  assert.equal(saved.status.phase, 'off');
  assert.equal(own.size, 0);
});

test('failed proxy cleanup retains the traffic block instead of exposing a pending candidate', async () => {
  const own = new Set(slots), saved = {enabled: false};
  const rules = gateRules('b'.repeat(32), 'f'.repeat(32));
  const gate = dnrFixture({dynamic: rules.dynamic, session: rules.session});
  await loadDisabledWorker({own, saved, denied: 'proxy', gate});
  assert.equal(saved.status.phase, 'stopError');
  assert.deepEqual([...own], ['proxy']);
  assert.equal(gate.state.dynamic.filter(rule => rule.action.type === 'block').length, 18);
  assert.deepEqual(gate.state.session, []);
  await loadDisabledWorker({own, saved, gate});
  assert.equal(saved.status.phase, 'off');
  assert.deepEqual(gate.state.dynamic, []); assert.deepEqual(gate.state.session, []);
});

test('failed DNR cleanup still releases proxy/privacy and reports a retryable Stop error', async () => {
  const own = new Set(slots), saved = {enabled: false};
  const rules = gateRules('b'.repeat(32), 'f'.repeat(32));
  let rejected = true;
  const gate = dnrFixture({dynamic: rules.dynamic, session: rules.session,
    reject: (kind, changes) => rejected && kind === 'dynamic' && !changes.addRules});
  await loadDisabledWorker({own, saved, gate});
  assert.equal(saved.status.phase, 'stopError'); assert.equal(own.size, 0);
  assert.deepEqual(gate.state.session, []);
  rejected = false; await loadDisabledWorker({own, saved, gate});
  assert.equal(saved.status.phase, 'off'); assert.deepEqual(gate.state.dynamic, []);
});

test('a stale disconnect from the helper cannot cancel Stop or report off over a new selection', async () => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const saved = {};
  const phases = [];
  let cleared = false;
  const controller = new Controller({
    save: async changes => Object.assign(saved, changes),
    publish: async (state, changes) => { Object.assign(saved, changes, {status: state}); phases.push(state.phase); },
    stopNative: async () => {},
    clear: async () => { entered.resolve(); await release.promise; cleared = true; },
    block: async () => assert.ok(cleared), startNative: async () => {}
  });
  const stopping = controller.stop();
  await entered.promise;
  const stoppingId = controller.id;
  await controller.lost();
  await controller.incompatible();
  assert.equal(controller.id, stoppingId);
  const starting = controller.start(['NO', 'EE']);
  assert.equal(saved.enabled, false);
  assert.deepEqual(phases, ['stopping']);
  release.resolve();
  await Promise.all([stopping, starting]);
  assert.equal(saved.enabled, true);
  assert.deepEqual(saved.selectedCountries, ['EE', 'NO']);
  assert.deepEqual(phases, ['stopping', 'searching']);
});


test('Stop persists disabled intent before pending guards and a worker wake only finishes cleanup', async () => {
  const saved={enabled:true,selected:'NO',countries:['NO'],status:{phase:'connected'}};
  const guard=Promise.withResolvers();let clearStarted=false;
  const controller=new Controller({
    save:async values=>Object.assign(saved,structuredClone(values)),
    publish:async(status,values)=>Object.assign(saved,structuredClone(values),{status:structuredClone(status)}),
    revokeTraffic:()=>guard.promise,protectRoute:async()=>true,
    clear:async()=>{clearStarted=true;},stopNative:async()=>{}
  });
  controller.enabled=true;controller.country='NO';controller.countries=['NO'];
  const stopping=controller.stop();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(saved.enabled,false,'Stop intent must not depend on a Chrome guard completing');
  assert.equal(saved.status.phase,'stopping');assert.equal(clearStarted,false,'cleanup still waits for guards');
  const restarted=structuredClone(saved);
  await loadDisabledWorker({own:new Set(slots),saved:restarted});
  assert.equal(restarted.enabled,false);assert.equal(restarted.status.phase,'off','worker wake finishes Stop instead of restoring connection');
  guard.resolve();await stopping;
  assert.equal(saved.status.phase,'off');
});

// Exercise the real worker command handler and the production popup render;
// only owned Chrome APIs fail, after a real equal-set Start installed the block.
async function withFailedStop(run) {
  const originalChrome = globalThis.chrome, originalFetch = globalThis.fetch;
  const saved = {enabled: false, countries: ['NO'], selected: 'NO'};
  const listeners = {}, writes = [], gate = dnrFixture();
  let ownRoute = null, clearFailures = 0, statusFailures = 0, rejectedWrites = 0;
  let beforeStatus = async () => {};
  const event = name => ({addListener: callback => { listeners[name] = callback; }});
  const setting = initial => { let value = initial; return {get: async () => ({value, levelOfControl: value === null ?
    'controllable_by_this_extension' : 'controlled_by_this_extension'}),
    clear: async () => { value = null; }, set: async options => { value = options.value; }}; };
  globalThis.chrome = {
    declarativeNetRequest: gate.api,
    proxy: {settings: {get: async () => ({value: ownRoute, levelOfControl: ownRoute ?
      'controlled_by_this_extension' : 'controllable_by_this_extension'}),
      set: async ({value}) => { ownRoute = value; }, clear: async () => {
        if (clearFailures > 0) { --clearFailures; throw Error('Injected owned proxy.clear rejection'); }
        ownRoute = null;
      }, onChange: event('route')}, onProxyError: event('proxyError')},
    privacy: {network: {webRTCIPHandlingPolicy: setting(null), networkPredictionEnabled: setting(null)}},
    runtime: {id: 'b'.repeat(32), getURL: x => x, onMessage: event('message'), onStartup: event('startup'),
      connectNative: () => ({onMessage: {addListener: callback => queueMicrotask(() => callback({type: 'hello', feedbackProtocol: 1}))},
        onDisconnect: event('nativeLost'), postMessage() {}, disconnect() {}})},
    alarms: {onAlarm: event('alarm'), clear: async () => {}, create: async () => {}},
    action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}},
    storage: {local: {get: async key => structuredClone(key === null ? saved : {[key]: saved[key]}), set: async values => {
      if (values.status?.phase === 'stopError') {
        await beforeStatus();
        if (statusFailures > 0) { --statusFailures; ++rejectedWrites; throw Error('Injected stopError publication rejection'); }
      }
      writes.push(structuredClone(values)); Object.assign(saved, structuredClone(values));
    }}}
  };
  globalThis.fetch = async () => ({json: async () => ['AT', 'EE', 'NO']});
  const send = message => new Promise(done => listeners.message(message, {id: 'b'.repeat(32)}, done));
  const root = process.env.CP_EXTENSION_ROOT || resolve('extension');
  try {
    await import(pathToFileURL(resolve(root, 'background.js')).href + '?failed-stop=' + crypto.randomUUID());
    await send({action: 'sourceQuality', country: 'NO'});
    assert.deepEqual(await send({action: 'connect', countries: ['NO', 'AT', 'EE']}), {ok: true});
    assert.equal(saved.status.phase, 'searching');
    assert.equal(ownRoute.mode, 'fixed_servers'); assert.ok(gate.state.dynamic.length);
    await run({saved, gate, send, writes, route: () => ownRoute, rejected: () => rejectedWrites,
      fail: (clear, status) => { clearFailures = clear; statusFailures = status; },
      intercept: callback => { beforeStatus = callback; }, popup: () => renderedStop(root, saved)});
  } finally {
    clearFailures = statusFailures = 0; beforeStatus = async () => {};
    await send({action: 'disconnect'});
    globalThis.chrome = originalChrome; globalThis.fetch = originalFetch;
  }
}
async function renderedStop(root, saved) {
  const source = await readFile(resolve(root, 'popup.js'), 'utf8'), elements = new Map();
  const $ = id => { if (!elements.has(id)) elements.set(id, {hidden: false, textContent: ''}); return elements.get(id); };
  const context = vm.createContext({$, validFavorites, restoreCountrySettings, statusDetail, hasRejectedHealthCountry,
    announceStatus() {}, chrome: {storage: {local: {get: async () => structuredClone(saved)}}, proxy: {settings: {get: async () => null}}},
    sourceSelection() {}, renderReserveDiagnostics() {}, pickerOpen: () => false, renderCountries() {}, closePicker() {},
    matchesEffectiveRoute: () => false, sameCountries: () => false, labels: {}, reasons: {}, byCode: new Map(), labelFor: x => x});
  vm.runInContext(`let catalog=[{code:'AT'},{code:'EE'},{code:'NO'}], favorites=[], selectedCountries=[], selectionMode='single',
    selectionInvalid=false, draftMode, draftCountries, applying=false, lastCountryState='';` +
    source.slice(source.indexOf('let renderRevision = 0;'), source.indexOf("$('mode-single').addEventListener")), context);
  await vm.runInContext('render()', context);
  return {stop: $('disconnect'), connect: $('connect'), detail: $('detail')};
}
for (const statusFailures of [0, 1, 100]) {
  test(`failed Stop keeps truthful actionable recovery after ${statusFailures} stopError write failures`, () =>
    withFailedStop(async ({saved, gate, send, fail, route, rejected, popup}) => {
      fail(1, statusFailures);
      const reply = await send({action: 'disconnect'});
      assert.equal(reply.ok, false);
      assert.match(reply.error, /Повторите отключение/);
      assert.equal(saved.enabled, false);
      assert.equal(saved.status.phase, statusFailures > 1 ? 'stopping' : 'stopError');
      assert.ok(route(), 'owned blocked proxy remains after failed cleanup');
      assert.ok(gate.state.dynamic.length, 'DNR remains closed'); assert.deepEqual(gate.state.session, []);
      const ui = await popup();
      assert.equal(ui.stop.hidden, false, 'Retry Stop must remain accessible even when diagnostic storage stays unavailable');
      assert.equal(ui.stop.textContent, 'Повторить отключение');
      assert.ok(rejected() <= 2, 'diagnostic retry is bounded');
      fail(0, 0);
      assert.equal((await send({action: 'disconnect'})).ok, true);
      assert.equal(saved.status.phase, 'off'); assert.equal(route(), null);
      assert.deepEqual(gate.state.dynamic, []); assert.deepEqual(gate.state.session, []);
      assert.equal((await popup()).stop.hidden, true);
    }));
}
for (const next of ['disconnect', 'connect']) {
  test(`a late rejected Stop diagnostic cannot replace a newer ${next}`, () => withFailedStop(async ({send, saved, fail, intercept, gate, route}) => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers(); let once = true;
    fail(1, 1);
    intercept(async () => { if (once) { once = false; entered.resolve(); await release.promise; } });
    const old = send({action: 'disconnect'}); await entered.promise;
    const newest = send(next === 'disconnect' ? {action: 'disconnect'} : {action: 'connect', countries: ['EE', 'AT']});
    await new Promise(done => setImmediate(done)); release.resolve();
    await old; assert.equal((await newest).ok, true);
    assert.equal(saved.enabled, next === 'connect');
    assert.equal(saved.status.phase, next === 'connect' ? 'searching' : 'off');
    if (next === 'connect') assert.deepEqual(saved.selectedCountries, ['AT', 'EE']);
    else { assert.equal(route(), null); assert.deepEqual(gate.state.dynamic, []); }
    assert.deepEqual(gate.state.session, []);
  }));
}

test('repeated cleanup and diagnostic failures keep Retry Stop available until cleanup succeeds', () =>
  withFailedStop(async ({send, saved, fail, route, gate, popup, rejected}) => {
    fail(2, 100);
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal((await send({action: 'disconnect'})).ok, false);
      assert.equal(saved.enabled, false); assert.equal(saved.status.phase, 'stopping');
      assert.ok(route()); assert.ok(gate.state.dynamic.length); assert.deepEqual(gate.state.session, []);
      assert.equal((await popup()).stop.hidden, false);
    }
    assert.equal(rejected(), 4, 'Each failed Stop has at most two diagnostic writes');
    fail(0, 0);
    assert.equal((await send({action: 'disconnect'})).ok, true);
    assert.equal(saved.status.phase, 'off'); assert.equal(route(), null);
    assert.deepEqual(gate.state.dynamic, []);
  }));
for (const next of ['disconnect', 'connect']) {
  test(`a newer ${next} supersedes the bounded Stop diagnostic retry already in flight`, () =>
    withFailedStop(async ({send, saved, fail, intercept, rejected}) => {
      const entered = Promise.withResolvers(), release = Promise.withResolvers(); let attempts = 0;
      fail(1, 2);
      intercept(async () => { if (++attempts === 2) { entered.resolve(); await release.promise; } });
      const old = send({action: 'disconnect'}); await entered.promise;
      const newest = send(next === 'disconnect' ? {action: 'disconnect'} : {action: 'connect', countries: ['NO', 'EE', 'AT']});
      await new Promise(done => setImmediate(done)); release.resolve();
      assert.equal((await old).ok, true, 'A superseded failure does not report over a newer command');
      assert.equal((await newest).ok, true);
      assert.equal(rejected(), 2); assert.equal(attempts, 2, 'No extra stale persistence retry');
      assert.equal(saved.enabled, next === 'connect');
      assert.equal(saved.status.phase, next === 'connect' ? 'searching' : 'off');
      if (next === 'connect') assert.deepEqual(saved.selectedCountries, ['AT', 'EE', 'NO']);
    }));
}
