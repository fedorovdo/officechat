# OfficeChat Backup Center v0.1

Backup Center is a `superadmin` view of the OfficeChat production backup system. It can start a full local backup or an isolated verify-only job after confirmation. It cannot delete, prune, restore, or reconfigure backups, schedules, retention, or off-site storage.

## Architecture

```text
Browser -> OfficeChat backend -> Unix socket -> officechat-backup-agent
                                             -> backup metadata
                                             -> fixed allowlisted backup/verify argv
                                             -> systemd timer status
```

The backend receives neither the backup root nor Docker access, systemd D-Bus access, dump/upload contents, private configuration, or agent state directory. The root-owned host agent accepts only metadata reads, fixed `create_backup`/`verify_backup` jobs, job reads, and terminal-audit claim acknowledgements. It never accepts an executable, configuration path, environment, or free-form argv from the client.

The agent persists bounded, sanitized job history atomically in `/var/lib/officechat-backup-agent` (mode `0700`). Only one operation runs at a time, an unfinished job becomes `interrupted` after restart, and subprocess output remains in journald rather than API responses or state JSON.

Terminal audit is independent of the browser polling lifecycle. Each job stores only the initiating user ID/login snapshot. On any later Backup Center GET, the backend atomically claims one pending terminal job from the agent, commits an idempotent audit event correlated by `job_id`, and acknowledges the claim only after the database commit. Failed commits release the claim; lost acknowledgements recover after `AUDIT_CLAIM_TTL_SECONDS`, with the database correlation check preventing duplicate events.

The default socket is `/run/officechat-backup-agent/agent.sock`, mode `0660`, owner `root`, group `officechat-backup`. Only the backend receives the supplementary numeric GID and a read-only bind of the runtime directory. The frontend and calendar worker receive no socket access.

## Visible metadata

- agent availability and overall backup health;
- last run and last successful backup;
- verification and off-site status without destination paths;
- backup-root capacity without exposing its path;
- installed timer state;
- current read-only retention values;
- backup history, version/build/Alembic/PostgreSQL metadata, and detected components.

Legacy backups without reliable type metadata remain `unknown`. Missing or corrupt metadata produces safe warnings without exposing tracebacks, configuration content, or filesystem paths.

## Installation and updates

The release bundle includes `backup-agent.py`, its root-owned configuration template, the hardened systemd unit, and Backup Center documentation. The installer creates the `officechat-backup` system group, installs `/etc/officechat/backup-agent.conf`, starts the agent, and passes only its numeric GID to the backend container. Updates preserve an existing agent configuration.

Installing the agent does not run a backup and does not enable `officechat-backup.timer`. Enabling scheduled backups remains an explicit operator decision.

The uninstaller stops and disables the agent, removes its systemd unit, and lets systemd remove the runtime socket directory. Backup data, `/etc/officechat/backup.conf`, `/etc/officechat/backup-agent.conf`, and the system group are preserved for recovery or reinstallation.

## Diagnostics

```bash
sudo systemctl status officechat-backup-agent.service
sudo journalctl -u officechat-backup-agent.service --since today
sudo stat /run/officechat-backup-agent/agent.sock
docker compose --env-file /opt/officechat/.env -f /opt/officechat/docker-compose.yml exec backend id
```

On an SELinux Enforcing host, run a confirmed UI backup and inspect `getenforce`, the agent and backup-service journals, contexts for `/run/officechat-backup-agent`, `/var/backups/officechat`, and `/var/lib/officechat`, plus the resulting manifest, `SHA256SUMS`, `SUCCESS`, and `latest.json`. Keep the backend socket bind `ro,z`, PostgreSQL/Valkey private labels `:Z`, and shared uploads label `:z`. Do not disable SELinux.

When the agent is unavailable, `/api/admin/backups/status` returns HTTP 200 with `agent_status=unavailable`; list and detail endpoints return a sanitized 503. Local development without the host agent remains usable and displays this unavailable state.

Backup Center requires confirmation before creation or verification. Equivalent server-side CLI commands are:

```bash
sudo /opt/officechat/backup-production.sh --config /etc/officechat/backup.conf
```

```bash
/opt/officechat/restore-production.sh \
  --config /etc/officechat/backup.conf \
  --backup-id officechat-backup-YYYYMMDD-HHMMSSZ \
  --verify-only
```

Backup Center intentionally has no restore button. Production restore is performed only through SSH as the separate, confirmed disaster-recovery procedure described in [BACKUP_RESTORE.md](BACKUP_RESTORE.md).

## Metadata security

The API and UI never return local or off-site paths, credentials, private configuration, dump/upload filenames, usernames, or message metadata. Backup IDs use strict full-match and realpath validation, verification requires the `SUCCESS` marker, protocol and state sizes are bounded, symlinks are rejected, and subprocess execution uses fixed argv without a shell. The backend still receives no Docker socket, backup root, or agent state mount.
