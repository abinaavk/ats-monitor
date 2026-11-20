# ATS Monitor

Server monitoring and service management dashboard.

For Terminal and Docker Shell support, use the single-worker WebSocket server
configuration in [the deployment guide](docs/terminal-server.md). Generic ATS
Python worker settings are not suitable for this Socket.IO application.

For the required ATS transport module and custom installation paths, see
[the multi-server setup guide](docs/multi-server.md#startup-dependency-and-non-sibling-installations).

## Settings and device security

Settings includes profile, appearance and registered-device controls. Standard sessions expire after 10 minutes; password-confirmed trusted devices authenticate persistently for up to 30 days, with individual and all-other-device revocation. See [deployment, migration and security behavior](docs/settings-devices.md) before upgrading: HTTPS and persistent private storage for `ATS_SECURITY_DB` are required, and existing sessions need one fresh login.
