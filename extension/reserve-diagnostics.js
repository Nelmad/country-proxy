// The helper reports observations for the whole native session. Keep only the
// agreed fields so candidate addresses or future internal fields cannot reach storage.
const stages = {
  noActive: 'Для пополнения нужен активный прокси. Помощник подбирает основной маршрут.',
  awaitingBrowser: 'Пополнение ждёт, пока Chrome подтвердит предложенный маршрут.',
  refilling: 'Помощник ищет и проверяет кандидатов в резерв.',
  full: 'При последней проверке оба места в резерве были заняты.',
  waiting: 'Помощник ждёт следующего пополнения.'
};

export const reserveCounters = {
  rounds: 'Проходов пополнения',
  roundsWithoutChecks: 'Завершённых проходов без начатых проверок',
  roundsWithSourceWarnings: 'Проходов с предупреждениями при получении списков',
  checked: 'Начато проверок кандидатов',
  qualified: 'Успешных проверок кандидатов',
  qualifiedUnique: 'Разных адресов с успешной проверкой (протокол, IP, порт)',
  checkFailed: 'Неудачных проверок кандидатов',
  cancelled: 'Прерванных проверок',
  unused: 'Успешных результатов, уже не нужных к концу прохода',
  added: 'Добавлений в резерв',
  sameHost: 'Пропусков из-за совпадения адреса сервера',
  sameExit: 'Пропусков из-за совпадения выходного IP',
  quarantined: 'Пропусков из-за карантина или временного исключения',
  alreadyReserved: 'Пропусков уже зарезервированного адреса',
  full: 'Пропусков из-за заполненного резерва',
  outsideGroup: 'Адресов со страной выхода вне выбранного набора',
  stale: 'Результатов, устаревших до добавления',
  expired: 'Записей с истёкшим сроком в резерве',
  removed: 'Других удалений из резерва',
  offered: 'Всего маршрутов предложено Chrome',
  confirmed: 'Маршрутов подтверждено Chrome',
  rejected: 'Маршрутов отклонено Chrome'
};

export const reserveFailures = {
  timeout: 'таймаут', tls: 'ошибка TLS', connect: 'нет соединения', http: 'неверный ответ HTTPS-сервиса',
  country: 'страна выхода вне набора', invalid_trace: 'неверные данные о выходе', transport: 'ошибка передачи данных',
  internal: 'ошибка проверки', unavailable: 'адрес недоступен', unknown: 'неизвестная причина'
};

function readCounts(input, labels) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const counts = {};
  for (const key of Object.keys(labels)) {
    if (!Object.hasOwn(input, key)) continue;
    const n = input[key];
    if (!Number.isSafeInteger(n) || n < 0) return null;
    if (n) counts[key] = n;
  }
  return counts;
}

const removalReasons = {
  expired: 'истёк срок проверки', quarantined: 'адрес временно исключён',
  outsideGroup: 'страна выхода вне выбранной группы', sameHost: 'совпадает сервер',
  sameExit: 'совпадает выходной IP', full: 'резерв заполнен', stale: 'результат проверки устарел',
  checkFailed: 'перепроверка не пройдена', unknown: 'точная причина не установлена'
};
const removalStages = {prune: 'Очистка', maintenance: 'Фоновая перепроверка', promotion: 'Проверка перед заменой'};
const safeNumber = n => Number.isSafeInteger(n) && n >= 0;

function readRemovals(input, wasLimited) {
  let limited = wasLimited === true;
  if (!Array.isArray(input)) return {removals: [], removalsLimited: true};
  if (input.length > 20) limited = true;
  let previousId = 0;
  const removals = [];
  for (const row of input.slice(-20)) {
    if (!row || typeof row !== 'object' || !safeNumber(row.id) || row.id <= previousId ||
        typeof row.reserveId !== 'string' || !/^[a-f0-9]{32}$/.test(row.reserveId) ||
        !safeNumber(row.atMs) || row.atMs > 8640000000000000 ||
        typeof row.stage !== 'string' || !Object.hasOwn(removalStages, row.stage)) {
      limited = true; continue;
    }
    previousId = row.id;
    const record = {id: row.id, reserveId: row.reserveId, atMs: row.atMs, stage: row.stage,
      reason: typeof row.reason === 'string' && Object.hasOwn(removalReasons, row.reason) ? row.reason : 'unknown'};
    if (safeNumber(row.ageMs)) record.ageMs = row.ageMs;
    const c = row.check;
    if (c && typeof c === 'object' && !Array.isArray(c)) {
      const check = {reason: typeof c.reason === 'string' && Object.hasOwn(reserveFailures, c.reason) ? c.reason : 'unknown'};
      if (c.endpoint === 'trace' || c.endpoint === 'target') check.endpoint = c.endpoint;
      if (safeNumber(c.code) && c.code <= 255) check.code = c.code;
      const status = typeof c.status === 'string' && /^[1-5][0-9]{2}$/.test(c.status) ? Number(c.status) : c.status;
      if (safeNumber(status) && status >= 100 && status <= 599) check.status = status;
      if (typeof c.latencyMs === 'number' && Number.isFinite(c.latencyMs) && c.latencyMs >= 0 && c.latencyMs <= Number.MAX_SAFE_INTEGER) check.latencyMs = c.latencyMs;
      record.check = check;
    }
    removals.push(record);
  }
  return {removals, removalsLimited: limited};
}

export function reserveRemovalText(row) {
  let text = `${removalStages[row.stage]}: ${removalReasons[row.reason]}.`;
  const check = row.check;
  if (check) {
    const reason = check.reason === 'http' && check.status ? `HTTP ${check.status}` : reserveFailures[check.reason];
    const target = {trace: 'Cloudflare (страна и IP)', target: 'Google (доступность HTTPS)'}[check.endpoint];
    text += ` Результат проверки: ${reason}${target ? ' · ' + target : ''}${check.code ? ' · код curl ' + check.code : ''}.`;
  }
  return text;
}

export function readReserveDiagnostics(report) {
  if (!report || typeof report.state !== 'string' || !Object.hasOwn(stages, report.state)) return null;
  const counts = readCounts(report.counts, reserveCounters);
  if (!counts) return null;
  const failures = readCounts(report.failures, reserveFailures);
  return {state: report.state, counts, limited: report.limited === true, ...(failures ? {failures} : {}),
    ...(Object.hasOwn(report, 'removals') ? readRemovals(report.removals, report.removalsLimited) : {})};
}

export function reserveStageText(report) {
  return report ? stages[report.state] : 'Помощник пока не передал статистику резерва для этого подключения.';
}
