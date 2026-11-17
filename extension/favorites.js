import {CountrySettingsError, normalizeCountries} from './controller.js';

// Explicit membership operations only: an obsolete whole-list writer must never
// overwrite unrelated edits. Untouched entries keep their order; additions append.
export function favoriteDelta(message, allowed) {
  if (Object.keys(message).some(key => !['action', 'add', 'remove'].includes(key)) ||
      !['add', 'remove'].every(key => Array.isArray(message[key]) && message[key].length <= allowed.length &&
        message[key].every(code => typeof code === 'string' && allowed.includes(code)))) {
    throw new CountrySettingsError('Не удалось сохранить избранное. Обновите страницу настроек и повторите.');
  }
  const add = [...new Set(message.add)], remove = [...new Set(message.remove)];
  if (add.some(code => remove.includes(code))) throw new CountrySettingsError('Противоречивые изменения избранного.');
  return {add, remove};
}

export function applyFavoriteDelta(current, {add, remove}) {
  const next = current.filter(code => !remove.includes(code));
  for (const code of add) if (!next.includes(code)) next.push(code);
  return next;
}

export class FavoritesWriter {
  constructor(storage, allowed) { this.storage = storage; this.allowed = allowed; this.tail = Promise.resolve(); }
  write(message) {
    // Validate and copy before queueing so a caller cannot mutate a pending intent.
    let delta;
    try { delta = favoriteDelta(message, this.allowed); }
    catch (error) { return Promise.reject(error); }
    const job = this.tail.then(async () => {
      try {
        const current = normalizeCountries((await this.storage.get('countries')).countries ?? [], this.allowed);
        const countries = applyFavoriteDelta(current, delta);
        await this.storage.set({countries});
      } catch (error) {
        // A failed preference write is not a connection failure.
        throw new CountrySettingsError(error.message || 'Не удалось сохранить избранное.');
      }
    });
    this.tail = job.catch(() => {});
    return job;
  }
}

// A remote baseline plus only explicit local edits. Per-edit versions preserve
// changes (including undo) made while an earlier snapshot is being committed.
export class FavoritesDraft {
  constructor(countries) { this.remote = [...countries]; this.edits = new Map(); this.version = 0; this.pending = null; }
  get countries() {
    return applyFavoriteDelta(this.remote, this.delta(this.edits));
  }
  get changed() { return this.edits.size > 0; }
  delta(edits) {
    return {add: [...edits].filter(([, edit]) => edit.present).map(([code]) => code),
      remove: [...edits].filter(([, edit]) => !edit.present).map(([code]) => code)};
  }
  receive(countries) { this.remote = [...countries]; }
  set(code, present) {
    if (this.remote.includes(code) === present && !this.pending?.has(code)) this.edits.delete(code);
    else this.edits.set(code, {present, version: ++this.version});
  }
  beginSave() {
    if (this.pending) throw Error('Сохранение уже выполняется.');
    this.pending = new Map(this.edits);
    return {snapshot: this.pending, ...this.delta(this.pending)};
  }
  finishSave(snapshot, succeeded) {
    if (snapshot !== this.pending) return;
    this.pending = null;
    for (const [code, edit] of this.edits) {
      if ((succeeded && edit.version === snapshot.get(code)?.version) ||
          (!succeeded && edit.present === this.remote.includes(code))) this.edits.delete(code);
    }
  }
}
