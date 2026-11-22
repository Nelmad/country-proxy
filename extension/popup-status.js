import {gateRules} from './traffic-gate.js';

// Read-only counterpart of TrafficGate.verify: compare the owned admission
// rules with the same canonical contract. The dummy capability affects only
// dynamic probe rules, which are neither used nor persisted here.
export function hasTrafficAdmission(sessionRules, extensionId) {
  if (!Array.isArray(sessionRules)) return false;
  const canonical = value => JSON.stringify(value, function (_key, item) {
    return item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
  });
  const expected = gateRules(extensionId, '0'.repeat(32)).session;
  const ids = expected.map(rule => rule.id);
  const actual = sessionRules.filter(rule => ids.includes(rule.id)).sort((a, b) => a.id - b.id);
  return canonical(actual) === canonical(expected);
}

// Keep the live summary separate from frequently updated progress/diagnostics.
export function hasRejectedHealthCountry(status) {
  return status.phase === 'confirming' && status.health?.ok === false && status.health.reason === 'country';
}

export function statusDetail(status, {multiple = false, hasSelection = false, announcement = false} = {}) {
  if (hasRejectedHealthCountry(status)) return 'Помощник обнаружил страну вне выбранного набора. Трафик заблокирован до нового подтверждения Chrome.';
  return status.error || status.note || ({
    off: hasSelection ? 'Можно снова подключиться с выбранными странами.' : 'Выберите одну или несколько стран. Адрес найдём автоматически.',
    searching: multiple ? 'Ищем адреса во всей выбранной группе без приоритета стран.' : 'Получаем свежие списки из открытых источников.',
    checking: announcement ? 'Проверяем HTTPS и страну выхода.' : `Проверено ${status.done || 0} из ${status.total || 0}. Проверяем HTTPS и страну выхода.`,
    slow: announcement ? 'Повторная проверка с увеличенным таймаутом.' : `Повторная проверка с увеличенным таймаутом: ${status.done || 0} из ${status.total || 0}.`,
    stopping: 'Освобождаем настройки Chrome.',
    verifying: 'Помощник нашёл адрес. Chrome проверяет HTTPS и страну выхода. Запросы вкладок откроются после подтверждения.',
    connected: 'При сбое расширение само подберёт замену.',
    confirming: 'Один запрос не прошёл. Проверяем повторно перед заменой.',
    reserve: 'Повторно проверяем подготовленный адрес перед подключением в Chrome.',
    replacing: multiple ? 'Пробуем резерв из всей группы, затем общий поиск без приоритета стран.' : 'Пробуем резерв, затем ищем следующий адрес выбранной страны.',
    empty: multiple ? 'Повторим поиск через минуту во всей группе. За её пределы не выходим.' : 'Повторим поиск через минуту в этой же стране. Можно выбрать другую.',
    helper: 'Запустите Install.command из папки Country Proxy. Повторное подключение — автоматически.'
  }[status.phase] || '');
}

export function createStatusAnnouncer(region) {
  let previous = '';
  return (status, {phaseLabel, recovery = '', ...options}) => {
    const summary = [phaseLabel, statusDetail(status, {...options, announcement: true}), recovery]
      .filter(Boolean).join(' ');
    if (summary === previous) return;
    previous = summary;
    region.textContent = summary;
  };
}
