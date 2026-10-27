import {Controller, DEFAULTS, BLOCKED, normalizeCountries} from './controller.js';
const HOST = 'local.country_proxy';
let port = null;
const privacy = chrome.privacy.network;
async function apply(value) {
  const {levelOfControl} = await chrome.proxy.settings.get({incognito: false});
  if (!['controllable_by_this_extension', 'controlled_by_this_extension'].includes(levelOfControl)) {
    throw Error('Настройками прокси управляет другое расширение или политика Chrome');
  }
  await chrome.proxy.settings.set({value, scope: 'regular'});
  await privacy.webRTCIPHandlingPolicy.set({value: 'disable_non_proxied_udp', scope: 'regular'});
  await privacy.networkPredictionEnabled.set({value: false, scope: 'regular'});
}
async function publish(status) {
  const state = {...status, updatedAt: Date.now()};
  delete state.id; delete state.type; delete state.force;
  await chrome.storage.local.set({status: state});
  const ok = state.phase === 'connected';
  await chrome.action.setBadgeText({text: state.phase === 'off' ? '' : ok ? state.country : '…'});
  await chrome.action.setBadgeBackgroundColor({color: ok ? '#288e72' : '#ad6b2f'});
}
async function probe(country, signal) {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(50000)]);
  const query = '?t=' + Date.now();
  const [trace, target] = await Promise.all([
    fetch('https://www.cloudflare.com/cdn-cgi/trace' + query,
      {signal: combined, cache: 'no-store', credentials: 'omit', redirect: 'error'}),
    fetch('https://www.google.com/generate_204' + query,
      {signal: combined, cache: 'no-store', credentials: 'omit', redirect: 'error'})
  ]);
  if (!trace.ok || target.status !== 204) { console.info('Probe HTTP',trace.status,target.status); return false; }
  const data = Object.fromEntries((await trace.text()).trim().split('\n').map(x => x.split('=')));
  if (data.loc !== country) console.info('Probe country mismatch', country, data.loc);
  return data.loc === country && !!data.ip;
}
const controller = new Controller({
  apply, block: () => apply(BLOCKED),
  save: values => chrome.storage.local.set(values), publish,
  clear: async () => {
    await chrome.proxy.settings.clear({scope: 'regular'});
    await privacy.webRTCIPHandlingPolicy.clear({scope: 'regular'});
    await privacy.networkPredictionEnabled.clear({scope: 'regular'});
    await chrome.alarms.clear('reconnect');
  },
  startNative: async message => {
    if (!port) {
      const p = chrome.runtime.connectNative(HOST);
      port = p;
      p.onMessage.addListener(event => {
        if (p === port && event.type === 'status') controller.status(event).catch(failure);
      });
      p.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (p !== port) return;
        port = null;
        controller.lost().catch(failure);
      });
    }
    port.postMessage(message);
    await chrome.alarms.create('reconnect', {periodInMinutes: 0.5});
  },
  stopNative: () => { const p = port; port = null; if (p) { p.postMessage({command: 'stop'}); p.disconnect(); } },
  rotate: () => port?.postMessage({command: 'rotate'})
}, probe);

async function failure(error) {
  await publish({phase: 'error', proxy: null, country: controller.country,
    error: error.message || 'Не удалось изменить настройки Chrome'});
}
const ready = (async () => {
  const saved = await chrome.storage.local.get(null);
  const values = {...DEFAULTS, ...saved};
  if (!saved.countries) await chrome.storage.local.set(DEFAULTS);
  if (values.enabled) await controller.start(values.selected);
  else await publish({phase: 'off', proxy: null});
})().catch(failure);

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  (async () => {
    await ready;
    const allowed = await (await fetch(chrome.runtime.getURL('countries.json'))).json();
    if (message.action === 'connect') {
      const {countries} = await chrome.storage.local.get('countries');
      if (!allowed.includes(message.country) || !countries.includes(message.country)) throw Error('Добавьте страну в настройках');
      await controller.start(message.country);
    } else if (message.action === 'disconnect') {
      await controller.stop();
    } else if (message.action === 'rotate') {
      port?.postMessage({command: 'rotate'});
    } else if (message.action === 'settings') {
      const countries = normalizeCountries(message.countries, allowed);
      const saved = await chrome.storage.local.get(['selected', 'enabled']);
      const selected = countries.includes(saved.selected) ? saved.selected : countries[0];
      await chrome.storage.local.set({countries, selected});
      if (saved.enabled && selected !== saved.selected) await controller.start(selected);
    }
    return {ok: true};
  })().then(respond, async error => { await failure(error); respond({ok: false, error: error.message}); });
  return true;
});
chrome.alarms.onAlarm.addListener(async alarm => {
  await ready;
  if (alarm.name === 'reconnect' && controller.enabled && !port) {
    controller.start(controller.country).catch(failure);
  }
});
let lastErrorCheck = 0;
chrome.proxy.onProxyError.addListener(() => {
  if (Date.now() - lastErrorCheck > 15000 && port) {
    lastErrorCheck = Date.now(); port.postMessage({command: 'check'});
    if (controller.active) controller.status({id: controller.id, country: controller.country,
      phase: 'connected', proxy: controller.active, force: true}).catch(failure);
  }
});
chrome.runtime.onStartup.addListener(() => { void ready; });
