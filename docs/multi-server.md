# Multi-server Monitor

Install the matching ATS multi-server change first and follow its
[`docs/multi-server.md`](https://github.com/abinaavk/ats/blob/main/docs/multi-server.md)
for private registry ownership, operator TLS routing, pairing and explicit GitHub
repository mappings. No production deployment or restart is performed by this PR.

Set `ATS_MODULE_DIR` to the installed ATS checkout and `ATS_CLUSTER_DB` to the
same private Local registry used by the primary ATS CLI. A configured registry
requires `X-ATS-Target` for every host read or operation; unknown or offline
servers never fall back to Local. Existing unconfigured legacy clients retain
their old Local routes until the operator enables the registry. The browser UI
requires primary Local setup to enable its target selector.

## Startup dependency and non-sibling installations

`ats_cluster.py` is supplied by the ATS repository, not by Monitor's pip
requirements. For example, if Monitor is `/opt/api/monitor/app.py` and ATS is
`/ats/app.py`, the required module is `/ats/ats_cluster.py`. Set this in the
**Monitor service environment**, not only in an interactive shell:

```ini
Environment="ATS_MODULE_DIR=/ats"
```

Use the actual installed ATS path. Confirm it contains `ats_cluster.py` from the
multi-server ATS release. With the service's Python interpreter and user, verify
before an operator-approved restart:

```sh
cd /opt/api/monitor
ATS_MODULE_DIR=/ats /path/to/monitor/venv/bin/python -c 'import cluster_support; print(cluster_support.Store.__module__)'
```

If the file is absent, update the ATS checkout to the matching multi-server
release first. Do not install an unrelated similarly named pip package or copy
one module out of an older checkout. Merge approval does not authorize a service
restart or production update.

An explicit `ATS_MODULE_DIR` takes priority. Otherwise Monitor uses the directory
of an absolute Python script in `ATS_CLI` (without executing the command), then,
when `ATS_CLI` is unset, the sibling `ats` checkout or the existing default CLI
location `/home/gaia/ats`. An explicit invalid path fails with setup guidance;
it never falls back to another ATS installation. For wrapper/module commands,
set `ATS_MODULE_DIR` explicitly. Relative script paths also require it.

Settings → Servers pairs named Global IDs with verified HTTPS API origins and
private credentials, and supports disconnect, reconnect and revocation. The
selector is shared by Overview, Manage, Docker, Logs, Database, Metrics, Stats,
Audit, Terminal and host settings/jobs. It persists the server ID and tab,
reloads when changing targets, and clears prior views, dialogs and sessions.
Long operations remain detached on their originating host; switch back to see
their status and logs. Browser account/device/session settings remain centralized.

On Global, set `ATS_MONITOR_ADAPTER` to `remote_host.py` and `ATS_CLI` to that
host's ATS CLI (`server setup --apply` does this). The adapter runs **headless**: the Global's
Python needs only Flask (and optionally `psutil`), see `requirements-adapter.txt`; Socket.IO and
gevent are for the browser-facing Local Monitor only. Prove an installation with
`python remote_host.py --check` using the daemon's interpreter and environment: it prints a
JSON report naming any missing module or unusable setting, and exits 2 on a problem. The adapter is a private subprocess with JSON on stdin/stdout; it
does not run a public Monitor server or expose its browser authentication routes.
It dispatches only the existing host route allowlist after the ATS HTTPS API has
verified the request. Existing route validators, service locks and detached jobs
are reused. Do not publish this adapter through CGI or another executable gateway.

Terminal and Docker shell sessions on a Global are relayed over the signed channel (`remote_terminal.py`): the browser
keeps its Socket.IO connection to this Monitor, which opens, polls and writes to a session on that Global. Failures are
shown in the terminal itself (disconnected or revoked server, wrong passkey, terminal disabled or too old on the Global).
The Global's shell runs as its ATS service user, not root. Browser
sessions and device trust retain the existing authentication and expiry behavior.

Settings polish from Monitor PR #15 is reused from main. Review this change
against main; the existing Settings, Themes, Devices and session behavior is
preserved. Recheck the exact head and base before merging this change.

## Diagnosing a Global

Failures from a selected or paired Global say what went wrong instead of "unavailable":
wrong ID or passkey, clock skew between the servers, a Cloudflare block, a missing tunnel
route, a stopped daemon or tunnel, DNS or TLS problems, or a missing adapter module. The reason
is also written to the Monitor log (no credentials). On either server `server doctor` (in the ATS
checkout) runs the same checks end to end and prints the fix for each.

Every operation error on a Global (not found, validation, a job already running) now reaches
Monitor with its real status and message; earlier versions reported them as an adapter outage.

## Validation

Run `python3 -m unittest discover -s tests`. Remote integration uses temporary
trusted TLS certificates and existing routes with fake ATS/Docker/system tools.
`tests/browser_servers.py` uses Playwright and temporary Local/Global fixtures;
set `BROWSER_EXECUTABLE` to an existing Chromium if needed. It checks all four
themes at phone/tablet/desktop widths, target headers across host tabs, delayed
response isolation, credential-free web storage, and that a remote target never receives a local shell.
Production hosts, Cloudflare/GitHub setup and real webhook deliveries are not
covered by fixture validation.
