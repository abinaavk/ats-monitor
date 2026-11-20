# Server settings and connection state

Install the companion ATS version that includes `Store.update_server` before this Monitor update. Monitor and ATS must use the same primary `ATS_CLUSTER_DB` and the intended ATS checkout via `ATS_MODULE_DIR`.

Settings → Servers shows the saved connection setting separately from a live signed health check. Enabled means the Local registry permits requests; Reachable means the Global answered a health request. Neither proves that every management operation or external tunnel service is healthy.

Global cards support name and HTTPS API origin editing on phones and desktops. Save and verify checks the candidate endpoint with the existing credential before committing either field; failures preserve existing settings. Editing a disconnected server preserves its disconnected state. Revoked servers require pairing again. Local identity remains configured on Local using ATS CLI option 12.

Connection actions use the authenticated Local registry, including when Global is unavailable. Disconnect needs no Global request. Reconnect and revoke need Global connectivity. Errors distinguish those actions. Switching the selected server after a change reloads the document to discard stale target state. Selected service configuration, deployment, backup and runtime options remain under Manage.

Before production rollout, verify health, selected Global service reads and a safe test service setting write end to end. Never use health alone as proof that the Global Monitor adapter is configured. See ATS `docs/persistent-startup.md` for listener startup and the required adapter environment.
