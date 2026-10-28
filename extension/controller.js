export const DEFAULTS = {countries: ['NO', 'EE', 'AT'], selected: 'NO', enabled: false};
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
export function normalizeCountries(input, allowed) {
  const values = [...new Set(input.map(x => String(x).trim().toUpperCase()))];
  if (!values.length || values.length > 249 || values.some(x => !allowed.includes(x))) {
    throw Error('Выберите хотя бы одну страну из списка');
  }
  return values;
}
export function proxyKey(p) { return p ? `${p.scheme}://${p.host}:${p.port}` : ''; }

// Serializes mutations; generation changes immediately so stale checks cannot reconnect.
export class Controller {
  constructor(api, probe) {
    this.api = api; this.probe = probe; this.id = ''; this.enabled = false;
    this.active = null; this.lastBrowserCheck = 0; this.rejected = new Map(); this.abort = null; this.tail = Promise.resolve();
  }
  queue(fn) { const job = this.tail.then(fn); this.tail = job.catch(() => {}); return job; }
  invalidate() { this.id = crypto.randomUUID(); this.abort?.abort(); return this.id; }
  start(country) {
    const id = this.invalidate();
    return this.queue(async () => {
      if (id !== this.id) return;
      this.enabled = true; this.country = country; this.active = null; this.rejected.clear();
      await this.api.save({enabled: true, selected: country, pool: null});
      await this.api.block();
      await this.api.publish({phase: 'searching', country, proxy: null});
      await this.api.startNative({command: 'start', country, id});
    });
  }
  stop() {
    const id = this.invalidate();
    return this.queue(async () => {
      if (id !== this.id) return;
      this.enabled = false; this.active = null;
      await this.api.save({enabled: false, pool: null});
      this.api.stopNative();
      await this.api.clear();
      await this.api.publish({phase: 'off', proxy: null});
    });
  }
  status(event) {
    return this.queue(async () => {
      if (!this.enabled || event.id !== this.id || event.country !== this.country) return;
      if (event.phase === 'pool') {
        const count = Number.isInteger(event.reserveCount) ? Math.max(0, Math.min(2, event.reserveCount)) : 0;
        return this.api.save({pool: {country: this.country, count, checking: event.reserveChecking === true,
          expiresAt: Number.isFinite(event.reserveExpiresAt) ? event.reserveExpiresAt : 0}});
      }
      // A queued health warning may arrive after browser rejection or replacement.
      if (event.phase === 'confirming' &&
          (!this.active || proxyKey(event.proxy) !== proxyKey(this.active))) return;
      if (event.phase === 'connected' && event.proxy) {
        if ((this.rejected.get(proxyKey(event.proxy)) || 0) > Date.now()) return;
        if (event.proxy.country !== this.country) throw Error('Страна прокси не совпадает');
        const same = proxyKey(this.active) === proxyKey(event.proxy);
        if (same && !event.force && Date.now() - this.lastBrowserCheck < 60000) {
          this.active = event.proxy;
          return this.api.publish(event);
        }
        if (!same) await this.api.apply(proxyConfig(event.proxy));
        await this.api.publish({...event, phase: 'verifying'});
        this.abort = new AbortController();
        let valid = false;
        try { valid = await this.probe(this.country, this.abort.signal); } catch (error) { console.info('Browser probe failed:', error.name, error.message); }
        if (event.id !== this.id) return;
        if (!valid) {
          this.rejected.set(proxyKey(event.proxy), Date.now() + 180000);
          this.active = null;
          await this.api.block();
          await this.api.publish({phase: 'replacing', proxy: null, country: this.country,
            note: 'Chrome не подтвердил выход. Ищем следующий адрес.'});
          this.api.rotate();
          return;
        }
        this.active = event.proxy; this.lastBrowserCheck = Date.now();
      } else if (['searching', 'replacing', 'reserve', 'empty', 'error'].includes(event.phase)) {
        this.active = null;
        await this.api.block();
      }
      await this.api.publish(event);
    });
  }
  lost() {
    const id = this.id;
    this.abort?.abort();
    return this.queue(async () => {
      if (!this.enabled || id !== this.id) return;
      this.active = null;
      await this.api.block();
      await this.api.save({pool: null});
      await this.api.publish({phase: 'helper', proxy: null, country: this.country});
    });
  }
}
