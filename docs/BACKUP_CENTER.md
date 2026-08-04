# OfficeChat Backup Center v0.1

Backup Center is a read-only `superadmin` view of the existing OfficeChat production backup system. It is available at `/en/admin/backups`. The page cannot create, verify, delete, prune, or restore backups and cannot change the schedule, retention, or off-site configuration.

## Architecture

```text
Browser -> OfficeChat backend -> Unix socket -> officechat-backup-agent
                                             -> backup metadata (read-only)
                                             -> systemd timer status
```

The backend receives neither the backup root nor Docker access, systemd D-Bus access, dump/upload contents, or private configuration. A separate root-owned host service reads a bounded set of metadata and returns normalized JSON. Protocol v1 permits only `status`, `list_backups`, and `get_backup`.

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

When the agent is unavailable, `/api/admin/backups/status` returns HTTP 200 with `agent_status=unavailable`; list and detail endpoints return a sanitized 503. Local development without the host agent remains usable and displays this unavailable state.

Use the server-side CLI to verify a selected backup:

```bash
/opt/officechat/restore-production.sh \
  --config /etc/officechat/backup.conf \
  --backup-id officechat-backup-YYYYMMDD-HHMMSSZ \
  --verify-only
```

Backup Center intentionally has no restore button. Production restore remains a separate, confirmed disaster-recovery procedure described in [BACKUP_RESTORE.md](BACKUP_RESTORE.md).

## Metadata security

The API and UI never return local or off-site paths, credentials, private configuration, dump/upload filenames, usernames, or message metadata. The agent accepts no arbitrary paths, unit names, or commands. Backup IDs use strict full-match validation; request sizes and timeouts are bounded; symlink metadata and backup directories are rejected; subprocess execution uses fixed `systemctl` arguments without a shell.
