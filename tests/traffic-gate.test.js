import test from 'node:test';
import assert from 'node:assert/strict';
import {TrafficGate, gateRules} from '../extension/traffic-gate.js';
import {dnrFixture} from './dnr-fixture.js';
const id = 'a'.repeat(32), capability = 'f'.repeat(32);

test('gate rules explicitly cover navigation and allow only own exact probe requests', () => {
  const {dynamic, session} = gateRules(id, capability);
  const blocks = dynamic.filter(rule => rule.action.type === 'block' && rule.priority === 1);
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
  assert.equal(state.dynamic.length, 21); assert.equal(state.session.length, 1);
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
  assert.equal(state.dynamic.length, 20); assert.deepEqual(state.session, []);
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
  assert.deepEqual(state.session, []); assert.equal(state.dynamic.length, 20);
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
  assert.deepEqual(state.session, []); assert.equal(state.dynamic.length, 20);
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

// These assertions model the highest matching action for Chrome-canonical URL
// strings. The separate isolated browser lab validates Chrome's actual matcher.
function winningAction(rules, raw, type) {
  const url = new URL(raw).href;
  return rules.filter(rule => rule.condition.regexFilter &&
    new RegExp(rule.condition.regexFilter, 'i').test(url) &&
    (rule.condition.resourceTypes ? rule.condition.resourceTypes.includes(type) : type !== 'main_frame'))
    .sort((a, b) => b.priority - a.priority)[0]?.action.type;
}
test('connected admission permanently excludes Chrome implicit special destinations', async () => {
  const {api, state} = dnrFixture(), gate = new TrafficGate(api, id);
  const special = ['.localhost', '.localhost.', 'localhost', 'localhost.', 'app.localhost', 'app.localhost.', '127.1', '127.255.255.254',
    '2130706433', '0x7f000001', '0177.0.0.1', '[::1]', '[0:0:0:0:0:0:0:1]',
    '[::ffff:127.0.0.1]', '[::ffff:127.255.255.254]', '[::ffff:169.254.0.1]', '[::ffff:a9fe:ffff]',
    '169.254.0.1', '169.254.255.254', '[fe80::1]', '[febf:ffff::123]', '0.0.0.0', '[::]', '[::ffff:0.0.0.0]'];
  for (let cycle = 0; cycle < 2; cycle++) {
    const ticket = await gate.hold(); await gate.allow(ticket, () => true);
    for (const scheme of ['http', 'https', 'ws', 'wss']) for (const host of special) {
      for (const type of ['main_frame', 'xmlhttprequest', 'websocket']) {
        assert.equal(winningAction([...state.dynamic, ...state.session], `${scheme}://${host}:12345/test`, type),
          'block', `${scheme} ${host} ${type}`);
      }
    }
    for (const host of ['example.test', 'notlocalhost', 'localhost.example.test', '128.0.0.1',
      '169.253.1.1', '[fec0::1]', '[2001:db8::1]']) {
      assert.equal(winningAction([...state.dynamic, ...state.session], `https://${host}/`, 'main_frame'), 'allow', host);
    }
    state.session = []; // Browser restart drops admission, never the special block.
    for (const host of special) assert.equal(winningAction(state.dynamic, `http://${host}/`, 'main_frame'), 'block');
  }
  await gate.clear(); assert.deepEqual(state.dynamic, []);
});

test('emergency revoke starts while another gate operation is pending and invalidates its admission', async () => {
  const {api, state} = dnrFixture(), gate = new TrafficGate(api, id);
  const ticket = await gate.hold(); await gate.allow(ticket, () => true);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const get = api.getDynamicRules;
  api.getDynamicRules = async () => { entered.resolve(); await release.promise; return get(); };
  const checking = gate.assertOpen(); await entered.promise;
  const revoked = gate.revoke(); await revoked;
  assert.deepEqual(state.session, [], 'session removal must not wait for gate queue');
  release.resolve(); await assert.rejects(checking);
  assert.equal(await gate.allow(ticket, () => true), false);
});

test('a delayed emergency revoke cannot remove admission of a later Start', async () => {
  const {api, state} = dnrFixture(), gate = new TrafficGate(api, id);
  await gate.hold();
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const remove = api.updateSessionRules; let delayed = true;
  api.updateSessionRules = async changes => {
    if (delayed && !changes.addRules) { delayed = false; entered.resolve(); await release.promise; }
    return remove(changes);
  };
  const revoked = gate.revoke(); await entered.promise;
  const stopping = gate.clear(); const starting = gate.hold();
  release.resolve(); await revoked; await stopping;
  const ticket = await starting; assert.equal(await gate.allow(ticket, () => true), true);
  await gate.assertOpen(); assert.equal(state.session.length, 2);
});


test('takeover during a pending admission commit is revoked before queued Stop finishes', async () => {
  const {api, state} = dnrFixture(), gate = new TrafficGate(api, id);
  const ticket = await gate.hold(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const update = api.updateSessionRules;
  api.updateSessionRules = async changes => {
    if (changes.addRules) { entered.resolve(); await release.promise; }
    return update(changes);
  };
  const admitting = gate.allow(ticket, () => true); await entered.promise;
  await gate.revoke();
  assert.deepEqual(state.session, [], 'takeover removal already completed while old admission is pending');
  const stopping = gate.clear(); release.resolve();
  assert.equal(await admitting, false); await stopping;
  assert.deepEqual(state.session, []); assert.deepEqual(state.dynamic, []);
});

test('rejected emergency removal remains retryable by queued cleanup', async () => {
  const {api, state} = dnrFixture(), gate = new TrafficGate(api, id);
  const ticket = await gate.hold(); await gate.allow(ticket, () => true);
  const update = api.updateSessionRules; let fail = true;
  api.updateSessionRules = async changes => {
    if (fail && !changes.addRules) { fail = false; throw Error('emergency removal denied'); }
    return update(changes);
  };
  await assert.rejects(gate.revoke(), /emergency removal denied/);
  assert.equal(await gate.allow(ticket, () => true), false);
  await gate.clear();
  assert.deepEqual(state.session, []); assert.deepEqual(state.dynamic, []);
});


test('mixed overlapping revocations retain the pending older completion barrier', async () => {
  const {api, state} = dnrFixture(), gate = new TrafficGate(api, id);
  const ticket = await gate.hold(); await gate.allow(ticket, () => true);
  const firstEntered = Promise.withResolvers(), firstFinish = Promise.withResolvers();
  const update = api.updateSessionRules; let count = 0;
  api.updateSessionRules = async changes => {
    if (!changes.addRules) {
      const operation = ++count;
      if (operation === 1) { firstEntered.resolve(); await firstFinish.promise; }
      if (operation === 2) throw Error('newer removal rejected');
    }
    return update(changes);
  };
  const first = gate.revoke(); await firstEntered.promise;
  await assert.rejects(gate.revoke(), /newer removal rejected/);
  let restored = false;
  const restarting = gate.hold().then(async next => { restored = await gate.allow(next, () => true); });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(restored, false); assert.equal(count, 2, 'new hold must not pass an older pending removal');
  firstFinish.resolve(); await first; await restarting;
  assert.equal(restored, true); await gate.assertOpen();
});
