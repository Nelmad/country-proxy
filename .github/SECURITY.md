# Security

Security fixes target the latest published release; older releases and development
snapshots have no separate maintenance promise. Before the first published
release, there is no released version to support. See
[Releases](https://github.com/Nelmad/country-proxy/releases) for actual releases.
The first stable scope is manual installation on macOS with an ordinary Chrome
profile, an unpacked extension and its matching local Python helper.

Public proxy operators are untrusted third parties. Passing HTTPS and country
checks does not establish operator trust, anonymity, a no-logging policy or access
to any particular site. This project does not provide an OS-wide VPN. Prefer a
separate profile without personal accounts for evaluation.

## Reporting a possible vulnerability

Do not post exploit details, credentials, private data or raw logs in a public
issue or PR. Use **Report a vulnerability** on the repository's
[Security advisories page](https://github.com/Nelmad/country-proxy/security/advisories)
if GitHub offers that button. Its availability depends on the repository setting;
this document does not assert that private reporting is enabled.

If no private-report button is available, open a
[blank public issue](https://github.com/Nelmad/country-proxy/issues/new) titled
**Request for a private security contact**. Include only the affected version and
“I would like a private reporting route.” Wait for an agreed private route before
sharing technical details. There is no dedicated security email or guaranteed
response deadline advertised here.

Once a private route is established, a small synthetic reproduction, affected
version, expected/actual security boundary and impact are useful. Keep secrets,
personal browsing data and unrelated logs out of the report even then. Test only
systems and data you are authorized to use.
