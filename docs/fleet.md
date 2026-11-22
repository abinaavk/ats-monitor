# Fleet panel (Settings → Servers)

The Servers page is the control point for every Global. It needs ATS from the same release on the Local; an older ATS makes
individual features answer "Update ATS on this Local server" instead of failing.

| Piece | What it does |
| --- | --- |
| **Fleet overview** | CPU, memory, fullest disk, uptime and ATS version for every server, from the ATS daemon's one-minute checks. *Check now* probes immediately and saves nothing. On phones each server is a stacked card. |
| **Update** | Shown beside a Global whose ATS commit differs from this Local. Fast-forward only, refused for a dirty checkout, checked before it is kept, rolled back on failure, then ATS restarts there. |
| **Rotate key** | New key created on the Global over the signed channel, verified, then saved here. The old key works for 10 more minutes. |
| **Pair with a one-time code** | Enter the Global's address and the code from `server pair-code`; no key is pasted. |
| **Webhook mappings** | Create (secret shown once with the GitHub payload URL), Test (signed ping through the real checks; never deploys) and Delete. |
| **Alerts** | ntfy, Telegram or webhook; thresholds for failed checks, disk and memory; *Send test* per channel. Tokens are masked and never returned to the browser. |
| **Registry backup** | Status of the daily backup, *Back up now* with an optional passphrase. Backups stay on the server and are restored only with the CLI. |

Manage → Settings → Cloudflare → *Edit config file* lists earlier versions of the tunnel config under *Restore an earlier version*;
a restore is validated like an edit and the current file is backed up first.

## Audit trail

Settings → Devices → Security activity shows which device did what on which server: `service_*`, `package_installed`,
`tunnel_config_edited/restored`, `terminal_opened`, `server_updated`, `server_key_rotated`, `webhook_mapping_*`, `alerts_changed`,
`registry_backup_created`. Only the server and the name acted on are recorded; request bodies, keystrokes, terminal output and secrets
never are. Failed attempts say `failed (HTTP n)`.

## API (all Local-only; changes need the anti-CSRF token)

`GET /api/fleet`, `POST /api/fleet/refresh`, `POST /api/servers/<id>/update|rotate|mappings`, `POST /api/servers/pair-code`,
`DELETE /api/mappings/<owner>/<repo>`, `POST /api/mappings/<owner>/<repo>/test`, `GET|PUT /api/alerts`, `POST /api/alerts/test`,
`GET|POST /api/registry-backup`, `GET /api/manage/cloudflare/backups`, `POST /api/manage/cloudflare/restore`.
