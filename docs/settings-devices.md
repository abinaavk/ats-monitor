# Settings and device security

Settings centralizes General, Account, Security, Appearance and Devices. The four existing themes and their localStorage keys are preserved. The shared administrator account remains the authorization boundary: every password-authenticated device has administrator privileges. Display name is a shared profile label, not a new account or username.

## Deployment and migration

- HTTPS is required in production. Cookies default to Secure, HttpOnly and SameSite=Lax, scoped to the host and `/`. `ATS_COOKIE_SECURE=false` is exclusively for local HTTP development.
- The first start creates an additive, independent SQLite registry at `instance/security.sqlite3` (or `ATS_SECURITY_DB=/persistent/private/path/security.sqlite3`). Keep that directory private, writable by the application user, on persistent local storage and shared by all application workers. The file is created with mode 0600. Do not put it under static assets, a public document root or ephemeral release storage. Back it up securely; it holds password hashes, device hashes and audit metadata.
- A generated Flask signing key and password hash persist in this registry. Existing `SECRET_KEY` overrides the generated key. `ATS_ACCESS_PASSWORD` supplies the initial administrator password; otherwise the existing access password is preserved for compatibility. Changing that environment value after initialization does not change the stored password. Existing host ATS databases and schemas are untouched.
- Existing signed-cookie sessions require one password sign-in after the upgrade. They cannot safely be converted into revocable registered devices because the previous app used a publicly known fallback signing key. The existing password still works. No historical device list existed; records begin with successful sign-ins after this upgrade.
- This feature does not change the server startup requirements described in Terminal PR #12. Its separate merge approval and required single-worker server configuration remain outstanding.

## Authentication and trust

Standard devices must authenticate with the password every 600 seconds, enforced by the server regardless of browser activity or keepalive calls. This makes the requested 10-minute rule authoritative; the previous Flask cookie refreshed during activity and the browser also ran an idle timeout.

Successful password login creates a device record and rotates its session. Two independent random 256-bit credentials identify the browser registration and active session; only SHA-256 digests are stored. Browser attributes and IP addresses never grant access. Device names are descriptive guesses from the User-Agent, not verified hostnames.

Trust is an explicit, password-confirmed action for an already password-registered device. It lasts 30 days, with an absolute expiry, and permits automatic session creation while the device credential is valid. It does not turn off authentication globally. The password is required again to renew trust after expiry. Trusted credentials are bearer secrets: the cookie flags reduce exposure, but a fully compromised browser or stolen complete cookie set can still impersonate a device until revocation/expiry. Hardware-bound or phishing-resistant authentication would require a separate WebAuthn implementation.

Untrusting a device revokes its active sessions and requires password login in Standard mode. Revoking a device also invalidates its registration credential; its next password login creates a new registration. Signing out explicitly removes trust for that browser. “Log out all other devices” revokes their sessions and clears trust so they cannot silently sign back in. These actions affect no unrelated device's session. Open Terminal and Docker shell connections check server state before input and throughout output loops; revoked shells are disconnected and reaped.

Settings mutations require a session-specific CSRF header, same-origin requests and password verification. Password failures are rate-limited (10 failures per observed source IP per 15 minutes). Login has its own CSRF form token. API responses containing account, session or device data are not cached. The existing PWA caches only its offline document.

## Metadata and limits

Device records include inferred browser/version, operating system and type, first login, last active (updated at most every 30 seconds), observed IP, trust expiry and active session count. “Current device” means the current cookie registration; separate browser profiles/private windows create separate records. Authentication and trust status are computed from registry state. An expired record is not proof that a physical device is powered off.

MAC addresses, client hostnames and geolocation are unavailable: no fabricated data and no third-party IP location lookup. IP is `remote_addr`; forwarded headers are deliberately not trusted by default. Behind a proxy this may be the proxy IP. Configure the trusted proxy boundary separately if reliable originating IP reporting is required. User-Agent metadata can be spoofed and is for display only.

Audit history records registration, password and trusted login, failed authentication, profile updates, trust/untrust/revoke and logout events. The Devices panel shows the newest 100 audit entries; records persist in the database. No credential values or password are logged. Operators should set an appropriate database backup and metadata retention policy; this version does not auto-delete device/audit history.

## Design references

Cookie flags follow [Flask security guidance](https://flask.palletsprojects.com/en/stable/web-security/). Server-side absolute expiry, login rotation and revocation follow the [OWASP session management guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

## Settings page overview

- **General** shows the selected server's host settings (domains, storage root, service user, Cloudflare file and tunnel service,
  webhook receiver, defaults for new services, Google Drive backups) as read-only cards, loaded when the section opens.
  *Edit host settings* and *Cloudflare…* open the existing editors in Manage.
- **Account** has the shared display name, **Change password** and the current session. Changing the password needs the
  current password (rate limited), requires at least 10 characters, signs out every other device (including trusted ones) and
  keeps this device signed in. It is recorded in the security activity as `password_changed`; passwords are never logged.
  New installations still start from the first-run default, so change it here.
- **Security** summarises the current session (standard or trusted, with time left) and device counts, and highlights the policy in effect.
- **Appearance** previews each theme; the choice is stored in this browser only.
- **Devices** shows a summary line and a card per device. **Servers** is described in `server-management.md`.

On phones the section list becomes a horizontally scrollable row, cards stack in one column and confirmation dialogs open as bottom sheets.

## Finding things and using the whole screen

On a PC the Settings page uses the full window width: an **At a glance** strip (servers online, host domain, session, devices; click a tile to
jump to it), a grouped section list (Workspace: Servers, General; Security: Account, Security, Devices; Preferences: Appearance) and cards that
flow into as many columns as fit. Server cards sit side by side on wide screens, with the automatic-setup guide next to the pairing form.

* **Search settings** filters the section list by name and by keywords (for example "password", "tunnel", "theme", "webhook"); press **/**
  anywhere on the Settings page to focus it, **Enter** to open the first match and **Esc** to clear.
* Each section has a link you can bookmark or share: `#settings/servers`, `#settings/general`, `#settings/account`, `#settings/security`,
  `#settings/devices`, `#settings/appearance`.
* On phones the search is a full-width row above a horizontally scrollable row of sections, and the glance tiles form a two-column grid.
