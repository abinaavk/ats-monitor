# Manage tab

Manage appears immediately after Overview on desktop and in the phone tab bar.
It calls the ATS CLI through `manage_api.py`; deployment and server operations
belong to ATS rather than a second implementation in the monitor.

## Install together

The monitor change requires the matching ATS version with `--api` support.
Install the ATS review fixes first, then its Manage API change, then this monitor
change. Restart the existing ATS daemon as well as the monitor after upgrading;
headless requests do not launch the webhook listener. Existing monitor tabs keep working if ATS is unavailable; Manage shows
the connection or configuration error.

Configure ATS interactively once on the server before using headless mode. The
existing ATS instance configuration and database remain the source of truth.
Settings changes to the storage root affect future deployments; existing service
paths stay where they are.

Set these environment variables in the monitor's service configuration:

- `ATS_CLI`: executable command for the configured ATS instance. Default:
  `sudo -n python3 /home/gaia/ats/app.py`. The bridge appends `--api <operation>`
  and sends the request JSON over stdin. It never starts a shell.
- `ATS_MONITOR_JOBS_DIR`: optional private, persistent directory owned by the
  monitor user, for example `/var/lib/ats-monitor/jobs`. If omitted it uses a
  private directory under the system temp directory. Persistent storage keeps
  job history across machine reboots; detached jobs survive a monitor restart.

ATS requires root. If the monitor runs as another user, configure a root-owned
launcher for the intended ATS instance and a narrowly scoped noninteractive sudo
rule for that launcher. The launcher, ATS source, and every parent directory must
be protected from modification by the monitor user. Avoid granting general
passwordless Python or shell access. Configure instance variables such as
`ATS_CONFIG_FILE` in that launcher, since sudo may remove environment variables.
The monitor's existing login protects the management endpoints; management access
allows server changes and must be restricted to trusted administrators.

## Supported controls

Select a service to view its status, resources, configuration, logs, backups,
git details and webhook settings. Start, stop, restart, update, redeploy and delete
are available there. Deploy offers Python, Node or optional Docker. CPU, memory,
workers, ports, branches, environment variables and domains can be edited with
server validation. Saved domains and resource defaults are in Settings, along
with Cloudflare status, route synchronization and restart controls.

Long operations run as detached jobs. Closing a dialog or refreshing the page
does not cancel a job. The same service cannot start overlapping jobs. Failed
operations show the ATS error and progress log. Job history expires after 24 hours.

Docker is optional. A Docker deployment needs a Dockerfile in the repository
and Docker access for the configured service user. Compose deployment is not
supported. Systemd owns the container lifecycle; webhook updates rebuild the
image before restarting the service.

## GitHub webhook setup

For each service, open **Git & Webhook** and copy its URL and secret into the
repository's GitHub webhook settings. Use `application/json` and push events.
Only pushes to the configured branch update the service. Rotating a secret
requires updating GitHub immediately. Existing unsigned webhooks stop working
after the ATS security fixes; use each service's newly generated secret.

The listener binds to loopback and is reached through the Cloudflare tunnel.
Use the Cloudflare panel to inspect route state. Sync preserves unrelated routes and the catch-all. Unowned hostnames need manual
review; the current ATS API does not automatically delete them.

## Validation and limitations

The bridge tests use a stub CLI. Browser flows exercise the real Flask bridge
with a deterministic fake ATS CLI, on desktop and phone viewports. These checks
do not verify the host's systemd, Docker daemon, Cloudflare tunnel, Google Drive
credentials or real GitHub deliveries. After installation, verify those on the
server using a disposable service before managing production services.
