import {loadCountryCatalog, countryLabel, filterCountries, validFavorites, navigateItems} from './country-catalog.js';
import {FavoritesDraft} from './favorites.js';
const $ = id => document.getElementById(id);
let catalog = [];
const draft = new FavoritesDraft([]);
let remoteRevision = 0;
let saving = false;
let catalogTabCode = null;

function render() {
  const countries = draft.countries;
  const byCode = new Map(catalog.map(country => [country.code, country]));
  $('empty-favorites').hidden = countries.length > 0;
  $('countries').replaceChildren(...countries.map(code => {
    const row = document.createElement('li');
    const name = document.createElement('span'); name.textContent = countryLabel(byCode.get(code));
    const remove = document.createElement('button'); remove.textContent = 'Убрать';
    remove.dataset.removeFavorite = code;
    remove.setAttribute('aria-label', `Убрать ${byCode.get(code).name} из избранного`);
    remove.addEventListener('click', () => {
      const index = countries.indexOf(code);
      draft.set(code, false);
      render(); renderCatalog();
      const remaining = $('countries').querySelectorAll('button');
      (remaining[Math.min(index, remaining.length - 1)] || ($('save').disabled ? $('country-search') : $('save'))).focus();
    });
    row.append(name, remove); return row;
  }));
  const changed = draft.changed;
  $('save').disabled = saving || !changed;
  $('message').textContent = changed ? 'Есть несохранённые изменения.' : 'Избранное сохранено.';
}

function renderCatalog() {
  const countries = draft.countries;
  const matches = filterCountries(catalog, $('country-search').value);
  if (!matches.some(country => country.code === catalogTabCode)) catalogTabCode = matches[0]?.code;
  $('country-count').textContent = `Найдено: ${matches.length} из ${catalog.length}`;
  $('country-results').replaceChildren(...matches.map(country => {
    const row = document.createElement('li'); row.className = 'country-result';
    const add = document.createElement('button'); add.className = 'option-country';
    add.dataset.addCountry = country.code;
    add.tabIndex = country.code === catalogTabCode ? 0 : -1;
    const added = countries.includes(country.code);
    add.setAttribute('aria-pressed', String(added));
    add.setAttribute('aria-label', `${added ? 'Убрать' : 'Добавить'} ${country.name} ${added ? 'из избранного' : 'в избранное'}`);
    const label = document.createElement('span'); label.textContent = countryLabel(country);
    const action = document.createElement('span'); action.className = 'option-action'; action.textContent = added ? '★ В избранном' : '☆ Добавить';
    add.append(label, action);
    add.addEventListener('click', () => {
      draft.set(country.code, !added);
      render(); renderCatalog();
      $('country-results').querySelector(`[data-add-country="${country.code}"]`)?.focus();
    });
    row.append(add); return row;
  }));
  if (!matches.length) {
    const empty = document.createElement('li'); empty.className = 'no-results';
    empty.textContent = 'Страна не найдена. Попробуйте другое название или код.';
    $('country-results').append(empty);
  }
}

$('country-search').addEventListener('input', () => {
  catalogTabCode = null;
  renderCatalog();
  $('country-results').scrollTop = 0;
});
$('country-search').addEventListener('keydown', event => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    $('country-results').querySelector('[data-add-country]')?.focus();
  }
});
$('country-results').addEventListener('focusin', event => {
  const code = event.target.dataset.addCountry;
  if (!code || code === catalogTabCode) return;
  const current = $('country-results').querySelector('[tabindex="0"]');
  if (current) current.tabIndex = -1;
  event.target.tabIndex = 0;
  catalogTabCode = code;
});
$('country-results').addEventListener('keydown', event => {
  navigateItems(event, [...$('country-results').querySelectorAll('[data-add-country]')], 'ArrowUp', 'ArrowDown', $('country-search'));
});
// Storage events and async reads can interleave. A read started before an event
// must not replace that newer event's baseline.
async function refreshFavorites() {
  const revision = remoteRevision;
  const stored = await chrome.storage.local.get('countries');
  if (revision === remoteRevision) draft.receive(validFavorites(stored.countries, catalog));
}
function renderFavorites() {
  const active = document.activeElement;
  const addCode = active?.dataset.addCountry;
  const removeCode = active?.dataset.removeFavorite;
  const scrollTop = $('country-results').scrollTop;
  render(); renderCatalog();
  if (addCode) $('country-results').querySelector(`[data-add-country="${addCode}"]`)?.focus();
  if (removeCode) {
    ($('countries').querySelector(`[data-remove-favorite="${removeCode}"]`) || $('country-search')).focus();
  }
  $('country-results').scrollTop = scrollTop;
}
$('save').addEventListener('click', async () => {
  if (saving || !draft.changed) return;
  saving = true; $('save').disabled = true;
  const {snapshot, add, remove} = draft.beginSave();
  let succeeded = false;
  try {
    const result = await chrome.runtime.sendMessage({action: 'settings', add, remove});
    if (!result?.ok) throw new Error(result?.error || 'Не удалось сохранить избранное.');
    await refreshFavorites();
    succeeded = true;
  } catch (error) {
    $('message').textContent = error.message;
  } finally {
    draft.finishSave(snapshot, succeeded);
    saving = false;
    if (succeeded) {
      renderFavorites();
      if (!draft.changed) $('message').textContent = 'Сохранено. Текущая страна и соединение не изменены.';
    }
    $('save').disabled = !draft.changed;
  }
});
try {
  catalog = await loadCountryCatalog();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !Object.hasOwn(changes, 'countries')) return;
    remoteRevision++;
    draft.receive(validFavorites(changes.countries.newValue, catalog));
    renderFavorites();
  });
  await refreshFavorites();
  renderFavorites();
} catch (error) {
  $('save').disabled = true;
  $('message').textContent = error.message;
}
