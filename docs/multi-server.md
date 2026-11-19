# Multi-server Monitor

Install the matching ATS multi-server change first and follow its
[`docs/multi-server.md`](https://github.com/abinaavk/ats/blob/feat/multi-server-control/docs/multi-server.md)
for private registry ownership, operator TLS routing, pairing and explicit GitHub
repository mappings. No production deployment or restart is performed by this PR.

Set `ATS_MODULE_DIR` to the installed ATS checkout and `ATS_CLUSTER_DB` to the
same private Local registry used by the primary ATS CLI. A configured registry
requires `X-ATS-Target` for every host read or operation; unknown or offline
servers never fall back to Local. Existing unconfigured legacy clients retain
their old Local routes until the operator enables the registry. The browser UI
requires primary Local setup to enable its target selector.

Settings → Servers pairs named Global IDs with verified HTTPS API origins and
private credentials, and supports disconnect, reconnect and revocation. The
selector is shared by Overview, Manage, Docker, Logs, Database, Metrics, Stats,
Audit, Terminal and host settings/jobs. It persists the server ID and tab,
reloads when changing targets, and clears prior views, dialogs and sessions.
Long operations remain detached on their originating host; switch back to see
their status and logs. Browser account/device/session settings remain centralized.

On Global, set `ATS_MONITOR_ADAPTER` to `remote_host.py` and `ATS_CLI` to that
host's ATS CLI. Install the normal Monitor Python dependencies in the ATS Python
environment. The adapter is a private subprocess with JSON on stdin/stdout; it
does not run a public Monitor server or expose its browser authentication routes.
It dispatches only the existing host route allowlist after the ATS HTTPS API has
verified the request. Existing route validators, service locks and detached jobs
are reused. Do not publish this adapter through CGI or another executable gateway.

Global terminal/Docker exec sessions are currently unavailable capabilities.
The UI says so, and Local socket handlers reject a remote target ID. Browser
sessions and device trust retain the existing authentication and expiry behavior.

Settings polish from Monitor PR #15 is reused from main. Review this change
against main; the existing Settings, Themes, Devices and session behavior is
preserved. Recheck the exact head and base before merging this change.

## Validation

Run `python3 -m unittest discover -s tests`. Remote integration uses temporary
trusted TLS certificates and existing routes with fake ATS/Docker/system tools.
`tests/browser_servers.py` uses Playwright and temporary Local/Global fixtures;
set `BROWSER_EXECUTABLE` to an existing Chromium if needed. It checks all four
themes at phone/tablet/desktop widths, target headers across host tabs, delayed
response isolation, credential-free web storage, and remote terminal rejection.
Production hosts, Cloudflare/GitHub setup and real webhook deliveries are not
covered by fixture validation.
