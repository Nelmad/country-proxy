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
    fallbackProxy: server, bypassList: []}};
}
// Chrome can return SOCKS4 for the fallback of an HTTP proxy at the same address.
export function matchesEffectiveRoute(setting, expected) {
  if (setting?.levelOfControl !== 'controlled_by_this_extension' ||
      setting.value?.mode !== 'fixed_servers') return false;
  const rules = setting.value.rules;
  if (!rules || rules.singleProxy || rules.proxyForFtp ||
      JSON.stringify(rules.bypassList || []) !== JSON.stringify(expected.rules.bypassList || [])) return false;
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
function sameOffer(event, offer) {
  return offer && event.id === offer.id && event.attempt === offer.attempt &&
    proxyKey(event.proxy) === proxyKey(offer.proxy);
}
export function validOffer(event) {
  try { proxyConfig(event.proxy); return Number.isSafeInteger(event.attempt) && event.attempt > 0; }
  catch { return false; }
}
const failureReasons = new Set(['country', 'invalid_trace', 'http', 'timeout', 'transport', 'unknown']);
// Local proof revision cannot be supplied by a native message. A known country
// failure invalidates pending/cached Chrome proof without retiring the offer.
const admissionRevision = Symbol('admissionRevision');
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
    this.offer = null; this.receivedOffer = null; this.lastAttempt = 0; this.retiredAttempt = 0;
    this.reserveDiagnostics = null;
    this.countries = []; this.selectionMode = 'single';
    this.lastFailure = null; this.diagnostics = null;
    this.active = null; this.browser = null; this.lastBrowserCheck = 0; this.rejected = new Map(); this.abort = null; this.tail = Promise.resolve();
    this.verification = null; this.recheckIntent = null; this.transitionBarrier = Promise.resolve();
    this.admissionRevision = 0;
  }
  publish(event, storageChanges) {
    const id = event.id ?? this.id;
    if (id !== this.id) return Promise.resolve();
    return this.api.publish({...event, countries: [...this.countries],
      country: event.browser?.country || event.proxy?.country || event.country || this.country || null, ...(this.diagnostics ? {diagnostics: this.diagnostics} : {}),
      ...(this.lastFailure ? {lastFailure: this.lastFailure} : {})}, {...storageChanges, reserveDiagnostics: this.reserveDiagnostics}, () => id === this.id);
  }
  save(values, id = this.id) {
    if (id !== this.id) return Promise.resolve();
    return this.api.save(values, () => id === this.id);
  }
  queue(fn) { const job = this.tail.then(fn); this.tail = job.catch(() => {}); return job; }
  guard(id, fn, report = false, current = () => true) {
    return this.queue(async () => {
      try { return await fn(); }
      catch (error) {
        if (!current()) return;
        const handled = await this.failClosed(error, id); if (report && handled) throw handled;
      }
    });
  }
  transition(protect = this.enabled) {
    const id = this.invalidate();
    const revocation = this.revokeTraffic();
    let protection;
    try { protection = Promise.resolve(protect ? this.api.protectRoute?.() : undefined)
      .then(value => ({value}), error => ({error})); }
    catch (error) { protection = Promise.resolve({error}); }
    // A newer transition must join every outstanding guard, including a failed
    // operation whose older sibling is still pending. Completion never rejects.
    const done = Promise.allSettled([this.transitionBarrier, revocation, protection]).then(() => undefined);
    this.transitionBarrier = done;
    return {id, revocation, protection, done};
  }
  failureNotice(error, id) {
    this.active = null; this.browser = null; this.offer = null;
    this.lastFailure = {stage: 'local', ok: false, reason: 'infrastructure'};
    // Publication is generation-bound and serialized by the production adapter.
    // Drop green status even if a guard API or controller job has not completed.
    return this.publish({id, phase: 'error', proxy: null,
      error: (error?.message || 'Ошибка локальной проверки маршрута') +
        '. Защита трафика не подтверждена; выполняется защитная остановка. Повторите подключение или отключите прокси.'},
      {enabled: true, pool: null}).catch(() => {});
  }
  routeChanged(id, error) {
    if (!this.enabled || this.suspended || this.id !== id) return;
    this.suspended = true; // Passive helper events cannot replace a security failure.
    const transition = this.transition(true);
    void this.failureNotice(error, transition.id);
    return this.queue(() => this.failClosed(error, transition.id, transition));
  }
  revokeTraffic() {
    try { return Promise.resolve(this.api.revokeTraffic?.()).then(() => null, error => error); }
    catch (error) { return Promise.resolve(error); }
  }
  withdrawAdmission() {
    ++this.admissionRevision;
    this.abort?.abort(); this.verification = null; this.recheckIntent = null;
    this.active = null; this.browser = null; this.lastBrowserCheck = 0;
    // These calls must start independently of storage/controller jobs. New
    // offers, Start and Stop all join their completion before changing routes.
    const revocation = this.revokeTraffic();
    let protection;
    try { protection = Promise.resolve(this.api.protectRoute?.())
      .then(value => ({value}), error => ({error})); }
    catch (error) { protection = Promise.resolve({error}); }
    const done = Promise.allSettled([this.transitionBarrier, revocation, protection]).then(() => undefined);
    this.transitionBarrier = done;
    return {done, revocation, protection};
  }
  async failClosed(error, failedId, transition = null) {
    if (failedId !== this.id) return;
    this.enabled = true; this.suspended = true;
    transition ??= this.transition(true);
    const id = transition.id;
    void this.failureNotice(error, id);
    const details = [error?.message || 'Ошибка локальной проверки маршрута'];
    // Both guard calls were already initiated independently of this queue.
    // Never release the barrier just because one of them failed quickly.
    await transition.done;
    if (id !== this.id) return;
    const revokeError = await transition.revocation;
    if (revokeError) details.push('Не удалось немедленно закрыть допуск трафика: ' + revokeError.message);
    const protectedRoute = await transition.protection;
    if (protectedRoute.error) details.push('Не удалось подтвердить независимую блокировку маршрута: ' + protectedRoute.error.message);
    if (protectedRoute.value === false) details.push('Блокировка прямого выхода не подтверждена');
    // Retry both normal protections; these also refresh the durable DNR policy.
    try {
      if (error instanceof RouteControlError) {
        if (!await this.api.releaseOrBlockRoute()) details.push('Блокировка прямого выхода не подтверждена');
      } else await this.api.block();
    }
    catch (failure) { details.push('Не удалось подтвердить блокировку и настройки защиты: ' + failure.message); }
    if (id !== this.id) return;
    try { await this.api.stopNative(); }
    catch (failure) { details.push('Не удалось остановить помощник: ' + failure.message); }
    if (id !== this.id) return;
    try { await this.save({enabled: true, pool: null}, id); }
    catch (failure) { details.push('Не удалось сохранить состояние: ' + failure.message); }
    if (id !== this.id) return;
    const message = details.join('. ') + '. Автоматические попытки остановлены в этой сессии. Повторите подключение или отключите прокси.';
    await this.publish({id, phase: 'error', proxy: null, error: message});
    return new HandledControllerError(message);
  }
  invalidate() {
    this.reserveDiagnostics = null;
    this.receivedOffer = null;
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
    const transition = this.transition();
    const id = transition.id;
    this.suspended = true;
    return this.guard(id, async () => {
      await transition.done;
      if (id !== this.id) return;
      this.lastFailure = null; this.diagnostics = null; this.offer = null; this.lastAttempt = 0; this.retiredAttempt = 0;
      this.enabled = true; this.suspended = false; this.country = country; this.countries = countries;
      this.selectionMode = multiple ? 'multiple' : 'single'; this.active = null; this.browser = null; this.rejected.clear();
      // Preserve the observed ownership failure before any redundant restore
      // write can replace it and accidentally attempt a fresh acquisition.
      if (protectionError) throw protectionError;
      await this.save({enabled: true, selected: country, selectedCountries: [...countries],
        selectionMode: this.selectionMode, pool: null, reserveDiagnostics: null}, id);
      await this.api.block();
      if (id !== this.id) return;
      await this.publish({id, phase: 'searching', country, proxy: null});
      if (id !== this.id) return;
      await this.api.startNative({command: 'start', country, countries: [...countries], id, feedbackProtocol: FEEDBACK_PROTOCOL});
    }, true);
  }
  stop() {
    const transition = this.transition();
    const id = transition.id;
    this.enabled = false;
    this.lastFailure = null; this.diagnostics = null;
    this.active = null; this.browser = null; this.offer = null;
    const disabled = {enabled: false, pool: null};
    // Persist the user's intent independently of pending Chrome protections.
    // The adapter orders this with every other controller storage mutation and
    // checks generation before starting, so an older Start cannot restore true.
    const intent = this.publish({id, phase: 'stopping', proxy: null}, disabled)
      .then(() => null, error => error);
    return this.queue(async () => {
      await transition.done;
      if (id !== this.id) return;
      this.suspended = false;
      const errors = [];
      const intentError = await intent;
      if (intentError) errors.push(intentError.message);
      if (id !== this.id) return;
      // Finish every cleanup request before the next queued Start can apply its settings.
      const cleanup = await Promise.allSettled([this.api.stopNative(), this.api.clear()]);
      for (const result of cleanup) {
        if (result.status === 'rejected') errors.push(result.reason.message);
      }
      if (id !== this.id) return;
      if (!errors.length) {
        try { return await this.publish({id, phase: 'off', proxy: null}, disabled); }
        catch (error) { errors.push(error.message); }
      }
      if (id !== this.id) return;
      const message = 'Не удалось завершить отключение. Повторите отключение. ' + errors.join('. ');
      // Cleanup failure remains a Stop failure even when its diagnostic write
      // also fails. Never let the generic command handler replace it with an
      // unrelated error phase. One bounded retry handles transient storage;
      // durable 'stopping' still offers Retry Stop when both writes reject.
      const status = {id, phase: 'stopError', proxy: null, error: message};
      try { await this.publish(status, disabled); }
      catch {
        if (id !== this.id) return;
        try { await this.publish(status, disabled); } catch { /* Keep durable Stop intent. */ }
      }
      if (id !== this.id) return;
      throw new HandledControllerError(message);
    });
  }
  incompatible() {
    if (!this.enabled || this.suspended) return Promise.resolve();
    const transition = this.transition();
    const id = transition.id;
    this.suspended = true;
    return this.guard(id, async () => {
      await transition.done;
      if (!this.enabled || id !== this.id) return;
      this.active = null; this.browser = null; this.offer = null;
      await this.api.block();
      if (id !== this.id) return;
      await this.publish({phase: 'error', proxy: null,
        error: 'Несовместимый помощник: обновите помощник и расширение из одного комплекта.'});
      if (id === this.id) this.suspended = false;
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
    return event.id === this.id && (!this.addressed || event.attempt > this.retiredAttempt) &&
      (event[admissionRevision] === undefined || event[admissionRevision] === this.admissionRevision);
  }
  status(event) {
    if (this.addressed && this.enabled && event.id === this.id && this.matchesSelection(event) &&
        (event.feedbackProtocol !== FEEDBACK_PROTOCOL ||
          (['connected', 'confirming'].includes(event.phase) && !validOffer(event)))) return this.incompatible();
    let withdrawal = null;
    const matchingSession = this.addressed && this.enabled && !this.suspended &&
      event.id === this.id && this.matchesSelection(event);
    // Native health can overtake an offer waiting behind storage. Record its
    // identity at receipt, before the mutation queue can apply or admit it.
    // Only a newer native attempt can replace that identity; local rechecks,
    // old generations and a different endpoint for the same attempt cannot.
    if (matchingSession && event.phase === 'connected' && !event.force &&
        event.attempt > this.retiredAttempt && event.attempt >= this.lastAttempt &&
        (!this.receivedOffer || event.attempt > this.receivedOffer.attempt)) {
      this.receivedOffer = offerAddress(event);
    }
    const countryNegative = matchingSession && event.phase === 'confirming' &&
      sameOffer(event, this.receivedOffer || this.offer) && event.attempt > this.retiredAttempt &&
      event.health?.ok === false && event.health.reason === 'country';
    if (countryNegative) {
      withdrawal = this.withdrawAdmission();
      this.lastFailure = {stage: 'native', ...event.health};
    }
    // Offer numbers increase within a native session. Record a withdrawal even when
    // its offer is queued; only interrupt the probe for that exact offer.
    if (event.phase === 'replacing' && this.addressed && this.enabled && !this.suspended &&
        event.id === this.id && this.matchesSelection(event) && Number.isSafeInteger(event.attempt) && event.attempt > 0) {
      if (event.attempt >= Math.max(this.lastAttempt, this.receivedOffer?.attempt || 0) && event.attempt > this.retiredAttempt) {
        withdrawal = this.withdrawAdmission();
      }
      this.retiredAttempt = Math.max(this.retiredAttempt, event.attempt);
    }
    event = {...event, [admissionRevision]: this.admissionRevision};
    const job = this.guard(event.id, async () => {
      if (!this.enabled || this.suspended || event.id !== this.id) return;
      if (!this.matchesSelection(event)) return;
      await this.transitionBarrier;
      if (!this.enabled || this.suspended || event.id !== this.id ||
          event[admissionRevision] !== this.admissionRevision) return;
      if (withdrawal) {
        const revokeError = await withdrawal.revocation;
        const protectedRoute = await withdrawal.protection;
        if (revokeError) throw revokeError;
        if (protectedRoute.error) throw protectedRoute.error;
        if (protectedRoute.value === false) throw new RouteControlError();
      }
      if (this.addressed && event.phase === 'replacing' && Number.isSafeInteger(event.attempt) && event.attempt < this.lastAttempt) return;
      if (event.diagnostics) {
        const {reserve, ...diagnostics} = event.diagnostics;
        this.diagnostics = diagnostics;
        this.reserveDiagnostics = readReserveDiagnostics(reserve);
      }
      if (event.phase === 'pool') {
        const count = Number.isInteger(event.reserveCount) ? Math.max(0, Math.min(2, event.reserveCount)) : 0;
        return this.save({reserveDiagnostics: this.reserveDiagnostics, pool: {country: this.country, countries: [...this.countries], count, checking: event.reserveChecking === true,
          expiresAt: Number.isFinite(event.reserveExpiresAt) ? event.reserveExpiresAt : 0}}, event.id);
      }
      // A queued health warning may arrive after browser rejection or replacement.
      const latestOffer = this.addressed ? this.receivedOffer || this.offer : this.active;
      if (event.phase === 'confirming' &&
          ((!this.addressed && !this.active) || proxyKey(event.proxy) !== proxyKey(latestOffer?.proxy || latestOffer) ||
            (this.addressed && (event.attempt !== latestOffer?.attempt || event.attempt <= this.retiredAttempt)))) return;
      if (event.phase === 'connected' && event.proxy) {
        if (!this.currentOffer(event)) return;
        if (this.addressed && this.receivedOffer && !sameOffer(event, this.receivedOffer)) return;
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
        if (sameEgress && this.browser && (!this.addressed || event.attempt === this.offer?.attempt) && !event.force && Date.now() - this.lastBrowserCheck < 60000) {
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
        // Country-negative evidence revoked admission. A native success must
        // first take the full Chrome proof path before either check can be green.
        if (this.active && this.browser) {
          await this.api.verifyRoute?.(proxyConfig(event.proxy));
          if (!this.currentOffer(event)) return;
          await this.api.verifyTraffic?.();
        }
        if (!this.currentOffer(event)) return;
      } else if (['searching', 'replacing', 'reserve', 'empty', 'error'].includes(event.phase)) {
        if (this.addressed && this.offer) this.retiredAttempt = Math.max(this.retiredAttempt, this.offer.attempt);
        this.active = null; this.browser = null;
        await this.api.block();
      }
      await this.publish({...event, ...(['connected', 'confirming'].includes(event.phase) ? {browser: this.browser} : {})});
    }, false, () => event[admissionRevision] === this.admissionRevision);
    return job;
  }
  lost() {
    if (!this.enabled || this.suspended) return Promise.resolve();
    // Reject queued offers and revoke the old admission before waiting here.
    const transition = this.transition();
    const id = transition.id;
    this.suspended = true;
    return this.guard(id, async () => {
      await transition.done;
      if (!this.enabled || id !== this.id) return;
      this.active = null; this.browser = null; this.offer = null;
      await this.api.block();
      await this.save({pool: null}, id);
      if (id !== this.id) return;
      await this.publish({id, phase: 'helper', proxy: null, country: this.country});
      if (id === this.id) this.suspended = false;
    });
  }
}
