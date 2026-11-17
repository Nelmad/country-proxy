# 0007 — Проверяемое ускорение поиска и восстановления

Дата: 2026-10-31. Статус: принято для реализации; runtime-изменения выполняются последовательно после исходных измерений.

## Причина

Сбор feeds/стран сейчас предшествует проверке адресов; обслуживание резервов ждёт пополнения; запасные перед использованием проверяются последовательно. Нужны сопоставимые измерения этих задержек. Снижение числа проверок не считается улучшением, если теряются рабочие адреса.

## Решение

До изменения поведения фиксируются source snapshot, hash harness/config, deadlines и условия cold/warm. Каждый benchmark вызывает настоящие API помощника или контроллера с явно указанными искусственными входами. Наблюдение не заменяет алгоритм и не выдаётся за настоящий Chrome/HTTPS. Стенд запускается одинаково для сохранённого baseline и кандидата. При несовместимости API нужен явно проверенный adapter; прежние измерения другого API не становятся end-to-end результатом нового.

Для детерминированных timing-сценариев —20 повторов, nearest-rank quantiles только для успешных latency с отдельным N; failures/timeouts имеют собственные счётчики. Timeout остаётся правой цензурой `>deadline`, не превращается в успешную latency. Внешняя сеть не участвует в этих latency-утверждениях. Для реального Chrome отдельны наблюдения HTTPS, route, lifecycle и public IP.

Отказ измеряется в одном monotonic clock: injection → detection → replacing → native-qualified → browser-confirmed. Отсутствующая стадия имеет null/unsupported, никогда ноль. У текущего helper нет browser-confirmation: она измеряется контроллером/Chrome отдельно. Idle отказ, browser-triggered отказ и browser-only rejection — разные сценарии. Idle инъекции: после завершённой health-проверки, на половине интервала и непосредственно перед следующим сроком.

Основной gate: нет новых failures/timeouts, ложных замен, нарушений country set/blocked route, потери coverage в фиксированном горизонте и регрессии end-to-end сверх заранее выбранной погрешности. Fake-clock regression tolerance=0; локальный timing без сети —max(100ms,10%baseline). Это описательная стендовая погрешность, не production SLO. Старые известные провалы baseline сохраняются как observations, не как PASS будущего исправления.

## Единица попытки и история

Logical attempt = generation + endpoint(protocol/IP/port) + attempt ID. Scan fast+разрешённый slow retry относятся к одной попытке. Отдельны admissions, физические started checks (включая cancellation), terminal logical outcomes, native-qualified и browser-confirmed. Нынешний diagnostics.attempts является счётчиком завершённых физических проверок и не переименовывается задним числом в terminal failures.

| Результат | Действие | Репутация |
|---|---|---|
| Оба HTTPS-origin прошли, actual country допустима | Native-qualified, затем обязательная проверка Chrome | Один успех; endpoint streak сбрасывается |
| Fast timeout/другая fast неудача | Сохраняется предусмотренный slow retry | Предварительный outcome, без quarantine до финального решения |
| Окончательный TLS/invalid trace reject | Никогда не подключать | При установленной некорректности ответа/сертификата —terminal reject; локальная конфигурационная ошибка нейтральна |
| Страна вне выбранного набора | Недопуск в этом наборе | Country hint, без глобального negative streak |
| HTTP origin error, timeout/connect/transport с неизвестной причиной | Недопуск, unknown/cooldown60s | Без постоянного роста серии; не выдумываем диагноз Wi-Fi или «IP умер» |
| Stop/cancel/смена generation/resource deadline/internal error | Не применять результат | Neutral; начавшаяся работа всё равно учитывается в расходе |
| Browser rejection | Принимать только совпадающие generation/endpoint/attempt | Поздний feedback нейтрален; новая попытка не штрафуется за старый ответ |

При неоднозначности выбирается neutral/unknown, а не подтверждённый endpoint failure. Таблица конкретных кодов terminal TLS/invalid-trace фиксируется отдельными regression cases до history implementation; blanket penalty для любой TLS ошибки запрещён. Существующие host exclusions180/60s остаются отдельным механизмом. Scan не создаёт новые host-баны. Это ограничивает агрессивность карантина в первой версии, сохраняя slow proxies и восстановление сети.

## Фиксированная первая версия ranking

Country credits не зависят от ranking. Внутри country queue: recent native success(age≤300s) → меньший подтверждённый terminal streak → меньшая EWMA успешных native checks → rotating cursor. EWMA: первый успешный sample=L; далее L=0.75L+0.25sample. Failed/cancelled и browser latency не входят в native EWMA. Unknown latency после известной только внутри своего класса.

Не менее каждого пятого admission выделяется новым/выздоровевшим при их наличии; FIFO ring гарантирует каждому из K eligible адресов возможность за≤5K admissions страны. Source contribution учитывает один уникальный endpoint за фиксированное300s окно; mirrors одна группа, одна единица вклада делится между provider groups. Native-qualified и browser-confirmed считаются отдельно. Fetch time не выдаётся за известный возраст публикации. History hint не заменяет fresh actual-country/TLS и не даёт ready reserve.

Автоматическое source-ranking включается только при измеренном выигрыше без потери coverage. Иначе сохраняется равномерный порядок и честные метрики. Параметры не подгоняются по финальному eval-набору.

## Обязательный gate перед обычным сетевым discovery

Read-only проверка текущего library adapter выявила: library limit120 применяется после загрузки глобальных JSON; внутренний body limit64MiB, допускается TLS fallback каталога, отсутствует самостоятельный общий deadline после смерти родителя. Это касается загрузки списка, а не native HTTPS-проверки прокси, где TLS остаётся строгим.

До обычного background discovery необходимы: bounded verified fetch≤2MB до parse, без insecure fallback; library worker watchdog≤28s до imports/network; управляемые feed fetch≤6/library workers≤1; single-flight source/country и backoff, не исчезающий от payload eviction; cleanup sibling fetch. Изменять установленную .venv нельзя. Решение реализуется в source adapter стандартными средствами и проверяется synthetic oversized/chunked/TLS/cancel/parent-death сценариями.

Это не мешает offline baseline или изолированному Chrome fixture с injected discoverer, который library не вызывает. Обычные live scans до закрытия gate не запускаются.

## Последствия и границы

Fairness модель и конкретный B_probe(N) описываются в [контракте равноправия](../recovery-fairness.md); до её проходящих model-tests функциональная стадия не начинается. Модель — спецификация будущего планировщика; её PASS не доказывает текущий production scheduler.

Изолированная браузерная приёмка, проверка настоящего установленного launcher, новый30-минутный soak и соответствие ZIP tested snapshot остаются обязательными после изменений. Публичная пара имеет отдельный PASS/INCONCLUSIVE. Основной Chrome и установленная копия не меняются; версия и публикация отдельно.
