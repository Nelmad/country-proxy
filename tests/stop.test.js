import {dnrFixture} from './dnr-fixture.js';
import {gateRules} from '../extension/traffic-gate.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Controller} from '../extension/controller.js';

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
    assert.deepEqual(calls.sort(), slots.map(slot => 'clear ' + slot).sort());
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
  assert.equal(gate.state.dynamic.filter(rule => rule.action.type === 'block').length, 2);
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
