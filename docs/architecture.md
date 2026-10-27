# Архитектура

MV3 service worker → Native Messaging (stdio) → Python asyncio → proxy-scraper catalogue и country list → curl с валидным HTTPS → проверенный адрес → chrome.proxy.settings → контрольный fetch из Chrome.

Native helper не принимает браузерный трафик и не открывает HTTP-порт управления. Chrome запускает его через manifest с одним точным `allowed_origins`. Расширение не читает страницы/историю/пароли. Разрешения: proxy, storage, nativeMessaging, alarms, privacy и два HTTPS-хоста для проверки. Страны и выбранный регион хранятся локально. ISO-каталог задаёт допустимые коды; пользовательский список не ограничен defaults. Ни один адрес прокси не зашит в код.

Список кандидатов недоверенный: разрешены только глобальные literal IPv4, порт 1–65535 и три известных протокола; не разрешены логины, hostnames, локальные или metadata endpoints. Список обрезается до 120 комбинаций. Максимум десять кандидатов одновременно, у каждого два запроса; два прохода с разными таймаутами. SOCKS5 использует удалённое DNS, SOCKS4 — локальное. TLS не отключается. Страна источника лишь фильтр; страна выхода обязательна в ответе HTTPS trace.

Контроллер сериализует мутации Chrome и использует generation ID. Смена страны/отключение немедленно отменяет browser probe и делает старые события недействительными. Backend отменяет старую сессию и curl-процессы. Первая ошибка активного адреса перепроверяется; вторая блокирует маршрут и запускает подбор, исключая старый адрес на три минуты. Отклонённый браузером адрес также исключается временно. Нет прямого fallback: ожидание использует недоступный loopback-прокси, маршруты HTTP/HTTPS/fallback направляются одинаково, implicit loopback bypass вычитается. localhost в браузере тоже будет недоступен при включённом режиме.

Native port поддерживает worker; после потери помощника настройки остаются блокирующими. Alarm переподключает каждые 30 секунд. При новом запуске Chrome сохранённое enabled запускает новую проверку. Внешнее управление настройками (другая extension / enterprise policy) даёт явную ошибку. Статус «Подключено» появляется после браузерной проверки. Повторная браузерная проверка выполняется на health-событии раз в минуту и по chrome.proxy.onProxyError; ошибка двух контрольных HTTPS-запросов вызывает замену, даже если curl всё ещё видит upstream.

Источники контрактов, проверены 2026-10-27:
- [Chrome proxy](https://developer.chrome.com/docs/extensions/reference/api/proxy)
- [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [proxy-scraper commit b1ade5b](https://github.com/maximilianfeix/proxy-scraper/tree/b1ade5b4aa0627ccbb193dcd9d36a621c0a22aeb)

## Решение об upstream

В trial 2026-10-27 норвежский HTTP-прокси отвечал через curl за 19–23 секунды, но дополнительный RotatingServer библиотеки завершался ошибкой. Причина не доказана. Здесь библиотека служит источником адресов; Chrome подключается непосредственно к upstream. Увеличенный таймаут применяется ко всем странам. Это не гарантирует наличия бесплатного адреса в конкретной стране.
