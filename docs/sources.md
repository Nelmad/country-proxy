# Источники бесплатных прокси

Контракты проверены 2026-10-27. Все источники получают выбранный ISO-код страны;
NO/EE/AT не имеют отдельной логики. Списки служат только кандидатами. Работоспособность,
валидный TLS и фактическую страну выхода helper и Chrome проверяют независимо.

| Источник | Формат | Кэш успешного ответа |
| --- | --- | --- |
| [proxy-scraper](https://github.com/maximilianfeix/proxy-scraper) | закреплённая библиотека, country filter | новый subprocess при поиске |
| [hproxy](https://github.com/hproxy-com/free-proxy-list) | country TXT | 5 минут |
| [Proxifly](https://github.com/proxifly/free-proxy-list) | country TXT с протоколом | 5 минут |
| [ProxyScrape](https://docs.proxyscrape.com/api-reference/public-api/get-proxy-list) | API TXT с протоколом, timeout filter 60 секунд | 1 минута |
| [GeoNode](https://geonode.com/free-proxy-list) | JSON data, country, protocols | 5 минут |
| [Litport](https://github.com/litportnet/free-proxy-list) | live branch, country TXT | 5 минут |
| [ProxMint](https://proxmint.com/free-proxies#api) | JSON rows, countryCode, protocol | 30 минут |
| [Databay](https://github.com/databay-labs/free-proxy-list) | четыре country TXT, по протоколам | 5 минут |

ProxMint публикует данные по [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
В приложении данные фильтруются, нормализуются, объединяются и проверяются заново.
Litport просит обращаться к спискам не чаще одного раза в пять минут.

`native/sources.py` содержит адаптеры. Никакие аккаунты или ключи не нужны.
Для TXT country-файлов отсутствие файла (404) означает пустой список; остальные
ошибки возвращаются предупреждением, не отменяя удачные источники. JSON-адаптеры
дополнительно сверяют поле страны и отбрасывают неизвестные форматы.

Кэш ограничен 160 записями на процесс, разделён по стране и источнику, сбрасывается
при перезапуске helper. Ошибки повторяются не чаще раза в минуту. Это кэш списков,
а не результатов проверки: перед подключением адрес обязательно проверяется заново.

Предел — 120 уникальных комбинаций протокол/IP/порт. Объединение идёт по очереди
между провайдерами, чтобы первый большой список не вытеснил остальные. Четыре
файла Databay получают общую долю одного провайдера. API используют ограниченную
первую страницу, поэтому это не полный мировой каталог. Ответ ограничен 2 MB.

HTTP CONNECT и HTTPS transport различаются. `https://` в типизированных TXT
и файл Databay `https.txt` означают TLS до самого прокси. В GeoNode/ProxMint
метка HTTPS интерпретируется как HTTP CONNECT. Самоподписанные сертификаты
прокси не принимаются: `--insecure` и `--proxy-insecure` не используются.
SOCKS4/SOCKS5 сохраняются как отдельные протоколы. Для адресов без указанного
протокола проверяются HTTP CONNECT, SOCKS4 и SOCKS5.
