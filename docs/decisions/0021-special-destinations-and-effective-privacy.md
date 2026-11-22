# 0021 — Специальные назначения и эффективные privacy settings

Принято 20 ноября 2026 года в рамках утверждённого исправления R1/R2/R6.
Дополняет [ADR 0018](0018-preconfirmation-traffic-gate.md); исторические решения
и опубликованный v1.0.0 не переписываются. Изменение **Unreleased**,
controlled browser-приёмка кандидата 1.0.1 прошла 20 ноября 2026; границы свидетельств — в [verification](../verification.md).

## Причина

В контролируемом компонентном опыте на v1.0.0 после допуска обычного трафика
прокси вернул страницу под localhost origin; локального сервиса на целевом
порту не было. Сочетание отменённого implicit bypass и общего DNR allow не
обеспечивало обещанный запрет локальных URL. Это не доказательство эксплуатации
публичного прокси, нарушения TLS или компрометации пользователя.

Успешный вызов privacy `.set()` не доказывает эффективного значения: другой
владелец или policy может изменить результат. Реакция на потерю proxy owner,
отложенная за native teardown, также продлевала допуск старого маршрута.

## Решение

Сохранять отдельные persistent dynamic DNR blocks priority 4 выше session allow
priority 3 на всём enabled-периоде, включая connected, recovery и restart.
Покрытие: HTTP/HTTPS и WS/WSS handshakes, все обычные resource types, включая
main frame. Special set соответствует macOS implicit destinations Chromium:
`localhost` и поддомены, включая конечную точку; `127.0.0.0/8`;
`169.254.0.0/16`; `::1`; `fe80::/10`; `0.0.0.0`; `::`; `::ffff:0:0`;
IPv4-mapped loopback и link-local. URL сначала канонизирует Chrome.

Для активного candidate использовать `bypassList: []`, сохраняя implicit
защиту Chromium. Одновременно DNR запрещает DIRECT-доступ к этим адресам.
Блокирующий placeholder сохраняет `<-loopback>` как дополнительную защиту
при ошибке DNR. Stop снимает и обычный hold, и special deny.

До допуска читать effective `webRTCIPHandlingPolicy` и
`networkPredictionEnabled`; безопасны только `disable_non_proxied_udp` и
`false` соответственно. Безопасное значение другого владельца допустимо.
Небезопасное или непроверяемое значение закрывает gate и даёт локальную ошибку.
Наблюдать изменения обеих настроек и proxy; начинать отзыв допуска при получении
уведомления до очереди teardown и ожидания `stopNative`. После конфликта нужен
Stop/устранение причины/явное повторное подключение; чужой proxy не захватывать.

## Границы и приёмка

API независимы и асинхронны: остаётся окно между внешним изменением, уведомлением
и завершением DNR update. Атомарность, отзыв отправленных запросов и прекращение
всех открытых соединений не обещаются. URL-фильтр не проверяет DNS каждого имени,
не блокирует все private IP и не заменяет OS firewall/VPN.

Нужны offline regression и отдельный Chrome через штатный controller: special
destinations не достигают ни proxy, ни local listener; обычный fixture работает
только после доказанного маршрута; restart/recovery сохраняют deny; Stop снимает
его. Для privacy нужны silent unsafe override до/после допуска, безопасный
чужой owner, readback failure и корректный Stop. Для takeover — измерение раннего
отзыва при задержанном native teardown и честное описание остаточного окна.
Фактические результаты фиксируются отдельно в [verification](../verification.md).

Источники, проверены 20 ноября 2026:

- [Chromium proxy/implicit bypass](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md#implicit-bypass-rules)
- [Chromium implicit host matcher](https://raw.githubusercontent.com/chromium/chromium/main/net/proxy_resolution/proxy_host_matching_rules.cc)
- [Chromium IP address classification](https://raw.githubusercontent.com/chromium/chromium/main/net/base/ip_address.cc)
- [Chrome privacy API](https://developer.chrome.com/docs/extensions/reference/api/privacy#concepts-and-usage)
