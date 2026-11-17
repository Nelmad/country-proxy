import {loadCountryCatalog} from './country-catalog.js';
import {groupStorageKey, readGroups} from './saved-groups.js';
import {exportGroups, parseBackup, mergeGroups} from './group-backup.js';

const download = document.querySelector('#export-groups');
const upload = document.querySelector('#import-groups');
const fileInput = document.querySelector('#groups-file');
const message = document.querySelector('#backup-result');
const readStored = async () => (await chrome.storage.local.get(groupStorageKey))[groupStorageKey];
let allowed, busy = false;

async function refreshButtons() {
  upload.disabled = busy || !allowed;
  download.disabled = busy || !allowed || !(await readStored())?.length;
}

async function run(action) {
  if (busy) return;
  busy = true;
  download.disabled = upload.disabled = true;
  message.textContent = '';
  try { await action(); }
  catch (error) { message.textContent = error.message; }
  finally { busy = false; await refreshButtons(); }
}

download.addEventListener('click', () => run(async () => {
  const json = exportGroups(await readStored(), allowed);
  const url = URL.createObjectURL(new Blob([json], {type: 'application/json'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'country-proxy-groups.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  message.textContent = 'Файл групп подготовлен.';
}));
upload.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const [file] = fileInput.files;
  fileInput.value = '';
  if (!file) return;
  run(async () => {
    if (file.size > 10 * 1024 * 1024) throw Error('Выберите файл групп размером до 10 МБ.');
    const incoming = parseBackup(await file.text(), allowed);
    const result = await navigator.locks.request(groupStorageKey, async () => {
      const merged = mergeGroups(readGroups(await readStored(), allowed), incoming);
      if (merged.added) await chrome.storage.local.set({[groupStorageKey]: merged.groups});
      return merged;
    });
    message.textContent = 'Добавлено групп: ' + result.added + '.'
      + (result.sameCountries ? ' Уже есть с таким составом: ' + result.sameCountries + '.' : '')
      + (result.nameConflicts ? ' Пропущено из-за совпадения названия: ' + result.nameConflicts + '.' : '');
  });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && groupStorageKey in changes) refreshButtons();
});
try {
  allowed = (await loadCountryCatalog()).map(c => c.code);
  await refreshButtons();
} catch (error) { message.textContent = error.message; }
