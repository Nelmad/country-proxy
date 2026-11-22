// Imported only by an ephemeral manifest in runtime-startup-lab.mjs.
// Production background.js remains byte-identical and is dynamically imported.
// Only storage/catalog timing and one rejected storage Promise are injected.
// The harness prepends a literal options object; no production code is patched.
const originalGet = chrome.storage.local.get.bind(chrome.storage.local);
const originalFetch = globalThis.fetch;
const originalSet = chrome.storage.local.set.bind(chrome.storage.local);
const originalProxyGet = chrome.proxy.settings.get.bind(chrome.proxy.settings);
const originalProxySet = chrome.proxy.settings.set.bind(chrome.proxy.settings);
const originalProxyClear = chrome.proxy.settings.clear.bind(chrome.proxy.settings);
let releaseStart, releaseRead, releaseCatalog;
const start = new Promise(resolve => { releaseStart = resolve; });
const read = new Promise(resolve => { releaseRead = resolve; });
const catalog = new Promise(resolve => { releaseCatalog = resolve; });
const fixture = globalThis.__runtimeFixture = {initialRead: 0, initialReadPending: false,
  catalogPending: false, storageRejected: 0, errorWriteRejected: 0, imported: false, routeReads: [], proxyClears: 0, proxyWrites: 0,
  start: () => { releaseStart(); return true; },
  releaseRead: () => { releaseRead(); return true; },
  releaseCatalog: () => { releaseCatalog(); return true; }};
const savedReady = chrome.storage.local.set(options.saved).then(() => { fixture.prepared = true; });
chrome.proxy.settings.get = async (...args) => {
  await savedReady; await start;
  const value = await originalProxyGet(...args); fixture.routeReads.push(value.levelOfControl); return value;
};
chrome.proxy.settings.set = async (...args) => { fixture.proxyWrites++; return originalProxySet(...args); };
chrome.proxy.settings.clear = async (...args) => { fixture.proxyClears++; return originalProxyClear(...args); };
chrome.storage.local.set = async values => {
  if (options.rejectFirstErrorWrite && !fixture.errorWriteRejected && values.status?.phase === 'error') {
    fixture.errorWriteRejected++;
    throw Error('Injected single initial error-status storage.local.set rejection');
  }
  return originalSet(values);
};
chrome.storage.local.get = async keys => {
  await savedReady; await start;
  if (keys === 'enabled' && ++fixture.initialRead === 1) {
    if (options.rejectInitialRead) {
      fixture.storageRejected++;
      throw Error('Injected single initial storage.local.get rejection');
    }
    if (options.holdInitialRead) {
      fixture.initialReadPending = true;
      await read;
      fixture.initialReadPending = false;
    }
  }
  return originalGet(keys);
};
globalThis.fetch = async (...args) => {
  if (options.holdCatalog && args[0] === chrome.runtime.getURL('countries.json')) {
    fixture.catalogPending = true;
    await catalog;
    fixture.catalogPending = false;
  }
  return originalFetch(...args);
};
