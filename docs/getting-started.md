# Getting started

[Overview](../README.md) · [Русское руководство](README.ru.md) ·
[Support](../.github/SUPPORT.md) · [Security](../.github/SECURITY.md)

Country Proxy is a manually installed Chrome extension plus a local Python
helper. The interface is Russian. This guide covers the supported macOS path
and the critical controls in English. Check [GitHub Releases](https://github.com/Nelmad/country-proxy/releases)
for published assets; the release-asset steps apply when an asset is available.

## Decide whether it fits

Use it for occasional public-page or country-routing experiments in a separate
Chrome profile without personal accounts. Public proxies are run by third
parties. HTTPS and country checks test connectivity, certificates, and a GeoIP
observation; they do not establish operator trust, anonymity, or a no-logging
policy. Use a trusted connection for sensitive activity. Plain HTTP to a
destination is unencrypted; HTTPS alone is not an endorsement of a public proxy.

The route changes for the **entire chosen Chrome profile**. While searching,
checking a candidate, recovering, or missing its helper, Country Proxy blocks
new ordinary HTTP/HTTPS requests, including requests from existing tabs and to
localhost. It cannot recall previously sent traffic or existing connections.
It does not change the system proxy or route the whole OS. Read
[Stop and recover](#stop-and-recover) before connecting.

Requirements and limits:

- macOS, a regular Chrome profile, and Python 3.11+ installed separately.
- Chrome 120+ is the code minimum. Acceptance used macOS 26.6.2 / Apple Silicon,
  Chrome for Testing 151.0.7922.34, and Python 3.14.7. Those results do not certify
  every older allowed version or a downloaded archive's Gatekeeper dialog.
- Linux has an installer but has not completed full browser acceptance.
  Windows and Incognito are unsupported.
- No Chrome Web Store package, automatic updates, or Python-free bundle.
  Node and Playwright are development tools, not user requirements.
- No Country Proxy account or API key is required. Free public-proxy supply
  and access to any particular site are not guaranteed.

## Install on macOS

1. On [GitHub Releases](https://github.com/Nelmad/country-proxy/releases), choose
   a published version and download **both** `country-proxy-X.Y.Z.zip` and
   `country-proxy-X.Y.Z.zip.sha256`. Replace `X.Y.Z` below with that version.
   GitHub's automatic **Source code (zip)** is a different archive. If there
   is no published asset, a checkout or local candidate is unreleased software.
2. In Terminal, change to the folder containing both downloads and check:

   ```sh
   shasum -a 256 -c country-proxy-X.Y.Z.zip.sha256
   ```

   Continue only if the archive reports `OK`. This checks the pair matches;
   you must also trust the source of both files. Extract the bundle into a
   **permanent folder** you will keep at the same path.
3. Run `Install.command` from that folder. It requires an installed Python
   3.11+, creates `.venv`, downloads the pinned dependencies, and registers the
   local Native Messaging helper for regular Google Chrome. It prints the
   registration and history paths. It does not change the system proxy or
   install a continuously running service. An alternative, from the bundle
   folder, is:

   ```sh
   python3 scripts/install.py
   ```

   Use the command for your installed Python 3.11+ if `python3` is older—for
   example, `python3.14 scripts/install.py`. Do not replace the system Python.
   Keep the folder in place: the helper registration uses an absolute path.
4. Open `chrome://extensions` in the intended Chrome profile. Enable
   **Developer mode**, click **Load unpacked**, and select the bundle's
   `extension` folder. Install the helper and extension from the **same bundle**.
   Pin Country Proxy using Chrome's extension menu. A terminal need not stay open.
5. Open Country Proxy and select a country as described below. A first install
   has no selected country. Wait for **Подключено** (connected), then load a
   public test page. Finish by clicking **Отключить** (Stop) and check that your
   normal route returns.

For an isolated Chrome for Testing installation, pass both the exact
`--profile` user-data-dir root and a separate `--data-dir` history directory to
the installer. The installer does not launch that browser. See the
[detailed installation guide (Russian)](installation.md#отдельный-chrome-for-testing).

## Select countries and read the result

The country catalog has 249 countries and territories. Search accepts Russian
or English names and ISO codes such as `JP`. The catalog describes selectable
codes, **not live availability**. Typing a search does not connect.

| Russian control | Meaning |
| --- | --- |
| **Одна страна** | Single country: clicking a country starts searching immediately. |
| **Несколько стран** | Multiple countries: edit an unordered allowed set. |
| **Подключить выбранные** | Apply and connect the selected set. |
| **Сохранённые группы** | Named groups; editing/saving does not connect until explicitly applied. |
| **Найти другой** | Find another proxy manually. |
| **Диагностика резерва** | Reserve search stage and candidate rejection reasons. |
| **Вклад источников** | Source contribution report; its country selector changes the report only. |
| **Отключить** | Stop and release Country Proxy's settings. |

A set such as EE / NO / PL has no ordering or preferred country. The first
acceptable checked address can win; the current exit receives no country
priority. A healthy address stays in use, with no periodic rotation timer.
The popup shows the allowed set separately from the measured exit country.
Favorites and group edits do not change the connection by themselves.

**Подключено** means Chrome confirmed its route after the helper passed HTTPS
and country checks. The displayed exit IP is then browser-confirmed. During
**Проверяем в Chrome** (checking in Chrome), it is still a helper result and
ordinary page requests remain blocked. The helper prepares up to two reserves
for the whole set; the browser checks a reserve when it is selected for use.
Empty reserves or no acceptable address are possible. Search retries
automatically and can remain blocked until you stop or an address is found.

After connection, reload a page that was blocked if it does not retry itself.
Country Proxy does not save blocked requests or automatically resubmit forms.

## Stop and recover

These steps work even when web pages cannot load:

1. Open Country Proxy and click **Отключить** (Stop). If it says
   **Отключение не завершено** (Stop incomplete), click **Повторить отключение**
   (retry Stop). A browser restart also retries interrupted cleanup.
2. Wait for **Отключено** (off). This means Country Proxy released its own
   proxy, request-blocking, and privacy settings. Another extension's proxy,
   a policy, or the system proxy may still apply.
3. If the popup does not work, open `chrome://extensions` and **turn off Country
   Proxy**. Chrome suspends its request blocking and releases its proxy/privacy
   settings. You do not need to remove the extension or delete the profile.

| Symptom | Next step |
| --- | --- |
| **Рабочих адресов пока нет** (no working addresses yet) | Wait for retry, select a different country/set, or Stop. The catalog is not a supply guarantee. |
| **Нужен локальный помощник** (local helper needed) | Stop, then rerun the installer from the permanent bundle folder. Check the printed registration path. Both install steps are required. |
| Helper incompatibility | Stop and update both parts from one complete bundle, then Reload in `chrome://extensions`. |
| **Проверяем в Chrome** / `ERR_BLOCKED_BY_CLIENT` | Ordinary requests are held pending browser confirmation. Wait for connected, or Stop. Reload the page after connection. |
| One website fails while connected | The probe sites do not establish access to every destination. Try **Найти другой** or Stop. |
| Another extension/policy controls the proxy | Use a separate profile or resolve that conflict. Country Proxy keeps its own request gate closed until Stop and does not overwrite the other owner's settings. |

For further help, use [Support](../.github/SUPPORT.md). Include a minimal
reproduction and visible status, not a browser profile, personal IP, credentials,
page content, or raw logs. The [Russian runbook](runbook.md) has detailed
diagnostics and local-history maintenance.

## Update, rollback, and remove

There is no automatic GitHub update. Keep the previous complete ZIP/checksum
and read the new release notes before updating.

1. Click **Отключить**, wait for **Отключено**, and temporarily turn off the
   extension in `chrome://extensions`. Do **not** remove it.
2. Verify and extract the new ZIP separately. Back up the current installed
   bundle. In the **same permanent folder**, replace all shipped files with
   the complete new bundle, preserving `.venv`, `.runtime`, and your own files.
   Do not overlay a developer checkout with unsaved edits or mix versions.
3. Run the installer again from that permanent folder to update dependencies
   and helper registration. Turn the extension on and click **Reload**.
4. Check the displayed version, countries, favorites, connection, and Stop.
   Keeping the extension and its stable ID preserves profile settings; reserves
   are rebuilt. Follow release-specific migration instructions if present.

To roll back, **Stop before replacing files** so request-blocking rules are
cleared. Restore the complete earlier bundle at the same path, run its
installer, and Reload. Before returning to an old version without country
groups, select one country and Stop. Older launchers and version 0.2.0 have
additional preparation steps: follow the
[rollback procedure (Russian)](installation.md#откат) before proceeding.
If already rolled back without Stop and pages remain blocked, restore the
complete newer bundle with the same extension ID, Stop, then repeat rollback.

Moving the folder requires a registration-path migration; rerunning another
copy does not silently replace an existing registration. See
[moved folder recovery (Russian)](installation.md#если-папка-уже-перемещена).

To uninstall, Stop, remove Country Proxy in `chrome://extensions`, and remove
only its `local.country_proxy.json` registration from
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`.
Then delete the application folder if no longer needed. That also removes its
`.venv` and ordinary `.runtime/data` helper history. A custom `--data-dir`
is outside that folder and must be considered separately; another profile may
share it. Leave other registrations and browser/system settings alone.

## Data and permissions

- **Local settings:** the extension uses `chrome.storage.local` for country
  selection, favorites, groups, enabled/off intent, and current status.
  Group export is a user-created JSON file of names and countries.
- **Local helper history:** candidate outcomes are retained locally for
  temporary skipping and expire automatically. The default is
  `.runtime/data/<profile-key>` inside the installation. Profiles under the
  same Chrome user-data-dir/helper registration can share that history;
  their country settings remain separate. The helper is launched by Chrome
  over Native Messaging, not a browser-traffic relay or HTTP control server.
- **Network activity:** the helper fetches candidate lists from
  [public sources](sources.md). Candidate and health checks contact Cloudflare
  and Google through proxies; Cloudflare supplies the observed exit IP/country.
  Chrome checks those HTTPS destinations too. Your actual browsing uses the
  selected public proxy. Checks do not certify the proxy operator's behavior.
- **Permissions:** `proxy` applies the profile route; `nativeMessaging`
  communicates with the helper; `storage` keeps local state; `alarms` supports
  reconnection. `declarativeNetRequest` holds new ordinary requests pending
  confirmation. Host permissions are limited to the two HTTPS probe hosts;
  the extension does not request access to every page's content.
- **`privacy`:** while applying its route, Country Proxy disables non-proxied
  WebRTC UDP and Chrome network prediction for the regular profile. Stop
  clears its own layer of these settings. These controls are not a promise
  of anonymity or routing of all traffic.

The [architecture](architecture.md), [verification results](verification.md),
and [stable scope](stable-readiness.md) provide the engineering details in
Russian. [Third-party notices](../NOTICE) identify the discovery dependency.
