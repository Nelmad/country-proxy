// Execute the exact targeted acceptance function/catch/exit policy with failing
// final Stop; no Chrome, network, source edits, or mirrored product assertions.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const root = path.resolve(process.argv[2] || path.join(import.meta.dirname, '..'));
const source = await fs.readFile(path.join(root, 'tests/preconfirm-traffic-lab.mjs'), 'utf8');
const start = source.indexOf('async function startupDoubleFailureMatrix()');
const end = source.indexOf('async function pairedHealthMatrix()', start);
assert.ok(start >= 0 && end > start, 'Exact targeted matrix markers');
const matrix = source.slice(start, end);
const runStart = source.indexOf('try {\n  await prepare();');
const catchStart = source.indexOf('} catch (error) {', runStart);
const catchEnd = source.indexOf('\n} finally {', catchStart);
assert.ok(runStart >= 0 && catchStart > runStart && catchEnd > catchStart, 'Exact outer acceptance catch');
const catchBody = source.slice(catchStart + '} catch (error) {'.length, catchEnd);
const exitLine = source.split('\n').find(line => line.trim().startsWith("if (!['PASS', 'RED_REPRODUCED', 'DEVELOPMENT_SMOKE_PASS'].includes(report.result)"));
assert.ok(exitLine, 'Exact acceptance exit policy');
const guardLine = source.split('\n').find(line => line.trim().startsWith('if (report.error || report.cleanupErrors.length') && line.includes("report.result = 'FAIL'"));
const expectationGuard = source.split('\n').find(line => line.startsWith('assert.ok([expectStopRed, expectStartupRed, expectPairedRed, expectUiTruthRed]'));
assert.ok(expectationGuard, 'Actual target-specific RED expectation guard');
const checkExpectations = new Function('assert', 'expectStopRed', 'expectStartupRed', 'expectPairedRed', 'expectUiTruthRed', expectationGuard);
for (let mask = 0; mask < 16; mask++) {
  const flags = [1, 2, 4, 8].map(bit => !!(mask & bit));
  if (flags.filter(Boolean).length > 1) assert.throws(() => checkExpectations(assert, ...flags), /target-specific expected RED/);
  else assert.doesNotThrow(() => checkExpectations(assert, ...flags));
}
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
for (const failure of ['final-stop', 'final-stop-state']) {
  const report = {result: 'FAIL', scenarios: [], cleanupErrors: [], mainRegistrationUnchanged: true, scratchRemoved: true, changedExtension: []};
  const worker = {evaluate: async () => ({storageRejected: 1, errorWriteRejected: 1})};
  const env = {context: {serviceWorkers: () => [{url: () => 'chrome-extension://owned/runtime-startup-fixture.js', ...worker}]},
    id: 'owned', until: async read => read(), cmd: async () => ({ok: false}), countries: ['AT', 'EE', 'NO'],
    expectStartupRed: true, startupOldProof: false, expectUiTruthRed: false, commands: async () => [], report, assert, popup: null, redact: value => value,
    disconnect: async () => { if (failure === 'final-stop') throw Error('Injected final Stop rejection'); assert.equal('stopping', 'off', 'Injected final Stop cleanup state mismatch'); }};
  await new AsyncFunction(...Object.keys(env), matrix + '\ntry { await startupDoubleFailureMatrix(); } catch (error) {' + catchBody + '\n}')(...Object.values(env));
  assert.equal(report.result, 'FAIL', failure + ': caught final Stop failure must erase accepted result');
  assert.ok(report.error, failure + ': failure must be retained');
  const fakeProcess = {exitCode: 0};
  new Function('report', 'process', exitLine)(report, fakeProcess);
  assert.equal(fakeProcess.exitCode, 1, failure + ': final Stop failure cannot exit success');
}
// Also execute the maintained failed-Stop matrix itself through its final
// cleanup. Accepted RED evidence must not survive a rejected final Stop.
const stopStart = source.indexOf('async function stopDoubleFailureMatrix()');
const stopEnd = source.indexOf('async function pairedHealthMatrix()', stopStart);
assert.ok(stopStart >= 0 && stopEnd > stopStart, 'Exact Stop matrix markers');
const stopMatrix = source.slice(stopStart, stopEnd);
for (const failure of ['final-stop', 'final-stop-state']) {
  const report = {result: 'FAIL', scenarios: [], cleanupErrors: []};
  let stage = 'initial', failures = 0, stops = 0;
  const worker = {evaluate: async (callback, argument) => {
    if (typeof argument === 'number') failures = argument;
    if (String(callback).includes('({...globalThis.__stopFixture})')) return {clearRejected: 1,
      statusRejected: failures ? 1 : 0, statusAttempts: 1};
  }};
  const owned = {levelOfControl: 'controlled_by_this_extension'};
  const state = async () => ({enabled: stage === 'initial',
    status: {phase: stage === 'off' ? 'off' : failures ? 'error' : 'stopError'},
    route: stage === 'off' ? {levelOfControl: 'controllable_by_this_extension'} : owned,
    dynamic: stage === 'off' ? [] : [{action: {type: 'block'}}], session: []});
  const env = {context: {serviceWorkers: () => [{url: () => 'chrome-extension://owned/runtime-startup-fixture.js', ...worker}]},
    id: 'owned', countries: ['AT', 'EE', 'NO'], report, assert, expectStopRed: true,
    begin: async () => { stage = 'initial'; }, held: async () => {}, blocked: async () => {}, requestURL: () => 'owned',
    until: async read => read(),
    popup: {locator: () => ({isVisible: async () => stage !== 'off', textContent: async () => 'failed',
      click: async () => { stage = stage === 'initial' ? 'failed' : 'off'; }}),
      evaluate: async callback => String(callback).includes('chrome.privacy') ? [{levelOfControl: 'controllable_by_this_extension'}] :
        {stopHidden: failures > 0, stopText: 'Повторить отключение',
          error: failures ? 'Injected stopError publication rejection' : 'Повторите отключение'}},
    state, releasePending() {}, connected: async () => ({status: {browser: {country: 'EE'}}, selectedCountries: ['AT', 'EE', 'NO']}),
    ordinaryOK: async () => ({status: 200}), redact: value => value,
    disconnect: async () => {
      if (++stops === 6) {
        if (failure === 'final-stop') throw Error('Injected final Stop rejection');
        assert.equal('stopping', 'off', 'Injected final Stop cleanup state mismatch');
      }
      stage = 'off';
    }};
  await new AsyncFunction(...Object.keys(env), stopMatrix + '\ntry { await stopDoubleFailureMatrix(); } catch (error) {' + catchBody + '\n}')(...Object.values(env));
  assert.equal(stops, 6, 'Execute every matrix case through final cleanup');
  assert.equal(report.result, 'FAIL'); assert.ok(report.error);
  const fakeProcess = {exitCode: 0};
  new Function('report', 'process', exitLine)(report, fakeProcess);
  assert.equal(fakeProcess.exitCode, 1, 'Failed final Stop cannot produce an accepted Stop matrix receipt');
}
// The optional UI truth acceptance also must reach strict final cleanup in
// both GREEN and immutable RED modes. Execute its actual function source.
const uiStart = source.indexOf('async function uiTruthMatrix()');
assert.ok(uiStart >= 0 && uiStart < start, 'Exact UI truth matrix markers');
const uiMatrix = source.slice(uiStart, start);
for (const expectUiTruthRed of [false, true]) for (const failure of ['final-stop', 'final-stop-state']) {
  const report = {result: 'FAIL', scenarios: [], cleanupErrors: []};
  let revoked = false, stopped = false;
  const active = {status: {phase: 'connected', browser: {ok: true, country: 'EE', exitIp: '8.8.4.11'}},
    selectedCountries: ['AT', 'EE', 'NO'], route: {value: 'same real route'}};
  const state = async () => ({...active, enabled: !stopped, status: stopped ? {phase: 'off'} : active.status,
    dynamic: [], session: []});
  const env = {report, assert, countries: active.selectedCountries, expectUiTruthRed,
    begin: async () => {}, held: async () => {}, releasePending() {}, connected: async () => active,
    ordinaryOK: async () => ({status: 200}), blocked: async () => {}, requestURL: () => 'owned',
    until: async read => read(), pause: async () => {}, state, redact: value => value,
    fs: {mkdir: async () => {}}, path, output: '/owned/report.json',
    popup: {setViewportSize: async () => {}, screenshot: async () => {}, reload: async () => {},
      evaluate: async () => { revoked = true; return []; }, locator: () => ({click: async () => { stopped = true; }})},
    popupTruth: async () => ({phase: revoked && !expectUiTruthRed ? 'Подключение не подтверждено' : 'Подключено',
      green: !revoked || expectUiTruthRed, currentIP: revoked && !expectUiTruthRed ? '' : 'Выход сейчас: 8.8.4.11',
      proxyHidden: revoked && !expectUiTruthRed, stopVisible: true}),
    disconnect: async () => { if (failure === 'final-stop') throw Error('Injected final Stop rejection');
      assert.equal('stopping', 'off', 'Injected final Stop cleanup state mismatch'); }};
  await new AsyncFunction(...Object.keys(env), uiMatrix + '\ntry { await uiTruthMatrix(); } catch (error) {' + catchBody + '\n}')(...Object.values(env));
  assert.equal(report.scenarios.length, 1, 'UI assertions execute before final Stop failure');
  assert.equal(report.result, 'FAIL'); assert.ok(report.error);
  const fakeProcess = {exitCode: 0};
  new Function('report', 'process', exitLine)(report, fakeProcess);
  assert.equal(fakeProcess.exitCode, 1, 'UI truth cleanup failure cannot produce an accepted receipt');
}
assert.ok(guardLine, 'Exact acceptance failure normalization');
for (const harness of ['tests/preconfirm-traffic-lab.mjs', 'tests/runtime-startup-lab.mjs']) {
 const text = await fs.readFile(path.join(root, harness), 'utf8');
 const actualGuard = text.split('\n').find(line => line.trim().startsWith('if (report.error || report.cleanupErrors.length') && line.includes("report.result = 'FAIL'"));
 const actualExit = text.split('\n').find(line => line.trim().startsWith("if (!['PASS', 'RED_REPRODUCED'"));
 assert.ok(actualGuard && actualExit, harness + ': actual receipt/exit guards');
for (const accepted of ['PASS', 'RED_REPRODUCED']) for (const failure of ['recorded-error', 'cleanup-error', 'scratch-remains', 'registration-change', 'source-change']) {
  const report = {result: accepted, cleanupErrors: [], mainRegistrationUnchanged: true, scratchRemoved: true, changedExtension: []};
  if (failure === 'recorded-error') report.error = 'Injected recorded failure';
  if (failure === 'cleanup-error') report.cleanupErrors.push('Injected close failure');
  if (failure === 'scratch-remains') report.scratchRemoved = false;
  if (failure === 'registration-change') report.mainRegistrationUnchanged = false;
  if (failure === 'source-change') report.changedExtension.push('background.js');
  new Function('report', actualGuard)(report);
  assert.equal(report.result, 'FAIL', accepted + '/' + failure + ': failure must erase accepted receipt label');
  const fakeProcess = {exitCode: 0};
  new Function('report', 'process', actualExit)(report, fakeProcess);
  assert.equal(fakeProcess.exitCode, 1, failure + ': accepted matrix label cannot override failure evidence');
}
}
console.log(JSON.stringify({result: 'PASS', actualRuntimeHarness: true, injectedFailureCases: 39,
  matrixSHA256: crypto.createHash('sha256').update(matrix).digest('hex'), chrome: false, network: false}));
