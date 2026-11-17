import test from 'node:test';
import assert from 'node:assert/strict';
import {TrafficGate, gateRules} from '../extension/traffic-gate.js';
import {dnrFixture} from './dnr-fixture.js';
const id = 'a'.repeat(32), capability = 'f'.repeat(32);

test('gate rules explicitly cover navigation and allow only own exact probe requests', () => {
  const {dynamic, session} = gateRules(id, capability);
  const blocks = dynamic.filter(rule => rule.action.type === 'block');
  assert.equal(blocks.length, 2);
  assert.ok(blocks.some(rule => rule.condition.resourceTypes?.includes('main_frame')));
  assert.ok(blocks.some(rule => !rule.condition.resourceTypes));
  for (const rule of blocks) {
    const regex = new RegExp(rule.condition.regexFilter);
    for (const scheme of ['http', 'https', 'ws', 'wss']) assert.ok(regex.test(scheme + '://example.test/request'));
    assert.equal(regex.test('chrome-extension://' + id + '/popup.html'), false);
  }
  for (const rule of dynamic.filter(rule => rule.action.type === 'allow')) {
    assert.deepEqual(rule.condition.initiatorDomains, [id]);
    assert.deepEqual(rule.condition.resourceTypes, ['xmlhttprequest']);
    assert.deepEqual(rule.condition.requestMethods, ['get']);
    assert.equal(rule.condition.isUrlFilterCaseSensitive, true);
    const regex = new RegExp(rule.condition.regexFilter);
    const base = rule.id === 710003 ? 'https://www.cloudflare.com/cdn-cgi/trace' : 'https://www.google.com/generate_204';
    for (const suffix of ['?t=123', '?t=123&attempt=2']) assert.ok(regex.test(base + suffix + '&gate=' + capability));
    for (const bad of [base, base + '?t=123&data=secret', base + '/extra?t=123', base.replace('https:', 'http:') + '?t=123',
      base.replace('.com/', '.com.evil/') + '?t=123', base.toUpperCase() + '?t=123', base + '?t=123&gate=' + '0'.repeat(32)]) assert.equal(regex.test(bad), false);
  }
  assert.equal(session.some(rule => rule.action.type === 'allowAllRequests'), false);
  assert.throws(() => gateRules('arbitrary-host'));
});

test('gate persists closed rules, admits only the current ticket, and clears only its own rules', async () => {
  const foreign = {id: 999, priority: 1, action: {type: 'block'}, condition: {urlFilter: 'unrelated.test'}};
  const {api, state} = dnrFixture({dynamic: [foreign], session: [foreign]});
  const gate = new TrafficGate(api, id);
  const ticket = await gate.hold();
  assert.equal(state.dynamic.length, 5); assert.equal(state.session.length, 1);
  assert.equal(await gate.allow(ticket, () => true), true); await gate.assertOpen();
  assert.equal(state.session.length, 3);
  const next = await gate.hold(); assert.equal(await gate.allow(ticket, () => true), false);
  assert.equal(await gate.allow(next, () => false), false);
  assert.equal(state.session.length, 1);
  await gate.clear();
  assert.deepEqual(state.dynamic, [foreign]); assert.deepEqual(state.session, [foreign]);
});

test('browser restart loses admission while durable block and narrow probes survive', async () => {
  const {api, state} = dnrFixture();
  const gate = new TrafficGate(api, id); const ticket = await gate.hold(); await gate.allow(ticket, () => true);
  state.session = [];
  const restarted = new TrafficGate(api, id);
  await assert.rejects(restarted.assertOpen());
  await restarted.hold();
  assert.equal(state.dynamic.length, 4); assert.deepEqual(state.session, []);
});

test('late session admission is closed before a queued Stop can finish', async () => {
  const {api, state} = dnrFixture();
  const gate = new TrafficGate(api, id), ticket = await gate.hold();
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  const update = api.updateSessionRules;
  api.updateSessionRules = async changes => {
    if (changes.addRules?.length) { entered.resolve(); await finish.promise; }
    return update(changes);
  };
  let current = true;
  const allowing = gate.allow(ticket, () => current); await entered.promise;
  current = false; const stopping = gate.clear(); finish.resolve();
  assert.equal(await allowing, false); await stopping;
  assert.deepEqual(state.dynamic, []); assert.deepEqual(state.session, []);
});

test('a new hold invalidates queued old admission before any rule is committed', async () => {
  const {api, state} = dnrFixture();
  const gate = new TrafficGate(api, id), old = await gate.hold();
  const allowing = gate.allow(old, () => true);
  const holding = gate.hold();
  assert.equal(await allowing, false); await holding;
  assert.deepEqual(state.session, []);
});

test('hold still removes session admission when the dynamic commit fails', async () => {
  let reject = false;
  const {api, state} = dnrFixture({reject: kind => reject && kind === 'dynamic'});
  const gate = new TrafficGate(api, id), ticket = await gate.hold(); await gate.allow(ticket, () => true);
  reject = true;
  await assert.rejects(gate.hold(), /удержать/);
  assert.deepEqual(state.session, []); assert.equal(state.dynamic.length, 4);
});

test('rule read-back mismatch cannot open ordinary traffic', async () => {
  const {api, state} = dnrFixture(); const gate = new TrafficGate(api, id), ticket = await gate.hold();
  state.dynamic = state.dynamic.filter(rule => rule.id !== 710002);
  await assert.rejects(gate.allow(ticket, () => true), /правила/);
  assert.deepEqual(state.session, []);
});

test('failed admission verification removes the newly installed allow', async () => {
  const {api, state} = dnrFixture(); const gate = new TrafficGate(api, id), ticket = await gate.hold();
  const get = api.getSessionRules;
  api.getSessionRules = async () => state.session.length ? [] : get();
  await assert.rejects(gate.allow(ticket, () => true), /правила/);
  assert.deepEqual(state.session, []);
});

test('clear attempts both rule families despite one rejected cleanup', async () => {
  let reject = false;
  const {api, state} = dnrFixture({reject: kind => reject && kind === 'dynamic'});
  const gate = new TrafficGate(api, id), ticket = await gate.hold(); await gate.allow(ticket, () => true);
  reject = true;
  await assert.rejects(gate.clear(), /освободить/);
  assert.deepEqual(state.session, []); assert.equal(state.dynamic.length, 4);
  reject = false; await gate.clear(); assert.deepEqual(state.dynamic, []);
});

test('probe capability is captured, narrowly scoped, and rotated on the next hold', async () => {
  const {api, state} = dnrFixture(); const gate = new TrafficGate(api, id);
  assert.throws(() => gate.probeFetcher(() => {}));
  await gate.hold();
  const calls = [];
  const oldFetcher = gate.probeFetcher((url, options) => { calls.push({url, options}); return 'sent'; });
  const signal = new AbortController().signal;
  const options = {signal, cache: 'no-store', credentials: 'omit', redirect: 'error'};
  const original = 'https://www.cloudflare.com/cdn-cgi/trace?t=123';
  assert.equal(oldFetcher(original, options), 'sent');
  assert.equal(calls[0].options.signal, signal);
  assert.deepEqual(calls[0].options, {...options, referrerPolicy: 'no-referrer'});
  assert.ok(new RegExp(state.dynamic.find(rule => rule.id === 710003).condition.regexFilter).test(calls[0].url));
  for (const url of ['https://www.cloudflare.com/ordinary?t=123', original + '&gate=forged', original + '&payload=hello']) {
    assert.throws(() => oldFetcher(url, options));
  }
  assert.throws(() => oldFetcher(original, {...options, method: 'POST'}));
  await gate.hold();
  oldFetcher(original, options);
  assert.equal(calls[0].url, calls[1].url, 'old closure must not borrow new capability');
  assert.equal(new RegExp(state.dynamic.find(rule => rule.id === 710003).condition.regexFilter).test(calls[1].url), false);
  const newFetcher = gate.probeFetcher((url, opts) => calls.push({url, options: opts}));
  newFetcher(original, options);
  assert.notEqual(calls[2].url, calls[1].url);
  await gate.clear(); assert.throws(() => gate.probeFetcher(() => {}));
});

test('hold during a pending admission closes old admission before committing new capability', async () => {
  const {api, state} = dnrFixture(); const gate = new TrafficGate(api, id), old = await gate.hold();
  const previousRules = structuredClone(state.dynamic);
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  const update = api.updateSessionRules;
  api.updateSessionRules = async changes => {
    if (changes.addRules?.length) { entered.resolve(); await finish.promise; }
    return update(changes);
  };
  const admitting = gate.allow(old, () => true); await entered.promise;
  const holding = gate.hold(); finish.resolve();
  assert.equal(await admitting, false); await holding;
  assert.deepEqual(state.session, []);
  assert.notDeepEqual(state.dynamic, previousRules);
});
