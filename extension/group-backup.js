import {readGroups} from './saved-groups.js';

const format = 'country-proxy/groups';
const nameKey = name => name.toLocaleLowerCase('ru');
const setKey = countries => countries.join(',');

export function exportGroups(raw, allowed) {
  const groups = readGroups(raw, allowed).map(({name, countries}) => ({name, countries}));
  return JSON.stringify({format, version: 1, groups}, null, 2) + '\n';
}

export function parseBackup(text, allowed) {
  let file;
  try { file = JSON.parse(text); }
  catch { throw Error('Не удалось прочитать JSON. Выберите файл групп Country Proxy.'); }
  if (file?.format !== format || file.version !== 1 || !Array.isArray(file.groups)) {
    throw Error('Нужен файл групп Country Proxy поддерживаемой версии.');
  }
  // File IDs never become local IDs. Use the same country/name validation as the editor.
  return readGroups(file.groups.map((row, index) => ({
    id: String(index), name: row?.name, countries: row?.countries
  })), allowed);
}

export function mergeGroups(existing, incoming) {
  const result = [...existing];
  const names = new Set(existing.map(g => nameKey(g.name)));
  const sets = new Set(existing.map(g => setKey(g.countries)));
  let sameCountries = 0, nameConflicts = 0;
  for (const {name, countries} of incoming) {
    const key = setKey(countries);
    if (sets.has(key)) { sameCountries++; continue; }
    if (names.has(nameKey(name))) { nameConflicts++; continue; }
    result.push({id: crypto.randomUUID(), name, countries});
    sets.add(key);
    names.add(nameKey(name));
  }
  return {groups: result, added: result.length - existing.length, sameCountries, nameConflicts};
}
