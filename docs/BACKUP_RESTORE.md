# OfficeChat Backup and Restore

## Operator guide

### 1. Purpose
Backups protect authoritative PostgreSQL and uploads. A backup on the same VM does not protect against loss of that VM or disk.

### 2. Included data
The backup includes a complete PostgreSQL dump, uploads, metadata/checksums, deployment configuration, and configured optional components.

### 3. Excluded data
Backup Center job state, its runtime socket, temporary restore-drill resources, and reconstructable runtime state are not recovery data.

### 4. Storage directory
`BACKUP_ROOT` is defined in root-owned `/etc/officechat/backup.conf`; neither the backend nor browser receives that path.

### 5. Backup structure
A completed copy uses `officechat-backup-YYYYMMDD-HHMMSSZ` and contains a manifest, `SHA256SUMS`, and atomic `SUCCESS` marker.

### 6. Create through Backup Center
A `superadmin` confirms “Create backup”. One host-side job runs while the UI polls it to a terminal state.

### 7. Create through CLI
```bash
sudo /opt/officechat/backup-production.sh --config /etc/officechat/backup.conf
```

### 8. Verify through Backup Center
Open a completed backup and confirm “Verify backup”. The agent starts the fixed root-owned verify executor for that strictly validated backup ID. The unit can run only `--verify-only`; Backup Center still exposes no restore operation.

### 9. Verify through CLI
```bash
sudo /opt/officechat/restore-production.sh --config /etc/officechat/backup.conf --verify-only --backup-id officechat-backup-YYYYMMDD-HHMMSSZ
```

### 10. Timer status
Use `sudo systemctl status officechat-backup.timer` and `sudo systemctl list-timers officechat-backup.timer`.

### 11. Enable or disable the timer
Use `sudo systemctl enable --now officechat-backup.timer` or `sudo systemctl disable --now officechat-backup.timer`.

### 12. Current schedule
Inspect `sudo systemctl cat officechat-backup.timer`; Backup Center does not edit schedules.

### 13. GFS 14/8/12
Defaults are `KEEP_DAILY=14`, `KEEP_WEEKLY=8`, and `KEEP_MONTHLY=12`; the UI displays them read-only.

### 14. Protected pre-upgrade copies
`backup-production.sh --config /etc/officechat/backup.conf --pre-upgrade` creates a copy with a `PROTECTED` marker.

### 15. Freeing space
Review `df -h` and GFS first. Backup Center has no delete or prune operation.

### 16. Safe verify-only
Verify-only creates isolated temporary Docker resources, validates the dump/uploads, and removes those resources without modifying production. It uses the same host `flock` as scheduled/manual backup and restore, so parallel operations fail safely as busy.

### 17. Restore drill on a VM clone
Exercise disaster recovery on an isolated clone without client traffic and complete post-restore acceptance.

### 18. Production restore
Only an authorized operator over SSH may run the actual CLI with all required confirmations. Backup Center never starts restore.

### 19. Restore to a new VM
Install a compatible OfficeChat/PostgreSQL environment and private configuration before transferring and restoring the backup.

### 20. PostgreSQL behavior
Restore stages the full dump, verifies Alembic revision, and atomically switches databases. It never performs an automatic database downgrade.

### 21. Upload behavior
Uploads are extracted and checked in staging, then switched while rollback uploads remain until acceptance.

### 22. Valkey behavior
Valkey is not authoritative. A best-effort RDB may be saved, while durable state remains in PostgreSQL.

### 23. Deployment configuration
Public and private configuration are archived separately; private archives must never be published.

### 24. Caddy CA
The internal CA is restored separately to retain LAN client trust and must be handled as a secret.

### 25. Post-restore checks
Check `/ready`, frontend `/api/health`, Alembic current, login, messages, uploads, and journals.

### 26. Rollback and safety backup
The actual restore script creates a protected pre-restore backup and retains rollback database/uploads until operator acceptance.

### 27. Logs and diagnostics
Use the backup agent/service journals and sanitized status APIs; never paste secrets into support reports.

### 28. Common failures
Check disk capacity, the existing lock/timer job, `SUCCESS`, checksums, Docker, SELinux, and the agent socket.

### 29. SELinux
Do not disable SELinux. Preserve `:Z` for PostgreSQL/Valkey, `:z` for uploads, and `ro,z` for the agent socket.

### 30. Backup Center limitations
It cannot edit schedules/GFS/off-site settings, delete, download, restore, inspect private content, cancel, or queue jobs. Restore remains SSH/CLI only.

## Architecture

The production backup toolkit creates an atomic, verifiable backup containing:

- a complete PostgreSQL custom-format logical dump;
- uploads with ownership, permissions, ACLs, xattrs, and SELinux labels;
- separate public and private deployment configuration archives;
- an optional best-effort Valkey RDB snapshot;
- an optional protected Caddy internal CA archive;
- configurable extra data paths;
- versioned manifest metadata and SHA-256 checksums;
- optional currently used frontend/backend images.

It discovers services through configurable Docker Compose files and
`docker compose ... ps -q SERVICE`. It does not depend on generated container
names, container IDs, image IDs, a fixed PostgreSQL table list, or a fixed
Alembic revision.

Current installations use the base Compose file plus optional HTTPS and final
version overrides. `COMPOSE_OPTIONAL_FILES` discovers both optional layers without
failing when either is absent. The generated version override is included in
public deployment metadata; private `.env` content remains protected.

## Data classification

PostgreSQL and uploads are required. PostgreSQL is authoritative for users,
messages, groups, discussions, notifications, calendar state, audit records, and
attachment metadata. Uploads contain attachments and avatars.

The private configuration archive and Caddy CA are sensitive. The CA is required
to retain client trust after a disaster. Valkey currently contains reconstructable
presence, typing, temporary rate-limit, and cache state; durable calendar data is
in PostgreSQL. Valkey backup is therefore optional and best-effort.

Never use a live filesystem copy of the PostgreSQL data directory as the primary
backup. Never publish private configuration or Caddy CA archives.

The PostgreSQL dump is transactionally consistent inside the database, but the
database dump and uploads archive are captured sequentially and are not one
cross-component transaction. The manifest records this as `best_effort_live`.
For strict attachment consistency, configure root-owned pre/post hooks that
quiesce writes, and include application-level attachment sampling in regular
restore drills.

A single-database `pg_dump` does not include cluster roles. On a new VM,
installer/Compose recreates the application role and database from the private
environment file. Restore uses `--no-owner --no-privileges`, making restored
objects belong to configured `POSTGRES_USER`; role password hashes are not
backed up. Valkey is non-authoritative and is not automatically restored by the
production script. Presence, typing, rate limits, and cache state rebuild after
startup.

## Installation

The release installer installs the scripts under `/opt/officechat`, creates
`/etc/officechat/backup.conf` with mode `0600` only when absent, installs systemd
units, and enables the timer only with explicit `--enable-backup-timer`. Updates
refresh versioned scripts and units while preserving the existing configuration.

Review the configurable Compose files, environment file, service names, data
paths (including `VALKEY_DATA_PATH`), and Caddy project in `backup.conf`. Add
future data directories through the colon-separated `BACKUP_EXTRA_PATHS`
setting.

Lifecycle hooks are disabled by default:

```ini
PRE_BACKUP_HOOK=
POST_BACKUP_HOOK=
POST_RESTORE_HOOK=
```

A hook must be an absolute executable wrapper path. Shell fragments and arguments
are rejected and `eval` is never used. It must be owned by root, must not be a
symlink or group/world writable, and runs with a minimal environment and
`HOOK_TIMEOUT_SECONDS`.

Private deployment configuration, the Caddy CA, and extra-path archives remain
available locally with mode `0600`, but plaintext private archives are excluded
from off-site copies by default. Configure a public `AGE_RECIPIENT` to create
encrypted `.age` copies; keep the private age identity outside OfficeChat and
outside the backup. `REQUIRE_ENCRYPTED_PRIVATE=yes` fails closed if the recipient
or `age` executable is missing. `ALLOW_PLAINTEXT_PRIVATE_OFFSITE=yes` is an
explicit, discouraged exception recorded in the manifest warnings.

## Backup

```bash
sudo /opt/officechat/backup-production.sh --config /etc/officechat/backup.conf
sudo /opt/officechat/backup-production.sh --config /etc/officechat/backup.conf --dry-run
sudo /opt/officechat/officechatctl backup
```

Before an upgrade:

```bash
sudo /opt/officechat/backup-production.sh \
  --config /etc/officechat/backup.conf \
  --pre-upgrade
```

`--pre-upgrade` includes only configured, currently used application images and
adds a `PROTECTED` marker so automatic rotation cannot remove the backup.

Backups are built under an `.partial` directory. `SUCCESS` and the final atomic
rename occur only after dump/list checks, tar checks, manifest creation, SHA-256
verification, and optional full verification.

Manifest format v1 records OfficeChat/build/script versions, Alembic and
PostgreSQL revisions, Compose project, detected/required/optional components,
image metadata, timestamps, sizes, warnings, and the location of the off-site
status receipt. Actual copy status is recorded separately so the checksummed
manifest remains immutable. Neither file contains passwords, tokens, secret
keys, environment contents, or webhook URLs.

## Verification and restore drill

```bash
sudo /opt/officechat/verify-backup.sh \
  --config /etc/officechat/backup.conf \
  /path/officechat-backup-YYYYMMDD-HHMMSSZ

sudo /opt/officechat/restore-production.sh \
  --config /etc/officechat/backup.conf \
  --verify-only \
  /path/officechat-backup-YYYYMMDD-HHMMSSZ
```

The restore drill uses a unique, ownership-labeled temporary Docker network,
volume, and PostgreSQL container without published ports or production mounts. It restores the complete
dump, checks the number of public tables/relations and Alembic revision, extracts
uploads into a temporary directory, checks PostgreSQL major compatibility,
object owners and extensions, and removes only its own labeled resources through
a trap. Tar traversal, links, special files, setuid/setgid entries, duplicate
names, and configured archive-size/member-limit violations are rejected before
extraction. It does not print message contents or personal data.

## Rotation and off-site copy

Default GFS retention is 14 daily, 8 weekly, and 12 monthly backups. Rotation only
considers correctly named directories with `SUCCESS`, ignores symlinks and active
partials, preserves protected backups and the latest successful backup, and never
touches unrelated directories.

Configure a mounted OMV/NFS destination:

```ini
OFFSITE_ROOT=/mnt/omv2/officechat
REQUIRE_OFFSITE=yes
```

Every configured off-site root must already be an active mountpoint on a
different filesystem; the script never creates a missing mount directory and
checks free space first. Off-site copies are written to `.partial`, verified, then renamed. A copy failure
does not remove the local backup. Until off-site storage is configured, local
backups do not protect against server or local-filesystem loss.
The PostgreSQL dump and uploads contain corporate data and remain regular files
inside the off-site backup. Use access-controlled storage with encrypted
transport and encryption at rest. The built-in `age` policy protects private
configuration, Caddy CA, and extra-path archives; it is not whole-volume
encryption.

## Production disaster recovery

Production restore is fail-closed and requires all confirmations:

```bash
sudo /opt/officechat/restore-production.sh \
  --config /etc/officechat/backup.conf \
  --production \
  --confirm-hostname "$(hostname)" \
  --confirm-backup officechat-backup-YYYYMMDD-HHMMSSZ \
  --yes \
  /path/officechat-backup-YYYYMMDD-HHMMSSZ
```

Non-TTY automation additionally requires explicit `--non-interactive`; it never
replaces `--production`, hostname/backup confirmations, or `--yes`.

The script creates a protected pre-restore backup and restores the complete dump
into a new staging database while production remains untouched. After SQL,
Alembic, and owner checks pass, it stops application services and switches the
staged and production databases with controlled renames. The original database
is retained under a rollback name. Uploads are validated in a staging directory
and swapped while retaining the old tree. Migrations then run, and completion is
reported only after backend `/ready` and frontend `/api/health` pass. A failure
after the switch keeps the application stopped and preserves the rollback
database, uploads, and pre-restore backup.

Unknown backup format versions are rejected. Application version differences
produce a warning. A dump from an older supported PostgreSQL version may be
restored into a compatible newer PostgreSQL release.

On a new VM:

1. install Docker Engine and Compose;
2. restore Compose and private configuration;
3. pull images or load saved pre-upgrade images;
4. run production restore;
5. restore the protected Caddy CA before starting Caddy;
6. restore SELinux contexts where applicable;
7. verify `/ready`, `/api/health`, login, and attachments;
8. rotate secrets if backup confidentiality is uncertain.

## systemd and monitoring

`officechat-backup.timer` is installed disabled by default. Enable it only after
reviewing `/etc/officechat/backup.conf`, or opt in during installation with
`--enable-backup-timer`. Once enabled it runs daily around 02:30 with a randomized
delay and `Persistent=true`. `flock` prevents parallel backup/restore execution.

```bash
systemctl list-timers officechat-backup.timer
journalctl -u officechat-backup.service
systemctl start officechat-backup.service
```

Future monitoring can read:

```text
/var/backups/officechat/status/latest.json
```

Monitor `current_result`, `last_run`, the independent `last_success`, age,
duration, verification status, off-site status, and free space. A failed run does
not erase the previous successful timestamp. Perform a full isolated restore
drill regularly.

## Cleanup and troubleshooting

GFS rotation runs only after a successful backup and ignores partial, protected,
symlinked, and unrelated directories. The active process removes its own partial
directory through a trap. Inspect journald and confirm no backup process is
running before manually removing an unknown stale partial.

For failures, inspect `systemctl status officechat-backup.service`, its journald
log, and `status/latest.json`; validate the configured Compose files; confirm the
configured PostgreSQL/backend services resolve through `compose ps -q`; and
check the OMV mount and free space. Re-run `verify-backup.sh` against the latest
directory with `SUCCESS`. Never delete a valid local backup merely because its
off-site copy failed.
