# OfficeChat Backup Center

Backup Center is the `superadmin` interface for production backup status, manual backup creation, and isolated verification. It is available at `/en/admin/backups`. It does not delete, download, restore, or reconfigure backups, retention, schedules, or external storage. Production restore remains an authorized CLI-only operation.

For storage layout, scheduled backups, external storage, restore, and disaster recovery, use [Backup and Restore](BACKUP_RESTORE.md).

## What the dashboard shows

- availability and health of the host backup agent;
- last run and last successful backup;
- verification status and latest successful backup size;
- free space in the local backup repository without revealing its path;
- next scheduled run and read-only daily/weekly/monthly retention values;
- external/off-site configuration and the last copy status without a destination path;
- completed local backups with type, version, build, Alembic/PostgreSQL metadata, components, protection, and warnings;
- the current or most recently observed browser job.

Only completed directories with a strict ID such as `officechat-backup-20260811-111632Z` are listed. Missing or corrupt metadata produces a sanitized warning rather than exposing paths, private configuration, or tracebacks.

## Buttons and job states

- **Create backup** starts the fixed full local backup command after confirmation. OfficeChat remains available while the live best-effort backup is created.
- **Refresh** reloads agent, storage, timer, history, and job metadata.
- **Verify backup** is available in a completed backup's details. It performs the existing isolated `--verify-only` restore drill and does not change production data.

The HTTP request only creates an asynchronous host job. The page then polls that job. Actual states are:

- `queued`: accepted and waiting for the worker;
- `running`: backup creation is in progress;
- `verifying`: isolated verification is in progress;
- `succeeded` with phase `completed`: operation completed successfully;
- `failed` with phase `error`: executor or script reported an error;
- `interrupted`: the agent stopped or restarted while observing the operation.

Closing the page does not cancel a job. Backup Center does not expose cancellation or a queue.

## Architecture and trust boundary

```text
Browser
  -> unprivileged backend
  -> read-only bind of a Unix socket directory
  -> hardened root backup agent
  -> fixed, allowlisted systemctl command
  -> fixed systemd executor unit
  -> fixed backup or verify-only script
```

The backend has no Docker socket, backup repository mount, or agent state mount. The frontend and calendar worker have no agent socket. A browser request cannot provide an executable, path, argv, environment, systemd property, or unit name.

The socket-facing `officechat-backup-agent.service` retains:

```ini
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
```

Only `officechat-backup-job.service` and `officechat-backup-verify@.service` use `NoNewPrivileges=false`. Their root-owned `ExecStart` commands are fixed by the release. This isolates the explicit Docker/SELinux privilege tradeoff in two narrow executors instead of the web application or socket-facing agent.

Create can run only:

```text
/opt/officechat/backup-production.sh --config /etc/officechat/backup.conf
```

Verify can run only:

```text
/opt/officechat/restore-production.sh --config /etc/officechat/backup.conf --verify-only --backup-id <validated-backup-id>
```

Restore mode cannot be selected through the protocol.

## Concurrency and interruption

The agent accepts one browser backup/verification operation at a time. Manual, scheduled, verify-only, and restore operations also share `/run/lock/officechat/backup.lock`. An active scheduled backup or executor causes a competing request to fail as `BACKUP_BUSY`.

If the agent restarts while a job is running, OfficeChat records that observed job as `interrupted`. The local `systemctl` client is terminated, but the `Type=oneshot` executor remains owned by PID 1 and may continue. A restarted agent checks active executors and refuses a competing operation. A late executor completion does not retroactively rewrite the interrupted OfficeChat job.

Do not delete the lock file, edit `/var/lib/officechat-backup-agent/jobs.json`, or immediately retry an interrupted job. First inspect the executor and journals.

## rc13.3 production acceptance evidence

Release `0.1.0-rc13.3-backup-jobs-completion-fix` was accepted on RED OS/systemd 253 on 2026-08-11. Browser backup `officechat-backup-20260811-111632Z` completed in 7 seconds with verification `passed` and final job `state=succeeded`, `phase=completed`, `success=true`, `exit_code=0`.

After completion, systemd had already garbage-collected the inactive static unit identity:

```text
InvocationID=
ExecMainStartTimestampMonotonic=0
```

This is expected. rc13.3 uses the result of blocking `systemctl start UNIT` as the authoritative success result for `Type=oneshot`; success no longer depends on polling invocation identity after completion. For a non-zero start result, stale metadata cannot become success or `BACKUP_BUSY`: exit 75 is classified as busy only when metadata proves a new failed invocation.

## Safe diagnostics

```bash
sudo systemctl status officechat-backup-agent.service
sudo systemctl status officechat-backup-job.service
sudo systemctl list-units --all 'officechat-backup-verify@*.service'
sudo journalctl -u officechat-backup-agent.service --since today --no-pager
sudo journalctl -u officechat-backup-job.service --since today --no-pager
sudo stat -c '%U %G %a %n' /run/officechat-backup-agent/agent.sock
sudo lslocks --output COMMAND,PID,TYPE,PATH | grep -F '/run/lock/officechat/backup.lock'
```

Common sanitized errors include `BACKUP_BUSY`, `BACKUP_EXECUTION_FAILED`, `VERIFY_FAILED`, `EXECUTOR_UNAVAILABLE`, `EXECUTOR_TIMEOUT`, and `JOB_INTERRUPTED`. Inspect the matching executor journal; raw stderr and private backup content are intentionally absent from browser responses.

On SELinux Enforcing systems also use:

```bash
getenforce
sudo ausearch -m AVC,USER_AVC -ts recent
sudo ls -Zd /run/officechat-backup-agent /var/backups/officechat /var/lib/officechat
```

Do not disable SELinux, make the socket world-writable, grant the backend Docker access, or broaden the executor allowlist as troubleshooting shortcuts.

## Installation and updates

The release installer installs the scripts, documentation, agent configuration, and five backup units. It creates `/etc/officechat/backup.conf` and `/etc/officechat/backup-agent.conf` only when absent and preserves existing configuration on update. The agent is enabled and started; `officechat-backup.timer` is enabled only with `--enable-backup-timer` or a later explicit operator command.

Updates preserve the agent's enabled/active state, replace fixed executor assets before `daemon-reload`, validate the new socket, and recreate only backend so its read-only bind points to the current socket inode. They do not change the timer state or schedule.
