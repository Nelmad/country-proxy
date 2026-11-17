# ADR 0011 — ограниченная локальная история endpoint

Статус: принято для Stage 4. Дата: 2026-11-01.

История помогает упорядочить повторно найденные endpoint. Она не является
списком готовых резервов и никогда не заменяет свежую native/browser проверку,
выбранный набор стран, fairness либо лимит конкурентных проверок. В файл не
попадают страницы, URL пользователей, credentials, сырые ответы или логи.

Модель истории сначала проверяется отдельно в памяти. Дисковый адаптер подключается
после прохождения её unit-тестов; повреждённый, устаревший, слишком большой файл,
неизвестная версия и перевод часов назад дают пустую историю. Схема и сроки
годности принадлежат `native/history.py`, а не файловому адаптеру.

Exact v1 document: `schemaVersion: 1`, `savedAt` (wall seconds) и `records`.
Каждая запись содержит только `scheme`, canonical global literal IP `host`,
`port`, `firstSeen`, `lastSeen`, nullable `lastSuccess`, `streak`, nullable
`cooldownUntil`, nullable `ewmaMs`, nullable `countryHint`, `groups` и nullable
`lastOutcome`. Последнее поле принимает только `success`, `invalid_trace`,
`timeout`, `http`, `transport`, `connect`, `tls`, `country`, `unknown`.
Схема не разрешает произвольные строки отказов. Неизвестные/лишние поля,
нечисловые или бесконечные значения и дубли endpoint отклоняют document целиком.

Лимиты: 5000 записей, 2 MiB UTF-8 compact JSON; срок без реального наблюдения
7 суток. Перед eviction удаляются истёкшие, затем старые `lastSeen`.
Повторное предложение feed не продлевает срок. В записи максимум 32 canonical
source-group ID, каждый до 64 символов. Схемы — `http`, `https`, `socks4`, `socks5`;
порт 1–65535, IP без логинов/URL/DNS/zone-id, countryHint только из ISO-каталога.
`firstSeen <= lastSeen <= savedAt`, `lastSuccess <= lastSeen`, `streak` 0–16;
cooldown ограничен `savedAt + 3600`, EWMA — 0–86400000 ms. Документ из будущего
отклоняется. При достижении 2 MiB snapshot опускает самые старые записи на диске.

Одна fast/slow пара даёт один логический outcome: поздний slow success не создаёт
промежуточный failed streak. Доказанный invalid trace получает exponential
backoff от 60 секунд с jitter до 10%, максимум 3600 секунд. Обычные неоднозначные
timeout/transport/HTTP/TLS — unknown и короткий cooldown 60 секунд без увеличения
terminal streak. Country mismatch хранит hint и не усиливает глобальный cooldown.
Успех сбрасывает streak/cooldown и обновляет EWMA с alpha 0.25. Отмена, локальный
certificate/configuration failure, internal error и ручная смена нейтральны.
Browser country/IP/транспортная обратная связь имеет отдельную проверку точного
attempt/generation; stale feedback не обновляет history.

Обычная установка выбирает private `.runtime/data/<profile-key>`; установка
с явным `--profile` требует явный `--data-dir`. Helper, вызванный напрямую без
`--data-dir`, работает только в памяти. Launcher получает exact абсолютный data-dir; имя
launcher содержит SHA-256 канонического пути Chrome user-data-dir, поэтому две
регистрации одного комплекта не перезаписывают настройки друг друга. Старый
`.runtime/host` того же install path может мигрировать в keyed launcher.

Для возврата к старому installer, который принимает только `.runtime/host`,
перед заменой комплекта выполняется текущий installer с
`--profile EXACT --prepare-legacy-rollback`. Команда проверяет exact регистрацию
этого комплекта и переключает её на memory-only legacy launcher. Данные остаются
на диске, старый комплект их не читает. Перерегистрация чужой установки запрещена.

Data-dir — отдельная директория владельца с mode 0700; history, lock и временные
файлы имеют mode 0600. Не разрешены симлинки в пути, чужой владелец, небезопасный
тип файла, слишком большой файл, `.git` и каталоги секретов. Home и существующие
родительские каталоги не chmod-ятся. Файлы читаются через ограниченный descriptor
с `O_NOFOLLOW`, запись использует уникальный temporary и atomic replace.

Один helper держит nonblocking flock до остановки/закрытия. Второй helper продолжает работу
в памяти. Загрузки/записи выполняются вне asyncio event loop; ошибки диска не
прерывают здоровую Session. Снимки объединяются, запись происходит не чаще раза
в 30 секунд, при нормальном завершении выполняется final flush. SIGKILL может
потерять последние обновления. История — best effort hint, не журнал аудита.

Очистка — отдельная команда `python3 scripts/history.py clear --data-dir EXACT`.
Она получает тот же exclusive lease и удаляет только точный history-файл и
собственные `.endpoint-history-<32 hex>.tmp` после проверки metadata; активный helper блокирует
очистку. Lock-файл не удаляется, чтобы не создать два lock inode. Каталог,
посторонние файлы и профиль Chrome не удаляются. Runtime/cache не входят в ZIP;
packager также отклоняет их попадание внутрь allowlisted source roots.
Data-dir не может совпадать с Home/корнем, находиться в `.git`, каталогах секретов
или source roots комплекта; внутри комплекта допустим только `.runtime`.
Relative paths и `..` запрещены. Для отсутствующего data-dir создаётся только
последняя компонента; существующий parent должен быть указан и уже существовать.

Проверки включают lease competition, права/симлинки/размер до чтения, corrupt
JSON/schema/time rollback, отказ записи/rename, coalescing/final flush,
installer migration/rollback и отсутствие cache в архиве. Основной Chrome,
сетевые проверки и dependency install не нужны для этих тестов.
