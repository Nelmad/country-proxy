import {readReserveDiagnostics} from './reserve-diagnostics.js';
export const DEFAULTS = {countries: [], selected: null, selectedCountries: [], selectionMode: 'single', enabled: false};
export const BLOCKED = {mode: 'fixed_servers', rules: {
  proxyForHttp: {scheme: 'http', host: '127.0.0.1', port: 9},
  proxyForHttps: {scheme: 'http', host: '127.0.0.1', port: 9},
  fallbackProxy: {scheme: 'http', host: '127.0.0.1', port: 9}, bypassList: ['<-loopback>']
}};
export function proxyConfig(proxy) {
  if (!['http', 'https', 'socks4', 'socks5'].includes(proxy.scheme) ||
      !/^\d{1,3}(\.\d{1,3}){3}$/.test(proxy.host) ||
      !Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65535) throw Error('Некорректный прокси');
  const server = {scheme: proxy.scheme, host: proxy.host, port: proxy.port};
  return {mode: 'fixed_servers', rules: {proxyForHttp: server, proxyForHttps: server,
    fallbackProxy: server, bypassList: ['<-loopback>']}};
}
// Chrome can return SOCKS4 for the fallback of an HTTP proxy at the same address.
export function matchesEffectiveRoute(setting, expected) {
  if (setting?.levelOfControl !== 'controlled_by_this_extension' ||
      setting.value?.mode !== 'fixed_servers') return false;
  const rules = setting.value.rules;
  if (!rules || rules.singleProxy || rules.proxyForFtp ||
      rules.bypassList?.length !== 1 || rules.bypassList[0] !== '<-loopback>') return false;
  return ['proxyForHttp', 'proxyForHttps', 'fallbackProxy'].every(key => {
    const actual = rules[key], wanted = expected.rules[key];
    return actual?.host === wanted.host && actual.port === wanted.port &&
      (actual.scheme === wanted.scheme ||
       (key === 'fallbackProxy' && wanted.scheme === 'http' && actual.scheme === 'socks4'));
  });
}
export class RouteControlError extends Error {
  constructor() {
    super('Chrome не подтвердил непрерывное управление маршрутом');
  }
}
export class CountrySettingsError extends Error {}
export class HandledControllerError extends Error {}
export function validateCountry(country, allowed) {
  if (typeof country !== 'string' || !allowed.includes(country)) {
    throw new CountrySettingsError('Выберите страну из каталога');
  }
  return country;
}
// The old countries preference is now a favorites list, not a connection allowlist.
export function normalizeCountries(input, allowed) {
  if (!Array.isArray(input) || input.some(x => typeof x !== 'string')) {
    throw new CountrySettingsError('Избранные страны должны быть списком кодов из каталога');
  }
  const values = [...new Set(input.map(x => x.trim().toUpperCase()))];
  if (values.length > allowed.length || values.some(x => !allowed.includes(x))) {
    throw new CountrySettingsError('Выберите избранные страны из каталога');
  }
  return values;
}
// Selected countries are an unordered permission set, independent of favorites.
export function normalizeSelection(input, allowed) {
  if (!Array.isArray(input) || !input.length || input.length > allowed.length) {
    throw new CountrySettingsError('Выберите хотя бы одну страну из каталога');
  }
  return [...new Set(input.map(code => validateCountry(code, allowed)))].sort();
}
export function restoreCountrySettings(saved, allowed) {
  const countries = normalizeCountries((Array.isArray(saved.countries) ? saved.countries : [])
    .filter(x => typeof x === 'string' && allowed.includes(x.trim().toUpperCase())), allowed);
  const selectionMode = saved.selectionMode ?? 'single';
  let selectedCountries = [];
  if (selectionMode === 'multiple') {
    try { selectedCountries = normalizeSelection(saved.selectedCountries, allowed); } catch { /* Do not silently shrink an invalid set. */ }
  } else if (selectionMode === 'single' && typeof saved.selected === 'string' && allowed.includes(saved.selected)) {
    selectedCountries = [saved.selected];
  }
  const selected = selectionMode === 'single' ? selectedCountries[0] ?? null : null;
  const valid = selectedCountries.length > 0;
  return {countries, selected, selectedCountries, selectionMode,
    enabled: saved.enabled === true && valid,
    invalidEnabledSelection: saved.enabled === true && !valid};
}
export function proxyKey(p) { return p ? `${p.scheme}://${p.host}:${p.port}` : ''; }
export const FEEDBACK_PROTOCOL = 1;
function offerAddress(event) {
  return {id: event.id, attempt: event.attempt,
    proxy: {scheme: event.proxy.scheme, host: event.proxy.host, port: event.proxy.port}};
}
export function validOffer(event) {
  try { proxyConfig(event.proxy); return Number.isSafeInteger(event.attempt) && event.attempt > 0; }
  catch { return false; }
}
const failureReasons = new Set(['country', 'invalid_trace', 'http', 'timeout', 'transport', 'unknown']);
function verificationKey(event) {
  return JSON.stringify([event.id, event.attempt, proxyKey(event.proxy), event.proxy?.country,
    event.proxy?.exitIp, [...(event.countries || [event.country])].sort()]);
}

// Serializes mutations; generation changes immediately so stale checks cannot reconnect.
export class Controller {
  constructor(api, probe) {
    this.api = api; this.probe = probe; this.id = ''; this.enabled = false; this.suspended = false;
    // The rotate-only injected API is retained for the frozen, offline controller harness.
    // The native adapter always supplies reject and cannot take this compatibility path.
    this.addressed = typeof api.reject === 'function';
    this.offer = null; this.lastAttempt = 0; this.retiredAttempt = 0;
    this.reserveDiagnostics = null;
    this.countries = []; this.selectionMode = 'single';
    this.lastFailure = null; this.diagnostics = null;
    this.active = null; this.browser = null; this.lastBrowserCheck = 0; this.rejected = new Map(); this.abort = null; this.tail = Promise.resolve();
    this.verification = null; this.recheckIntent = null;
  }
  publish(event, storageChanges) {
    return this.api.publish({...event, countries: [...this.countries],
      country: event.browser?.country || event.proxy?.country || event.country || this.country || null, ...(this.diagnostics ? {diagnostics: this.diagnostics} : {}),
      ...(this.lastFailure ? {lastFailure: this.lastFailure} : {})}, {...storageChanges, reserveDiagnostics: this.reserveDiagnostics});
  }
  queue(fn) { const job = this.tail.then(fn); this.tail = job.catch(() => {}); return job; }
  guard(id, fn, report = false) {
    return this.queue(async () => {
      try { return await fn(); }
      catch (error) { const handled = await this.failClosed(error, id); if (report && handled) throw handled; }
    });
  }
  routeChanged(id, error) {
    if (!this.enabled || this.suspended || this.id !== id) return;
    const generation = this.invalidate(); // Interrupt the HTTPS check before waiting on its queue.
    return this.queue(() => this.failClosed(error, generation));
  }
  async failClosed(error, failedId) {
    if (failedId !== this.id) return;
    const id = this.invalidate();
    // A local policy/storage/transport error says nothing about endpoint health.
    // Keep the saved enabled intent truthful while suspending automatic retries.
    this.enabled = true; this.suspended = true;
    this.active = null; this.browser = null; this.offer = null;
    this.lastFailure = {stage: 'local', ok: false, reason: 'infrastructure'};
    const details = [error?.message || 'Ошибка локальной проверки маршрута'];
    try { await this.api.stopNative(); }
    catch (failure) { details.push('Не удалось остановить помощник: ' + failure.message); }
    if (id !== this.id) return;
    // Respect a setting that is now controlled by Chrome, the user or another extension.
    try {
      if (error instanceof RouteControlError) {
        if (!await this.api.releaseOrBlockRoute()) details.push('Блокировка прямого выхода не подтверждена');
      } else await this.api.block();
    }
    catch (failure) { details.push('Не удалось подтвердить блокировку и настройки защиты: ' + failure.message); }
    if (id !== this.id) return;
    try { await this.api.save({enabled: true, pool: null}); }
    catch (failure) { details.push('Не удалось сохранить состояние: ' + failure.message); }
    if (id !== this.id) return;
    const message = details.join('. ') + '. Автоматические попытки остановлены в этой сессии. Повторите подключение или отключите прокси.';
    await this.publish({phase: 'error', proxy: null, error: message});
    return new HandledControllerError(message);
  }
  invalidate() {
    this.reserveDiagnostics = null;
    this.verification = null; this.recheckIntent = null;
    this.id = crypto.randomUUID(); this.abort?.abort(); return this.id;
  }
  start(selection, protectionError = null) {
    const multiple = Array.isArray(selection);
    const countries = [...new Set(multiple ? selection : [selection])].sort();
    if (!countries.length || countries.some(code => typeof code !== 'string' || !/^[A-Z]{2}$/.test(code))) {
      throw new CountrySettingsError('Выберите страны из каталога');
    }
    const country = multiple ? null : countries[0];
    const id = this.invalidate();
    return this.guard(id, async () => {
      if (id !== this.id) return;
      this.lastFailure = null; this.diagnostics = null; this.offer = null; this.lastAttempt = 0; this.retiredAttempt = 0;
      this.enabled = true; this.suspended = false; this.country = country; this.countries = countries;
      this.selectionMode = multiple ? 'multiple' : 'single'; this.active = null; this.browser = null; this.rejected.clear();
      // Preserve the observed ownership failure before any redundant restore
      // write can replace it and accidentally attempt a fresh acquisition.
      if (protectionError) throw protectionError;
      await this.api.save({enabled: true, selected: country, selectedCountries: [...countries],
        selectionMode: this.selectionMode, pool: null, reserveDiagnostics: null});
      await this.api.block();
      await this.publish({phase: 'searching', country, proxy: null});
      if (id !== this.id) return;
      await this.api.startNative({command: 'start', country, countries: [...countries], id, feedbackProtocol: FEEDBACK_PROTOCOL});
    }, true);
  }
  stop() {
    const id = this.invalidate();
    this.enabled = false;
    return this.queue(async () => {
      if (id !== this.id) return;
      this.lastFailure = null; this.diagnostics = null;
      this.suspended = false; this.active = null; this.browser = null; this.offer = null;
      const disabled = {enabled: false, pool: null};
      const errors = [];
      try {
        // Persist the intent and drop the old green status in the same write.
        await this.publish({phase: 'stopping', proxy: null}, disabled);
      } catch (error) { errors.push(error.message); }
      // Finish every cleanup request before the next queued Start can apply its settings.
      const cleanup = await Promise.allSettled([this.api.stopNative(), this.api.clear()]);
      for (const result of cleanup) {
        if (result.status === 'rejected') errors.push(result.reason.message);
      }
      if (id !== this.id) return;
      if (!errors.length) {
        try { return await this.publish({phase: 'off', proxy: null}, disabled); }
        catch (error) { errors.push(error.message); }
      }
      if (id !== this.id) return;
      const message = 'Не удалось завершить отключение. Повторите отключение. ' + errors.join('. ');
      await this.publish({phase: 'stopError', proxy: null, error: message}, disabled);
      throw new HandledControllerError(message);
    });
  }
  incompatible() {
    if (!this.enabled) return Promise.resolve();
    const id = this.invalidate();
    return this.guard(id, async () => {
      if (!this.enabled || id !== this.id) return;
      this.active = null; this.browser = null; this.offer = null;
      await this.api.block();
      if (id !== this.id) return;
      await this.publish({phase: 'error', proxy: null,
        error: 'Несовместимый помощник: обновите помощник и расширение из одного комплекта.'});
    });
  }
  async reject(event, reason) {
    if (event.id !== this.id) return;
    const feedback = {...offerAddress(event), reason: failureReasons.has(reason) ? reason : 'unknown'};
    if (this.addressed) await this.api.reject({command: 'reject', ...feedback});
    else await this.api.rotate(feedback);
  }
  recheck() {
    if (!this.enabled || this.suspended || !this.active || !this.offer) return Promise.resolve();
    const event = {...this.offer, proxy: {...this.active}, countries: [...this.countries],
      country: this.active.country, phase: 'connected', force: true};
    const key = verificationKey(event);
    if (this.currentOffer(event) && this.verification?.key === key) return this.verification.job;
    if (this.currentOffer(event) && this.recheckIntent?.key === key && this.recheckIntent.state === 'queued') {
      return this.recheckIntent.job;
    }
    const intent = {key, state: 'queued', job: null, sourceJob: null};
    const job = this.status(event);
    intent.sourceJob = job;
    intent.job = job.finally(() => {
      if (this.recheckIntent === intent) this.recheckIntent = null;
    });
    this.recheckIntent = intent;
    return intent.job;
  }
  matchesSelection(event) {
    return Array.isArray(event.countries)
      ? event.countries.length === this.countries.length && [...event.countries].sort().every((code, i) => code === this.countries[i])
      : this.countries.length === 1 && event.country === this.countries[0];
  }
  currentOffer(event) {
    return event.id === this.id && (!this.addressed || event.attempt > this.retiredAttempt);
  }
  status(event) {
    if (this.addressed && this.enabled && event.id === this.id && this.matchesSelection(event) &&
        (event.feedbackProtocol !== FEEDBACK_PROTOCOL ||
          (['connected', 'confirming'].includes(event.phase) && !validOffer(event)))) return this.incompatible();
    // Offer numbers increase within a native session. Record a withdrawal even when
    // its offer is queued; only interrupt the probe for that exact offer.
    if (event.phase === 'replacing' && this.addressed && this.enabled && !this.suspended &&
        event.id === this.id && this.matchesSelection(event) && Number.isSafeInteger(event.attempt) && event.attempt > 0) {
      this.retiredAttempt = Math.max(this.retiredAttempt, event.attempt);
      if (this.offer?.attempt === event.attempt) this.abort?.abort();
    }
    const job = this.guard(event.id, async () => {
      if (!this.enabled || this.suspended || event.id !== this.id) return;
      if (!this.matchesSelection(event)) return;
      if (this.addressed && event.phase === 'replacing' && Number.isSafeInteger(event.attempt) && event.attempt < this.lastAttempt) return;
      if (event.diagnostics) {
        const {reserve, ...diagnostics} = event.diagnostics;
        this.diagnostics = diagnostics;
        this.reserveDiagnostics = readReserveDiagnostics(reserve);
      }
      if (event.phase === 'pool') {
        const count = Number.isInteger(event.reserveCount) ? Math.max(0, Math.min(2, event.reserveCount)) : 0;
        return this.api.save({reserveDiagnostics: this.reserveDiagnostics, pool: {country: this.country, countries: [...this.countries], count, checking: event.reserveChecking === true,
          expiresAt: Number.isFinite(event.reserveExpiresAt) ? event.reserveExpiresAt : 0}});
      }
      // A queued health warning may arrive after browser rejection or replacement.
      if (event.phase === 'confirming' &&
          (!this.active || proxyKey(event.proxy) !== proxyKey(this.active) ||
            (this.addressed && event.attempt !== this.offer?.attempt))) return;
      if (event.phase === 'connected' && event.proxy) {
        if (this.addressed) {
          if (event.attempt < this.lastAttempt || event.attempt <= this.retiredAttempt) return;
          if (event.attempt === this.lastAttempt && this.offer && proxyKey(event.proxy) !== proxyKey(this.offer.proxy)) return;
          if (event.force && event.attempt !== this.offer?.attempt) return;
          this.lastAttempt = event.attempt;
        }
        if ((this.rejected.get(proxyKey(event.proxy)) || 0) > Date.now()) {
          if (!this.addressed) return;
          this.retiredAttempt = event.attempt;
          this.active = null; this.browser = null;
          await this.api.block();
          if (event.id !== this.id) return;
          await this.publish({phase: 'replacing', proxy: null});
          await this.reject(event, this.lastFailure?.reason);
          return;
        }
        if (!this.countries.includes(event.proxy.country)) {
          if (this.addressed) this.retiredAttempt = event.attempt;
          this.rejected.set(proxyKey(event.proxy), Date.now() + 180000);
          this.active = null; this.browser = null;
          this.lastFailure = {stage: 'browser', ok: false, reason: 'country', country: event.proxy.country};
          await this.api.block();
          await this.publish({phase: 'replacing', proxy: null, country: null,
            note: 'Адрес вне выбранного набора стран отклонён.'});
          await this.reject(event, 'country'); return;
        }
        const same = proxyKey(this.active) === proxyKey(event.proxy);
        // A health update can change the observed egress even on the same proxy.
        // A queued browser recheck must not restore its obsolete native snapshot.
        const sameEgress = same && this.active.exitIp === event.proxy.exitIp && this.active.country === event.proxy.country;
        if (event.force && !sameEgress) return;
        if (same) {
          await this.api.verifyRoute?.(proxyConfig(event.proxy));
          if (!this.currentOffer(event)) return;
        }
        if (sameEgress && (!this.addressed || event.attempt === this.offer?.attempt) && !event.force && Date.now() - this.lastBrowserCheck < 60000) {
          await this.api.verifyTraffic?.();
          if (!this.currentOffer(event)) return;
          this.active = event.proxy; this.lastFailure = null;
          return this.publish({...event, browser: this.browser});
        }
        this.offer = {...offerAddress(event), feedbackProtocol: event.feedbackProtocol};
        // Native qualification is not permission for ordinary tabs. Keep them
        // blocked while Chrome makes the two required HTTPS requests, including
        // a same-endpoint recheck. The production adapter always supplies these
        // hooks; frozen controller-only fixtures retain their smaller API.
        const trafficTicket = await this.api.holdTraffic?.();
        if (!this.currentOffer(event)) return;
        if (!same) await this.api.apply(proxyConfig(event.proxy));
        // stop/start/lost may invalidate us while Chrome applies or publishes the route.
        // Do not create a new probe after their cancellation has already happened.
        if (!this.currentOffer(event)) return;
        await this.publish({...event, phase: 'verifying'});
        if (!this.currentOffer(event)) return;
        this.abort = new AbortController();
        const verification = {key: verificationKey(event), job};
        this.verification = verification;
        const intent = this.recheckIntent?.sourceJob === job ? this.recheckIntent : null;
        if (intent) intent.state = 'probing';
        let result;
        try { result = await this.probe(this.selectionMode === 'multiple' ? [...this.countries] : this.country, this.abort.signal); }
        catch (error) { if (error.name !== 'AbortError') throw error; result = {ok: false, reason: 'cancelled'}; }
        finally {
          // A new error after HTTPS completes needs new evidence, even while
          // route validation, addressed feedback or status publication waits.
          if (this.verification === verification) this.verification = null;
          if (intent) intent.state = 'settled';
        }
        if (!this.currentOffer(event) || result?.reason === 'cancelled') return;
        // A probe (even a failed one) is evidence about this endpoint only while Chrome
        // still uses the same fixed route. This also catches a missed settings event.
        await this.api.verifyRoute?.(proxyConfig(event.proxy));
        if (!this.currentOffer(event)) return;
        if (result?.ok && result.country && !this.countries.includes(result.country)) result = {...result, ok: false, reason: 'country'};
        if (result?.ok !== true) {
          if (this.addressed) this.retiredAttempt = event.attempt;
          this.rejected.set(proxyKey(event.proxy), Date.now() + 180000);
          this.active = null; this.browser = null;
          this.lastFailure = {stage: 'browser', ...(result || {ok: false, reason: 'transport'})};
          await this.api.block();
          await this.publish({phase: 'replacing', proxy: null, country: this.country,
            note: 'Chrome не подтвердил выход. Ищем следующий адрес.',
            diagnostic: this.lastFailure});
          await this.reject(event, result?.reason);
          return;
        }
        this.active = event.proxy; this.browser = result; this.lastFailure = null; this.lastBrowserCheck = Date.now();
        if (this.addressed) await this.api.confirm({command: 'confirm', ...offerAddress(event)});
        if (!this.currentOffer(event)) return;
        if (this.api.allowTraffic) {
          await this.api.verifyRoute?.(proxyConfig(event.proxy));
          if (!this.currentOffer(event)) return;
          if (!await this.api.allowTraffic(trafficTicket, () => this.currentOffer(event) && this.enabled && !this.suspended)) return;
          if (!this.currentOffer(event)) return;
          await this.api.verifyRoute?.(proxyConfig(event.proxy));
          if (!this.currentOffer(event)) return;
        }
      } else if (event.phase === 'confirming') {
        await this.api.verifyRoute?.(proxyConfig(event.proxy));
        await this.api.verifyTraffic?.();
        if (!this.currentOffer(event)) return;
      } else if (['searching', 'replacing', 'reserve', 'empty', 'error'].includes(event.phase)) {
        if (this.addressed && this.offer) this.retiredAttempt = Math.max(this.retiredAttempt, this.offer.attempt);
        this.active = null; this.browser = null;
        await this.api.block();
      }
      await this.publish({...event, ...(['connected', 'confirming'].includes(event.phase) ? {browser: this.browser} : {})});
    });
    return job;
  }
  lost() {
    if (!this.enabled) return Promise.resolve();
    // Reject already queued events from the disconnected native session before they apply a route.
    const id = this.invalidate();
    return this.guard(id, async () => {
      if (!this.enabled || id !== this.id) return;
      this.active = null; this.browser = null; this.offer = null;
      await this.api.block();
      await this.api.save({pool: null});
      await this.publish({phase: 'helper', proxy: null, country: this.country});
    });
  }
}
