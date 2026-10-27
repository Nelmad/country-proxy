import {DEFAULTS} from './controller.js';
const $ = id => document.getElementById(id);
const names = new Intl.DisplayNames(['ru'], {type:'region'});
const all = await (await fetch('countries.json')).json();
all.sort((a,b) => names.of(a).localeCompare(names.of(b), 'ru'));
$('catalog').replaceChildren(...all.map(cc => new Option(`${names.of(cc)} · ${cc}`, cc)));
let countries = (await chrome.storage.local.get('countries')).countries || DEFAULTS.countries;
function render() {
  $('countries').replaceChildren(...countries.map(cc => {
    const row = document.createElement('li');
    const name = document.createElement('span'); name.textContent = `${names.of(cc)} · ${cc}`;
    const remove = document.createElement('button'); remove.textContent = 'Убрать';
    remove.addEventListener('click', () => { countries = countries.filter(x => x !== cc); render(); });
    row.append(name, remove); return row;
  }));
}
$('add').addEventListener('click', () => { if (!countries.includes($('catalog').value)) countries.push($('catalog').value); render(); });
$('save').addEventListener('click', async () => {
  const result = await chrome.runtime.sendMessage({action:'settings', countries});
  $('message').textContent = result?.ok ? 'Сохранено. Страны обновлены в меню расширения.' : result?.error;
});
render();
