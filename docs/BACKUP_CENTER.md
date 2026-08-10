# OfficeChat Backup Center v0.1

Backup Center is a `superadmin` view of the OfficeChat production backup system. It can start a full local backup or an isolated verify-only job after confirmation. It cannot delete, prune, restore, or reconfigure backups, schedules, retention, or off-site storage.

## Architecture

```text
Browser -> OfficeChat backend -> Unix socket -> officechat-backup-agent
                                             -> backup metadata
                                             -> fixed allowlisted systemctl argv
                                             -> root-owned executor units
                                             -> fixed backup/verify scripts
                                             -> systemd timer status
```

The backend receives neither the backup root nor Docker access, systemd D-Bus access, dump/upload contents, private configuration, or agent state directory. The root-owned host agent accepts only metadata reads, fixed `create_backup`/`verify_backup` jobs, job reads, and terminal-audit claim acknowledgements. It never accepts an executable, configuration path, environment, unit name, systemd property, or free-form argv from the client.

The agent runs with `NoNewPrivileges=true`, an empty capability bounding set, and its hardened sandbox. It can only issue exact, shell-free `systemctl show/start/stop` forms for `officechat-backup-job.service`, a strictly validated `officechat-backup-verify@<backup-id>.service`, read-only status for the scheduled backup unit, and one fixed `list-units` query for active OfficeChat verify instances. Creation executes only the fixed production backup command. Verification executes only `restore-production.sh --verify-only` with a backup ID matching `officechat-backup-YYYYMMDD-HHMMSSZ`; it cannot be changed into restore mode. Job completion is accepted only for a new systemd invocation or monotonic start timestamp observed after the fixed unit is started.

Only the two root-owned executor units use `NoNewPrivileges=false`. Their `ExecStart` commands, configuration path, environment, writable paths, and service properties are installed by the release and are never supplied by the API. This is an explicit security tradeoff required for Docker under SELinux Enforcing: compromise of either root-owned unit file or the root-owned backup scripts can yield host root-equivalent access through Docker. Keep `/etc/systemd/system/officechat-backup-*.service` and `/opt/officechat/{backup-agent.py,backup-production.sh,verify-backup.sh,restore-production.sh,backup}` writable only by root and treat changes as security-sensitive.

The agent persists bounded, sanitized job history atomically in `/var/lib/officechat-backup-agent` (mode `0700`). Only one API operation runs at a time. Scheduled, manual, and verify-only operations also share the same host `flock`; contention returns `BACKUP_BUSY`. An unfinished observed job becomes `interrupted` after an agent restart, while the systemd executor continues independently. A restarted agent refuses a second operation while that executor is active. Executor output remains in journald rather than API responses or state JSON.

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

The release bundle includes `backup-agent.py`, its root-owned configuration template, the hardened agent unit, the two fixed executor units, and Backup Center documentation. The installer creates the `officechat-backup` system group, installs `/etc/officechat/backup-agent.conf`, installs all units as `root:root` mode `0644`, starts the agent, validates the socket owner/group/mode, and passes only its numeric GID to the backend container. Updates preserve an existing agent configuration.

Updates install scripts and units first, run `daemon-reload`, restart the agent only when it was active, preserve its enabled/disabled state, validate the newly created socket, and then force-recreate backend so its bind mount uses the current socket inode. The backup timer state and schedule are not changed. A failed partial update restores the prior agent/executor assets and active/enabled state before recreating backend against the restored socket.

Installing the agent does not run a backup and does not enable `officechat-backup.timer`. Enabling scheduled backups remains an explicit operator decision.

The uninstaller stops and disables the agent, removes its systemd unit, and lets systemd remove the runtime socket directory. Backup data, `/etc/officechat/backup.conf`, `/etc/officechat/backup-agent.conf`, and the system group are preserved for recovery or reinstallation.

## Diagnostics

```bash
sudo systemctl status officechat-backup-agent.service
sudo systemctl status officechat-backup-job.service
sudo systemctl status 'officechat-backup-verify@officechat-backup-YYYYMMDD-HHMMSSZ.service'
sudo journalctl -u officechat-backup-agent.service --since today
sudo journalctl -u officechat-backup-job.service --since today
sudo stat /run/officechat-backup-agent/agent.sock
docker compose --env-file /opt/officechat/.env -f /opt/officechat/docker-compose.yml exec backend id
```

On an SELinux Enforcing host, run a confirmed UI backup and inspect `getenforce`, `ps -eZ`, `ausearch -m AVC,USER_AVC -ts recent`, the agent and executor journals, contexts for `/run/officechat-backup-agent`, `/var/backups/officechat`, and `/var/lib/officechat`, plus the resulting manifest, `SHA256SUMS`, `SUCCESS`, and `latest.json`. The agent journal must not show an `nnp_transition` denial. Confirm the agent retains `NoNewPrivileges=true` and only the two executor units contain `NoNewPrivileges=false`. Keep the backend socket bind `ro,z`, PostgreSQL/Valkey private labels `:Z`, and shared uploads label `:z`. Keep SELinux Enforcing; do not use permissive mode, `label=disable`, or an allow-all policy.

Terminal job errors are deliberately sanitized: `BACKUP_BUSY`, `BACKUP_EXECUTION_FAILED`, `VERIFY_FAILED`, `EXECUTOR_UNAVAILABLE`, `EXECUTOR_TIMEOUT`, and `JOB_INTERRUPTED`. Inspect the corresponding executor journal for operational detail; raw stderr is never returned to the browser.

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
