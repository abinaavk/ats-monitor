# monitor
## Settings and device security

Settings includes profile, appearance and registered-device controls. Standard sessions expire after 10 minutes; password-confirmed trusted devices authenticate persistently for up to 30 days, with individual and all-other-device revocation. See [deployment, migration and security behavior](docs/settings-devices.md) before upgrading: HTTPS and persistent private storage for `ATS_SECURITY_DB` are required, and existing sessions need one fresh login.
