import {DEFAULTS} from './controller.js';
const $ = id => document.getElementById(id);
const names = new Intl.DisplayNames(['ru'], {type: 'region'});
let enabled = false; let lastCountries = ''; let lastSelected = '';
const labels = {off: 'Отключено', searching: 'Ищем адреса', checking: 'Проверяем прокси', slow: 'Проверяем медленные адреса',
  verifying: 'Проверяем в Chrome', connected: 'Подключено', confirming: 'Перепроверяем соединение',
  reserve: 'Проверяем резерв', replacing: 'Меняем прокси', empty: 'Рабочих адресов пока нет', helper: 'Нужен локальный помощник', error: 'Не удалось подключиться'};
async function render() {
  const state = await chrome.storage.local.get(null);
  const s = state.status || {phase: 'off'};
  enabled = !!state.enabled;
  const countries = state.countries || DEFAULTS.countries;
  if (JSON.stringify(countries) !== lastCountries) {
    $('country').replaceChildren(...countries.map(cc => new Option(`${names.of(cc)} · ${cc}`, cc)));
    lastCountries = JSON.stringify(countries); lastSelected = '';
  }
  if (state.selected !== lastSelected) {
    $('country').value = state.selected || DEFAULTS.selected; lastSelected = state.selected;
  }
  $('phase').textContent = labels[s.phase] || s.phase;
  $('dot').className = 'dot ' + (s.phase === 'connected' ? 'online' : enabled ? 'busy' : '');
  $('detail').textContent = s.error || s.note || ({
    off: 'Выберите страну — поиск и подключение начнутся автоматически.',
    searching: 'Получаем свежие списки из открытых источников.',
    checking: `Проверено ${s.done || 0} из ${s.total || 0}. Проверяем HTTPS и страну выхода.`,
    slow: `Повторная проверка с увеличенным таймаутом: ${s.done || 0} из ${s.total || 0}.`,
    verifying: 'Подтверждаем страну и HTTPS через браузер.',
    connected: 'Соединение проверяется каждые 30 секунд. Замена при сбое — автоматически.',
    confirming: 'Один запрос не прошёл. Проверяем повторно перед заменой.',
    reserve: 'Повторно проверяем подготовленный адрес перед подключением в Chrome.',
    replacing: 'Пробуем резерв, затем ищем следующий адрес выбранной страны.',
    empty: 'Повторим поиск через минуту. Можно выбрать другую страну.',
    helper: 'Запустите Install.command из папки Country Proxy. Повторное подключение — автоматически.'
  }[s.phase] || '');
  $('progress').hidden = !['checking','slow'].includes(s.phase) || !s.total;
  $('progress').max = s.total || 1; $('progress').value = s.done || 0;
  $('proxy').hidden = !s.proxy;
  $('proxy').textContent = s.proxy ? `${s.proxy.scheme.toUpperCase()}  ${s.proxy.host}:${s.proxy.port}\nВыход: ${s.proxy.exitIp} · ${s.proxy.country} · ${(s.proxy.latencyMs/1000).toFixed(1)} с` : '';
  $('checked').textContent = s.proxy ? 'Проверено ' + new Date(s.proxy.checkedAt).toLocaleTimeString('ru') : (s.warnings || []).join(' · ');
  const pool = state.pool?.country === state.selected ? state.pool : null;
  const count = pool?.expiresAt > Date.now() ? pool.count : 0;
  $('reserve').hidden = !enabled;
  $('reserve').textContent = count ? `Резерв: ${count} из 2 · проверен помощником` : pool?.checking ? 'Ищем и проверяем резервные адреса…' : 'Проверенных резервных адресов пока нет.';
  $('connect').hidden = enabled; $('disconnect').hidden = !enabled;
  $('rotate').hidden = !enabled || !s.proxy;
}
async function send(action, country) {
  $('error').textContent = '';
  try { const result = await chrome.runtime.sendMessage({action, country}); if (!result?.ok) throw Error(result?.error || 'Ошибка'); }
  catch (e) { $('error').textContent = e.message; }
}
$('country').addEventListener('change', () => send('connect', $('country').value));
$('connect').addEventListener('click', () => send('connect', $('country').value));
$('disconnect').addEventListener('click', () => send('disconnect'));
$('rotate').addEventListener('click', () => send('rotate'));
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
chrome.storage.onChanged.addListener(render);
setInterval(render, 1000);
render();
