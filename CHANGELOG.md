# Changelog

User-facing changes by version. [Русское руководство](docs/README.ru.md) ·
[Verification and limits](docs/verification.md) · [Release process](docs/releases.md)

Dated entries record preparation. Publishing a version is a separate step;
see [GitHub Releases](https://github.com/Nelmad/country-proxy/releases) for
published assets and the [release process](docs/releases.md) for preparation status.

## [1.0.1] - 2026-11-22

### Connection, status and recovery

- Keep special local destinations blocked while connected: localhost names,
  loopback, link-local and unspecified address literals, including Chrome-normalized
  IPv4/IPv6 forms. This URL guard does not classify arbitrary DNS names by private IP.
- Require safe effective WebRTC and network-prediction settings, watch changes,
  and revoke ordinary traffic before waiting for helper shutdown. A proxy-owner
  conflict observed during startup requires an explicit retry even if control
  becomes available before restoration finishes.
- Revoke traffic on an explicit outside-country health result and require fresh
  Chrome proof before reopening, including for the same address. Preserve a
  completed outside-country HTTPS result when the other probe fails first;
  an unfinished probe does not delay failure reporting.
- Withdraw the popup's connected/current-exit display when the effective route,
  country proof or traffic admission no longer matches, including failed reads.
  Keep Stop available without changing saved preferences or connection state.
- Recover catalogue/preferences initialization on an explicit retry after startup
  storage errors. Accept Stop during startup without restoring saved intent;
  keep retry Stop available after cleanup and diagnostic-storage failures.
  Newer commands still supersede failed attempts.
- Revoke withdrawn offers without waiting for reserve statistics to save. When
  successful health changes the active host or exit, reconcile and publish the
  reserve immediately while preserving independent reserves. Apply failed-host
  cooldown before endpoint quarantine removes its lease, preventing other ports
  on that host from immediately refilling the pool.
- Announce meaningful recovery/detail changes without repeating progress
  counters; mark the selected country explicitly in the single-country picker.

### Installation, validation and delivery

- Verify runtime and build dependency downloads with hashes, build the upstream
  helper in a disposable isolated environment, and check the installed graph.
- Share the package inventory with clean ZIP extraction; include license files
  and dependency locks in installation and upgrade acceptance. Require expected
  ZIP identity before clean-install execution and fail acceptance on product errors.
- Exercise the generated native launcher against ambient Python path injection
  using a real owned test venv and a positive control without isolation. Validate
  documentation section links as well as file paths.
- Clarify privacy/DNS and recovery limits, dated evidence, and release steps.
  Protect main/tags and future releases; add bounded dependency-update proposals.

[Verification and limits](docs/verification.md#current-candidate) records the
dated local acceptance. Controlled fixtures establish the tested recovery
behavior, not the availability or uptime of public proxies.

## [1.0.0] - 2026-11-17

First stable package for manual macOS installation. Published assets and status:
[GitHub Releases](https://github.com/Nelmad/country-proxy/releases).
A source checkout is not itself a release. The date records package preparation;
[verification](docs/verification.md) records the dated local acceptance and limits.

### Country selection and use

- Choose any country in the 249-entry searchable catalog, or an unordered set
  of equally allowed countries. The catalog does not promise live proxies.
  Favorites are separate from the allowed set; no country is selected on first install.
- Save named groups before or after connecting, edit them without changing the
  active route, and transfer names/countries through JSON export/import.
- Discover and check public proxies automatically, confirm the route in Chrome,
  keep a healthy address, and recover within the selected set after failure.
  There is no periodic rotation timer or preferred country within a group.
- See the actual browser-confirmed exit, source contribution, reserve search
  progress, and reasons candidates or reserves were rejected.

### Connection and recovery

- New ordinary profile HTTP/HTTPS requests are held until Chrome confirms the
  candidate, including during search, restart, and replacement. This adds the
  `declarativeNetRequest` permission. Stop releases Country Proxy's settings.
- Up to two distinct reserves are prepared for the entire set. Parallel reserve
  checks and fresh discovery avoid waiting for one failed candidate; local
  outcome history temporarily skips repeated failures and expires automatically.
- HTTPS certificates, both probe services, and an allowed exit country remain
  mandatory. Bound retries do not turn TLS, HTTP, or country failures into success.
- Concurrent favorites edits are merged instead of overwriting another window's
  changes. Interrupted Stop can be retried; stale results cannot restore an old route.
- Cold-start route errors leave the popup and favorites available. A valid saved
  selection can be retried explicitly; invalid saved intent requires reselection.
- Python 3.11 helper shutdown and restart preserve cancellation when a wake
  completes at the same time. Checks keep their existing deadlines and cleanup.

### Installation and documentation

- `Install.command` forwards isolated-profile/history arguments and recognizes
  installed versioned Python commands. The extension and helper ship together.
- English setup/recovery and contributor entry points accompany the Russian
  interface and detailed operating guides. Support and security policies explain
  reporting routes and what private data to avoid publishing.
- MIT License and third-party NOTICE are included in the bundle. Reproducible
  packaging records source hashes and a ZIP checksum; validation and draft-release
  workflows do not publish automatically.

### Scope and limits

The supported first-stable path is manual installation on macOS, a regular Chrome
profile, and Python 3.11+. Browser acceptance uses the exact Chrome for Testing
configuration in [verification](docs/verification.md), not all allowed versions.
Linux has an installer but lacks full browser acceptance. Windows, Incognito,
Chrome Web Store distribution, automatic updates, and Python-free setup are outside
this release. Hosted CI and downloaded-archive Gatekeeper/system-picker behavior
are not claimed as tested here.

Public-proxy availability, speed, country coverage, recovery time, and access to a
particular website are not guaranteed. Controlled tests and public observations
are reported separately. HTTPS checks are not operator-trust, anonymity, or
no-logging certifications. Use a trusted connection for sensitive activity.

### Upgrade and rollback

Stop first, preserve the installed extension/ID and permanent folder, replace the
complete bundle, rerun its installer, then Reload in `chrome://extensions`.
Do not mix helper and extension versions. Back up the old complete bundle and
check any release-specific migration requirements.

Stop before rollback so request-blocking rules are cleared. Before returning to
an older version without groups, select one country and Stop. Version 0.2.0 and
older launchers require the additional preparation in the
[rollback procedure](docs/installation.md#откат). Restore the complete earlier
bundle with its dependencies; do not delete the Chrome profile to roll back.

## [0.2.0] - 2026-10-29

Код опубликован в main, commit
[8a1ab49](https://github.com/Nelmad/country-proxy/commit/8a1ab4954ef8ec633fdd93df2ab37eb70ab79c48).
На момент оформления этого changelog отдельный GitHub Release не создавался;
эта дата — дата публикации кода.

- До двух резервов выбранной страны, фоновые проверки, TTL и повторная проверка перед заменой.
- Счётчик резерва в popup; host/exitIp должны отличаться от основного адреса.
- Расширенные публичные источники и HTTPS proxy transport.
- Защита от позднего health-статуса/rotate; проверка реально исполняемых scripts в тестовом Chrome.
- 46 unit-тестов и structural checks; стенды fresh/saved profile с резервом прошли.
  Успешная публичная пара NO этим не подтверждена.

## [0.1.0] - 2026-10-27

Первый публичный код, commit
[70f0add](https://github.com/Nelmad/country-proxy/commit/70f0add525943f654faa747424fe77da3c4c587d).

- Настраиваемый список стран, поиск/HTTPS/GeoIP-проверка и подключение из Chrome.
- Native Messaging helper, автоматическая замена и повторный поиск.
- Блокировка прямого выхода при поиске; освобождение настроек при отключении.
- Установщик Mac/Linux, первые live NO/EE/AT проверки и восстановление helper.
