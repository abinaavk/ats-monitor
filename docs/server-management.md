# Server settings and connection state

Install the companion ATS version that includes `Store.update_server` before this Monitor update. Monitor and ATS must use the same primary `ATS_CLUSTER_DB` and the intended ATS checkout via `ATS_MODULE_DIR`.

Settings → Servers shows the saved connection setting separately from a live signed health check. Enabled means the Local registry permits requests; Reachable means the Global answered a health request. Neither proves that every management operation or external tunnel service is healthy.

Global cards support name and HTTPS API origin editing on phones and desktops. Save and verify checks the candidate endpoint with the existing credential before committing either field; failures preserve existing settings. Editing a disconnected server preserves its disconnected state. Revoked servers require pairing again. Local identity remains configured on Local using ATS CLI option 12.

Connection actions use the authenticated Local registry, including when Global is unavailable. Disconnect needs no Global request. Reconnect and revoke need Global connectivity. Errors distinguish those actions. Switching the selected server after a change reloads the document to discard stale target state. Selected service configuration, deployment, backup and runtime options remain under Manage.

Before production rollout, verify health, selected Global service reads and a safe test service setting write end to end. Never use health alone as proof that the Global Monitor adapter is configured. See ATS `docs/persistent-startup.md` for listener startup and the required adapter environment.

## Pasting a pairing file

Both **Pair a Global server** and **Update ID and passkey** accept the whole private pairing file
(`files/pairing.json` on the Global). Paste its contents into the box at the top of the form: the
name, address, ID and passkey fields fill in and the box empties immediately, so the key is not left
on the page. Review the fields, then submit. Nothing is saved until the new credentials verify.

To replace credentials from the Local CLI instead, run
`server replace-credentials --pairing-file FILE`; the saved server is matched by the file's ID,
then address, then name (or pass `--server-id`).

## The Servers page

Settings → Servers shows one card per server with a status badge (Online, Unreachable, Needs attention,
Disconnected, Access revoked, Revocation unconfirmed), the address, a copyable server ID, whether the
Monitor adapter is ready, the last live check and its latency, and the explicit GitHub webhook mappings
for that server (repository → service @ branch; the webhook secret is never shown). The summary line counts
how many Globals are online.

Each card offers the actions that make sense for its state: **Manage this server** (switch the dashboard to it),
**Test connection** (signed health, adapter readiness and a real service read, each step with its timing and
the reason it failed), **Disconnect**, **Reconnect**, **Pair again** for a revoked server, and expandable
**Edit name and address**, **Update ID and passkey** and a **Danger zone** for revocation. **Add a Global server**
walks through the two commands to run on the Global and accepts the pasted pairing file. A troubleshooting table
explains every message. `GET /api/servers/<id>/test` backs the connection test (read-only, login required).

The Servers page also carries an **Automatic setup on a Global server** guide: what `server setup --apply` does for you (service file,
Cloudflare route, restart, verification, rollback) and what you provide first (a config-file-managed tunnel, its DNS record, an HTTPS API
address, Flask), with copy buttons for the `configure`, `setup --apply --install-monitor` and `doctor` commands. Monitor itself never runs
commands on a Global.

## Webhooks and the central receiver

GitHub deliveries go to the Local's receiver, which accepts a push only for an explicit mapping (repository → server, service, branch)
and forwards it over signed HTTPS to the mapped Global (or updates a Local service directly). Mappings are listed per server on
Settings → Servers (never with their secrets). In Manage → a service → Webhook, **Central receiver** shows whether that service is mapped;
if not, the page shows the command to run on the Local (`server map --from-service NAME`), which reuses the service's existing secret so a GitHub
webhook that already uses the payload URL and secret needs no change. For a Global service use `server map … --generate-secret`.
