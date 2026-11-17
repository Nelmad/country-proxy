import {normalizeSelection} from './controller.js';

export const groupStorageKey = 'savedCountryGroups';
export const selectionKeys = ['selected', 'selectedCountries', 'selectionMode'];
export const nameLimit = 48;

export function appliedCountries(state, allowed) {
  const selection = Array.isArray(state.selectedCountries)
    ? state.selectedCountries : [state.selected];
  try {
    return normalizeSelection(selection, allowed);
  } catch {
    return [];
  }
}

function sameCountries(first, second) {
  return first.length === second.length && first.every((code, i) => code === second[i]);
}

function cleanName(value) {
  const name = typeof value === 'string' ? value.trim().normalize('NFC') : '';
  if (!name || name.length > nameLimit || /[\p{Cc}\p{Cf}]/u.test(name)) {
    throw Error('Введите название группы длиной до ' + nameLimit + ' символов.');
  }
  return name;
}

export function readGroups(raw, allowed) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw Error('Не удалось прочитать сохранённые группы.');
  const seen = new Set();
  return raw.map(group => {
    if (typeof group?.id !== 'string' || !group.id || seen.has(group.id)) {
      throw Error('Не удалось прочитать сохранённую группу.');
    }
    seen.add(group.id);
    return {id: group.id, name: cleanName(group.name), countries: normalizeSelection(group.countries, allowed)};
  });
}

export function updateGroups(groups, draft, allowed) {
  const {original, remove, id} = draft;
  if (original) {
    const current = groups.find(group => group.id === original.id);
    if (!current || current.name !== original.name || !sameCountries(current.countries, original.countries)) {
      throw Error('Группа изменилась. Откройте её для редактирования ещё раз.');
    }
    if (remove) return groups.filter(group => group.id !== original.id);
  }

  const name = cleanName(draft.name);
  const countries = normalizeSelection(draft.countries, allowed);
  const others = groups.filter(group => group.id !== original?.id);
  if (others.some(group => group.name.toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru'))) {
    throw Error('Группа с таким названием уже есть.');
  }
  if (others.some(group => sameCountries(group.countries, countries))) {
    throw Error('Группа с таким набором стран уже сохранена.');
  }
  if (original) return groups.map(group => group.id === original.id ? {...group, name, countries} : group);
  return [...groups, {id, name, countries}];
}
