import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import vm from 'node:vm';
import {createStatusAnnouncer, statusDetail} from '../extension/popup-status.js';
import {hasRejectedHealthCountry, hasTrafficAdmission} from '../extension/popup-status.js';
import {BLOCKED, matchesEffectiveRoute, proxyConfig, restoreCountrySettings} from '../extension/controller.js';
import {validFavorites} from '../extension/country-catalog.js';
import {gateRules} from '../extension/traffic-gate.js';

test('country-negative health announces blocked traffic instead of a transient request retry', () => {
  const warning = {phase: 'confirming', proxy: {country: 'NO'}, health: {ok: false, reason: 'country', country: 'JP'}};
  assert.match(statusDetail(warning), /Трафик заблокирован до нового подтверждения Chrome/);
  assert.doesNotMatch(statusDetail(warning), /Один запрос/);
  assert.match(statusDetail({...warning, health: {ok: false, reason: 'transport'}}), /Проверяем повторно/);
  assert.doesNotMatch(statusDetail({...warning, phase: 'connected'}), /Трафик заблокирован/);
});

function liveRegion() {
  const updates = [];
  const announce = createStatusAnnouncer({set textContent(value) { updates.push(value); }});
  return {updates, announce};
}

test('progress remains visible while repeated progress/time updates do not speak', () => {
  for (const phase of ['checking', 'slow']) {
    const {updates, announce} = liveRegion();
    const options = {phaseLabel: 'Проверяем'};
    const start = {phase, done: 1, total: 40, checkedAt: 1, retrySeconds: 60};
    const tick = {...start, done: 2, total: 50, checkedAt: 2, retrySeconds: 59};
    announce(start, options); announce(tick, options);
    assert.equal(updates.length, 1);
    assert.doesNotMatch(updates[0], /40|50|60|59/);
    assert.notEqual(statusDetail(start), statusDetail(tick));
  }
});

test('same-phase reason and blocked-route recovery changes are announced once', () => {
  const {updates, announce} = liveRegion();
  const options = {phaseLabel: 'Не удалось подключиться'};
  const first = {phase: 'error', error: 'Настройками управляет другое расширение.'};
  announce(first, options); announce({...first, updatedAt: 2}, options);
  const next = {...first, error: 'Не удалось применить настройки приватности.'};
  announce(next, options);
  const recovery = 'Нажмите «Отключить», устраните конфликт и подключитесь снова.';
  announce(next, {...options, recovery}); announce(next, {...options, recovery});
  assert.equal(updates.length, 3);
  assert.match(updates[1], /приватности/);
  assert.match(updates[2], /устраните конфликт/);
});

test('same-phase note changes and cleared errors restore the current guidance', () => {
  const {updates, announce} = liveRegion();
  const options = {phaseLabel: 'Ищем адреса', multiple: true};
  announce({phase: 'searching', error: 'Временный отказ'}, options);
  announce({phase: 'searching', note: 'Chrome не подтвердил выход. Ищем следующий адрес.'}, options);
  announce({phase: 'searching'}, options);
  assert.equal(updates.length, 3);
  assert.match(updates[2], /без приоритета стран/);
  assert.doesNotMatch(updates[2], /Временный отказ/);
});

test('changing checked time, reserve/probe diagnostics or retry timer stays quiet', () => {
  const {updates, announce} = liveRegion();
  const options = {phaseLabel: 'Подключено'};
  announce({phase: 'connected', browser: {checkedAt: 1}, diagnostics: {attempts: 3}}, options);
  announce({phase: 'connected', browser: {checkedAt: 2}, diagnostics: {attempts: 4}, retrySeconds: 59}, options);
  assert.equal(updates.length, 1);
});

// Execute production render, including its async revision guard. Only the DOM
// and Chrome API boundaries are mocked; no display decisions are copied here.
async function popupFixture() {
  const source = await readFile(resolve(process.env.CP_EXTENSION_ROOT || 'extension', 'popup.js'), 'utf8');
  const elements = new Map();
  const $ = id => {
    if (!elements.has(id)) elements.set(id, {hidden: false, textContent: ''});
    return elements.get(id);
  };
  const proxy = {scheme: 'https', host: '192.0.2.1', port: 8443, country: 'EE', exitIp: '203.0.113.4'};
  const saved = {enabled: true, selected: null, selectedCountries: ['AT', 'EE', 'NO'], countries: [],
    selectionMode: 'multiple', status: {phase: 'connected', countries: ['AT', 'EE', 'NO'], proxy,
      browser: {ok: true, country: 'EE', exitIp: '203.0.113.5', checkedAt: 1000}},
    pool: {countries: ['AT', 'EE', 'NO'], count: 2, expiresAt: Date.now() + 60000}};
  let route = {levelOfControl: 'controlled_by_this_extension', value: proxyConfig(proxy)};
  let readRoute = async () => structuredClone(route);
  let readState = async () => structuredClone(saved);
  const expectedAdmission = gateRules('b'.repeat(32), '0'.repeat(32)).session;
  let readAdmission = async () => structuredClone(expectedAdmission);
  const context = vm.createContext({$, validFavorites, restoreCountrySettings, statusDetail, hasRejectedHealthCountry, hasTrafficAdmission,
    BLOCKED, matchesEffectiveRoute, proxyConfig, gateRules, announceStatus: createStatusAnnouncer($('status-announcement')),
    chrome: {storage: {local: {get: () => readState(),
      set: () => { throw Error('render must not write settings'); }}}, proxy: {settings: {get: () => readRoute()}},
      declarativeNetRequest: {getSessionRules: () => readAdmission()},
      runtime: {id: 'b'.repeat(32), sendMessage: () => { throw Error('render must not dispatch commands'); }}},
    sourceSelection() {}, renderReserveDiagnostics() {}, pickerOpen: () => false, renderCountries() {}, closePicker() {},
    sameCountries: (a,b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort()),
    reasons: {}, byCode: new Map([['EE', {}]]), labelFor: code => code});
  vm.runInContext(source.slice(source.indexOf('const labels ='), source.indexOf('let catalog =')) +
    `let catalog = [{code:'AT'}, {code:'EE'}, {code:'NO'}], favorites = [], selectedCountries = [],
      selectionMode = 'single', selectionInvalid = false, draftMode, draftCountries, applying = false, lastCountryState = '';` +
    source.slice(source.indexOf('let renderRevision = 0;'), source.indexOf("$('mode-single').addEventListener")), context);
  return {$, saved, render: () => vm.runInContext('render()', context),
    route: value => { route = value; }, readRoute: callback => { readRoute = callback; },
    readState: callback => { readState = callback; },
    readAdmission: callback => { readAdmission = callback; }, expectedAdmission};
}

test('production popup only presents connected/current exit for a matching owned route and selected countries', async () => {
  const h = await popupFixture();
  await h.render();
  assert.equal(h.$('phase').textContent, 'Подключено');
  assert.equal(h.$('dot').className, 'dot online');
  assert.equal(h.$('exit-address').textContent, 'Выход сейчас: 203.0.113.5');
  assert.match(h.$('reserve').textContent, /Резерв группы: 2 из 2/);
  assert.equal(h.$('disconnect').hidden, false);
  assert.deepEqual(h.saved.selectedCountries, ['AT', 'EE', 'NO']);
});

for (const kind of ['blocked', 'direct', 'foreign', 'unreadable', 'different route', 'browser country', 'saved selection', 'invalid selection', 'disabled', 'missing proof', 'malformed proxy', 'revoked admission', 'partial admission', 'changed admission', 'unreadable admission']) {
  test(`production popup suppresses saved connected claim for ${kind}`, async () => {
    const h = await popupFixture();
    if (kind === 'blocked') h.route({levelOfControl: 'controlled_by_this_extension', value: BLOCKED});
    if (kind === 'direct') h.route({levelOfControl: 'controllable_by_this_extension', value: {mode: 'direct'}});
    if (kind === 'foreign') h.route({levelOfControl: 'controlled_by_other_extensions', value: proxyConfig(h.saved.status.proxy)});
    if (kind === 'unreadable') h.readRoute(async () => { throw Error('route read refused'); });
    if (kind === 'different route') h.route({levelOfControl: 'controlled_by_this_extension', value: proxyConfig({...h.saved.status.proxy, port: 8444})});
    if (kind === 'browser country') h.saved.status.browser.country = 'JP';
    if (kind === 'saved selection') h.saved.status.countries = ['EE'];
    if (kind === 'invalid selection') h.saved.selectedCountries.push('XX');
    if (kind === 'disabled') h.saved.enabled = false;
    if (kind === 'missing proof') h.saved.status.browser.ok = false;
    if (kind === 'malformed proxy') h.saved.status.proxy.scheme = 'unknown';
    if (kind === 'revoked admission') h.readAdmission(async () => []);
    if (kind === 'partial admission') h.readAdmission(async () => h.expectedAdmission.slice(0, 1));
    if (kind === 'changed admission') h.readAdmission(async () => h.expectedAdmission.map(rule => ({...rule, priority: 2})));
    if (kind === 'unreadable admission') h.readAdmission(async () => { throw Error('session read refused'); });
    const before = structuredClone(h.saved);
    await h.render();
    assert.equal(h.$('phase').textContent, 'Подключение не подтверждено');
    assert.doesNotMatch(h.$('dot').className, /online/);
    assert.equal(h.$('proxy').hidden, true);
    assert.doesNotMatch(h.$('exit-address').textContent, /Выход сейчас|203\.0\.113/);
    assert.match(h.$('detail').textContent, /Отключить/);
    assert.match(h.$('status-announcement').textContent, /Подключение не подтверждено/);
    assert.equal(h.$('disconnect').hidden, false);
    assert.equal(h.$('rotate').hidden, true);
    assert.deepEqual(h.saved, before, 'display must retain saved proof and selection');
  });
}

test('production popup keeps explicit error/stop labels and disconnected state with an unknown route', async () => {
  for (const [phase, label] of [['off','Отключено'], ['error','Не удалось подключиться'],
    ['stopError','Отключение не завершено'], ['stopping','Отключаем прокси']]) {
    const h = await popupFixture();
    h.saved.status.phase = phase;
    h.saved.status.error = phase === 'error' ? 'Ошибка настройки' : undefined;
    h.saved.enabled = false;
    h.readRoute(async () => { throw Error('unavailable'); });
    await h.render();
    assert.equal(h.$('phase').textContent, label);
    assert.doesNotMatch(h.$('dot').className, /online/);
    assert.doesNotMatch(h.$('exit-address').textContent, /Выход сейчас/);
    if (phase === 'error') assert.equal(h.$('detail').textContent, 'Ошибка настройки');
  }
});

test('production popup confirming only shows a last Chrome exit while its route and selection still match', async () => {
  const h = await popupFixture();
  h.saved.status.phase = 'confirming';
  await h.render();
  assert.equal(h.$('phase').textContent, 'Перепроверяем соединение');
  assert.match(h.$('exit-address').textContent, /^Последний выход Chrome:/);
  h.route({levelOfControl: 'controlled_by_this_extension', value: BLOCKED});
  await h.render();
  assert.equal(h.$('phase').textContent, 'Перепроверяем соединение');
  assert.equal(h.$('proxy').hidden, true);
  assert.doesNotMatch(h.$('exit-address').textContent, /203\.0\.113/);
  assert.match(h.$('detail').textContent, /Отключить/);
});

test('production popup discards an older route read after a newer render', async () => {
  const h = await popupFixture(), delayed = Promise.withResolvers();
  h.readRoute(() => delayed.promise);
  const older = h.render();
  h.readRoute(async () => ({levelOfControl: 'controlled_by_this_extension', value: BLOCKED}));
  await h.render();
  const newer = h.$('phase').textContent;
  delayed.resolve({levelOfControl: 'controlled_by_this_extension', value: proxyConfig(h.saved.status.proxy)});
  await older;
  assert.equal(h.$('phase').textContent, newer);
  assert.equal(newer, 'Подключение не подтверждено');
  assert.doesNotMatch(h.$('dot').className, /online/);
});

test('production popup storage read failure withdraws a previous green render and recovers without commands', async () => {
  const h = await popupFixture();
  await h.render();
  assert.equal(h.$('dot').className, 'dot online');
  const before = structuredClone(h.saved);
  h.readState(async () => { throw Error('storage read refused'); });
  await h.render();
  assert.equal(h.$('phase').textContent, 'Подключение не подтверждено');
  assert.equal(h.$('dot').className, 'dot problem');
  assert.equal(h.$('proxy').hidden, true);
  assert.equal(h.$('exit-address').textContent, '');
  assert.equal(h.$('disconnect').hidden, false);
  assert.match(h.$('status-announcement').textContent, /Не удалось прочитать/);
  assert.deepEqual(h.saved, before);
  h.readState(async () => structuredClone(h.saved));
  await h.render();
  assert.equal(h.$('dot').className, 'dot online');
  assert.equal(h.$('exit-address').textContent, 'Выход сейчас: 203.0.113.5');
});

test('traffic admission uses canonical rule keys, accepts unrelated rules and rejects changed owned rules', () => {
  const expected = gateRules('b'.repeat(32), '0'.repeat(32)).session;
  const reordered = expected.toReversed().map(rule => ({condition: rule.condition, action: rule.action,
    priority: rule.priority, id: rule.id}));
  assert.equal(hasTrafficAdmission(reordered, 'b'.repeat(32)), true);
  assert.equal(hasTrafficAdmission([...reordered, {id: 999, priority: 1, action: {type: 'allow'}, condition: {urlFilter: 'example.com'}}], 'b'.repeat(32)), true);
  assert.equal(hasTrafficAdmission(expected.map(rule => ({...rule, condition: {...rule.condition, requestMethods: ['get']}})), 'b'.repeat(32)), false);
});
