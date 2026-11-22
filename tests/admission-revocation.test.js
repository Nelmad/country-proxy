import test from 'node:test';
import assert from 'node:assert/strict';
import {Controller, BLOCKED} from '../extension/controller.js';
import {TrafficGate} from '../extension/traffic-gate.js';
import {dnrFixture} from './dnr-fixture.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const countries = ['AT', 'EE', 'NO'];
function setup(country = 'NO') {
  const dnr = dnrFixture(), gate = new TrafficGate(dnr.api, 'b'.repeat(32));
  const state = {route: null, probes: 0, confirmations: 0, published: []};
  const proxy = {scheme: 'http', host: '8.8.8.8', port: 3128, country, exitIp: '9.9.9.9'};
  const api = {
    holdTraffic: () => gate.hold(), revokeTraffic: () => gate.revoke(),
    allowTraffic: (ticket, current) => gate.allow(ticket, current), verifyTraffic: () => gate.assertOpen(),
    protectRoute: async () => { state.route = BLOCKED; return true; },
    block: async () => { await gate.hold(); state.route = BLOCKED; },
    apply: async route => { state.route = route; },
    verifyRoute: async route => assert.deepEqual(state.route, route),
    clear: async () => { await gate.clear(); state.route = null; },
    save: async () => {}, publish: async event => state.published.push(event),
    startNative: async () => {}, stopNative: async () => {}, reject: async () => {},
    confirm: async () => { state.confirmations++; }
  };
  const c = new Controller(api, async () => { state.probes++; return {ok: true, country}; });
  const event = (phase = 'connected', changes = {}) => ({id: c.id, countries, feedbackProtocol: 1,
    phase, proxy, attempt: 1, ...changes});
  const connect = async () => { await c.start(countries); await c.status(event()); assert.equal(dnr.state.session.length, 2); };
  const busyPool = async () => {
    const entered = Promise.withResolvers(), finish = Promise.withResolvers();
    api.save = async changes => { if (changes.pool) { entered.resolve(); await finish.promise; } };
    const saving = c.status(event('pool', {reserveCount: 1}));
    await entered.promise;
    return {finish, saving};
  };
  return {c, api, state, gate, dnr, proxy, event, connect, busyPool};
}

for (const country of countries) test(`native country-negative revokes and requires fresh Chrome proof: ${country}`, async () => {
  const {c, dnr, state, event, connect, busyPool} = setup(country);
  await connect();
  const {finish, saving} = await busyPool();
  const warning = c.status(event('confirming', {health: {ok: false, reason: 'country', country: 'JP', endpoint: 'trace'}}));
  await tick();
  assert.equal(dnr.state.session.length, 0, 'known forbidden country must revoke outside the storage queue');
  finish.resolve(); await Promise.all([saving, warning]);
  assert.equal(c.suspended, false, 'one failure need not replace the native session');
  assert.equal(state.probes, 1);
  assert.equal(state.published.at(-1).phase, 'confirming');
  // Native says the same endpoint has recovered. Its previous browser success
  // remains recent, but cannot be used to admit ordinary traffic again.
  const proof = Promise.withResolvers(), entered = Promise.withResolvers();
  c.probe = async () => { state.probes++; entered.resolve(); return proof.promise; };
  const recovered = c.status(event('connected', {health: {ok: true}}));
  await entered.promise;
  assert.equal(dnr.state.session.length, 0);
  proof.resolve({ok: true, country}); await recovered;
  assert.equal(state.probes, 2); assert.equal(state.confirmations, 2);
  assert.equal(dnr.state.session.length, 2);
});

test('one transport failure preserves already verified admission', async () => {
  const {c, state, dnr, event, connect} = setup(); await connect();
  await c.status(event('confirming', {health: {ok: false, reason: 'timeout'}}));
  assert.equal(dnr.state.session.length, 2); assert.equal(state.probes, 1);
});

test('replacing revokes admission while pool storage is pending', async () => {
  const {c, dnr, event, connect, busyPool} = setup(); await connect();
  const {finish, saving} = await busyPool();
  const replacing = c.status(event('replacing', {proxy: null}));
  await tick(); assert.equal(dnr.state.session.length, 0);
  assert.equal(c.currentOffer(event()), false);
  finish.resolve(); await Promise.all([saving, replacing]);
});

test('stale id, endpoint and attempt health cannot revoke a newer admission', async () => {
  const {c, state, dnr, event, connect, proxy} = setup(); await connect();
  const health = {ok: false, reason: 'country', country: 'JP'};
  for (const changes of [{id: 'old'}, {attempt: 2}, {proxy: {...proxy, host: '1.1.1.1'}}]) {
    await c.status(event('confirming', {...changes, health}));
  }
  await c.status(event('connected', {attempt: 2}));
  await c.status(event('replacing', {attempt: 1, proxy: null}));
  await c.status(event('confirming', {attempt: 1, health}));
  assert.equal(dnr.state.session.length, 2); assert.equal(c.offer.attempt, 2);
  assert.equal(state.published.at(-1).phase, 'connected');
});

for (const next of ['stop', 'start']) test(`delayed emergency completion is joined before newer ${next}`, async () => {
  const {c, api, state, dnr, event, connect, busyPool} = setup(); await connect();
  const {finish, saving} = await busyPool();
  const revoke = Promise.withResolvers(), protect = Promise.withResolvers(); let revokes = 0;
  const realRevoke = api.revokeTraffic;
  api.revokeTraffic = () => ++revokes === 1 ? revoke.promise.then(() => realRevoke()) : realRevoke();
  api.protectRoute = () => protect.promise.then(() => { state.route = BLOCKED; return true; });
  const replacing = c.status(event('replacing', {proxy: null}));
  assert.equal(revokes, 1, 'emergency must be started synchronously');
  const changed = next === 'stop' ? c.stop() : c.start(countries);
  finish.resolve(); await tick();
  let completed = false; changed.then(() => { completed = true; });
  await tick(); assert.equal(completed, false);
  revoke.resolve(); protect.resolve(); await Promise.all([saving, replacing, changed]);
  if (next === 'stop') {
    assert.equal(dnr.state.session.length, 0); assert.equal(state.route, null);
  } else {
    await c.status(event()); assert.equal(dnr.state.session.length, 2);
    assert.equal(state.published.at(-1).phase, 'connected');
  }
});

test('country-negative invalidates a Chrome proof already in flight', async () => {
  const {c, state, dnr, event, connect} = setup(); await connect();
  const proof = Promise.withResolvers(), entered = Promise.withResolvers();
  c.probe = async () => { entered.resolve(); return proof.promise; };
  const pending = c.recheck(); await entered.promise;
  const warning = c.status(event('confirming', {health: {ok: false, reason: 'country', country: 'JP'}}));
  proof.resolve({ok: true, country: 'NO'}); await Promise.all([pending, warning]);
  assert.equal(dnr.state.session.length, 0); assert.equal(state.confirmations, 1);
});

for (const failed of ['revoke', 'protect']) test(`emergency ${failed} failure closes and suspends admission`, async () => {
  const {c, api, state, dnr, event, connect} = setup(); await connect();
  if (failed === 'revoke') api.revokeTraffic = async () => { throw Error('failed revoke'); };
  else api.protectRoute = async () => { throw Error('failed protection'); };
  await c.status(event('replacing', {proxy: null}));
  assert.equal(dnr.state.session.length, 0); assert.deepEqual(state.route, BLOCKED);
  assert.equal(c.suspended, true); assert.equal(state.published.at(-1).phase, 'error');
});

for (const result of [{ok: false, reason: 'timeout'}, {ok: true, country: 'JP'}, {ok: false, reason: 'http'}]) {
  test(`failed fresh Chrome proof after native recovery stays closed: ${result.reason || result.country}`, async () => {
    const {c, state, dnr, event, connect} = setup(); await connect();
    await c.status(event('confirming', {health: {ok: false, reason: 'country', country: 'JP'}}));
    c.probe = async () => result;
    await c.status(event('connected', {health: {ok: true}}));
    assert.equal(dnr.state.session.length, 0); assert.equal(state.confirmations, 1);
    assert.equal(state.published.at(-1).phase, 'replacing');
  });
}

test('a route check rejected by emergency protection cannot suspend its newer recovery', async () => {
  const {c, api, state, dnr, event, connect} = setup(); await connect();
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  api.verifyRoute = async () => { entered.resolve(); await finish.promise; throw Error('route now blocked'); };
  const cachedHealth = c.status(event()); await entered.promise;
  const warning = c.status(event('confirming', {health: {ok: false, reason: 'country', country: 'JP'}}));
  finish.resolve(); await Promise.all([cachedHealth, warning]);
  assert.equal(c.suspended, false); assert.equal(dnr.state.session.length, 0);
  assert.equal(state.published.at(-1).phase, 'confirming');
  api.verifyRoute = async () => {};
  await c.status(event('connected', {health: {ok: true}}));
  assert.equal(c.suspended, false); assert.equal(dnr.state.session.length, 2);
});

for (const previous of [false, true]) test(`country-negative invalidates a queued proposal before it becomes this.offer: previous=${previous}`, async () => {
  const {c, state, dnr, event, connect, busyPool, proxy} = setup();
  if (previous) await connect();
  else await c.start(countries);
  const {finish, saving} = await busyPool();
  const attempt = previous ? 2 : 1;
  const proposal = event('connected', {attempt, proxy: {...proxy, host: '1.1.1.1'}});
  const connected = c.status(proposal);
  assert.notEqual(c.offer?.attempt, attempt, 'proposal is still behind pool storage');
  const warning = c.status({...proposal, phase: 'confirming',
    health: {ok: false, reason: 'country', country: 'JP', endpoint: 'trace'}});
  finish.resolve(); await Promise.all([saving, connected, warning]);
  assert.equal(dnr.state.session.length, 0, 'queued stale native success must never admit traffic');
  assert.equal(state.confirmations, Number(previous));
  assert.equal(state.probes, Number(previous));
  assert.equal(c.suspended, false);
  assert.equal(state.published.at(-1).phase, 'confirming');
  const proof = Promise.withResolvers(), entered = Promise.withResolvers();
  c.probe = async () => { entered.resolve(); return proof.promise; };
  const recovered = c.status({...proposal, health: {ok: true}});
  await entered.promise; assert.equal(dnr.state.session.length, 0);
  proof.resolve({ok: true, country: 'NO'}); await recovered;
  assert.equal(dnr.state.session.length, 2);
  assert.equal(c.offer.attempt, attempt);
});

test('older country-negative cannot invalidate a newer queued native proposal', async () => {
  const {c, state, dnr, event, connect, busyPool, proxy} = setup(); await connect();
  const {finish, saving} = await busyPool();
  const connected = c.status(event('connected', {attempt: 2, proxy: {...proxy, host: '1.1.1.1'}}));
  const warning = c.status(event('confirming', {health: {ok: false, reason: 'country', country: 'JP'}}));
  finish.resolve(); await Promise.all([saving, connected, warning]);
  assert.equal(dnr.state.session.length, 2);
  assert.equal(c.offer.attempt, 2); assert.equal(state.confirmations, 2);
  assert.equal(state.published.at(-1).phase, 'connected');
});
