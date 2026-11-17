import {countryLabel, filterCountries, loadCountryCatalog} from './country-catalog.js';
import {appliedCountries, groupStorageKey, nameLimit, readGroups, selectionKeys, updateGroups} from './saved-groups.js';

const container = document.getElementById('saved-groups');
container.innerHTML = `
  <details class="selection-help">
    <summary>Сохранённые группы</summary>
    <ul id="group-list" aria-label="Сохранённые группы"></ul>
    <p id="group-hint"></p>
    <button id="group-add" type="button">Сохранить выбранные страны</button>
    <form id="group-editor" hidden>
      <div id="group-name-and-members">
        <label for="group-name">Название группы</label>
        <input id="group-name" required autocomplete="off">
        <p id="group-members"></p>
        <button type="button" id="group-country-summary" aria-expanded="false" aria-controls="group-country-picker">Изменить страны</button>
        <div id="group-country-picker" hidden>
          <label for="group-country-search">Поиск страны</label>
          <input id="group-country-search" type="search" placeholder="Название или код страны" autocomplete="off" spellcheck="false">
          <label><input type="checkbox" id="group-selected-only"> Только выбранные</label>
          <p id="group-catalog-count" role="status"></p>
          <ul id="group-country-results" aria-label="Страны группы"></ul>
          <button type="button" id="group-country-more" hidden>Показать ещё</button>
        </div>
        <div class="group-actions">
          <button id="group-save" type="submit">Сохранить</button>
          <button id="group-cancel" type="button">Отмена</button>
          <button id="group-delete" type="button" hidden>Удалить</button>
        </div>
      </div>
      <div id="group-delete-confirm" role="group" aria-labelledby="group-delete-question" hidden>
        <p id="group-delete-question"></p>
        <button type="button" id="group-keep">Оставить группу</button>
        <button type="button" id="group-delete-now">Удалить группу</button>
      </div>
    </form>
    <p id="group-message" role="status" aria-live="polite"></p>
  </details>`;
const get = id => container.querySelector('#' + id);
const nameField = get('group-name');
nameField.maxLength = nameLimit;

async function initialize() {
  const catalog = await loadCountryCatalog();
  const allowed = catalog.map(country => country.code);
  const labels = new Map(catalog.map(country => [country.code, country.name]));
  const readKeys = [groupStorageKey, ...selectionKeys];
  let selection = [], groups = [], editing = null, busy = false, generation = 0;
  let initialVisibilitySet = false;
  const list = get('group-list'), message = get('group-message');
  const pageSize = 20;
  let rowLimit = pageSize;
  const disclosure = get('group-country-summary');
  const picker = get('group-country-picker');
  const search = get('group-country-search');
  const selectedOnly = get('group-selected-only');
  const results = get('group-country-results');
  const editorFields = get('group-name-and-members');
  function preview(codes, label, separator) {
    const text = codes.slice(0, 3).map(label).join(separator);
    return codes.length > 3 ? text + ' и ещё ' + (codes.length - 3) : text;
  }
  function showMembers() {
    const countries = editing.countries;
    get('group-members').textContent = countries.length
      ? preview(countries, code => labels.get(code), ', ') : 'Выберите страны для группы.';
    disclosure.textContent = countries.length ? 'Изменить страны (' + countries.length + ')' : 'Выбрать страны';
  }
  function renderMatches() {
    const members = new Set(editing.countries);
    const matches = filterCountries(catalog, search.value)
      .filter(country => !selectedOnly.checked || members.has(country.code));
    results.replaceChildren(...matches.slice(0, rowLimit).map(country => {
      const row = document.createElement('li');
      const label = document.createElement('label');
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = members.has(country.code);
      check.dataset.groupCountry = country.code;
      const name = document.createElement('span');
      name.textContent = countryLabel(country);
      label.append(check, name);
      row.append(label);
      return row;
    }));
    get('group-country-more').hidden = matches.length <= rowLimit;
    get('group-catalog-count').textContent = matches.length
      ? 'Показано ' + Math.min(rowLimit, matches.length) + ' из ' + matches.length + '.'
      : selectedOnly.checked ? 'Выбранных стран по этому запросу нет.' : 'Страна не найдена.';
  }
  function togglePicker(open, focus = true) {
    picker.hidden = !open;
    disclosure.setAttribute('aria-expanded', String(open));
    if (open) renderMatches();
    if (focus) (open ? search : disclosure).focus();
  }
  function resetMatches() {
    rowLimit = pageSize;
    renderMatches();
    results.scrollTop = 0;
  }
  results.addEventListener('change', event => {
    const check = event.target;
    const code = check.dataset.groupCountry;
    if (!editing || !code) return;
    const selected = new Set(editing.countries);
    if (check.checked) selected.add(code);
    else selected.delete(code);
    editing.countries = [...selected].sort();
    showMembers();
    if (selectedOnly.checked && !check.checked) {
      const index = [...results.querySelectorAll('input')].indexOf(check);
      renderMatches();
      const inputs = results.querySelectorAll('input');
      (inputs[Math.min(index, inputs.length - 1)] || selectedOnly).focus();
    }
  });
  search.addEventListener('input', resetMatches);
  selectedOnly.addEventListener('change', resetMatches);
  search.addEventListener('keydown', event => {
    if (event.key === 'Enter') event.preventDefault();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      results.querySelector('input')?.focus();
    }
  });
  picker.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      togglePicker(false);
    }
  });
  disclosure.addEventListener('click', () => togglePicker(picker.hidden));
  get('group-country-more').addEventListener('click', () => {
    const nextIndex = rowLimit;
    rowLimit += pageSize;
    renderMatches();
    results.querySelectorAll('input')[nextIndex]?.focus();
  });

  function button(text, label, action) {
    const element = document.createElement('button');
    element.type = 'button'; element.textContent = text; element.setAttribute('aria-label', label);
    element.addEventListener('click', action);
    return element;
  }

  function showRows() {
    list.replaceChildren(...groups.map(group => {
      const row = document.createElement('li');
      const connect = button(group.name, 'Подключить группу «' + group.name + '»', () => connectGroup(group));
      connect.dataset.connectGroup = group.id;
      connect.title = 'Подключить группу «' + group.name + '»';
      const title = document.createElement('span');
      title.className = 'group-title';
      title.textContent = group.name;
      const cue = document.createElement('span');
      cue.className = 'group-connect-cue';
      cue.textContent = 'Подключить';
      const codes = document.createElement('small');
      codes.textContent = preview(group.countries, code => code, ' · ');
      connect.replaceChildren(title, cue, codes);
      const edit = button('Изменить', 'Изменить группу «' + group.name + '»', () => openEditor(group));
      edit.dataset.editGroup = group.id;
      row.append(connect, edit);
      return row;
    }));
    list.hidden = !groups.length;
  }

  function showControls() {
    get('group-add').hidden = Boolean(editing);
    get('group-add').textContent = selection.length ? 'Сохранить выбранные страны' : 'Создать группу';
    list.hidden = Boolean(editing) || !groups.length;
    get('group-hint').textContent = groups.length || editing ? '' : selection.length
      ? 'Сохраните набор, чтобы подключать его одним нажатием.' : 'Группу можно сохранить до подключения.';
    get('group-editor').hidden = !editing;
    nameField.disabled = busy;
    for (const field of container.querySelectorAll('button, input')) field.disabled = busy;
  }

  async function refresh() {
    const token = ++generation;
    const state = await chrome.storage.local.get(readKeys);
    if (token !== generation) return;
    const nextGroups = readGroups(state[groupStorageKey], allowed);
    if (!initialVisibilitySet) {
      container.querySelector('details').open = nextGroups.length > 0;
      initialVisibilitySet = true;
    }
    selection = appliedCountries(state, allowed);
    if (JSON.stringify(nextGroups) !== JSON.stringify(groups)) {
      groups = nextGroups;
      showRows();
    }
    showControls();
  }

  function openEditor(group) {
    editing = {original:group, countries:[...(group ? group.countries : selection)]};
    nameField.value = group?.name ?? '';
    showMembers();
    search.value = '';
    selectedOnly.checked = false;
    rowLimit = pageSize;
    togglePicker(!editing.countries.length, false);
    get('group-delete').hidden = !group;
    get('group-delete-confirm').hidden = true;
    editorFields.hidden = false;
    message.textContent = '';
    showControls();
    nameField.focus();
  }

  function closeEditor(focusId = editing?.original?.id) {
    editing = null;
    showControls();
    const edit = [...list.querySelectorAll('[data-edit-group]')].find(b => b.dataset.editGroup === focusId);
    const fallback = get('group-add').hidden ? container.querySelector('summary') : get('group-add');
    (edit || fallback).focus();
  }

  async function operate(action) {
    if (busy) return;
    busy = true;
    message.textContent = '';
    showControls();
    try {
      await action();
    } catch (error) {
      message.textContent = error.message;
    } finally {
      busy = false;
      showControls();
    }
  }

  async function connectGroup(group) {
    await operate(async () => {
      const state = await chrome.storage.local.get(groupStorageKey);
      const saved = readGroups(state[groupStorageKey], allowed).find(item => item.id === group.id);
      if (!saved) throw Error('Группа удалена. Выберите другую группу.');
      const result = await chrome.runtime.sendMessage({action:'connect', countries:saved.countries});
      if (!result?.ok) throw Error(result?.error || 'Не удалось подключить группу.');
      editing = null;
      message.textContent = 'Запущено подключение группы «' + saved.name + '».';
    });
  }

  async function save(remove) {
    if (!editing) return;
    const draft = {...editing, name:nameField.value, remove, id:editing.original?.id || crypto.randomUUID()};
    await operate(async () => {
      await navigator.locks.request(groupStorageKey, async () => {
        const state = await chrome.storage.local.get(groupStorageKey);
        const stored = readGroups(state[groupStorageKey], allowed);
        const changed = updateGroups(stored, draft, allowed);
        await chrome.storage.local.set({[groupStorageKey]:changed});
      });
      await refresh();
      editing = null;
      message.textContent = remove ? 'Группа удалена.' : 'Группа сохранена.';
    });
    if (!editing) closeEditor(remove ? null : draft.id);
  }

  get('group-add').addEventListener('click', () => openEditor(null));
  get('group-cancel').addEventListener('click', () => {
    closeEditor();
    message.textContent = '';
  });
  get('group-delete').addEventListener('click', () => {
    get('group-delete-question').textContent = 'Удалить группу «' + editing.original.name + '»?';
    editorFields.hidden = true;
    get('group-delete-confirm').hidden = false;
    get('group-keep').focus();
  });
  get('group-keep').addEventListener('click', () => {
    get('group-delete-confirm').hidden = true;
    editorFields.hidden = false;
    get('group-delete').focus();
  });
  get('group-delete-now').addEventListener('click', () => save(true));
  get('group-editor').addEventListener('submit', e => { e.preventDefault(); save(false); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && readKeys.some(key => Object.hasOwn(changes, key))) {
      refresh().catch(error => { message.textContent = error.message; });
    }
  });
  showRows();
  await refresh();
}

initialize().catch(error => { get('group-message').textContent = error.message; get('group-add').hidden = true; })
  .finally(() => { container.hidden = false; });
