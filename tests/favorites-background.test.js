import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {validFavorites} from '../extension/country-catalog.js';
import {restoreCountrySettings} from '../extension/controller.js';
import {dnrFixture} from './dnr-fixture.js';

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
async function withForeignStartup(run, {releaseDuringCatalog = false, invalidSelection = false, rejectRestoredSave = false} = {}) {
  const originalChrome = globalThis.chrome, originalFetch = globalThis.fetch;
  const saved = {countries: ['NO'], selected: null, selectedCountries: ['AT', 'EE', 'NO'],
    selectionMode: 'multiple', enabled: true};
  if (invalidSelection) saved.selectedCountries = ['AT', 'XX'];
  const gate = dnrFixture(), listeners = {}, nativeStarts = [], proxyWrites = [];
  let foreign = true, ownRoute = null, fetchedCatalog = 0;
  const event = name => ({addListener: callback => { listeners[name] = callback; }});
  const setting = {clear: async () => {}, set: async () => {}};
  globalThis.chrome = {
    declarativeNetRequest: gate.api,
    proxy: {settings: {
      get: async () => ({levelOfControl: foreign ? 'controlled_by_other_extensions' :
        ownRoute ? 'controlled_by_this_extension' : 'controllable_by_this_extension',
        value: foreign ? {mode: 'direct'} : ownRoute}),
      set: async ({value}) => { assert.equal(foreign, false, 'never replace a foreign owner'); proxyWrites.push(value); ownRoute = value; },
      clear: async () => { ownRoute = null; }, onChange: event('route')
    }, onProxyError: event('proxyError')},
    privacy: {network: {webRTCIPHandlingPolicy: setting, networkPredictionEnabled: setting}},
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
    storage: {local: {get: async key => structuredClone(key === null ? saved : {[key]: saved[key]}),
      set: async values => {
        if (rejectRestoredSave && values.enabled === true && values.selectionMode) throw Error('transient restore save failure');
        Object.assign(saved, structuredClone(values));
      }}}
  };
  globalThis.fetch = async url => {
    assert.equal(url, 'countries.json'); fetchedCatalog++;
    assert.equal(gate.state.dynamic.filter(rule => rule.action.type === 'block').length, 2,
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
      assert.equal(gate.state.dynamic.filter(rule => rule.action.type === 'block').length, 2);
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
      assert.equal(gate.state.dynamic.filter(rule => rule.action.type === 'block').length, 2);
      assert.deepEqual(gate.state.session, [], 'retry does not admit unverified requests');
    }));
}


test('a foreign owner releasing during bootstrap still requires an explicit Retry', () =>
  withForeignStartup(async ({saved, send, proxyWrites, nativeStarts, listeners, gate}) => {
    assert.equal(saved.status.lastFailure?.stage, 'local');
    assert.deepEqual(proxyWrites, []); assert.deepEqual(nativeStarts, []);
    await listeners.alarm({name: 'reconnect'});
    assert.deepEqual(proxyWrites, []); assert.deepEqual(nativeStarts, []);
    assert.equal(gate.state.dynamic.filter(rule => rule.action.type === 'block').length, 2);
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
    assert.equal(gate.state.dynamic.filter(rule => rule.action.type === 'block').length, 2);
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
    assert.equal(gate.state.dynamic.filter(rule => rule.action.type === 'block').length, 2);
  }, {releaseDuringCatalog: true, rejectRestoredSave: true}));

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
  const context = vm.createContext({$, validFavorites, restoreCountrySettings,
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
