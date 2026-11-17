const russian = new Intl.DisplayNames(['ru'], {type: 'region'});
const english = new Intl.DisplayNames(['en'], {type: 'region'});
const fold = value => String(value).trim().normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('ru').replace(/ё/g, 'е');

export async function loadCountryCatalog() {
  const response = await fetch(chrome.runtime.getURL('countries.json'));
  if (!response.ok) throw new Error('Не удалось загрузить список стран.');
  const codes = await response.json();
  return codes.map(code => ({
    code, name: russian.of(code), englishName: english.of(code),
    search: [code, russian.of(code), english.of(code)].map(fold)
  })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

export function countryLabel(country) {
  return `${country.name} · ${country.code}`;
}

export function filterCountries(catalog, query) {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return catalog;
  const matches = catalog.filter(country => terms.every(term => country.search.some(value => value.includes(term))));
  const queryCode = fold(query);
  return matches.sort((a, b) => Number(fold(b.code) === queryCode) - Number(fold(a.code) === queryCode));
}

export function validFavorites(value, catalog) {
  const valid = new Set(catalog.map(country => country.code));
  return [...new Set(Array.isArray(value) ? value.filter(code => valid.has(code)) : [])];
}

export function navigateItems(event, items, previousKey, nextKey, firstFallback) {
  if (!['Home', 'End', previousKey, nextKey].includes(event.key) || !items.includes(event.target)) return;
  event.preventDefault();
  const index = items.indexOf(event.target);
  if (event.key === previousKey && index === 0 && firstFallback) { firstFallback.focus(); return; }
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 :
    Math.max(0, Math.min(items.length - 1, index + (event.key === nextKey ? 1 : -1)));
  items[next].focus();
}
