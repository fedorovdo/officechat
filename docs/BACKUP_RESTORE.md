# OfficeChat Backup, Verification, and Restore

This is the canonical operator runbook for application-level backup and recovery. Backup Center usage and its web-to-host security boundary are described in [BACKUP_CENTER.md](BACKUP_CENTER.md).

## Scope and defaults

The release installer uses these production defaults unless `/etc/officechat/backup.conf` overrides them:

| Purpose | Path |
| --- | --- |
| OfficeChat application and release scripts | `/opt/officechat` |
| Application state | `/var/lib/officechat` |
| Backup configuration | `/etc/officechat/backup.conf` |
| Local backup repository | `/var/backups/officechat/production` |
| Last-run status | `/var/backups/officechat/status/latest.json` |
| Backup agent state | `/var/lib/officechat-backup-agent` |
| Shared operation lock | `/run/lock/officechat/backup.lock` |

The backend and browser never receive the local backup repository path, agent state directory, database dump, uploads archive, or private configuration. The installer creates `backup.conf` with mode `0600` only when it is absent; updates preserve it.

## What a backup contains

Required components:

- complete PostgreSQL custom-format dump, including future application tables;
- uploads archive, including attachments and avatars;
- manifest and SHA-256 checksums.

Configured optional components:

- public and private deployment configuration when `BACKUP_DEPLOYMENT_CONFIG=yes`;
- best-effort Valkey RDB when `BACKUP_VALKEY=auto`, or required RDB when set to `yes`;
- Caddy internal CA when `BACKUP_CADDY_CA=yes` and its Compose project is available;
- colon-separated absolute paths from `BACKUP_EXTRA_PATHS`;
- currently used frontend/backend images with `--include-images` or `--pre-upgrade`.

The normal command does not include image tar files unless `--include-images` is supplied. `--pre-upgrade` implies `--include-images` and also creates `PROTECTED`, so automatic rotation cannot remove that copy. PostgreSQL is authoritative; Valkey runtime state is not restored automatically.

Private deployment configuration and Caddy CA are sensitive. Plaintext `config/deployment-private.tar.gz`, `caddy/caddy-ca.tar.gz`, and plaintext extra-path archives remain local but are excluded from an external copy by default. A public `AGE_RECIPIENT` creates encrypted `.age` alternatives. Keep the private age identity outside OfficeChat and outside the backup repository.

## Directory lifecycle and markers

Each ID is UTC and has the form:

```text
officechat-backup-YYYYMMDD-HHMMSSZ
```

Creation follows this lifecycle:

```text
officechat-backup-....partial
  -> database, uploads, configured optional components
  -> manifest and SHA256SUMS
  -> checksum verification
  -> verify-backup.sh when VERIFY_AFTER_BACKUP=yes
  -> SUCCESS
  -> PROTECTED only for --pre-upgrade
  -> atomic rename to officechat-backup-....
```

`SUCCESS` means the directory was completely published after the configured checks. It is not proof that an isolated restore drill has succeeded. If `VERIFY_AFTER_BACKUP=yes` (the default), the manifest records `verification_status=passed` after manifest, checksums, PostgreSQL dump-list, and archive checks. If verification is disabled, a completed copy may have `verification_status=not_requested`.

`PROTECTED` is created only by `--pre-upgrade`, after verification and immediately before the final atomic rename. It prevents GFS rotation but does not replace off-site storage.

PostgreSQL and uploads are captured sequentially, not as one cross-component transaction. The manifest records `best_effort_live`. Use validated root-owned lifecycle hooks to quiesce writes when strict attachment consistency is required.

## Manual backup

Create a normal backup:

```bash
sudo /opt/officechat/backup-production.sh \
  --config /etc/officechat/backup.conf
```

Create a protected pre-upgrade backup with current images:

```bash
sudo /opt/officechat/backup-production.sh \
  --config /etc/officechat/backup.conf \
  --pre-upgrade
```

Successful output ends with `Backup completed: <path>`. Safely inspect the published result:

```bash
sudo cat /var/backups/officechat/status/latest.json
BACKUP_ID=officechat-backup-YYYYMMDD-HHMMSSZ
BACKUP_PATH="/var/backups/officechat/production/${BACKUP_ID}"
sudo test -f "${BACKUP_PATH}/SUCCESS" && echo 'SUCCESS present'
sudo test -f "${BACKUP_PATH}/PROTECTED" && echo 'PROTECTED present'
sudo lslocks --output COMMAND,PID,TYPE,PATH | grep -F '/run/lock/officechat/backup.lock'
```

Do not edit a backup directory, manufacture markers, or remove the lock file manually. The lock file may remain when unlocked; `lslocks` shows whether a process owns a lock.

## Scheduled backups

The installer installs `officechat-backup.timer` and `officechat-backup.service`. The timer is disabled by default unless installation used `--enable-backup-timer`. Its shipped schedule is 02:30 daily with `RandomizedDelaySec=15m`, `AccuracySec=1m`, and `Persistent=true`; use systemd output as the authoritative next-run time rather than assuming an exact minute.

```bash
sudo systemctl status officechat-backup.timer
sudo systemctl list-timers --all officechat-backup.timer
sudo systemctl cat officechat-backup.timer
sudo journalctl -u officechat-backup.service --since today --no-pager
```

Enable or disable scheduled backups explicitly:

```bash
sudo systemctl enable --now officechat-backup.timer
sudo systemctl disable --now officechat-backup.timer
```

Disabling the timer does not disable `officechat-backup-agent.service`. The agent is still required for Backup Center metadata and manual browser jobs. Scheduled, CLI, browser verification, and restore operations share the same lock; only one may run at a time.

## Verification methods

### Automatic structural verification

With `VERIFY_AFTER_BACKUP=yes`, backup creation runs `verify-backup.sh` before publishing `SUCCESS`. It checks the manifest format and required components, complete checksum set, `pg_restore --list`, archive structure, traversal/links/special files, and configured archive limits.

### Manual structural verification

```bash
sudo /opt/officechat/verify-backup.sh \
  --config /etc/officechat/backup.conf \
  /var/backups/officechat/production/officechat-backup-YYYYMMDD-HHMMSSZ
```

### Isolated restore drill

For a local backup ID:

```bash
sudo /opt/officechat/restore-production.sh \
  --config /etc/officechat/backup.conf \
  --verify-only \
  --backup-id officechat-backup-YYYYMMDD-HHMMSSZ
```

For a copied external backup, supply its full path instead of `--backup-id`:

```bash
sudo /opt/officechat/restore-production.sh \
  --config /etc/officechat/backup.conf \
  --verify-only \
  /mnt/officechat-offsite/officechat-backup-YYYYMMDD-HHMMSSZ
```

Verify-only acquires the common lock, repeats structural verification, creates uniquely labeled temporary Docker network/volume/container resources with no production ports or mounts, restores the complete dump into temporary PostgreSQL, checks tables, relations, owners, extensions, Alembic revision and PostgreSQL major compatibility, and extracts uploads into a temporary directory. Its trap removes only resources bearing its restore-drill label.

The Backup Center **Verify backup** action runs this same `--verify-only --backup-id` workflow. A directory should not be treated as recoverable merely because it exists or has `SUCCESS`; perform recurring isolated restore drills.

## External/off-site storage

### What is implemented

OfficeChat supports one filesystem destination already mounted by the host operating system. It does not implement NFS/SMB clients, object storage, S3, URLs, credentials, remote shells, or cloud APIs.

Relevant keys are:

```ini
OFFSITE_ROOT=/mnt/officechat-offsite
REQUIRE_OFFSITE=yes
ALLOW_PLAINTEXT_PRIVATE_OFFSITE=no
REQUIRE_ENCRYPTED_PRIVATE=no
AGE_RECIPIENT=
```

This complete baseline copies PostgreSQL, uploads, public configuration, metadata, and any non-private optional content. Plaintext private configuration, Caddy CA, and extra-path archives are excluded. To include their encrypted alternatives, install `age`, set a valid public `AGE_RECIPIENT`, and normally set `REQUIRE_ENCRYPTED_PRIVATE=yes`.

`OFFSITE_ROOT` must already be a real active mountpoint, must not be a symlink, must not overlap application/local backup data, and must report a different filesystem device from `BACKUP_ROOT`. The root executor must be able to inspect free space and create, chmod, rename, and rotate directories there. The script never creates a missing mountpoint and rechecks mount/device identity before and after transfer.

NFS, SMB/CIFS, or a dedicated externally backed local mount are all possible host-level patterns. Configure authentication, encryption in transit, boot ordering, and mount recovery in the operating system. Use a stable mountpoint and test root access; NFS root-squash or restrictive SMB mappings may prevent the required operations. OfficeChat stores no network-storage credential.

### Copy and failure semantics

The local copy is verified, receives `SUCCESS`, and is atomically published before external transfer. OfficeChat then:

1. checks mountpoint, separate device, and free space;
2. creates `<backup-id>.partial` on external storage;
3. uses `rsync -aHAX --numeric-ids` when available, otherwise a tar stream;
4. rewrites external manifest file-size metadata for the transferred payload;
5. regenerates and verifies checksums;
6. runs `verify-backup.sh --allow-partial` on the external copy;
7. atomically renames it to `<backup-id>`;
8. records the local `metadata/offsite-receipt.json` and `latest.json` status.

Statuses are `not_configured`, `copied`, `skipped_not_mounted`, `failed`, or `unknown`.

- With `REQUIRE_OFFSITE=no`, a missing/unmounted destination leaves the local backup valid and the run succeeds as `skipped_not_mounted`.
- With `REQUIRE_OFFSITE=yes`, missing configuration or mount makes the overall run fail, although the already published local backup remains.
- A mounted destination that fails separate-device, capacity, copy, or verification checks makes the run fail regardless of `REQUIRE_OFFSITE`; the local completed backup remains intact.

There is no copy retry and no dedicated network-copy timeout. systemd/browser executions have a six-hour unit/agent limit; a direct CLI run relies on the filesystem and operating-system timeout behavior. Monitor network mounts so a stalled storage server cannot leave an unattended CLI process waiting indefinitely.

After a successful external copy, the same GFS policy is run independently on local and external repositories. Rotation considers only correctly named directories with `SUCCESS`, preserves the newest successful copy and every `PROTECTED` copy, and ignores partial, symlinked, and unrelated paths. External rotation is not run when the current external copy was skipped or failed.

### Acceptance procedure

```bash
mountpoint /mnt/officechat-offsite
findmnt /mnt/officechat-offsite
df -h /mnt/officechat-offsite
sudo /opt/officechat/backup-production.sh --config /etc/officechat/backup.conf
sudo cat /var/backups/officechat/status/latest.json
sudo find /mnt/officechat-offsite -mindepth 1 -maxdepth 1 -type d \
  -name 'officechat-backup-????????-??????Z' -print | sort -r
```

Then run both `verify-backup.sh` and `restore-production.sh --verify-only` against the external path in a staging acceptance window. Do not consider mount availability alone proof of an off-site backup.

## Selecting a backup for restore

List completed local copies without including partial directories:

```bash
sudo find /var/backups/officechat/production -mindepth 1 -maxdepth 1 -type d \
  -name 'officechat-backup-????????-??????Z' \
  -exec test -f '{}/SUCCESS' ';' -print | sort -r
```

Before production restore, inspect `metadata/manifest.json`, confirm `officechat_version`, `build_sha`, `alembic_revision`, `postgresql_version`, detected components, warnings, and run the isolated restore drill.

## Production restore

Restore is CLI-only. For a local repository backup:

```bash
BACKUP_ID=officechat-backup-YYYYMMDD-HHMMSSZ
sudo /opt/officechat/restore-production.sh \
  --config /etc/officechat/backup.conf \
  --production \
  --confirm-hostname "$(hostname)" \
  --confirm-backup "${BACKUP_ID}" \
  --yes \
  --backup-id "${BACKUP_ID}"
```

Production mode requires root and a local TTY. Non-interactive automation additionally requires `--non-interactive`; it does not replace `--production`, hostname confirmation, backup-ID confirmation, or `--yes`. For an external path use that path as the final positional argument instead of `--backup-id`.

The script:

1. verifies the selected backup before mutation;
2. warns when the backup OfficeChat version differs from the installed version;
3. creates a new verified `--pre-upgrade` backup of current production for rollback;
4. acquires the common lock;
5. restores the dump into a new staging database and validates tables, revision, and ownership;
6. safely extracts uploads into a staging directory;
7. stops backend, frontend, and configured workers only after staging checks pass;
8. atomically renames the production and staged databases, retaining the old database;
9. swaps uploads, retaining the old uploads directory;
10. runs `alembic current`, `alembic upgrade head`, and `alembic current` with the installed backend image;
11. starts application services and requires backend `/ready` and frontend `/api/health`;
12. runs the configured `POST_RESTORE_HOOK`.

If failure occurs after application shutdown, services remain stopped for inspection and the protected safety backup, rollback database, and rollback uploads are retained. Do not delete them until operator acceptance.

The script restores PostgreSQL and uploads. It does not automatically restore `.env`, `backup.conf`, Caddy CA, Valkey RDB, extra paths, or saved images. Prepare compatible application/configuration first and recover optional components through their dedicated controlled procedures. Use the dedicated [Caddy CA backup and restore guide](deployment/caddy-ca-backup-restore.md) for the internal certificate authority.

### Version and migration rules

- Unknown `backup_format_version` is rejected.
- Target PostgreSQL major must be equal to or newer than the source major recorded in the backup.
- The staged database Alembic revision must match the backup manifest.
- A different OfficeChat version produces a warning, not an automatic application switch.
- After the switch, the installed release may upgrade the restored schema to its own head.
- The script never performs a database downgrade.

Install the same backup release or a tested compatible newer release before restore. If the backup schema is newer than the installed application's migration chain, migration/readiness is expected to fail safely with the application stopped; select a compatible release rather than attempting a downgrade.

For a protected pre-upgrade backup, use the same verify and production commands. `metadata/manifest.json`, `metadata/image-digests.txt`, `officechat_version`, and `build_sha` identify the source release. `images/backend.tar` and `images/frontend.tar` exist only when images were included. Loading saved images and restoring private configuration are explicit operator steps outside `restore-production.sh`.

## Full recovery after a disaster

Use this order when the OfficeChat server/VM is lost but a valid external application backup exists:

1. Prepare a supported Linux amd64 host with Docker Engine, Compose v2, systemd, sufficient local storage, and SELinux Enforcing where applicable.
2. Install the same OfficeChat release recorded in the manifest, or a tested compatible newer release. Do not start client traffic yet.
3. Recreate `/opt/officechat`, `/var/lib/officechat`, private `.env`, `/etc/officechat/backup.conf`, and storage permissions through the installer and controlled secret recovery.
4. Make the external backup available as a local mounted path; do not modify its contents.
5. Run structural verification and the isolated restore drill against that external path.
6. Run the confirmed production restore against the path.
7. Confirm Alembic current/head, backend `/ready`, and frontend `/api/health`.
8. Verify administrator and normal-user login, group/direct messaging, and WebSocket delivery.
9. Download a representative attachment/avatar and compare expected content.
10. Restore and validate optional components separately, including Caddy CA when retaining LAN trust.
11. Confirm Backup Center, agent socket, timer status, journals, local free space, and external status.
12. Re-enable the timer only after acceptance and run one new backup through the normal path.

An OfficeChat application backup protects application data and selected configuration. A full VM/hypervisor backup protects the wider host, boot/system configuration, and other services. Use both where possible; neither is a substitute for testing restore from an independent off-site copy.

## Security model

- `officechat-backup-agent.service`: `NoNewPrivileges=true`, empty `CapabilityBoundingSet`, empty `AmbientCapabilities`.
- Only `officechat-backup-job.service` and `officechat-backup-verify@.service` use `NoNewPrivileges=false` for fixed root-owned Docker workflows.
- Backend is unprivileged and has no Docker socket, backup repository mount, or agent state mount.
- Backend receives only a read-only bind of the Unix-socket runtime directory and a supplementary group ID.
- Frontend and calendar worker receive no agent socket.
- Restore is never exposed through browser/API.

Do not disable SELinux, grant Docker or host filesystem access to backend, make the agent socket world-writable, edit job state, or replace fixed executor commands during incident response.

## Troubleshooting matrix

| Symptom | Meaning and safe diagnostics | Do not |
| --- | --- | --- |
| Running unusually long | Inspect `systemctl status officechat-backup-job.service`, active verify units, `journalctl`, `pgrep -af 'backup-production|restore-production|verify-backup'`, and `lslocks`. | Do not restart the agent or kill processes before identifying the PID1-owned executor. |
| `BACKUP_BUSY` | A scheduled/manual/verify/restore operation or lock is active. Inspect both executor units, timer service, and `lslocks`. | Do not delete `backup.lock` or start a parallel script. |
| `EXECUTOR_UNAVAILABLE` | Agent cannot validate/query/start the fixed unit. Check `systemctl status`, `systemctl cat`, `daemon-reload` state, and agent journal. | Do not broaden allowed argv or make backend privileged. |
| `JOB_INTERRUPTED` | Agent stopped while observing a job; executor may still run under PID 1. Inspect active units and journals. | Do not edit `jobs.json` or retry until executors and lock are idle. |
| Verification failed | Manifest, checksums, dump restore, PostgreSQL compatibility, or uploads validation failed. Re-run the exact verify command and inspect its journal. | Do not add `SUCCESS`, edit checksums, or restore that copy. |
| Off-site not configured | `OFFSITE_ROOT` is empty; local backups do not protect against server loss. | Do not treat local `SUCCESS` as off-site protection. |
| Off-site unavailable | Check `mountpoint`, `findmnt`, `df`, permissions, device identity, and `latest.json`. | Do not create files in an unmounted destination path or enable plaintext private transfer casually. |
| Low disk space | Check `df -h`, retention values, protected copies, and recent successful copies. | Do not remove arbitrary directories or protected rollback copies. |
| Timer did not run | Check `systemctl list-timers --all`, timer/service status, and service journal. `Persistent=true` may run a missed job after boot. | Do not disable the agent; timer and agent are separate. |
| Agent inactive/socket unavailable | Check agent status/journal and `stat` the socket (`root:officechat-backup`, mode `0660`). | Do not use mode `0777` or mount the Docker socket into backend. |
| SELinux denial | Keep Enforcing; inspect `ausearch -m AVC,USER_AVC -ts recent` and `ls -Z` for runtime/data paths. | Do not set permissive mode, disable labels, or install an allow-all policy. |

## Operator quick reference

```bash
# Normal and protected backups
sudo /opt/officechat/backup-production.sh --config /etc/officechat/backup.conf
sudo /opt/officechat/backup-production.sh --config /etc/officechat/backup.conf --pre-upgrade

# Latest status, timer, agent, and logs
sudo cat /var/backups/officechat/status/latest.json
sudo systemctl list-timers --all officechat-backup.timer
sudo systemctl status officechat-backup-agent.service
sudo journalctl -u officechat-backup.service --since today --no-pager

# Structural verification
sudo /opt/officechat/verify-backup.sh --config /etc/officechat/backup.conf \
  /var/backups/officechat/production/officechat-backup-YYYYMMDD-HHMMSSZ

# Isolated restore drill
sudo /opt/officechat/restore-production.sh --config /etc/officechat/backup.conf \
  --verify-only --backup-id officechat-backup-YYYYMMDD-HHMMSSZ

# Lock and active executors
sudo lslocks --output COMMAND,PID,TYPE,PATH | grep -F '/run/lock/officechat/backup.lock'
sudo systemctl status officechat-backup-job.service
sudo systemctl list-units --all 'officechat-backup-verify@*.service'
```

The full confirmed production restore command belongs only in the [Production restore](#production-restore) procedure above.
