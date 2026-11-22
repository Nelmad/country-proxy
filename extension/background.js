import {Controller, DEFAULTS, BLOCKED, CountrySettingsError, HandledControllerError,
  restoreCountrySettings, validateCountry, normalizeSelection, FEEDBACK_PROTOCOL, validOffer, matchesEffectiveRoute, RouteControlError} from './controller.js';
import {probeBrowser} from './probe.js';
import {TrafficGate} from './traffic-gate.js';
import {PrivacyGuard, PrivacyControlError, PRIVACY_REQUIREMENTS} from './privacy-guard.js';
import {FavoritesWriter} from './favorites.js';
const HOST = 'local.country_proxy';
let port = null;
let handshake = null;
const HANDSHAKE_TIMEOUT_MS = 5000;
// Diagnostic readers share the existing port. Bound pending reads across popup windows.
const reportReaders = new Map();
function cancelReports() {
  for (const read of reportReaders.values()) read.finish(null);
}
function readSourceQuality(country) {
  const id = controller.id;
  if (reportReaders.size >= 8 || !port || !handshake?.sourceQuality || !controller.enabled || !controller.countries.includes(country)) {
    return Promise.resolve(null);
  }
  return new Promise(resolve => {
    const token = crypto.randomUUID();
    const finish = value => {
      clearTimeout(timer);
      reportReaders.delete(token);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 2500);
    reportReaders.set(token, {id, country, finish});
    try { port.postMessage({command: 'sourceQuality', id, token, country}); }
    catch { finish(null); }
  });
}

function incompatible(p) {
  if (p !== port) return;
  clearTimeout(handshake?.timer); handshake = null; port = null;
  cancelReports();
  p.disconnect();
  controller.incompatible().catch(failure);
}
let allowed = [];
let favoritesWriter;
let preferencesLoading;
function initializePreferences() {
  if (!preferencesLoading) {
    // One shared attempt creates one writer. A failed attempt is retryable, but
    // never replays saved enabled intent or rewrites a newer explicit selection.
    preferencesLoading = Promise.all([chrome.storage.local.get(null),
      fetch(chrome.runtime.getURL('countries.json')).then(response => response.json())])
      .then(([saved, catalog]) => {
        allowed = catalog;
        favoritesWriter = new FavoritesWriter(chrome.storage.local, allowed);
        return saved;
      }).catch(error => { preferencesLoading = null; throw error; });
  }
  return preferencesLoading;
}
const privacy = chrome.privacy.network;
const privacyGuard = new PrivacyGuard(privacy);
let watchedRoute = null;
const trafficGate = new TrafficGate(chrome.declarativeNetRequest, chrome.runtime.id);
// Chrome settings writes have their own queue: emergency route protection never
// waits for controller/storage/native/DNR work. Every newer write and Stop clear
// still waits for already-issued protective writes to settle.
let routeTail = Promise.resolve();
function routeMutation(fn) {
  const job = routeTail.then(fn); routeTail = job.catch(() => {}); return job;
}
function protectRoute() {
  const id = controller.id;
  return routeMutation(async () => {
    if (id !== controller.id) return;
    watchedRoute = null;
    const actual = await chrome.proxy.settings.get({incognito: false});
    if (id !== controller.id) return;
    if (actual.levelOfControl !== 'controlled_by_this_extension') {
      // Release a hidden old candidate without replacing the foreign layer.
      if (actual.levelOfControl === 'controllable_by_this_extension') return false;
      const error = new RouteControlError();
      try { await chrome.proxy.settings.clear({scope: 'regular'}); }
      catch (failure) { error.message += '. ' + failure.message; }
      throw error;
    }
    await chrome.proxy.settings.set({value: BLOCKED, scope: 'regular'});
    const blocked = await chrome.proxy.settings.get({incognito: false});
    if (!matchesEffectiveRoute(blocked, BLOCKED)) throw new RouteControlError();
    return true;
  });
}

async function verifyRoute(value) {
  const actual = await chrome.proxy.settings.get({incognito: false});
  if (matchesEffectiveRoute(actual, value)) { await privacyGuard.verify(); return; }
  if (actual.levelOfControl !== 'controlled_by_this_extension') throw new RouteControlError();
  throw Error('Действующие правила прокси Chrome отличаются от ожидаемых');
}
async function apply(value, requireOwnership = false) {
  const id = controller.id;
  return routeMutation(async () => {
    if (id !== controller.id) return;
    watchedRoute = null; // Ignore notifications for the route we are replacing.
    const {levelOfControl} = await chrome.proxy.settings.get({incognito: false});
    if (id !== controller.id) return;
    if (requireOwnership && levelOfControl !== 'controlled_by_this_extension') {
      // Remove our hidden route so the old candidate cannot reappear when the
      // other owner releases control. clear() leaves that owner's layer in place.
      await chrome.proxy.settings.clear({scope: 'regular'});
      return false;
    }
    if (!['controllable_by_this_extension', 'controlled_by_this_extension'].includes(levelOfControl)) {
      throw new RouteControlError();
    }
    await chrome.proxy.settings.set({value, scope: 'regular'});
    await privacyGuard.apply();
    if (controller.id !== id) return;
    watchedRoute = {id, value};
    await verifyRoute(value);
    return true;
  });
}
let publicationTail = Promise.resolve();
let badgeTail = Promise.resolve();
let badgeRevision = 0;
const badgeAction = chrome.action;
function updateBadge(state, current) {
  const revision = ++badgeRevision;
  const latest = () => current() && revision === badgeRevision;
  // Cosmetic Chrome APIs have their own order. A delayed badge must never hold
  // up durable Stop intent, cleanup or a newer connection's saved status.
  badgeTail = badgeTail.then(async () => {
    if (!latest()) return;
    const ok = state.phase === 'connected';
    await badgeAction.setBadgeText({text: state.phase === 'off' ? '' : ok ? state.country : '…'});
    if (!latest()) return;
    await badgeAction.setBadgeBackgroundColor({color: ok ? '#288e72' : '#ad6b2f'});
  }).catch(() => {}); // Cosmetic failure neither changes status nor poisons the next badge.
}
function publish(status, storageChanges = {}, current = () => true) {
  const job = publicationTail.then(async () => {
    if (!current()) return;
    const state = {...status, updatedAt: Date.now()};
    delete state.id; delete state.type; delete state.force;
    await chrome.storage.local.set({...storageChanges, status: state});
    if (!current()) return;
    updateBadge(state, current);
  });
  publicationTail = job.catch(() => {});
  return job;
}
function save(values, current = () => true) {
  const job = publicationTail.then(() => current() ? chrome.storage.local.set(values) : undefined);
  publicationTail = job.catch(() => {});
  return job;
}
const controller = new Controller({
  apply, verifyRoute, protectRoute,
  holdTraffic: () => trafficGate.hold(),
  revokeTraffic: () => trafficGate.revoke(),
  allowTraffic: (ticket, current) => trafficGate.allow(ticket, current),
  verifyTraffic: () => trafficGate.assertOpen(),
  block: () => blockTraffic(),
  releaseOrBlockRoute: () => blockTraffic(true),
  save, publish,
  clear: async () => {
    // clear only releases this extension's own layer, including when another
    // extension or a policy currently masks it. Leave other owners in place.
    const {errors, proxyReleased} = await routeMutation(async () => {
      watchedRoute = null;
      const settings = [chrome.proxy.settings, privacy.webRTCIPHandlingPolicy, privacy.networkPredictionEnabled];
      const results = await Promise.allSettled(settings.map(async setting => setting.clear({scope: 'regular'})));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      let proxyReleased = results[0].status === 'fulfilled';
      if (proxyReleased) {
        try {
          if ((await chrome.proxy.settings.get({incognito: false})).levelOfControl === 'controlled_by_this_extension') {
            throw Error('Chrome сохранил маршрут расширения после отключения');
          }
        } catch (error) { proxyReleased = false; errors.push(error); }
      }
      return {errors, proxyReleased};
    });
    // A failed proxy clear may leave the not-yet-confirmed candidate installed.
    // Keep its request gate closed; still finish all independent privacy cleanup.
    try { if (proxyReleased) await trafficGate.clear(); else await trafficGate.hold(); }
    catch (error) { errors.push(error); }
    if (errors.length) throw Error(errors.map(error => error.message).join('. '));
  },
  startNative: async message => {
    cancelReports();
    if (!port) {
      const p = chrome.runtime.connectNative(HOST);
      port = p;
      const state = {ready: false, pending: message, timer: null};
      handshake = state;
      state.timer = setTimeout(() => incompatible(p), HANDSHAKE_TIMEOUT_MS);
      p.onMessage.addListener(event => {
        if (p !== port) return;
        if (event?.type === 'hello') {
          if (event.feedbackProtocol !== FEEDBACK_PROTOCOL) return incompatible(p);
          if (state.ready) return;
          clearTimeout(state.timer); state.ready = true; state.sourceQuality = event.sourceQuality === 1;
          const pending = state.pending; state.pending = null;
          if (pending?.id === controller.id && controller.enabled) p.postMessage(pending);
        } else if (event?.type === 'sourceQuality') {
          const read = reportReaders.get(event.token);
          if (read && read.id === controller.id && event.id === read.id &&
              event.report?.country === read.country) read.finish(event.report);
        } else if (event?.type === 'status') {
          if (event.id !== controller.id) return;
          if (!state.ready || event.feedbackProtocol !== FEEDBACK_PROTOCOL ||
              (['connected', 'confirming'].includes(event.phase) && !validOffer(event))) return incompatible(p);
          controller.status(event).catch(failure);
        }
      });
      p.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (p !== port) return;
        clearTimeout(state.timer); handshake = null; port = null;
        cancelReports();
        controller.lost().catch(failure);
      });
    } else if (handshake.ready) port.postMessage(message);
    else handshake.pending = message;
    await chrome.alarms.create('reconnect', {periodInMinutes: 0.5});
  },
  stopNative: async () => {
    cancelReports();
    const p = port; port = null; clearTimeout(handshake?.timer); handshake = null;
    try { if (p) { try { p.postMessage({command: 'stop'}); } finally { p.disconnect(); } } }
    finally { await chrome.alarms.clear('reconnect'); }
  },
  reject: message => { if (handshake?.ready) port?.postMessage(message); },
  confirm: message => { if (handshake?.ready) port?.postMessage(message); }
}, (country, signal) => probeBrowser(country, signal, {fetcher: trafficGate.probeFetcher(fetch)}));

async function blockTraffic(requireOwnership = false) {
  // Neither cleanup depends on success of the other: a DNR failure still tries
  // the blocked proxy, and a lost proxy owner still leaves our request gate held.
  const results = await Promise.allSettled([trafficGate.hold(), apply(BLOCKED, requireOwnership)]);
  const errors = results.filter(result => result.status === 'rejected');
  if (errors.length) {
    // Preserve lost ownership so failClosed releases our hidden route rather
    // than trying to reacquire it if the foreign owner leaves during startup.
    const error = errors.some(result => result.reason instanceof RouteControlError)
      ? new RouteControlError() : Error();
    error.message = errors.map(result => result.reason.message).join('. ');
    throw error;
  }
  return results[1].value;
}

async function failure(error) {
  if (error instanceof HandledControllerError) return;
  await publish({phase: 'error', proxy: null, country: controller.country,
    error: error.message || 'Не удалось изменить настройки Chrome'});
}
// This call precedes the first storage await. A sleeping worker may inherit
// session admission even though it has not reconstructed its settings watches.
const wakeRevocation = trafficGate.revoke().then(() => null, error => error);
const wakeProtection = protectRoute().then(() => null, error => error);
// Explicit Stop is accepted even while storage/catalog restoration is pending.
// Keep that intent separate from the saved snapshot: a late startup read must
// never resurrect it, including when the worker has already completed cleanup.
let restoreCancelled = false;
let stopRevision = 0;
const ready = (async () => {
  // Session admission survives worker suspension but not browser restart.
  // Close it before asynchronous restoration can apply a candidate again.
  // A disabled worker instead releases all owned rules through Stop below.
  const initial = await chrome.storage.local.get('enabled');
  // Route protection must run first, but its failure must not disable the
  // independent catalog/preferences services for the lifetime of this worker.
  const wakeErrors = (await Promise.all([wakeRevocation, wakeProtection])).filter(Boolean);
  let protectionError = wakeErrors.length
    ? (wakeErrors.some(error => error instanceof RouteControlError) ? new RouteControlError() : Error()) : null;
  if (protectionError) protectionError.message = wakeErrors.map(error => error.message).join('. ');
  if (initial.enabled === true && !restoreCancelled) {
    try {
      // A positively observed conflict belongs to this bootstrap even if the
      // foreign layer vanished while storage was pending. Do not reacquire it.
      if (protectionError instanceof RouteControlError) await trafficGate.hold();
      else await blockTraffic();
    } catch (error) {
      if (protectionError instanceof RouteControlError) protectionError.message += '. ' + error.message;
      else protectionError = error;
    }
  }
  const saved = await initializePreferences();
  const values = restoreCountrySettings(saved, allowed);
  await chrome.storage.local.set({countries: values.countries, reserveDiagnostics: null,
    ...(!values.invalidEnabledSelection ? {selectedCountries: values.selectedCountries, selectionMode: values.selectionMode} : {}),
    ...(!Object.hasOwn(saved, 'selected') ? {selected: DEFAULTS.selected} : {}),
    ...(!Object.hasOwn(saved, 'enabled') ? {enabled: DEFAULTS.enabled} : {})});
  if (restoreCancelled) return;
  if (values.invalidEnabledSelection) {
    // Keep the invalid saved intent visible until an explicit connect or disconnect.
    // Never silently pick a different country or expose a direct route on recovery.
    const message = 'Сохранённый выбор стран недоступен. Выберите страны заново или отключите прокси.';
    if (protectionError) {
      protectionError.message = message + ' ' + protectionError.message;
      await controller.failClosed(protectionError, controller.id);
    } else {
      await blockTraffic();
      if (restoreCancelled) return;
      await publish({phase: 'error', proxy: null, country: null, error: message});
    }
  } else if (values.enabled) await controller.start(
    values.selectionMode === 'multiple' ? values.selectedCountries : values.selected, protectionError);
  // A previous worker (including one from an older version) may have persisted
  // enabled=false and exited before releasing its settings.
  else await controller.stop();
})().catch(async error => {
  await Promise.all([wakeRevocation, wakeProtection]);
  if (restoreCancelled || error instanceof HandledControllerError) return;
  await initializationFailure(error, () => !restoreCancelled);
});

function initializationFailure(error, current) {
  return publish({phase: 'error', proxy: null, country: controller.country,
    lastFailure: {stage: 'local', ok: false, reason: 'infrastructure'},
    error: (error?.message || 'Ошибка восстановления настроек') +
      '. Защита трафика не подтверждена; повторите подключение или отключите прокси.'}, {}, current)
    // Diagnostics use the same fallible storage as startup. A failed error write
    // must not reject readiness forever or replace an explicit retry's real error.
    .catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender?.id !== chrome.runtime.id) return;
  (async () => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new CountrySettingsError('Некорректное действие');
    }
    if (message.action === 'disconnect') {
      // Older callers reuse the single-country command envelope for Stop.
      // Its optional country is inert, but malformed envelopes change no intent.
      if (Object.keys(message).some(key => !['action', 'country'].includes(key)) ||
          (Object.hasOwn(message, 'country') &&
            (typeof message.country !== 'string' || !/^[A-Z]{2}$/.test(message.country)))) {
        throw new CountrySettingsError('Некорректное действие');
      }
      restoreCancelled = true;
      ++stopRevision;
      await controller.stop();
      return {ok: true};
    }
    const receivedStopRevision = stopRevision;
    await ready;
    if (['connect', 'settings'].includes(message.action) && !favoritesWriter) {
      const initializationId = controller.id;
      try { await initializePreferences(); }
      catch (error) {
        if (message.action === 'connect') {
          await initializationFailure(error, () => receivedStopRevision === stopRevision && initializationId === controller.id);
        }
        // Preserve Stop/live state in the outer handler; this failure describes
        // local initialization rather than an invalid (empty) country catalogue.
        throw new CountrySettingsError(error.message || 'Ошибка восстановления настроек');
      }
    }
    if (message.action === 'connect') {
      let selection;
      if (Object.hasOwn(message, 'countries')) {
        if (Object.hasOwn(message, 'country')) throw new CountrySettingsError('Выберите один способ подключения');
        selection = normalizeSelection(message.countries, allowed);
      } else selection = validateCountry(message.country, allowed);
      // A Connect waiting for the catalog is older than any Stop received in
      // that interval. A newer explicit Connect still starts normally.
      if (receivedStopRevision === stopRevision) await controller.start(selection);
    } else if (message.action === 'rotate') {
      if (handshake?.ready) port?.postMessage({command: 'rotate', id: controller.id});
    } else if (message.action === 'sourceQuality') {
      return {ok: true, report: await readSourceQuality(message.country)};
    } else if (message.action === 'settings') {
      await favoritesWriter.write(message);
    } else {
      throw new CountrySettingsError('Неизвестное действие');
    }
    return {ok: true};
  })().then(respond, async error => {
    // A rejected preference is not a connection failure; preserve truthful live status.
    try { if (!(error instanceof CountrySettingsError)) await failure(error); }
    catch { /* Preserve the initiating error even when reporting storage is unavailable. */ }
    respond({ok: false, error: error.message});
  });
  return true;
});
chrome.alarms.onAlarm.addListener(async alarm => {
  await ready;
  if (alarm.name === 'reconnect' && controller.enabled && !controller.suspended && !port) {
    controller.start(controller.selectionMode === 'multiple' ? controller.countries : controller.country).catch(failure);
  }
});
chrome.proxy.settings.onChange.addListener(async change => {
  const watch = watchedRoute;
  if (change.incognitoSpecific || !watch || watch.id !== controller.id ||
      !controller.enabled || controller.suspended || matchesEffectiveRoute(change, watch.value)) return;
  // A foreign owner interrupted this route even if it already released control.
  // Invalidate first so an in-flight, same-country HTTPS response cannot confirm it.
  if (change.levelOfControl !== 'controlled_by_this_extension') {
    await controller.routeChanged(watch.id, new RouteControlError());
    return;
  }
  // An event from our previous write may arrive after the next one. Read the
  // regular profile again and bind the answer to this exact write and generation.
  try { await verifyRoute(watch.value); }
  catch (error) {
    if (watchedRoute === watch) await controller.routeChanged(watch.id, error);
  }
});
for (const [name, wanted] of Object.entries(PRIVACY_REQUIREMENTS)) {
  privacy[name].onChange?.addListener(change => {
    const watch = watchedRoute;
    if (change.incognitoSpecific || change.value === wanted || !watch || watch.id !== controller.id ||
        !controller.enabled || controller.suspended) return;
    // Invalidate and initiate revocation in this callback, before any awaited
    // reads, mutation queue or native Stop. Safe foreign values remain valid.
    controller.routeChanged(watch.id, new PrivacyControlError(name)).catch(failure);
  });
}
let lastErrorCheck = 0;
chrome.proxy.onProxyError.addListener(() => {
  if (Date.now() - lastErrorCheck > 15000 && port && handshake?.ready) {
    lastErrorCheck = Date.now(); port.postMessage({command: 'check', id: controller.id});
    controller.recheck().catch(failure);
  }
});
chrome.runtime.onStartup.addListener(() => { void ready; });
