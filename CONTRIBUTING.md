# Contributing to Country Proxy

Bug reports, documentation corrections and focused pull requests are welcome in
English or Russian. For help or feature requests, start with
[Support](.github/SUPPORT.md). For a possible vulnerability, follow
[Security](.github/SECURITY.md) before opening a public report.

The extension UI and detailed engineering guide are currently in Russian.
[Русское руководство разработчика](docs/contributing-ru.md) contains the browser
harness commands, installation lifecycle, acceptance criteria and evidence limits.

## Work in a separate checkout

Read [AGENTS.md](AGENTS.md), [architecture](docs/architecture.md) and the
[check contract](project-checks.json). Extension code is in `extension/`, the
Python helper in `native/`, and tests in `tests/`. Use a short branch from current
`main`. Keep development separate from the installed folder used by your regular
Chrome: changed Python files can run on the helper's next start.

## Run the offline contract

Use Python 3.11+ and Node 24 LTS. No pip installation, Chrome launch or public
proxy access is needed for these unit and structure checks. Run from the repo root,
using your actual supported Python command (for example `python3.14` if `python3`
is an older system interpreter):

```sh
python3 scripts/check.py --list
```

Read the commands and their permissions in `project-checks.json`, then run:

```sh
python3 scripts/check.py --execute-reviewed <reviewed-digest-from-list>
```

`--list` does not execute checks. Review a changed contract before approving its
new digest. When that contract changes, review and update the same literal digest
in both `.github/workflows/checks.yml` and `.github/workflows/release-draft.yml`;
do not compute approval dynamically in a workflow.

The runner filters environment/output and enforces timeouts; it is not an OS or
network sandbox. The checked-in contract is offline. Network or write-enabled
checks need the runner's explicit acknowledgements and a separately appropriate
test environment.

## Scope the evidence to the change

Describe the concrete before/after behavior. Include a regression for a behavior
fix and update affected docs and the CHANGELOG when relevant. Routing, browser
probes, session and reserve changes require applicable isolated Chrome for Testing
scenarios; installer/dependency/storage changes require applicable installation,
update and rollback checks. See the [release acceptance matrix](docs/releases.md)
and [detailed guide](docs/contributing-ru.md). Documentation-only changes do not
automatically require new public-proxy or soak runs.

Use an isolated test profile and its exact helper registration; never use a
personal browser profile for a harness. Keep PASS, PARTIAL and INCONCLUSIVE
separate. A controlled fixture proves its mechanism, not public proxy availability,
country coverage or uptime. State what you did not test.

In a PR, include commands, outcomes, relevant versions and limitations. Share short
sanitized summaries, not raw NetLogs, profiles, IP addresses, full request URLs,
credentials or page contents. Keep raw evidence in ignored `.runtime/` locally.
Do not attach screenshots containing these details.

Review and CI do not publish a release or update an installed browser. Version,
tag, release assets and publication follow the separate
[release procedure](docs/releases.md).
