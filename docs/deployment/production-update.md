# Production update safety

Run an update from the extracted target release bundle:

```bash
sudo ./officechatctl update VERSION
```

`RELEASE.json` binds the requested version to an exact commit SHA, UTC build date,
backend image, and frontend image. The updater rejects malformed or mismatched
metadata before changing production files.

## Compose order

Every application command uses this ordered stack:

1. `/opt/officechat/docker-compose.yml`;
2. optional `/opt/officechat/docker-compose.https-override.yml`;
3. optional, updater-managed `/opt/officechat/docker-compose.version-override.yml`.

The final override pins backend and calendar-worker to the exact backend image and
pins frontend to the exact frontend image. It also supplies public frontend
version, revision, and build-date metadata. A legacy HTTPS override may keep old
image declarations, but it is never edited and cannot override the final layer.
Do not run operational commands with an incomplete manual list of `-f` arguments.

The shipped Caddy access/runtime log filters are security controls, not
formatting-only configuration. The updater snapshots and replaces the installer-managed
`caddy/Caddyfile.example`; when that Caddy service is running, it reloads the
configuration without removing its volumes. An external or separately managed
reverse proxy is not rewritten: preserve equivalent redaction for WebSocket
`token` query values and token-bearing bot webhook paths.

Before mutation, the updater renders a staging stack with a copied `.env`, the new
base Compose, the existing HTTPS override, and a temporary final override. It
validates resolved images, localhost frontend binding, public network, SELinux
labels, and backup-agent socket isolation. Resolved config and secrets are not
printed. The `.env` metadata and final override are replaced atomically.

If migration or readiness fails, the updater restores the previous Compose, final
override, `.env`, agent/executor units, agent config/executable, backup scripts, and application containers. It does
not downgrade the database. Backup data, `backup.conf`, the HTTPS override, Caddy
volumes, PostgreSQL data, and uploads are never removed.

The updater preserves the backup agent's enabled and active states independently. It installs the fixed executor assets before `daemon-reload`, restarts the agent only when it was active, validates the replacement socket as `root:officechat-backup` mode `0660`, and force-recreates backend so the bind mount points at the current socket inode. It never changes the backup timer state or schedule. The same ordering is used when rolling back a partially completed update.

Before updating, follow the protected pre-upgrade procedure in
[Backup and Restore](../BACKUP_RESTORE.md). After updating, confirm the
[Backup Center](../BACKUP_CENTER.md), agent socket, timer state, and most recent
successful backup. The restore runbook is canonical; this update guide does not
duplicate its confirmed production restore command.

## SELinux acceptance

On RED OS or another RHEL-like host, keep SELinux Enforcing:

```bash
getenforce
sudo systemctl restart officechat-backup-agent
sudo stat -c '%U %G %a' /run/officechat-backup-agent/agent.sock
sudo systemctl status officechat-backup-job.service
sudo journalctl -u officechat-backup-job.service --since today
sudo ausearch -m AVC,USER_AVC -ts recent
sudo ls -Zd /run/officechat-backup-agent /var/lib/officechat/{postgres,valkey,uploads}
sudo /opt/officechat/officechatctl restart
sudo /opt/officechat/officechatctl health
```

The socket must remain `root:officechat-backup` mode `0660`; only backend receives
its read-only shared-label bind and supplementary GID. Calendar-worker and frontend
must not see the socket. Confirm Backup Center status after backend recreation.
Never disable SELinux, use privileged containers, or make the socket world-writable.
