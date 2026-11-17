// Persistent protection with a browser-session-only admission. A browser restart
// drops the admission before JavaScript runs, while the network block survives.
// DNR does not queue requests or recall requests already sent before a transition.
const DYNAMIC_IDS = [710001, 710002, 710003, 710004];
const SESSION_IDS = [710005, 710006];
const NETWORK = '^(https?|wss?)://';
const errorText = error => String(error?.message || error).replace(/gate=[a-f0-9]{32}/gi, 'gate=<hidden>');
const clone = value => JSON.parse(JSON.stringify(value));
const canonical = value => JSON.stringify(value, function (_key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
});

function validExtensionId(extensionId) {
  if (typeof extensionId !== 'string' || !/^[a-p]{32}$/.test(extensionId)) throw Error('Некорректный ID расширения для защиты трафика');
}
export function gateRules(extensionId, capability) {
  validExtensionId(extensionId);
  if (typeof capability !== 'string' || !/^[a-f0-9]{32}$/.test(capability)) throw Error('Некорректное разрешение служебной проверки');
  // Omitted resourceTypes matches everything EXCEPT main_frame. The second rule
  // closes that explicit hole without hard-coding a list of present resource types.
  const broad = (id, type, priority, main = false) => ({id, priority, action: {type},
    condition: {regexFilter: NETWORK, ...(main ? {resourceTypes: ['main_frame']} : {})}});
  const probe = (id, regexFilter) => ({id, priority: 2, action: {type: 'allow'},
    condition: {regexFilter, isUrlFilterCaseSensitive: true, initiatorDomains: [extensionId],
      requestMethods: ['get'], resourceTypes: ['xmlhttprequest']}});
  return {
    dynamic: [broad(DYNAMIC_IDS[0], 'block', 1), broad(DYNAMIC_IDS[1], 'block', 1, true),
      probe(DYNAMIC_IDS[2], '^https://www\\.cloudflare\\.com/cdn-cgi/trace\\?t=[0-9]+(&attempt=2)?&gate=' + capability + '$'),
      probe(DYNAMIC_IDS[3], '^https://www\\.google\\.com/generate_204\\?t=[0-9]+(&attempt=2)?&gate=' + capability + '$')],
    session: [broad(SESSION_IDS[0], 'allow', 3), broad(SESSION_IDS[1], 'allow', 3, true)]
  };
}

export class TrafficGate {
  constructor(dnr, extensionId) {
    validExtensionId(extensionId);
    this.dnr = dnr; this.extensionId = extensionId; this.rules = null; this.probeCapability = null;
    this.epoch = 0; this.tail = Promise.resolve();
  }
  queue(fn) {
    const task = this.tail.then(fn); this.tail = task.catch(() => {}); return task;
  }
  async verify(open) {
    if (!this.rules) throw Error('Удержание трафика ещё не установлено');
    const [dynamic, session] = await Promise.all([this.dnr.getDynamicRules(), this.dnr.getSessionRules()]);
    const selected = (rules, ids) => rules.filter(rule => ids.includes(rule.id)).sort((a, b) => a.id - b.id);
    if (canonical(selected(dynamic, DYNAMIC_IDS)) !== canonical(this.rules.dynamic) ||
        canonical(selected(session, SESSION_IDS)) !== canonical(open ? this.rules.session : [])) {
      throw Error('Chrome не подтвердил правила удержания трафика');
    }
  }
  async removeAdmission() {
    await this.dnr.updateSessionRules({removeRuleIds: SESSION_IDS});
  }
  hold() {
    const epoch = ++this.epoch;
    return this.queue(async () => {
      // initiatorDomains matches a host, not a complete origin. An unguessable,
      // per-hold capability also prevents an ordinary web origin with that host
      // from borrowing the exception. Only the two HTTPS controls receive it.
      const capability = crypto.randomUUID().replaceAll('-', '');
      this.probeCapability = null;
      this.rules = gateRules(this.extensionId, capability);
      const errors = [];
      // Attempt both protections even if one API operation fails. The caller also
      // independently blocks the proxy route before reporting an infrastructure error.
      try { await this.removeAdmission(); } catch (error) { errors.push(error); }
      try { await this.dnr.updateDynamicRules({removeRuleIds: DYNAMIC_IDS, addRules: clone(this.rules.dynamic)}); }
      catch (error) { errors.push(error); }
      if (errors.length) throw Error('Не удалось удержать трафик: ' + errors.map(errorText).join('. '));
      await this.verify(false);
      this.probeCapability = {epoch, capability};
      return epoch;
    });
  }
  probeFetcher(fetcher) {
    const grant = this.probeCapability;
    if (!grant || grant.epoch !== this.epoch) throw Error('Служебная проверка не получила разрешение');
    // Capture this grant once: a cancelled old probe may not obtain the token of
    // the next candidate. Do not put the capability in storage, status or logs.
    return (url, options = {}) => {
      if (typeof url !== 'string' || !/^https:\/\/(www\.cloudflare\.com\/cdn-cgi\/trace|www\.google\.com\/generate_204)\?t=[0-9]+(&attempt=2)?$/.test(url) ||
          (options.method !== undefined && options.method !== 'GET')) {
        throw Error('Недопустимый запрос служебной проверки');
      }
      return fetcher(url + '&gate=' + grant.capability, {...options, referrerPolicy: 'no-referrer'});
    };
  }
  allow(epoch, current) {
    return this.queue(async () => {
      const valid = () => epoch === this.epoch && current();
      if (!valid()) return false;
      await this.verify(false);
      if (!valid()) return false;
      try {
        await this.dnr.updateSessionRules({removeRuleIds: SESSION_IDS, addRules: clone(this.rules.session)});
        if (!valid()) {
          await this.removeAdmission(); await this.verify(false); return false;
        }
        await this.verify(true);
        if (!valid()) {
          await this.removeAdmission(); await this.verify(false); return false;
        }
        return true;
      } catch (error) {
        // A rejected read/commit must never leave an unverified admission behind.
        try { await this.removeAdmission(); } catch { /* Controller also blocks the route. */ }
        throw Error(errorText(error));
      }
    });
  }
  assertOpen() { return this.queue(() => this.verify(true)); }
  clear() {
    ++this.epoch;
    this.probeCapability = null;
    return this.queue(async () => {
      const errors = [];
      try { await this.removeAdmission(); } catch (error) { errors.push(error); }
      try { await this.dnr.updateDynamicRules({removeRuleIds: DYNAMIC_IDS}); } catch (error) { errors.push(error); }
      try {
        const [dynamic, session] = await Promise.all([this.dnr.getDynamicRules(), this.dnr.getSessionRules()]);
        if (dynamic.some(rule => DYNAMIC_IDS.includes(rule.id)) || session.some(rule => SESSION_IDS.includes(rule.id))) {
          throw Error('Chrome сохранил правила удержания трафика');
        }
      } catch (error) { errors.push(error); }
      if (errors.length) throw Error('Не удалось освободить трафик: ' + errors.map(errorText).join('. '));
    });
  }
}
