import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {validFavorites} from '../extension/country-catalog.js';
import {restoreCountrySettings} from '../extension/controller.js';
import {statusDetail, createStatusAnnouncer, hasRejectedHealthCountry} from '../extension/popup-status.js';
import {dnrFixture} from './dnr-fixture.js';
import {gateRules} from '../extension/traffic-gate.js';

async function withWorker(run) {
  const originalChrome = globalThis.chrome, originalFetch = globalThis.fetch;
  const saved = {countries: ['NO'], enabled: false, selected: 'NO'};
  const listeners = {}, writes = [];
  let beforeWrite = async () => {};
  const event = name => ({addListener: callback => { listeners[name] = callback; }});
  const setting = {get: async () => ({levelOfControl: 'controllable_by_this_extension'}), clear: async () => {}};
  globalThis.chrome = {
    declarativeNetRequest: dnrFixture().api,
    proxy: {settings: {...setting, onChange: event('proxy')}, onProxyError: event('proxyError')},
    privacy: {network: {webRTCIPHandlingPolicy: setting, networkPredictionEnabled: setting}},
    runtime: {id: 'b'.repeat(32), getURL: name => name, onMessage: event('message'), onStartup: event('startup')},
    alarms: {onAlarm: event('alarm'), clear: async () => {}},
    action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}},
    storage: {local: {
      get: async key => structuredClone(key === null ? saved : {[key]: saved[key]}),
      set: async values => { await beforeWrite(values); writes.push(structuredClone(values)); Object.assign(saved, structuredClone(values)); }
    }}
  };
  globalThis.fetch = async () => ({json: async () => ['AT', 'EE', 'NO', 'PL']});
  const send = message => new Promise(resolveReply => listeners.message(message, {id: 'b'.repeat(32)}, resolveReply));
  try {
    const root = process.env.CP_EXTENSION_ROOT || resolve('extension');
    await import(pathToFileURL(resolve(root, 'background.js')).href + '?favorites=' + crypto.randomUUID());
    assert.equal((await send({action: 'sourceQuality', country: 'NO'})).ok, true);
    writes.length = 0;
    await run({saved, writes, send, intercept: callback => { beforeWrite = callback; }});
  } finally { globalThis.chrome = originalChrome; globalThis.fetch = originalFetch; }
}

test('stale full replacement cannot erase another window favorite', () => withWorker(async ({send, saved, writes}) => {
  const reply = await send({action: 'settings', countries: ['NO', 'AT']});
  assert.equal(reply.ok, false, 'obsolete whole-array writer must be rejected');
  assert.deepEqual(saved.countries, ['NO']);
  assert.deepEqual(writes, []);
}));

test('concurrent popup/settings deltas serialize from the latest committed favorites', () => withWorker(async ({send, saved, intercept, writes}) => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let first = true;
  intercept(async values => {
    assert.deepEqual(Object.keys(values), ['countries']);
    if (first) { first = false; entered.resolve(); await release.promise; }
  });
  const popup = send({action: 'settings', add: ['EE'], remove: []});
  await entered.promise;
  const options = send({action: 'settings', add: ['AT'], remove: []});
  const remove = send({action: 'settings', add: [], remove: ['NO']});
  release.resolve();
  assert.ok((await Promise.all([popup, options, remove])).every(reply => reply.ok));
  assert.deepEqual(saved.countries, ['EE', 'AT']);
  assert.deepEqual(writes.map(write => write.countries), [['NO', 'EE'], ['NO', 'EE', 'AT'], ['EE', 'AT']]);
  assert.equal(saved.selected, 'NO'); assert.equal(saved.enabled, false); assert.equal(saved.status.phase, 'off');
}));

test('failed favorite persistence preserves live status and queue recovers for another writer and retry', () => withWorker(async ({send, saved, writes, intercept}) => {
  const status = structuredClone(saved.status);
  let fail = true;
  intercept(async () => { if (fail) { fail = false; throw Error('storage denied'); } });
  const denied = send({action: 'settings', add: ['EE'], remove: []});
  const next = send({action: 'settings', add: ['AT'], remove: []});
  assert.equal((await denied).ok, false);
  assert.equal((await next).ok, true);
  assert.deepEqual(saved.countries, ['NO', 'AT']);
  assert.deepEqual(saved.status, status);
  assert.equal((await send({action: 'settings', add: ['EE'], remove: []})).ok, true);
  assert.deepEqual(saved.countries, ['NO', 'AT', 'EE']);
  assert.ok(writes.every(value => Object.keys(value).join() === 'countries'));
}));

test('invalid and oversized deltas are rejected atomically; explicit last commit wins and empty favorites persist', () => withWorker(async ({send, saved, writes}) => {
  for (const message of [
    {add: ['EE'], remove: ['XX']}, {add: ['EE'], remove: ['EE']},
    {add: ['EE','EE','EE','EE','EE'], remove: []}, {add: ['ee'], remove: []},
    {add: ['EE'], remove: [], countries: []}, {add: ['EE']}, {add: [], remove: [], enabled: true}
  ]) assert.equal((await send({action: 'settings', ...message})).ok, false);
  assert.deepEqual(writes, []); assert.deepEqual(saved.countries, ['NO']);
  const replies = await Promise.all([
    send({action: 'settings', add: ['EE'], remove: []}),
    send({action: 'settings', add: [], remove: ['EE','NO']}),
    send({action: 'settings', add: ['EE'], remove: []}),
    send({action: 'settings', add: [], remove: ['EE']})
  ]);
  assert.ok(replies.every(reply => reply.ok)); assert.deepEqual(saved.countries, []);
}));

// Synthetic cold-start profile: a foreign owner masks an enabled multi-country
// selection. Exercise the real worker/message adapter without re-importing it
// between failure, preference edits, owner release and explicit recovery.
async function withForeignStartup(run, {releaseDuringCatalog = false, invalidSelection = false, rejectRestoredSave = false, releaseBeforeInitial = false, foreignInitially = true} = {}) {
  const originalChrome = globalThis.chrome, originalFetch = globalThis.fetch;
  const saved = {countries: ['NO'], selected: null, selectedCountries: ['AT', 'EE', 'NO'],
    selectionMode: 'multiple', enabled: true};
  if (invalidSelection) saved.selectedCountries = ['AT', 'XX'];
  const gate = dnrFixture(), listeners = {}, nativeStarts = [], proxyWrites = [];
  let foreign = foreignInitially, ownRoute = null, fetchedCatalog = 0;
  const initialRelease = Promise.withResolvers();
  const event = name => ({addListener: callback => { listeners[name] = callback; }});
  const privacySettings = Object.fromEntries(Object.entries({webRTCIPHandlingPolicy:'disable_non_proxied_udp',networkPredictionEnabled:false}).map(([name,value]) =>
    [name, {onChange:event(name),get:async()=>({value,levelOfControl:'controlled_by_this_extension'}),clear:async()=>{},set:async()=>{}}]));
  globalThis.chrome = {
    declarativeNetRequest: gate.api,
    proxy: {settings: {
      get: async () => ({levelOfControl: foreign ? 'controlled_by_other_extensions' :
        ownRoute ? 'controlled_by_this_extension' : 'controllable_by_this_extension',
        value: foreign ? {mode: 'direct'} : ownRoute}),
      set: async ({value}) => { assert.equal(foreign, false, 'never replace a foreign owner'); proxyWrites.push(value); ownRoute = value; },
      clear: async () => {
        ownRoute = null;
        if (releaseBeforeInitial && foreign) setImmediate(() => { foreign = false; initialRelease.resolve(); });
      }, onChange: event('route')
    }, onProxyError: event('proxyError')},
    privacy: {network: privacySettings},
    runtime: {id: 'b'.repeat(32), getURL: name => name, onMessage: event('message'), onStartup: event('startup'),
      connectNative: () => {
        const port = {postMessage: message => { if (message.command === 'start') nativeStarts.push(message); },
          disconnect: () => {}, onDisconnect: event('nativeLost'), onMessage: {addListener: callback => {
            queueMicrotask(() => callback({type: 'hello', feedbackProtocol: 1}));
          }}};
        return port;
      }},
    alarms: {onAlarm: event('alarm'), clear: async () => {}, create: async () => {}},
    action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}},
    storage: {local: {get: async key => {
      if (releaseBeforeInitial && key === 'enabled') await initialRelease.promise;
      return structuredClone(key === null ? saved : {[key]: saved[key]});
    },
      set: async values => {
        if (rejectRestoredSave && values.enabled === true && values.selectionMode) throw Error('transient restore save failure');
        Object.assign(saved, structuredClone(values));
      }}}
  };
  globalThis.fetch = async url => {
    assert.equal(url, 'countries.json'); fetchedCatalog++;
    assert.equal(gate.state.dynamic.filter(rule => rule.action.type === 'block').length, 18,
      'hold ordinary requests before loading settings/catalog');
    assert.deepEqual(gate.state.session, [], 'discard old probe admission at startup');
    if (releaseDuringCatalog) foreign = false;
    return {json: async () => ['AT', 'EE', 'NO', 'PL']};
  };
  const send = message => new Promise(resolveReply => listeners.message(message, {id: 'b'.repeat(32)}, resolveReply));
  try {
    const root = process.env.CP_EXTENSION_ROOT || resolve('extension');
    await import(pathToFileURL(resolve(root, 'background.js')).href + '?foreign-startup=' + crypto.randomUUID());
    await send({action: 'sourceQuality', country: 'NO'}); // Await complete startup.
    await run({saved, gate, send, nativeStarts, proxyWrites, listeners,
      fetchedCatalog: () => fetchedCatalog, releaseOwner: () => { foreign = false; }});
  } finally {
    await send({action: 'disconnect'}); // Clear native handshake/timers before restoring globals.
    globalThis.chrome = originalChrome; globalThis.fetch = originalFetch;
  }
}

for (const stopBeforeRetry of [false, true]) {
  test(`enabled cold start under foreign owner recovers in the same worker ${stopBeforeRetry ? 'after Stop' : 'with Retry'}`, () =>
    withForeignStartup(async ({saved, gate, send, nativeStarts, proxyWrites, listeners, fetchedCatalog, releaseOwner}) => {
      assert.equal(fetchedCatalog(), 1, 'route refusal must not skip independent settings initialization');
      assert.equal(saved.status.phase, 'error');
      assert.equal(saved.status.lastFailure?.stage, 'local', 'popup exposes explicit Retry');
      assert.deepEqual(saved.status.countries, ['AT', 'EE', 'NO']);
      assert.equal(saved.enabled, true);
      assert.equal((await send({action: 'settings', add: ['EE'], remove: []})).ok, true);
      assert.deepEqual(saved.countries, ['NO', 'EE']);
      assert.deepEqual(proxyWrites, []); assert.deepEqual(nativeStarts, []);
      await listeners.alarm({name: 'reconnect'});
      assert.deepEqual(proxyWrites, []); assert.deepEqual(nativeStarts, []);
      assert.equal(gate.state.dynamic.filter(rule => rule.action.type === 'block').length, 18);
      assert.deepEqual(gate.state.session, []);
      if (stopBeforeRetry) {
        assert.equal((await send({action: 'disconnect'})).ok, true);
        assert.equal(saved.status.phase, 'off'); assert.equal(saved.enabled, false);
        assert.deepEqual(gate.state.dynamic, []);
      }
      releaseOwner();
      await listeners.alarm({name: 'reconnect'});
      assert.deepEqual(proxyWrites, [], 'owner release alone must not acquire proxy settings');
      assert.deepEqual(nativeStarts, []);
      assert.equal((await send({action: 'connect', countries: ['NO', 'AT', 'EE']})).ok, true);
      assert.equal(saved.status.phase, 'searching', 'no connection claim before browser proof');
      assert.deepEqual(saved.selectedCountries, ['AT', 'EE', 'NO']);
      assert.equal(nativeStarts.length, 1);
      assert.deepEqual(nativeStarts[0].countries, ['AT', 'EE', 'NO']);
      assert.equal(gate.state.dynamic.filter(rule => rule.action.type === 'block').length, 18);
      assert.deepEqual(gate.state.session, [], 'retry does not admit unverified requests');
    }));
}


test('a foreign owner releasing during bootstrap still requires an explicit Retry', () =>
  withForeignStartup(async ({saved, send, proxyWrites, nativeStarts, listeners, gate}) => {
    assert.equal(saved.status.lastFailure?.stage, 'local');
    assert.deepEqual(proxyWrites, []); assert.deepEqual(nativeStarts, []);
    await listeners.alarm({name: 'reconnect'});
    assert.deepEqual(proxyWrites, []); assert.deepEqual(nativeStarts, []);
    assert.equal(gate.state.dynamic.filter(rule => rule.action.type === 'block').length, 18);
    assert.equal((await send({action: 'connect', countries: ['NO', 'EE', 'AT']})).ok, true);
    assert.deepEqual(nativeStarts[0].countries, ['AT', 'EE', 'NO']);
  }, {releaseDuringCatalog: true}));

test('invalid saved selection plus foreign startup stays blocked and preferences remain usable', () =>
  withForeignStartup(async ({saved, send, gate, fetchedCatalog, releaseOwner, proxyWrites, nativeStarts}) => {
    assert.equal(fetchedCatalog(), 1);
    assert.equal(saved.enabled, true);
    assert.equal(saved.status.phase, 'error');
    assert.match(saved.status.error, /Сохранённый выбор стран недоступен/);
    assert.equal(saved.status.lastFailure?.stage, 'local');
    assert.deepEqual(saved.selectedCountries, ['AT', 'XX'], 'never silently shrink an invalid enabled set');
    assert.deepEqual(proxyWrites, []); assert.deepEqual(nativeStarts, []);
    assert.equal(gate.state.dynamic.filter(rule => rule.action.type === 'block').length, 18);
    assert.equal((await send({action: 'settings', add: ['EE'], remove: []})).ok, true);
    assert.equal((await send({action: 'connect', countries: ['AT', 'XX']})).ok, false);
    releaseOwner();
    assert.equal((await send({action: 'connect', countries: ['NO', 'EE', 'AT']})).ok, true);
    assert.deepEqual(saved.selectedCountries, ['AT', 'EE', 'NO']);
    assert.equal(saved.status.phase, 'searching');
  }, {invalidSelection: true}));


test('remembered startup ownership loss wins over a transient restore save error', () =>
  withForeignStartup(async ({saved, proxyWrites, nativeStarts, listeners, gate}) => {
    assert.equal(saved.status.lastFailure?.stage, 'local');
    assert.match(saved.status.error, /Chrome не подтвердил непрерывное управление маршрутом/);
    assert.deepEqual(proxyWrites, []);
    assert.deepEqual(nativeStarts, []);
    await listeners.alarm({name: 'reconnect'});
    assert.deepEqual(proxyWrites, []);
    assert.equal(gate.state.dynamic.filter(rule => rule.action.type === 'block').length, 18);
  }, {releaseDuringCatalog: true, rejectRestoredSave: true}));


test('foreign owner observed before initial enabled read requires Retry even after release', () =>
  withForeignStartup(async ({saved, send, nativeStarts, proxyWrites, listeners, gate}) => {
    assert.equal(saved.status.phase, 'error');
    assert.equal(saved.status.lastFailure?.stage, 'local');
    assert.match(saved.status.error, /Chrome не подтвердил непрерывное управление маршрутом/);
    assert.deepEqual(nativeStarts, []); assert.deepEqual(proxyWrites, []);
    await listeners.alarm({name: 'reconnect'});
    assert.deepEqual(nativeStarts, []); assert.deepEqual(proxyWrites, []);
    assert.equal(gate.state.dynamic.filter(rule => rule.action.type === 'block').length, 18);
    assert.deepEqual(gate.state.session, []);
    assert.equal((await send({action: 'connect', countries: ['NO', 'AT', 'EE']})).ok, true);
    assert.deepEqual(nativeStarts.map(start => start.countries), [['AT', 'EE', 'NO']]);
  }, {releaseBeforeInitial: true}));

test('fresh worker without an observed ownership conflict restores saved enabled selection', () =>
  withForeignStartup(async ({saved, nativeStarts, gate}) => {
    assert.equal(saved.status.phase, 'searching');
    assert.deepEqual(nativeStarts.map(start => start.countries), [['AT', 'EE', 'NO']]);
    assert.deepEqual(gate.state.session, []);
  }, {foreignInitially: false}));

// Run the production render function and its registered Connect click handler.
// The DOM adapter only records rendered state/actions; selection logic is never
// copied into the test. The isolated Chrome oracle exercises the complete DOM.
async function popupRecoveryAction(selectedCountries, enabled = true) {
  const root = process.env.CP_EXTENSION_ROOT || resolve('extension');
  const source = await readFile(resolve(root, 'popup.js'), 'utf8');
  const elements = new Map(), sent = [];
  let pickerCount = 0;
  const $ = id => {
    if (!elements.has(id)) elements.set(id, {hidden: false, textContent: '',
      addEventListener: (name, callback) => { elements.get(id)[name] = callback; }});
    return elements.get(id);
  };
  const state = {enabled, countries: ['NO'], selected: null, selectedCountries,
    selectionMode: 'multiple', status: {phase: enabled ? 'error' : 'off', lastFailure: {stage: 'local'}}};
  const context = vm.createContext({$, validFavorites, restoreCountrySettings, statusDetail, hasRejectedHealthCountry,
    announceStatus: createStatusAnnouncer($('status-announcement')),
    chrome: {storage: {local: {get: async () => state}}, proxy: {settings: {get: async () => null}}},
    sourceSelection() {}, renderReserveDiagnostics() {}, pickerOpen: () => false,
    renderCountries() {}, closePicker() {}, matchesEffectiveRoute: () => false,
    openPicker: () => pickerCount++, connect: message => sent.push(message),
    chooseCountry: country => sent.push({action: 'connect', country}),
    sameCountries: (a,b) => JSON.stringify(a) === JSON.stringify(b),
    labels: {}, reasons: {}, byCode: new Map(), labelFor: code => code});
  vm.runInContext(`let catalog = [{code:'AT'}, {code:'EE'}, {code:'NO'}], favorites = [], selectedCountries = [],
    selectionMode = 'single', selectionInvalid = false, draftMode, draftCountries, applying = false, lastCountryState = '';` +
    source.slice(source.indexOf('let renderRevision = 0;'), source.indexOf("$('mode-single').addEventListener")) +
    source.slice(source.indexOf("$('connect').addEventListener"), source.indexOf("$('disconnect').addEventListener")), context);
  await vm.runInContext('render()', context);
  $('connect').click();
  return {button: $('connect'), pickerCount, sent, state};
}

test('rendered popup routes mixed invalid intent to picker instead of a truncated Retry, including after Stop', async () => {
  for (const enabled of [true, false]) {
    const actual = await popupRecoveryAction(['AT', 'XX'], enabled);
    assert.equal(actual.button.hidden, false);
    assert.equal(actual.button.textContent, 'Выбрать страны заново');
    assert.equal(actual.pickerCount, 1);
    assert.deepEqual(actual.sent, []);
    assert.deepEqual(actual.state.selectedCountries, ['AT', 'XX']);
  }
  const valid = await popupRecoveryAction(['AT', 'EE', 'NO']);
  assert.equal(valid.button.hidden, false);
  assert.equal(valid.button.textContent, 'Повторить подключение');
  assert.equal(valid.pickerCount, 0);
  assert.equal(JSON.stringify(valid.sent), JSON.stringify([{action:'connect', countries:['AT','EE','NO']}]));
});

// Pause real worker dependencies, rather than reimplementing its startup logic.
// A snapshot is taken before a delayed storage read returns: Stop must also win
// over a stale enabled=true value already being read by the waking worker.
async function withDelayedStartup(pause, run, {failCatalog = false, failBadge = false} = {}) {
  const originalChrome = globalThis.chrome, originalFetch = globalThis.fetch;
  const saved = {enabled: true, selected: 'NO', countries: [], selectionMode: 'single',
    status: {phase: 'connected'}};
  const gate = dnrFixture(gateRules('b'.repeat(32), 'a'.repeat(32)));
  const listeners = {}, nativeCalls = [], writes = [];
  const badge = {text: null, color: null, writes: [], errors: 0};
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let paused = false;
  const delay = async stage => {
    if (stage !== pause || paused) return;
    paused = true; entered.resolve(); await release.promise;
  };
  const event = name => ({addListener: callback => { listeners[name] = callback; }});
  const setting = (name, initial) => {
    let value = initial, owned = initial !== null;
    return {onChange: event(name),
      get: async () => ({levelOfControl: owned ? 'controlled_by_this_extension' : 'controllable_by_this_extension', value}),
      set: async input => { await delay(name); value = input.value; owned = true; },
      clear: async () => { owned = false; value = null; }};
  };
  const proxy = setting('proxyWrite', {mode: 'fixed_servers'});
  globalThis.chrome = {
    declarativeNetRequest: gate.api,
    proxy: {settings: proxy, onProxyError: event('proxyError')},
    privacy: {network: {
      webRTCIPHandlingPolicy: setting('webRTC', 'disable_non_proxied_udp'),
      networkPredictionEnabled: setting('prediction', false)}},
    runtime: {id: 'b'.repeat(32), getURL: name => name,
      onMessage: event('message'), onStartup: event('startup'),
      connectNative: () => {
        nativeCalls.push({command: 'connectNative'});
        return {onDisconnect: event('nativeLost'), disconnect() {},
          onMessage: {addListener: callback => queueMicrotask(() => callback({type: 'hello', feedbackProtocol: 1}))},
          postMessage: message => nativeCalls.push(structuredClone(message))};
      }},
    storage: {local: {
      get: async key => {
        const snapshot = structuredClone(key === null ? saved : {[key]: saved[key]});
        if (key === 'enabled') await delay('initialRead');
        return snapshot;
      },
      set: async values => {
        if (values.enabled === true && values.selectionMode) await delay('restoreSave');
        writes.push(structuredClone(values)); Object.assign(saved, structuredClone(values));
      }}},
    alarms: {onAlarm: event('alarm'), create: async () => {}, clear: async () => {}},
    action: {
      setBadgeText: async ({text}) => {
        await delay('startupBadge');
        if (failBadge) { badge.errors++; throw Error('badge unavailable'); }
        badge.text = text; badge.writes.push({text});
      },
      setBadgeBackgroundColor: async ({color}) => {
        await delay('startupBadgeColor');
        if (failBadge) { badge.errors++; throw Error('badge unavailable'); }
        badge.color = color; badge.writes.push({color});
      }}
  };
  globalThis.fetch = async () => {
    await delay('catalog');
    if (failCatalog) throw Error('catalog unavailable');
    return {json: async () => ['AT', 'EE', 'NO']};
  };
  const send = (message, sender = {id: 'b'.repeat(32)}) =>
    new Promise(resolveReply => listeners.message(message, sender, resolveReply));
  const tick = () => new Promise(resolveTick => setImmediate(resolveTick));
  try {
    const root = process.env.CP_EXTENSION_ROOT || resolve('extension');
    await import(pathToFileURL(resolve(root, 'background.js')).href + '?delayed-startup=' + crypto.randomUUID());
    await entered.promise;
    await run({saved, gate, nativeCalls, writes, send, tick, listeners, badge,
      release: () => release.resolve(), proxy});
  } finally {
    release.resolve();
    await send({action: 'sourceQuality', country: 'NO'}); // Drain any delayed restore.
    await send({action: 'disconnect'});
    await tick(); // Drain cosmetic badge jobs, which cannot block durable intent.
    globalThis.chrome = originalChrome; globalThis.fetch = originalFetch;
  }
}

for (const pause of ['initialRead', 'catalog', 'proxyWrite']) {
  test(`startup Stop persists before delayed ${pause} and prevents the saved native Start`, () =>
    withDelayedStartup(pause, async ({send, tick, saved, gate, nativeCalls, release, proxy}) => {
      const stopped = send({action: 'disconnect'});
      await tick();
      assert.equal(saved.enabled, false, 'persist Stop without awaiting startup storage/catalog/proxy');
      assert.deepEqual(gate.state.session, [], 'never retain session admission while stopping');
      assert.deepEqual(nativeCalls, [], 'Stop must not first launch the saved helper session');
      if (pause !== 'proxyWrite') {
        assert.equal((await stopped).ok, true, 'independent cleanup can finish before startup resumes');
        assert.equal(saved.status.phase, 'off');
      } else assert.equal(saved.status.phase, 'stopping', 'pending Chrome protection joins cleanup');
      release();
      assert.equal((await stopped).ok, true);
      await send({action: 'sourceQuality', country: 'NO'});
      assert.equal(saved.enabled, false); assert.equal(saved.status.phase, 'off');
      assert.deepEqual(nativeCalls, []);
      assert.deepEqual(gate.state.dynamic, []); assert.deepEqual(gate.state.session, []);
      assert.equal((await proxy.get()).levelOfControl, 'controllable_by_this_extension');
    }));
}

test('Stop invalidates an already pending restore save; its late completion cannot launch native or restore enabled', () =>
  withDelayedStartup('restoreSave', async ({send, tick, saved, gate, nativeCalls, release, writes}) => {
    const stopped = send({action: 'disconnect'});
    await tick();
    assert.deepEqual(gate.state.session, []);
    assert.deepEqual(nativeCalls, []);
    release();
    assert.equal((await stopped).ok, true);
    assert.equal(saved.enabled, false); assert.equal(saved.status.phase, 'off');
    assert.deepEqual(nativeCalls, []);
    assert.equal(writes.filter(value => Object.hasOwn(value, 'enabled')).at(-1).enabled, false);
    assert.deepEqual(gate.state.dynamic, []);
  }));

test('repeated startup Stop preserves command order and a newer explicit equal-set Connect succeeds', () =>
  withDelayedStartup('catalog', async ({send, tick, saved, gate, nativeCalls, release}) => {
    const firstStop = send({action: 'disconnect'});
    const staleConnect = send({action: 'connect', country: 'NO'});
    const secondStop = send({action: 'disconnect'});
    await tick();
    assert.equal(saved.enabled, false);
    assert.deepEqual(nativeCalls, []);
    release();
    assert.ok((await Promise.all([firstStop, staleConnect, secondStop])).every(reply => reply.ok));
    assert.equal(saved.enabled, false, 'the later Stop cancels a Connect still waiting on startup');
    assert.deepEqual(nativeCalls, []);
    assert.deepEqual(gate.state.dynamic, []);
    assert.equal((await send({action: 'connect', countries: ['NO', 'AT', 'EE']})).ok, true);
    assert.equal(saved.enabled, true); assert.equal(saved.status.phase, 'searching');
    assert.deepEqual(saved.selectedCountries, ['AT', 'EE', 'NO']);
    assert.deepEqual(nativeCalls.filter(value => value.command === 'start').map(value => value.countries), [['AT', 'EE', 'NO']]);
    assert.equal(gate.state.dynamic.filter(rule => rule.action.type === 'block').length, 18);
    assert.deepEqual(gate.state.session, [], 'new explicit Start has no admission before HTTPS/country proof');
  }));

test('a newer Connect received during delayed startup supersedes earlier Stops', () =>
  withDelayedStartup('catalog', async ({send, tick, saved, nativeCalls, release}) => {
    const first = send({action: 'disconnect'}), second = send({action: 'disconnect'});
    const connected = send({action: 'connect', countries: ['EE', 'AT']});
    await tick(); assert.equal(saved.enabled, false);
    release();
    assert.ok((await Promise.all([first, second, connected])).every(reply => reply.ok));
    assert.equal(saved.enabled, true);
    assert.deepEqual(nativeCalls.filter(value => value.command === 'start').map(value => value.countries), [['AT', 'EE']]);
  }));

test('unauthorized or malformed startup messages do not cancel the saved enabled intent', () =>
  withDelayedStartup('catalog', async ({send, tick, saved, nativeCalls, release, listeners}) => {
    let foreignReply = false;
    assert.equal(listeners.message({action: 'disconnect'}, {id: 'a'.repeat(32)}, () => { foreignReply = true; }), undefined);
    const malformed = [null, [], 'disconnect', {action: 'disconnect', enabled: false},
      {action: 'disconnect', country: null}, {action: 'disconnect', country: ['JP']}, {action: 'missing'}]
      .map(message => send(message));
    await tick();
    assert.equal(saved.enabled, true); assert.equal(foreignReply, false);
    release();
    assert.ok((await Promise.all(malformed)).every(reply => reply.ok === false));
    await send({action: 'sourceQuality', country: 'NO'});
    assert.equal(saved.enabled, true);
    assert.deepEqual(nativeCalls.filter(value => value.command === 'start').map(value => value.countries), [['NO']]);
  }));

test('catalog failure after an accepted startup Stop cannot overwrite completed off status', () =>
  withDelayedStartup('catalog', async ({send, tick, saved, nativeCalls, release}) => {
    const stopped = send({action: 'disconnect'});
    await tick(); assert.equal(saved.enabled, false);
    assert.equal((await stopped).ok, true);
    release();
    await send({action: 'sourceQuality', country: 'NO'});
    assert.equal(saved.enabled, false); assert.equal(saved.status.phase, 'off');
    assert.deepEqual(nativeCalls, []);
  }, {failCatalog: true}));

for (const pause of ['startupBadge', 'startupBadgeColor']) {
  test(`Stop saves durable off state and completes cleanup while ${pause} is pending`, () =>
    withDelayedStartup(pause, async ({send, tick, saved, gate, release, proxy, badge}) => {
      const stopped = send({action: 'disconnect'});
      await tick();
      assert.equal(saved.enabled, false, 'cosmetic API completion cannot delay durable Stop');
      assert.equal(saved.status.phase, 'off');
      assert.equal((await stopped).ok, true);
      assert.deepEqual(gate.state.session, []); assert.deepEqual(gate.state.dynamic, []);
      assert.equal((await proxy.get()).levelOfControl, 'controllable_by_this_extension');
      release(); await tick();
      assert.equal(saved.enabled, false); assert.equal(saved.status.phase, 'off');
      assert.equal(badge.text, '', 'latest off badge replaces any delayed older text');
      assert.equal(badge.color, '#ad6b2f');
      assert.equal(badge.writes.filter(value => Object.hasOwn(value, 'color')).length, pause === 'startupBadge' ? 1 : 2,
        'a superseded pending text must not start its old color write');
    }));
}

test('a newer explicit Connect persists while an older badge is pending and owns the final badge', () =>
  withDelayedStartup('startupBadge', async ({send, tick, saved, nativeCalls, release, badge}) => {
    const stopped = send({action: 'disconnect'});
    await tick();
    assert.equal(saved.enabled, false);
    assert.equal((await stopped).ok, true);
    assert.equal((await send({action: 'connect', countries: ['EE', 'AT']})).ok, true);
    assert.equal(saved.enabled, true); assert.equal(saved.status.phase, 'searching');
    assert.deepEqual(nativeCalls.filter(value => value.command === 'start').at(-1).countries, ['AT', 'EE']);
    release(); await tick();
    assert.equal(saved.enabled, true); assert.equal(saved.status.phase, 'searching');
    assert.equal(badge.text, '…');
    assert.equal(badge.writes.some(value => value.text === ''), false, 'skip obsolete queued off badge after newer Start');
    assert.equal(badge.writes.filter(value => Object.hasOwn(value, 'color')).length, 1);
  }));

test('badge API errors remain cosmetic: Stop persists off, releases protections and returns success', () =>
  withDelayedStartup('catalog', async ({send, tick, saved, gate, release, badge}) => {
    const stopped = send({action: 'disconnect'});
    await tick();
    assert.equal((await stopped).ok, true, 'badge failure must not report a failed disconnection');
    assert.equal(saved.enabled, false); assert.equal(saved.status.phase, 'off');
    assert.ok(badge.errors > 0, 'the badge failure was exercised');
    assert.deepEqual(gate.state.dynamic, []); assert.deepEqual(gate.state.session, []);
    release();
    await send({action: 'sourceQuality', country: 'NO'});
    assert.equal(saved.status.phase, 'off');
    assert.equal((await send({action: 'connect', country: 'EE'})).ok, true, 'cosmetic failure cannot poison the durable queue');
    assert.equal(saved.enabled, true); assert.equal(saved.status.phase, 'searching');
  }, {failBadge: true}));

// Storage failures are permitted Chrome API outcomes. Retry services in the same
// worker, with all Chrome/network dependencies synthetic and explicitly paused.
async function withRecoverableStartup(failedStage, run, {failErrorWrites = 0, beforeErrorWrite = async () => {}, awaitStartup = true} = {}) {
  const originalChrome = globalThis.chrome, originalFetch = globalThis.fetch;
  const saved = {enabled: true, selected: null, selectionMode: 'multiple',
    selectedCountries: ['AT', 'EE', 'NO'], countries: ['NO'], status: {phase: 'connected'}};
  const gate = dnrFixture(gateRules('b'.repeat(32), 'a'.repeat(32)));
  const listeners = {}, starts = [], writes = [], reads = [];
  let failureStage = failedStage, before = async () => {}, catalogReads = 0;
  const event = name => ({addListener: callback => { listeners[name] = callback; }});
  const step = async stage => {
    await before(stage);
    if (stage === failureStage) { failureStage = null; throw Error('transient ' + stage + ' failure'); }
  };
  const setting = value => {
    let current = value;
    return {get: async () => ({value: current, levelOfControl: current === null ?
      'controllable_by_this_extension' : 'controlled_by_this_extension'}),
    set: async ({value}) => { current = value; }, clear: async () => { current = null; }};
  };
  globalThis.chrome = {
    declarativeNetRequest: gate.api,
    proxy: {settings: {...setting(null), onChange: event('route')}, onProxyError: event('proxyError')},
    privacy: {network: {webRTCIPHandlingPolicy: setting('disable_non_proxied_udp'), networkPredictionEnabled: setting(false)}},
    runtime: {id: 'b'.repeat(32), getURL: name => name, onMessage: event('message'), onStartup: event('startup'),
      connectNative: () => ({postMessage: message => { if (message.command === 'start') starts.push(message); },
        disconnect() {}, onDisconnect: event('nativeLost'),
        onMessage: {addListener: callback => queueMicrotask(() => callback({type: 'hello', feedbackProtocol: 1}))}})},
    alarms: {onAlarm: event('alarm'), clear: async () => {}, create: async () => {}},
    action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}},
    storage: {local: {get: async key => {
      reads.push(key); await step(key === 'enabled' ? 'initialRead' : key === null ? 'savedRead' : 'favoritesRead');
      return structuredClone(key === null ? saved : {[key]: saved[key]});
    }, set: async values => {
      if (values.status?.phase === 'error') {
        await beforeErrorWrite(values);
        if (failErrorWrites > 0) { --failErrorWrites; throw Error('transient error-status write failure'); }
      }
      writes.push(structuredClone(values)); Object.assign(saved, structuredClone(values));
    }}}
  };
  globalThis.fetch = async () => {
    ++catalogReads; await step('catalog'); return {json: async () => ['AT', 'EE', 'NO']};
  };
  const send = message => new Promise(resolveReply => listeners.message(message, {id: 'b'.repeat(32)}, resolveReply));
  const tick = () => new Promise(resolveTick => setImmediate(resolveTick));
  try {
    const root = process.env.CP_EXTENSION_ROOT || resolve('extension');
    await import(pathToFileURL(resolve(root, 'background.js')).href + '?recoverable-startup=' + crypto.randomUUID());
    if (awaitStartup) await send({action: 'sourceQuality', country: 'NO'});
    await run({saved, gate, starts, writes, reads, send, tick, listeners,
      catalogReads: () => catalogReads, fail: stage => { failureStage = stage; },
      intercept: callback => { before = callback; }});
  } finally {
    before = async () => {}; failureStage = null;
    await send({action: 'disconnect'}); await tick();
    globalThis.chrome = originalChrome; globalThis.fetch = originalFetch;
  }
}

for (const stage of ['initialRead', 'savedRead', 'catalog']) {
  test(`explicit Retry repairs ${stage} startup failure without worker reload or saved-intent replay`, () =>
    withRecoverableStartup(stage, async ({saved, send, starts, gate}) => {
      assert.equal(saved.status.phase, 'error');
      assert.equal(saved.status.lastFailure?.stage, 'local', 'popup must expose Retry for enabled local startup errors');
      assert.match(saved.status.error, /transient/);
      assert.deepEqual(starts, []); assert.deepEqual(gate.state.session, []);
      assert.equal((await send({action: 'connect', countries: ['NO', 'EE', 'AT']})).ok, true);
      assert.equal(saved.status.phase, 'searching');
      assert.deepEqual(starts.map(start => start.countries), [['AT', 'EE', 'NO']], 'only explicit intent starts');
      assert.equal((await send({action: 'settings', add: ['EE'], remove: []})).ok, true);
      assert.deepEqual(saved.countries, ['NO', 'EE']);
      assert.deepEqual(gate.state.session, [], 'no admission until independent HTTPS/country proof');
    }));
}

test('Stop then Connect repairs a first-read failure without restoring the saved selection first', () =>
  withRecoverableStartup('initialRead', async ({saved, send, starts, gate}) => {
    assert.equal((await send({action: 'disconnect'})).ok, true);
    assert.equal(saved.enabled, false); assert.equal(saved.status.phase, 'off');
    assert.deepEqual(gate.state.dynamic, []);
    assert.equal((await send({action: 'connect', countries: ['EE', 'AT']})).ok, true);
    assert.deepEqual(starts.map(start => start.countries), [['AT', 'EE']]);
    assert.deepEqual(saved.selectedCountries, ['AT', 'EE']);
  }));

test('repeated initialization rejection remains retryable and does not become an empty-catalog validation error', () =>
  withRecoverableStartup('initialRead', async ({saved, fail, send, starts}) => {
    fail('savedRead');
    const rejected = await send({action: 'connect', countries: ['AT', 'EE']});
    assert.equal(rejected.ok, false); assert.match(rejected.error, /transient savedRead failure/);
    assert.equal(saved.status.lastFailure?.stage, 'local'); assert.deepEqual(starts, []);
    assert.equal((await send({action: 'connect', countries: ['EE', 'AT']})).ok, true);
    assert.deepEqual(starts.map(start => start.countries), [['AT', 'EE']]);
  }));

test('concurrent Retry and favorites edits share initialization and keep one serialized favorites writer', () =>
  withRecoverableStartup('initialRead', async ({send, saved, starts, catalogReads, intercept}) => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    intercept(async stage => { if (stage === 'catalog') { entered.resolve(); await release.promise; } });
    const connect = send({action: 'connect', countries: ['AT', 'EE']});
    await entered.promise;
    const add = send({action: 'settings', add: ['EE'], remove: []});
    const replace = send({action: 'settings', add: ['AT'], remove: ['NO']});
    release.resolve();
    assert.ok((await Promise.all([connect, add, replace])).every(reply => reply.ok));
    assert.equal(catalogReads(), 1, 'share one catalogue retry');
    assert.deepEqual(saved.countries, ['EE', 'AT']);
    assert.deepEqual(starts.map(start => start.countries), [['AT', 'EE']]);
  }));

for (const rejectLate of [false, true]) {
  test(`Stop wins deferred initialization retry${rejectLate ? ' including a late failure' : ''}`, () =>
    withRecoverableStartup('initialRead', async ({send, saved, starts, gate, tick, fail, intercept}) => {
      const entered = Promise.withResolvers(), release = Promise.withResolvers();
      intercept(async stage => { if (stage === 'savedRead') { entered.resolve(); await release.promise; } });
      if (rejectLate) fail('savedRead');
      const retry = send({action: 'connect', countries: ['AT', 'EE']});
      await entered.promise;
      assert.equal((await send({action: 'disconnect'})).ok, true, 'Stop must not wait for retry services');
      assert.equal(saved.status.phase, 'off'); assert.equal(saved.enabled, false);
      release.resolve(); await retry; await tick();
      assert.equal(saved.status.phase, 'off'); assert.equal(saved.enabled, false);
      assert.deepEqual(starts, []); assert.deepEqual(gate.state.dynamic, []); assert.deepEqual(gate.state.session, []);
    }));
}

test('a newer explicit Connect owns the final selection after a shared delayed initialization retry', () =>
  withRecoverableStartup('initialRead', async ({send, starts, saved, intercept}) => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    intercept(async stage => { if (stage === 'catalog') { entered.resolve(); await release.promise; } });
    const old = send({action: 'connect', countries: ['AT', 'NO']});
    await entered.promise;
    const stopped = send({action: 'disconnect'});
    const newest = send({action: 'connect', countries: ['AT', 'EE']});
    await stopped; release.resolve();
    assert.ok((await Promise.all([old, newest])).every(reply => reply.ok));
    assert.equal(saved.enabled, true); assert.deepEqual(saved.selectedCountries, ['AT', 'EE']);
    assert.deepEqual(starts.map(start => start.countries), [['AT', 'EE']]);
  }));

for (const firstAction of ['connect', 'settings']) {
  test(`double storage failure does not poison readiness: explicit ${firstAction} recovers in the same worker`, () =>
    withRecoverableStartup('initialRead', async ({send, saved, starts, gate}) => {
      if (firstAction === 'settings') {
        assert.equal((await send({action: 'settings', add: ['EE'], remove: []})).ok, true);
        assert.deepEqual(saved.countries, ['NO', 'EE']);
        assert.deepEqual(starts, [], 'preference recovery does not replay enabled intent');
      }
      assert.equal((await send({action: 'connect', countries: ['NO', 'EE', 'AT']})).ok, true);
      assert.deepEqual(starts.map(start => start.countries), [['AT', 'EE', 'NO']]);
      assert.equal(saved.status.phase, 'searching'); assert.equal(saved.enabled, true);
      assert.deepEqual(gate.state.session, []);
    }, {failErrorWrites: 1}));
}

test('Stop then Connect recovers after startup read and diagnostic-write failures without stale error publication', () =>
  withRecoverableStartup('initialRead', async ({send, saved, starts, gate}) => {
    assert.equal((await send({action: 'disconnect'})).ok, true);
    assert.equal(saved.enabled, false); assert.equal(saved.status.phase, 'off');
    assert.equal((await send({action: 'connect', countries: ['EE', 'AT']})).ok, true);
    assert.deepEqual(starts.map(start => start.countries), [['AT', 'EE']]);
    assert.equal(saved.status.phase, 'searching'); assert.equal(saved.enabled, true);
    assert.deepEqual(gate.state.session, []);
  }, {failErrorWrites: 1}));

test('a delayed rejected startup diagnostic cannot revive a preexisting Connect after newer Stop', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let once = true;
  await withRecoverableStartup('initialRead', async ({send, saved, starts, tick, gate}) => {
    await entered.promise;
    const obsolete = send({action: 'connect', countries: ['AT', 'NO']});
    const stopped = send({action: 'disconnect'});
    await tick();
    release.resolve();
    assert.equal((await stopped).ok, true);
    assert.equal((await obsolete).ok, true, 'obsolete Connect settles without launching');
    await tick();
    assert.equal(saved.enabled, false); assert.equal(saved.status.phase, 'off');
    assert.deepEqual(starts, []); assert.deepEqual(gate.state.dynamic, []); assert.deepEqual(gate.state.session, []);
    assert.equal((await send({action: 'connect', countries: ['AT', 'EE']})).ok, true);
    assert.deepEqual(starts.map(start => start.countries), [['AT', 'EE']]);
    assert.equal(saved.status.phase, 'searching');
  }, {failErrorWrites: 1, awaitStartup: false,
    beforeErrorWrite: async () => { if (once) { once = false; entered.resolve(); await release.promise; } }});
});
