import {BLOCKED, matchesEffectiveRoute, proxyConfig, restoreCountrySettings} from './controller.js';
import {readReserveDiagnostics, reserveCounters, reserveFailures, reserveStageText, reserveRemovalText} from './reserve-diagnostics.js';
import {loadCountryCatalog, countryLabel, filterCountries, validFavorites, navigateItems} from './country-catalog.js';
const $ = id => document.getElementById(id);
const reasons = {timeout: 'таймаут', tls: 'ошибка TLS', connect: 'нет соединения', transport: 'сбой передачи', http: 'HTTPS-сервис не ответил как ожидалось', country: 'другая страна', invalid_trace: 'неверный ответ о стране', internal: 'ошибка проверки', unavailable: 'недоступен'};
const labels = {off: 'Отключено', stopping: 'Отключаем прокси', stopError: 'Отключение не завершено', searching: 'Ищем адреса', checking: 'Проверяем прокси', slow: 'Проверяем медленные адреса',
  verifying: 'Проверяем в Chrome', connected: 'Подключено', confirming: 'Перепроверяем соединение',
  reserve: 'Проверяем резерв', replacing: 'Меняем прокси', empty: 'Рабочих адресов пока нет', helper: 'Нужен локальный помощник', error: 'Не удалось подключиться'};
let catalog = [];
let byCode = new Map();
let favorites = [];
let selectedCountries = [];
let selectionInvalid = false;
let selectionMode = 'single';
let draftCountries = [];
let draftMode = 'single';
let favoritesBusy = false;
let applying = false;
let lastCountryState = '';
let pickerOpener = null;
let catalogTabCode = null;
let chipTabCode = null;
const pickerOpen = () => $('country-picker').open;
const rowCode = el => el.dataset.favorite || el.dataset.selectCountry || el.dataset.country;
const choiceMode = () => pickerOpen() ? draftMode : selectionMode;
const sameCountries = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const labelFor = code => countryLabel(byCode.get(code));

function updateStar(button, code) {
  const favorite = favorites.includes(code);
  button.textContent = favorite ? '★' : '☆';
  button.setAttribute('aria-pressed', String(favorite));
  button.setAttribute('aria-label', `${favorite ? 'Убрать' : 'Добавить'} ${byCode.get(code).name} ${favorite ? 'из избранного' : 'в избранное'}`);
  button.title = favorite ? 'Убрать из избранного' : 'Добавить в избранное';
  button.setAttribute('aria-disabled', String(favoritesBusy));
}

function renderDraft() {
  const multiple = draftMode === 'multiple';
  $('picker-title').textContent = multiple ? 'Выберите страны' : 'Выберите страну';
  $('selection-draft').hidden = !multiple;
  $('selection-apply').hidden = !multiple;
  $('selection-apply').disabled = !draftCountries.length || applying;
  $('selection-apply').textContent = applying ? 'Подключаем…' : `Подключить выбранные (${draftCountries.length})`;
  $('selection-draft-note').textContent = draftCountries.length ? `Выбрано стран: ${draftCountries.length}` : 'Отметьте хотя бы одну страну.';
  if (!draftCountries.includes(chipTabCode)) chipTabCode = draftCountries[0];
  $('selection-draft-chips').replaceChildren(...draftCountries.map(code => {
    const button = document.createElement('button');
    button.textContent = `${labelFor(code)} ×`;
    button.dataset.removeCountry = code;
    button.tabIndex = code === chipTabCode ? 0 : -1;
    button.setAttribute('aria-label', `Убрать ${byCode.get(code).name} из выбираемой группы`);
    button.disabled = applying;
    button.addEventListener('click', () => toggleDraftCountry(code));
    return button;
  }));
  $('picker-hint').textContent = multiple ? 'Подойдёт прокси из любой отмеченной страны. Звезда сохраняет страну в избранное.' : 'Выберите страну, чтобы подключиться. Звезда сохраняет её в избранное.';
}

function renderCountryList() {
  const previous = document.activeElement;
  const focusCode = previous?.dataset.favorite || previous?.dataset.country || previous?.dataset.selectCountry;
  const focusKind = previous?.dataset.favorite ? 'favorite' : previous?.dataset.selectCountry ? 'select-country' : 'country';
  const scrollTop = $('country-results').scrollTop;
  const matches = filterCountries(catalog, $('country-search').value);
  const multiple = choiceMode() === 'multiple';
  if (!matches.some(country => country.code === catalogTabCode)) catalogTabCode = matches[0]?.code;
  $('country-count').textContent = `Найдено: ${matches.length} из ${catalog.length} стран и территорий`;
  $('country-results').replaceChildren(...matches.map(country => {
    const row = document.createElement('li'); row.className = 'country-result';
    const choose = document.createElement(multiple ? 'label' : 'button');
    choose.className = 'country-option' + (multiple ? ' country-checkbox' : '');
    const text = document.createElement('span');
    const name = document.createElement('span'); name.textContent = countryLabel(country);
    const english = document.createElement('small'); english.textContent = country.englishName;
    text.append(name, english);
    if (multiple) {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.dataset.selectCountry = country.code;
      checkbox.checked = draftCountries.includes(country.code); checkbox.disabled = applying;
      checkbox.setAttribute('aria-label', countryLabel(country));
      checkbox.addEventListener('change', () => toggleDraftCountry(country.code));
      choose.append(checkbox, text);
    } else {
      choose.dataset.country = country.code;
      choose.disabled = applying;
      choose.setAttribute('aria-current', String(selectionMode === 'single' && selectedCountries.includes(country.code)));
      choose.setAttribute('aria-label', `Подключиться: ${countryLabel(country)}`);
      choose.append(text);
      choose.addEventListener('click', () => chooseCountry(country.code));
    }
    const favorite = document.createElement('button'); favorite.className = 'favorite-toggle';
    favorite.dataset.favorite = country.code; updateStar(favorite, country.code);
    favorite.addEventListener('click', () => toggleFavorite(country.code));
    const choiceControl = multiple ? choose.querySelector('input') : choose;
    choiceControl.tabIndex = favorite.tabIndex = country.code === catalogTabCode ? 0 : -1;
    row.append(choose, favorite); return row;
  }));
  if (!matches.length) {
    const empty = document.createElement('li'); empty.className = 'no-results';
    empty.textContent = 'Страна не найдена. Попробуйте другое название или код.';
    $('country-results').append(empty);
  }
  $('country-results').scrollTop = scrollTop;
  if (focusCode) $('country-results').querySelector(`[data-${focusKind}="${focusCode}"]`)?.focus({preventScroll: true});
  renderDraft();
}

function renderCountries() {
  const multiple = selectionMode === 'multiple';
  const current = selectedCountries[0];
  $('mode-single').setAttribute('aria-pressed', String(choiceMode() === 'single'));
  $('mode-multiple').setAttribute('aria-pressed', String(choiceMode() === 'multiple'));
  $('mode-single').disabled = applying; $('mode-multiple').disabled = applying;
  $('country-label').textContent = multiple ? 'Выбранная группа' : 'Страна подключения';
  $('country-name').textContent = multiple ? `Изменить группу (${selectedCountries.length})` : current ? labelFor(current) : 'Выберите страну';
  $('pin-selected').hidden = multiple || !current;
  if (current && !multiple) updateStar($('pin-selected'), current);
  $('selection-summary').hidden = !multiple || !selectedCountries.length;
  $('selection-summary').textContent = selectedCountries.map(code => byCode.get(code).name).join(', ');
  $('selection-active-note').hidden = !multiple;
  $('selection-active-note').textContent = 'При сбое подойдёт любая страна этой группы.';
  $('favorites-section').hidden = !favorites.length;
  $('favorites').replaceChildren(...favorites.map(code => {
    const button = document.createElement('button');
    button.textContent = labelFor(code); button.dataset.quickCountry = code;
    button.setAttribute('aria-current', String(selectedCountries.includes(code)));
    button.setAttribute('aria-label', multiple ? `Изменить группу: ${labelFor(code)}` : `Подключиться: ${labelFor(code)}`);
    button.addEventListener('click', () => {
      if (selectionMode === 'multiple') { openPicker(selectionMode, button); toggleDraftCountry(code); }
      else chooseCountry(code);
    });
    return button;
  }));
  $('favorites-section').querySelector('.section-label').textContent = multiple ? 'Избранное · нажмите для изменения группы' : 'Избранное';
  $('catalog-note').hidden = multiple;
  $('catalog-note').textContent = `В каталоге ${catalog.length} стран и территорий. Доступность проверим при подключении.`;
  $('selection-help-first').textContent = multiple ? 'Страны образуют одну равноправную группу. Подключаем первый проверенный адрес из любой выбранной страны; порядок выбора стран не задаёт приоритет.' : 'Подключаем первый адрес выбранной страны, прошедший HTTPS-проверку и проверку страны выхода, затем подтверждаем соединение в Chrome.';
  $('selection-help-replace').textContent = multiple ? 'Работающий адрес сохраняем. При сбое пробуем резерв из всей группы, затем общий поиск. Страна текущего адреса не получает приоритета; за пределы группы не выходим.' : 'Готовим резерв. При сбое меняем адрес в той же стране. Если адресов нет, повторяем поиск; страну автоматически не меняем.';
  renderCountryList();
}

function closePicker({focus = true} = {}) {
  const dialog = $('country-picker');
  if (!dialog.open) return;
  dialog.close();
  dialog.hidden = true;
  document.body.classList.remove('picker-open');
  $('country').setAttribute('aria-expanded', 'false');
  draftMode = selectionMode; draftCountries = [...selectedCountries];
  $('selection-error').textContent = '';
  renderCountries();
  if (focus) {
    const opener = pickerOpener?.id ? $(pickerOpener.id) :
      $('favorites').querySelector(`[data-quick-country="${pickerOpener?.dataset.quickCountry}"]`);
    (opener?.getClientRects().length && !opener.disabled ? opener : $('country')).focus();
  }
  pickerOpener = null;
}

function openPicker(mode = selectionMode, opener = document.activeElement) {
  if (!pickerOpen()) {
    draftCountries = [...selectedCountries];
    pickerOpener = opener;
    $('country-picker').hidden = false;
    $('country-picker').showModal();
  }
  draftMode = mode;
  catalogTabCode = null;
  chipTabCode = null;
  document.body.classList.add('picker-open');
  $('country').setAttribute('aria-expanded', 'true');
  $('country-search').value = '';
  $('selection-error').textContent = '';
  renderCountries();
  $('country-results').scrollTop = 0;
  $('country-search').focus();
}

function toggleDraftCountry(code) {
  if (applying || !byCode.has(code)) return;
  const chipRemoved = document.activeElement.dataset.removeCountry === code;
  const index = draftCountries.indexOf(code);
  draftCountries = index < 0 ? [...draftCountries, code].sort() : draftCountries.filter(value => value !== code);
  if (chipRemoved) chipTabCode = draftCountries[Math.min(index, draftCountries.length - 1)];
  renderCountryList();
  if (chipRemoved) ($('selection-draft-chips').querySelector('[tabindex="0"]') || $('country-search')).focus();
}

async function send(message) {
  $('error').textContent = ''; $('selection-error').textContent = '';
  try {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw Error(result?.error || 'Не удалось выполнить действие.');
    return true;
  } catch (error) {
    $('error').textContent = error.message;
    if (pickerOpen()) $('selection-error').textContent = error.message;
    return false;
  }
}

async function connect(message) {
  if (applying) return;
  applying = true; renderCountries();
  try {
    if (await send(message)) { await render(); closePicker(); }
  } finally { applying = false; renderCountries(); }
}

function chooseCountry(code) {
  if (byCode.has(code)) return connect({action: 'connect', country: code});
}

async function toggleFavorite(code) {
  if (favoritesBusy || !byCode.has(code)) return;
  favoritesBusy = true;
  const present = favorites.includes(code);
  const delta = {add: present ? [] : [code], remove: present ? [code] : []};
  renderCountries();
  try {
    if (await send({action: 'settings', ...delta})) await render();
  } finally { favoritesBusy = false; renderCountries(); }
}

let reportSequence = 0;
const formatShare = new Intl.NumberFormat('ru', {maximumFractionDigits: 3});
async function refreshSourceReport() {
  const section = $('source-quality');
  const seq = ++reportSequence;
  $('source-table').hidden = true;
  $('source-fetches').textContent = '';
  if (!section.open || section.hidden) return;
  $('source-message').textContent = 'Получаем данные…';
  const country = $('source-country').value;
  let reply;
  try { reply = await chrome.runtime.sendMessage({action: 'sourceQuality', country}); }
  catch { /* A disappearing helper also makes the report unavailable. */ }
  if (seq !== reportSequence || country !== $('source-country').value) return;
  const report = reply?.report;
  if (!report || report.country !== country) {
    $('source-message').textContent = 'Статистика помощника сейчас недоступна.';
    return;
  }
  $('source-message').textContent = report.assessedNative
    ? `Уникальных проверено: ${report.assessedNative}. Работали: ${report.nativeWorking}.`
    : 'Завершённых проверок адресов из этой страны пока нет.';
  if (report.capacityLimited) $('source-message').textContent += ' Достигнут лимит 5000 адресов. Часть наблюдений выбыла.';
  const ranked = report.groups.toSorted((a, b) =>
    b.nativeQualifiedShare - a.nativeQualifiedShare || b.browserConfirmedShare - a.browserConfirmedShare ||
    a.group.localeCompare(b.group));
  $('source-rows').replaceChildren(...ranked.map(group => {
    const row = document.createElement('tr');
    for (const value of [group.group, ...[group.nativeQualifiedShare, group.browserConfirmedShare].map(
      share => !group.assessedNative ? '—' : share > 0 && share < .001 ? '<0,001' : formatShare.format(share))]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    return row;
  }));
  $('source-table').hidden = false;
  if (report.feeds?.length) {
    const sums = report.feeds.reduce((s, f) => [s[0] + f.fetches, s[1] + f.errors], [0, 0]);
    $('source-fetches').textContent = `С запуска помощника: запросов к спискам — ${sums[0]}, подтверждённых ошибок источников — ${sums[1]}.`;
  }
}

function sourceSelection(enabled, selectionChanged) {
  const section = $('source-quality');
  if (section.hidden === !enabled && !selectionChanged) return;
  section.hidden = !enabled;
  const select = $('source-country'), old = select.value;
  select.replaceChildren(...selectedCountries.map(cc => new Option(labelFor(cc), cc)));
  if (selectedCountries.includes(old)) select.value = old;
  if (!enabled) section.open = false;
  void refreshSourceReport();
}

$('source-quality').addEventListener('toggle', refreshSourceReport);
$('source-country').addEventListener('change', refreshSourceReport);
$('refresh-sources').addEventListener('click', refreshSourceReport);

function renderReserveDiagnostics(enabled, rawReport) {
  const section = $('reserve-diagnostics');
  section.hidden = !enabled;
  if (!enabled) section.open = false;
  const report = enabled ? readReserveDiagnostics(rawReport) : null;
  $('reserve-state').textContent = reserveStageText(report);
  $('reserve-window').textContent = report ? `С начала сеанса · ${selectedCountries.join(', ')}. Повторная проверка адреса учитывается снова.` : '';
  if (report?.limited) $('reserve-window').textContent += ' Достигнут лимит учёта. Часть адресов и пропусков не вошла в статистику.';
  const rows = [];
  for (const [key, value] of Object.entries(report?.counts || {})) {
    const label = document.createElement('dt');
    label.textContent = reserveCounters[key];
    const number = document.createElement('dd');
    number.dataset.counter = key;
    number.textContent = String(value);
    rows.push(label, number);
  }
  $('reserve-counts').replaceChildren(...rows);
  const failures = Object.entries(report?.failures || {}).map(([reason, n]) => `${reserveFailures[reason]} — ${n}`);
  $('reserve-failures').hidden = !failures.length;
  $('reserve-failures').textContent = failures.length ? 'Причины неудачных проверок резерва: ' + failures.join(', ') + '.' : '';
  const removals = report?.removals || [];
  $('reserve-removals').hidden = !removals.length && !report?.removalsLimited;
  $('reserve-removal-note').textContent = report?.removalsLimited
    ? 'Показаны последние доступные записи этого подключения. Часть истории не вошла.'
    : 'Снятые запасные адреса. Использование резерва для подключения сюда не входит.';
  $('reserve-removal-list').replaceChildren(...removals.toReversed().map(row => {
    const li = document.createElement('li');
    li.dataset.removalId = String(row.id);
    const label = document.createElement('span');
    label.className = 'muted';
    label.textContent = `№${row.id} · ${new Date(row.atMs).toLocaleTimeString('ru-RU')}`;
    const text = document.createElement('p');
    text.textContent = reserveRemovalText(row);
    li.append(label, text);
    return li;
  }));
}

let renderRevision = 0;
async function render() {
  const revision = ++renderRevision;
  const [state, effectiveRoute] = await Promise.all([
    chrome.storage.local.get(null),
    chrome.proxy.settings.get({incognito:false}).catch(() => null)
  ]);
  if (revision !== renderRevision) return;
  const s = state.status || {phase: 'off'};
  const enabled = !!state.enabled;
  const previousSelection = JSON.stringify([selectionMode, selectedCountries]);
  favorites = validFavorites(state.countries, catalog);
  // A display list may omit unknown codes, but a shortcut must never apply
  // that shortened list as the owner's saved selection, even after Stop.
  const hasSavedSelection = state.enabled === true || state.selected != null ||
    (Array.isArray(state.selectedCountries) && state.selectedCountries.length > 0);
  selectionInvalid = hasSavedSelection && restoreCountrySettings({...state, enabled: true},
    catalog.map(country => country.code)).invalidEnabledSelection;
  selectedCountries = validFavorites(Array.isArray(state.selectedCountries) ? state.selectedCountries : [state.selected], catalog).sort();
  selectionMode = state.selectionMode === 'multiple' || (!state.selectionMode && selectedCountries.length > 1) ? 'multiple' : 'single';
  const newSelection = JSON.stringify([selectionMode, selectedCountries]);
  sourceSelection(enabled, previousSelection !== newSelection);
  renderReserveDiagnostics(enabled, state.reserveDiagnostics);
  if (!pickerOpen()) { draftMode = selectionMode; draftCountries = [...selectedCountries]; }
  else if (previousSelection !== newSelection && !applying) closePicker();
  const countryState = JSON.stringify([favorites, newSelection]);
  if (lastCountryState !== countryState) { lastCountryState = countryState; renderCountries(); }
  const multiple = selectionMode === 'multiple';
  const phaseLabel = labels[s.phase] || s.phase;
  if ($('phase').textContent !== phaseLabel) $('phase').textContent = phaseLabel;
  $('dot').className = 'dot ' + (s.phase === 'connected' && s.browser?.ok ? 'online' : ['error', 'stopError', 'helper'].includes(s.phase) ? 'problem' : enabled ? 'busy' : '');
  $('detail').textContent = s.error || s.note || ({
    off: selectedCountries.length ? 'Можно снова подключиться с выбранными странами.' : 'Выберите одну или несколько стран. Адрес найдём автоматически.',
    searching: multiple ? 'Ищем адреса во всей выбранной группе без приоритета стран.' : 'Получаем свежие списки из открытых источников.',
    checking: `Проверено ${s.done || 0} из ${s.total || 0}. Проверяем HTTPS и страну выхода.`,
    slow: `Повторная проверка с увеличенным таймаутом: ${s.done || 0} из ${s.total || 0}.`,
    stopping: 'Освобождаем настройки Chrome.',
    verifying: 'Помощник нашёл адрес. Chrome проверяет HTTPS и страну выхода. Запросы вкладок откроются после подтверждения.',
    connected: 'При сбое расширение само подберёт замену.',
    confirming: 'Один запрос не прошёл. Проверяем повторно перед заменой.',
    reserve: 'Повторно проверяем подготовленный адрес перед подключением в Chrome.',
    replacing: multiple ? 'Пробуем резерв из всей группы, затем общий поиск без приоритета стран.' : 'Пробуем резерв, затем ищем следующий адрес выбранной страны.',
    empty: multiple ? 'Повторим поиск через минуту во всей группе. За её пределы не выходим.' : 'Повторим поиск через минуту в этой же стране. Можно выбрать другую.',
    helper: 'Запустите Install.command из папки Country Proxy. Повторное подключение — автоматически.'
  }[s.phase] || '');
  $('progress').hidden = !['checking','slow'].includes(s.phase) || !s.total;
  $('progress').max = s.total || 1; $('progress').value = s.done || 0;
  $('proxy').hidden = !s.proxy;
  const confirmed = ['connected', 'confirming'].includes(s.phase) && s.browser?.ok === true;
  const observation = confirmed ? s.browser : s.proxy;
  const exitCountry = observation?.country;
  const exitLabel = byCode.has(exitCountry) ? labelFor(exitCountry) : exitCountry;
  const exitTitle = confirmed ? (s.phase === 'confirming' ? 'Последний выход Chrome' : 'Выход сейчас') : 'Выход по проверке помощника';
  const latency = Number.isFinite(observation?.latencyMs) ? ` · ${(observation.latencyMs/1000).toFixed(1)} с` : '';
  $('exit-location').textContent = s.proxy ? exitLabel || 'Страна неизвестна' : '';
  $('exit-address').textContent = s.proxy ? `${exitTitle}: ${observation?.exitIp || '—'}` : '';
  $('server-address').textContent = s.proxy ? `${s.proxy.scheme.toUpperCase()} · ${s.proxy.host}:${s.proxy.port}${latency}` : '';
  $('checked').textContent = observation?.checkedAt ? (confirmed ? 'Проверено в Chrome: ' : 'Проверено помощником: ') +
    new Date(observation.checkedAt).toLocaleTimeString('ru') : (s.warnings || []).join(' · ');
  const diagnostics = s.diagnostics;
  const failures = Object.entries(diagnostics?.failures || {}).filter(([,count]) => count > 0)
    .sort((a,b) => b[1]-a[1]).map(([reason,count]) => `${reasons[reason] || 'не прошёл проверку'}: ${count}`);
  const messages = [];
  const lastFailure = s.diagnostic || s.lastFailure;
  if (lastFailure?.stage === 'browser') messages.push('Последний отказ Chrome: ' + (reasons[lastFailure.reason] || 'не прошла') + '.');
  if (diagnostics?.attempts) messages.push(`Проверок за сессию: ${diagnostics.attempts}, успешных: ${diagnostics.passed}.`);
  if (failures.length) messages.push(failures.join(' · '));
  $('diagnostics').hidden = !messages.length; $('diagnostics').textContent = messages.join(' ');
  const poolCountries = state.pool?.countries || [state.pool?.country];
  const pool = sameCountries(poolCountries, selectedCountries) ? state.pool : null;
  const count = pool?.expiresAt > Date.now() ? pool.count : 0;
  let routeNote = '';
  if (enabled && s.phase === 'connected' && confirmed && s.proxy && matchesEffectiveRoute(effectiveRoute, proxyConfig(s.proxy))) {
    routeNote = count ? `Резерв${multiple ? ' группы' : ''}: ${count} из 2 · проверен помощником` :
      pool?.checking ? 'Подключение работает. Ищем запасной адрес.' : 'Подключение работает. Запасного адреса пока нет.';
  } else if (enabled && ['searching','checking','slow','reserve','replacing','empty','helper'].includes(s.phase) &&
      matchesEffectiveRoute(effectiveRoute, BLOCKED)) {
    routeNote = 'Вкладки ждут прокси. Кнопка «Отключить» вернёт прежние настройки Chrome.';
  }
  $('reserve').textContent = routeNote;
  $('reserve').hidden = !routeNote;
  const retry = enabled && s.phase === 'error' && s.lastFailure?.stage === 'local';
  $('connect').hidden = (enabled && !retry) || s.phase === 'stopping';
  $('connect').textContent = selectionInvalid ? 'Выбрать страны заново' : retry ? 'Повторить подключение' : multiple ? `Подключить группу (${selectedCountries.length})` : selectedCountries.length ? 'Подключить' : 'Выбрать страну';
  $('disconnect').hidden = !enabled && s.phase !== 'stopError';
  $('disconnect').textContent = s.phase === 'stopError' ? 'Повторить отключение' : 'Отключить';
  $('rotate').hidden = !enabled || !s.proxy;
}

$('mode-single').addEventListener('click', event => openPicker('single', event.currentTarget));
$('mode-multiple').addEventListener('click', event => openPicker('multiple', event.currentTarget));
$('country').addEventListener('click', () => pickerOpen() ? closePicker() : openPicker());
$('selection-cancel').addEventListener('click', () => closePicker());
$('selection-apply').addEventListener('click', () => {
  if (draftCountries.length) connect({action: 'connect', countries: [...draftCountries].sort()});
});
$('country-search').addEventListener('input', () => { renderCountryList(); $('country-results').scrollTop = 0; });
$('country-search').addEventListener('keydown', event => {
  if (event.key === 'ArrowDown') { event.preventDefault(); $('country-results').querySelector('[data-country], [data-select-country]')?.focus(); }
});
// Each row has two actions. Tab reaches both on the current row and then leaves
// the catalogue; arrow keys move the same action to another row.
$('country-results').addEventListener('focusin', event => {
  const code = rowCode(event.target);
  if (!code || code === catalogTabCode) return;
  for (const element of $('country-results').querySelectorAll('[tabindex="0"]')) element.tabIndex = -1;
  for (const element of event.target.closest('li').querySelectorAll('input, button')) element.tabIndex = 0;
  catalogTabCode = code;
});
$('country-results').addEventListener('keydown', event => {
  const selector = event.target.dataset.favorite ? '[data-favorite]' : '[data-country], [data-select-country]';
  navigateItems(event, [...$('country-results').querySelectorAll(selector)], 'ArrowUp', 'ArrowDown', $('country-search'));
});
$('selection-draft-chips').addEventListener('focusin', event => {
  const code = event.target.dataset.removeCountry;
  if (!code || chipTabCode === code) return;
  const previous = $('selection-draft-chips').querySelector('[tabindex="0"]');
  if (previous) previous.tabIndex = -1;
  event.target.tabIndex = 0;
  chipTabCode = code;
});
$('selection-draft-chips').addEventListener('keydown', event => {
  navigateItems(event, [...$('selection-draft-chips').querySelectorAll('button')], 'ArrowLeft', 'ArrowRight');
});
$('country-picker').addEventListener('cancel', event => {
  event.preventDefault(); closePicker();
});
$('country-picker').addEventListener('keydown', event => {
  if (event.key === 'Escape' && !event.isComposing) {
    event.preventDefault();
    closePicker();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [...$('country-picker').querySelectorAll('button:not(:disabled), input:not(:disabled)')].filter(el => el.tabIndex >= 0 && el.getClientRects().length);
  const first = focusable[0], last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
});
$('country-picker').addEventListener('click', event => {
  if (event.target !== $('country-picker')) return;
  const rect = event.currentTarget.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closePicker();
});
$('pin-selected').addEventListener('click', () => toggleFavorite(selectedCountries[0]));
$('connect').addEventListener('click', () => {
  if (selectionInvalid || !selectedCountries.length) openPicker();
  else if (selectionMode === 'multiple') connect({action: 'connect', countries: [...selectedCountries]});
  else chooseCountry(selectedCountries[0]);
});
$('disconnect').addEventListener('click', () => send({action: 'disconnect'}));
$('rotate').addEventListener('click', () => send({action: 'rotate'}));
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
try {
  catalog = await loadCountryCatalog();
  byCode = new Map(catalog.map(country => [country.code, country]));
  const refresh = () => render().catch(error => { $('error').textContent = error.message; });
  chrome.storage.onChanged.addListener(refresh);
  chrome.proxy.settings.onChange.addListener(refresh);
  setInterval(refresh, 1000);
  await render();
} catch (error) {
  $('error').textContent = error.message;
  for (const id of ['country', 'connect', 'mode-single', 'mode-multiple']) $(id).disabled = true;
}
