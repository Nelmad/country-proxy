import test from 'node:test';
import assert from 'node:assert/strict';
import {Controller, BLOCKED} from '../extension/controller.js';

const countries = ['AT', 'EE', 'NO'];
const proxy = {scheme: 'http', host: '8.8.8.8', port: 3128, country: 'EE', exitIp: '8.8.4.4'};
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(probe) {
  const observed = {held: false, opened: 0, calls: [], states: [], route: null};
  const api = {
    save: async () => {}, publish: async value => observed.states.push(value),
    startNative: async () => {}, stopNative: async () => {}, reject: async () => {},
    confirm: async () => observed.calls.push('confirm'),
    block: async () => { observed.route = BLOCKED; },
    clear: async () => { observed.held = false; observed.route = null; },
    holdTraffic: async () => { observed.held = true; observed.calls.push('hold'); return 1; },
    allowTraffic: async (ticket, current) => {
      assert.equal(ticket, 1); assert.ok(current());
      observed.held = false; observed.opened++; observed.calls.push('allow'); return true;
    },
    verifyTraffic: async () => {}, verifyRoute: async () => {},
    apply: async value => { observed.calls.push('apply'); observed.route = value; }
  };
  const controller = new Controller(api, probe);
  const offer = (attempt = 1, value = proxy) => ({id: controller.id, feedbackProtocol: 1,
    phase: 'connected', attempt, countries, proxy: value});
  return {observed, api, controller, offer};
}

test('ordinary traffic is held before candidate apply and throughout pending Chrome proof', async () => {
  const done = Promise.withResolvers();
  const {observed, controller, offer} = setup(() => done.promise);
  await controller.start(countries);
  const pending = controller.status(offer()); await tick();
  assert.equal(observed.states.at(-1).phase, 'verifying');
  assert.equal(observed.held, true);
  assert.deepEqual(observed.calls, ['hold', 'apply']);
  done.resolve({ok: true, country: 'EE'}); await pending;
  assert.deepEqual(observed.calls, ['hold', 'apply', 'confirm', 'allow']);
  assert.equal(observed.held, false);
  assert.equal(observed.states.at(-1).phase, 'connected');
});

for (const result of [{ok: false, reason: 'timeout'}, {ok: true, country: 'US'}, {ok: false, reason: 'http'}]) {
  test(`failed or outside-country proof never opens traffic: ${result.reason || result.country}`, async () => {
    const {observed, controller, offer} = setup(async () => result);
    await controller.start(countries); await controller.status(offer());
    assert.equal(observed.held, true); assert.equal(observed.opened, 0);
    assert.deepEqual(observed.route, BLOCKED);
    assert.equal(observed.states.at(-1).phase, 'replacing');
  });
}

test('Stop invalidates held proof without opening traffic on its late success', async () => {
  const done = Promise.withResolvers();
  const {observed, controller, offer} = setup(() => done.promise);
  await controller.start(countries); const pending = controller.status(offer()); await tick();
  const stopping = controller.stop(); done.resolve({ok: true, country: 'EE'});
  await Promise.all([pending, stopping]);
  assert.equal(observed.opened, 0); assert.equal(observed.route, null);
  assert.equal(observed.states.at(-1).phase, 'off');
});

test('same endpoint recheck holds traffic again; cached healthy status does not reopen it', async () => {
  const done = Promise.withResolvers(); let probes = 0;
  const {observed, controller, offer} = setup(() => ++probes === 1 ? {ok: true, country: 'EE'} : done.promise);
  await controller.start(countries); await controller.status(offer());
  await controller.status(offer()); assert.equal(observed.opened, 1);
  const pending = controller.recheck(); await tick();
  assert.equal(observed.held, true); assert.equal(observed.opened, 1);
  done.resolve({ok: true, country: 'EE'}); await pending;
  assert.equal(observed.opened, 2); assert.equal(observed.held, false);
});

test('invalidated hold cannot apply the old candidate', async () => {
  const hold = Promise.withResolvers(), entered = Promise.withResolvers();
  const {observed, api, controller, offer} = setup(async () => ({ok: true, country: 'EE'}));
  api.holdTraffic = async () => { entered.resolve(); await hold.promise; return 1; };
  await controller.start(countries); const pending = controller.status(offer());
  await entered.promise; const stopping = controller.stop(); hold.resolve();
  await Promise.all([pending, stopping]);
  assert.equal(observed.calls.includes('apply'), false);
  assert.equal(observed.opened, 0);
});

test('failed traffic hold never applies candidate and falls back to blocked proxy', async () => {
  const {observed, api, controller, offer} = setup(async () => ({ok: true, country: 'EE'}));
  api.holdTraffic = async () => { throw Error('rule commit failed'); };
  await controller.start(countries); await controller.status(offer());
  assert.equal(observed.calls.includes('apply'), false);
  assert.deepEqual(observed.route, BLOCKED);
  assert.equal(observed.states.at(-1).phase, 'error');
  assert.equal(controller.suspended, true);
});

test('failed admission suspends the session and blocks its qualified candidate', async () => {
  const {observed, api, controller, offer} = setup(async () => ({ok: true, country: 'EE'}));
  api.allowTraffic = async () => { throw Error('admission commit failed'); };
  await controller.start(countries); await controller.status(offer());
  assert.deepEqual(observed.route, BLOCKED);
  assert.equal(observed.opened, 0);
  assert.equal(observed.states.at(-1).phase, 'error');
  assert.equal(controller.active, null); assert.equal(controller.suspended, true);
});
