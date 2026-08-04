#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

FAKE_BIN="${TMP_DIR}/bin"
FAKE_LOG="${TMP_DIR}/docker.log"
INSTALL_DIR="${TMP_DIR}/officechat"
DATA_DIR="${TMP_DIR}/data"
UPLOADS_DIR="${DATA_DIR}/uploads"
BACKUP_ROOT="${TMP_DIR}/backups"
ENV_FILE="${INSTALL_DIR}/.env"
COMPOSE_FILE="${INSTALL_DIR}/docker-compose.yml"
HTTPS_COMPOSE_FILE="${INSTALL_DIR}/docker-compose.https-override.yml"
VERSION_COMPOSE_FILE="${INSTALL_DIR}/docker-compose.version-override.yml"
CONFIG_FILE="${TMP_DIR}/backup.conf"
STATUS_FILE="${TMP_DIR}/status/latest.json"
LOCK_FILE="${TMP_DIR}/backup.lock"

mkdir -p "$FAKE_BIN" "$INSTALL_DIR" "$UPLOADS_DIR"
printf '0.1.0-rc2\n' >"${INSTALL_DIR}/VERSION"
printf 'services: {}\n' >"$COMPOSE_FILE"
printf 'services: {}\n' >"$HTTPS_COMPOSE_FILE"
printf 'services: {}\n' >"$VERSION_COMPOSE_FILE"
printf '%s\n' \
  'POSTGRES_PASSWORD=CANARY_SECRET_DO_NOT_LEAK' \
  'APP_SECRET_KEY=CANARY_SECRET_DO_NOT_LEAK' \
  'INCOMING_WEBHOOK_URL=https://example.invalid/api/bots/incoming/SECRET_TOKEN' \
  >"$ENV_FILE"
chmod 600 "$ENV_FILE"
printf 'attachment\n' >"${UPLOADS_DIR}/sample.txt"

cat >"${FAKE_BIN}/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"$OFFICECHAT_FAKE_DOCKER_LOG"
if [[ "${1:-}" == "compose" && "$*" == *" version"* ]]; then
  [[ "$*" == *"--short"* ]] && printf '2.30.0\n' || printf 'Docker Compose version v2.30.0\n'
  exit 0
fi
if [[ "${1:-}" == "compose" && "$*" == *"config --services"* ]]; then
  printf 'postgres\nbackend\nfrontend\ncalendar-worker\nvalkey\n'
  exit 0
fi
if [[ "${1:-}" == "compose" && "$*" == *"config --images"* ]]; then
  printf 'officechat/backend:test\nofficechat/frontend:test\n'
  exit 0
fi
if [[ "${1:-}" == "compose" && "$*" == *" ps -q "* ]]; then
  printf 'fake-container-id\n'
  exit 0
fi
if [[ "${1:-}" == "compose" && "$*" == *" pg_dump "* ]]; then
  [[ "${OFFICECHAT_FAKE_DUMP_FAIL:-0}" != "1" ]] || exit 7
  printf 'FAKE-CUSTOM-DUMP\n'
  exit 0
fi
if [[ "${1:-}" == "compose" && "$*" == *"printenv POSTGRES_USER"* ]]; then
  printf 'officechat\n'
  exit 0
fi
if [[ "${1:-}" == "compose" && "$*" == *"postgres --version"* ]]; then
  printf 'postgres (PostgreSQL) 16.4\n'
  exit 0
fi
if [[ "${1:-}" == "compose" && "$*" == *"alembic current"* ]]; then
  printf '20260704_0017 (head)\n'
  exit 0
fi
if [[ "${1:-}" == "compose" && "$*" == *"APP_VERSION"* ]]; then
  printf '0.1.0-rc2\n'
  exit 0
fi
if [[ "${1:-}" == "compose" && "$*" == *"OFFICECHAT_BUILD_SHA"* ]]; then
  printf 'test-sha\n'
  exit 0
fi
if [[ "${1:-}" == "compose" && "$*" == *"POSTGRES_DB"* ]]; then
  printf 'officechat\n'
  exit 0
fi
if [[ "${1:-}" == "compose" && "$*" == *" images -q "* ]]; then
  printf 'sha256:fake-image\n'
  exit 0
fi
if [[ "${1:-}" == "image" && "${2:-}" == "inspect" ]]; then
  printf 'backend\tofficechat/backend:test\tsha256:fake-image\t\tamd64\n'
  exit 0
fi
if [[ "${1:-}" == "save" && "${2:-}" == "-o" ]]; then
  printf 'FAKE-IMAGE\n' >"$3"
  exit 0
fi
if [[ "${1:-}" == "version" ]]; then
  printf '27.0.0\n'
  exit 0
fi
if [[ "${1:-}" == "run" ]]; then
  cat >/dev/null
  exit 0
fi
if [[ "${1:-}" == "exec" && "$*" == *"information_schema.tables"* ]]; then
  printf '42\n'
  exit 0
fi
if [[ "${1:-}" == "exec" && "$*" == *"postgres --version"* ]]; then
  printf 'postgres (PostgreSQL) 16.4\n'
  exit 0
fi
if [[ "${1:-}" == "exec" && "$*" == *"alembic_version"* ]]; then
  printf '20260704_0017\n'
  exit 0
fi
if [[ "${1:-}" == "exec" && "$*" == *"pg_get_userbyid"* ]]; then
  printf '0\n'
  exit 0
fi
if [[ "${1:-}" == "exec" && "$*" == *"pg_extension"* ]]; then
  printf '1\n'
  exit 0
fi
if [[ "${1:-}" == "exec" && "$*" == *"pg_class"* ]]; then
  printf '42\n'
  exit 0
fi
if [[ "${2:-}" == "inspect" && "$*" == *"com.officechat.restore-drill"* ]]; then
  printf 'true\n'
  exit 0
fi
exit 0
EOF
chmod +x "${FAKE_BIN}/docker"

cat >"${FAKE_BIN}/mountpoint" <<'EOF'
#!/usr/bin/env bash
[[ "${OFFICECHAT_FAKE_MOUNTPOINT:-0}" == "1" ]]
EOF
chmod +x "${FAKE_BIN}/mountpoint"

write_config() {
  local root="$1"
  cat >"$CONFIG_FILE" <<EOF
BACKUP_FORMAT_VERSION=1
OFFICECHAT_DIR=${INSTALL_DIR}
OFFICECHAT_DATA_DIR=${DATA_DIR}
BACKUP_ROOT=${root}
OFFSITE_ROOT=
REQUIRE_OFFSITE=no
COMPOSE_ENV_FILE=${ENV_FILE}
COMPOSE_FILES=${COMPOSE_FILE}
COMPOSE_OPTIONAL_FILES=${HTTPS_COMPOSE_FILE}:${VERSION_COMPOSE_FILE}
COMPOSE_PROJECT_NAME=officechat-test
POSTGRES_SERVICE=postgres
BACKEND_SERVICE=backend
FRONTEND_SERVICE=frontend
WORKER_SERVICES=calendar-worker
VALKEY_SERVICE=valkey
VALKEY_DATA_PATH=/data/dump.rdb
UPLOADS_DIR=${UPLOADS_DIR}
BACKUP_EXTRA_PATHS=
PUBLIC_CONFIG_PATHS=docker-compose.yml:docker-compose.https-override.yml:docker-compose.version-override.yml
BACKUP_VALKEY=no
BACKUP_CADDY_CA=no
BACKUP_DEPLOYMENT_CONFIG=no
VERIFY_AFTER_BACKUP=yes
KEEP_DAILY=1
KEEP_WEEKLY=0
KEEP_MONTHLY=0
POSTGRES_VERIFY_IMAGE=postgres:16-alpine
IMAGE_SERVICES=frontend:backend
LOCK_FILE=${LOCK_FILE}
STATUS_FILE=${STATUS_FILE}
EOF
  chmod 600 "$CONFIG_FILE"
}

export PATH="${FAKE_BIN}:${PATH}"
export OFFICECHAT_FAKE_DOCKER_LOG="$FAKE_LOG"
# shellcheck source=backup/lib.sh
. "${SCRIPT_DIR}/backup/lib.sh"

bash -n "${SCRIPT_DIR}/backup-production.sh"
bash -n "${SCRIPT_DIR}/verify-backup.sh"
bash -n "${SCRIPT_DIR}/restore-production.sh"
bash -n "${SCRIPT_DIR}/backup/lib.sh"

if bash "${SCRIPT_DIR}/backup-production.sh" --config "${TMP_DIR}/missing.conf" >/dev/null 2>&1; then
  echo "backup accepted a missing config" >&2
  exit 1
fi

write_config "${TMP_DIR}/config-security-backups"
chmod 644 "$CONFIG_FILE"
if bash "${SCRIPT_DIR}/backup-production.sh" --config "$CONFIG_FILE" --dry-run >/dev/null 2>&1; then
  echo "backup accepted a group/world-readable config" >&2
  exit 1
fi
chmod 600 "$CONFIG_FILE"
config_symlink="${TMP_DIR}/backup-symlink.conf"
ln -s "$CONFIG_FILE" "$config_symlink"
if bash "${SCRIPT_DIR}/backup-production.sh" --config "$config_symlink" --dry-run >/dev/null 2>&1; then
  echo "backup accepted a symlink config" >&2
  exit 1
fi

symlink_backup_target="${TMP_DIR}/symlink-backup-target"
symlink_backup_root="${TMP_DIR}/symlink-backup-root"
mkdir "$symlink_backup_target"
ln -s "$symlink_backup_target" "$symlink_backup_root"
write_config "$symlink_backup_root"
if bash "${SCRIPT_DIR}/backup-production.sh" --config "$CONFIG_FILE" --dry-run >/dev/null 2>&1; then
  echo "backup dry-run accepted a symlink backup root" >&2
  exit 1
fi

write_config ""
if bash "${SCRIPT_DIR}/backup-production.sh" --config "$CONFIG_FILE" >/dev/null 2>&1; then
  echo "backup accepted an empty BACKUP_ROOT" >&2
  exit 1
fi

write_config "/tmp/.."
if bash "${SCRIPT_DIR}/backup-production.sh" --config "$CONFIG_FILE" >/dev/null 2>&1; then
  echo "backup accepted a path that resolves to the filesystem root" >&2
  exit 1
fi

write_config "$BACKUP_ROOT"
: >"$FAKE_LOG"
if ! dry_run_output="$(bash "${SCRIPT_DIR}/backup-production.sh" --config "$CONFIG_FILE" --dry-run 2>&1)"; then
  printf '%s\n' "$dry_run_output" >&2
  exit 1
fi
[[ ! -e "$BACKUP_ROOT" ]] || {
  echo "dry-run changed the backup filesystem" >&2
  exit 1
}
if grep -Eq 'pg_dump|valkey-cli SAVE| compose cp | save -o | compose stop | compose up ' "$FAKE_LOG"; then
  echo "dry-run invoked a Docker mutation" >&2
  exit 1
fi
compose_services_call="$(grep 'config --services' "$FAKE_LOG" | tail -n 1)"
expected_compose_layers="-f ${COMPOSE_FILE} -f ${HTTPS_COMPOSE_FILE} -f ${VERSION_COMPOSE_FILE} config --services"
[[ "$compose_services_call" == *"$expected_compose_layers"* ]] || {
  echo "backup did not resolve Compose layers in base, HTTPS, version order" >&2
  exit 1
}

bash "${SCRIPT_DIR}/backup-production.sh" --config "$CONFIG_FILE" >/dev/null
backup_path="$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name 'officechat-backup-*' | head -n 1)"
[[ -n "$backup_path" && -f "$backup_path/SUCCESS" ]] || {
  echo "successful backup was not published" >&2
  exit 1
}
python3 - "$backup_path/metadata/manifest.json" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as stream:
    manifest = json.load(stream)
assert manifest["backup_format_version"] == 1
assert set(manifest["required_components"]) == {"database", "uploads"}
serialized = json.dumps(manifest)
assert "CANARY_SECRET_DO_NOT_LEAK" not in serialized
assert "SECRET_TOKEN" not in serialized
assert manifest["verification_status"] == "passed"
assert manifest["consistency"]["database_and_uploads_atomic_together"] is False
PY
python3 - "$backup_path/metadata/offsite-receipt.json" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as stream:
    receipt = json.load(stream)
assert receipt["status"] == "not_configured"
PY
bash "${SCRIPT_DIR}/verify-backup.sh" --config "$CONFIG_FILE" "$backup_path" >/dev/null

if grep -R -E 'CANARY_SECRET_DO_NOT_LEAK|SECRET_TOKEN' \
    "$backup_path/metadata" "$backup_path/config/deployment-public.tar.gz" \
    >/dev/null 2>&1; then
  echo "secret canary leaked into public backup metadata" >&2
  exit 1
fi
if grep -E 'CANARY_SECRET_DO_NOT_LEAK|SECRET_TOKEN' "$FAKE_LOG" "$STATUS_FILE" \
  >/dev/null 2>&1; then
  echo "secret canary leaked into backup logs or status" >&2
  exit 1
fi

private_policy_root="${TMP_DIR}/private-policy-backups"
write_config "$private_policy_root"
cat >>"$CONFIG_FILE" <<EOF
BACKUP_DEPLOYMENT_CONFIG=yes
BACKUP_PRIVATE_CONFIG=yes
EOF
bash "${SCRIPT_DIR}/backup-production.sh" --config "$CONFIG_FILE" >/dev/null
private_policy_backup="$(find "$private_policy_root" -mindepth 1 -maxdepth 1 \
  -type d -name 'officechat-backup-*' -print -quit)"
[[ -s "$private_policy_backup/config/deployment-private.tar.gz" ]] || {
  echo "private deployment archive was not created locally" >&2
  exit 1
}
if tar -xOzf "$private_policy_backup/config/deployment-public.tar.gz" 2>/dev/null |
  grep -Eq 'CANARY_SECRET_DO_NOT_LEAK|SECRET_TOKEN'; then
  echo "secret canary leaked into public deployment archive" >&2
  exit 1
fi
tar -xOzf "$private_policy_backup/config/deployment-private.tar.gz" 2>/dev/null |
  grep -Fq 'CANARY_SECRET_DO_NOT_LEAK' || {
  echo "private deployment archive did not preserve recovery configuration" >&2
  exit 1
}

assert_restore_rejected() {
  if bash "${SCRIPT_DIR}/restore-production.sh" --config "$CONFIG_FILE" "$@" >/dev/null 2>&1; then
    echo "production restore accepted missing or invalid safety confirmations" >&2
    exit 1
  fi
}
assert_restore_rejected --production "$backup_path"
assert_restore_rejected --production --yes "$backup_path"
assert_restore_rejected --production --yes --confirm-hostname "$(hostname)" "$backup_path"
assert_restore_rejected --production --yes --confirm-hostname "$(hostname)" \
  --confirm-backup wrong "$backup_path"

failed_pre_restore_root="${TMP_DIR}/failed-pre-restore"
write_config "$failed_pre_restore_root"
: >"$FAKE_LOG"
export OFFICECHAT_FAKE_DUMP_FAIL=1
if bash "${SCRIPT_DIR}/restore-production.sh" \
  --config "$CONFIG_FILE" \
  --production \
  --confirm-hostname "$(hostname)" \
  --confirm-backup "$(basename "$backup_path")" \
  --yes \
  --non-interactive \
  "$backup_path" >/dev/null 2>&1; then
  echo "production restore continued after failed pre-restore backup" >&2
  exit 1
fi
unset OFFICECHAT_FAKE_DUMP_FAIL
if grep -Eq ' compose stop | dropdb | alter database ' "$FAKE_LOG"; then
  echo "failed pre-restore backup allowed a production mutation" >&2
  exit 1
fi

pre_upgrade_root="${TMP_DIR}/pre-upgrade-backups"
write_config "$pre_upgrade_root"
bash "${SCRIPT_DIR}/backup-production.sh" --config "$CONFIG_FILE" --pre-upgrade >/dev/null
pre_upgrade_path="$(find "$pre_upgrade_root" -mindepth 1 -maxdepth 1 -type d -name 'officechat-backup-*' | head -n 1)"
[[ -f "$pre_upgrade_path/PROTECTED" && -s "$pre_upgrade_path/images/frontend.tar" && -s "$pre_upgrade_path/images/backend.tar" ]] || {
  echo "pre-upgrade backup is not protected or does not contain configured images" >&2
  exit 1
}

hook_root="${TMP_DIR}/hook-backups"
hook_marker="${TMP_DIR}/hook-ran"
hook_script="${TMP_DIR}/backup-hook"
cat >"$hook_script" <<EOF
#!/usr/bin/env bash
printf 'hook\n' >>"${hook_marker}"
EOF
chmod +x "$hook_script"
write_config "$hook_root"
cat >>"$CONFIG_FILE" <<EOF
PRE_BACKUP_HOOK=${hook_script}
POST_BACKUP_HOOK=${hook_script}
EOF
bash "${SCRIPT_DIR}/backup-production.sh" --config "$CONFIG_FILE" --dry-run >/dev/null
[[ ! -e "$hook_marker" ]] || {
  echo "dry-run executed a lifecycle hook" >&2
  exit 1
}
bash "${SCRIPT_DIR}/backup-production.sh" --config "$CONFIG_FILE" >/dev/null
[[ "$(wc -l <"$hook_marker")" == "2" ]] || {
  echo "configured lifecycle hooks did not run exactly once" >&2
  exit 1
}

unsafe_hook="${TMP_DIR}/unsafe-hook"
cp "$hook_script" "$unsafe_hook"
chmod 777 "$unsafe_hook"
write_config "${TMP_DIR}/unsafe-hook-backups"
printf 'PRE_BACKUP_HOOK=%s\n' "$unsafe_hook" >>"$CONFIG_FILE"
if bash "${SCRIPT_DIR}/backup-production.sh" --config "$CONFIG_FILE" --dry-run >/dev/null 2>&1; then
  echo "backup accepted a world-writable lifecycle hook" >&2
  exit 1
fi

hook_symlink="${TMP_DIR}/hook-symlink"
ln -s "$hook_script" "$hook_symlink"
write_config "${TMP_DIR}/hook-symlink-backups"
printf 'PRE_BACKUP_HOOK=%s\n' "$hook_symlink" >>"$CONFIG_FILE"
if bash "${SCRIPT_DIR}/backup-production.sh" --config "$CONFIG_FILE" --dry-run >/dev/null 2>&1; then
  echo "backup accepted a symlink lifecycle hook" >&2
  exit 1
fi

hook_injection_marker="${TMP_DIR}/hook-injection-ran"
write_config "${TMP_DIR}/hook-injection-backups"
printf 'PRE_BACKUP_HOOK=%s;touch %s\n' "$hook_script" "$hook_injection_marker" >>"$CONFIG_FILE"
if bash "${SCRIPT_DIR}/backup-production.sh" --config "$CONFIG_FILE" --dry-run >/dev/null 2>&1; then
  echo "backup accepted a hook command string" >&2
  exit 1
fi
[[ ! -e "$hook_injection_marker" ]] || {
  echo "hook configuration allowed command injection" >&2
  exit 1
}

write_config "$BACKUP_ROOT"
: >"$FAKE_LOG"
bash "${SCRIPT_DIR}/restore-production.sh" --config "$CONFIG_FILE" --verify-only "$backup_path" >/dev/null
grep -q 'officechat-restore-check-' "$FAKE_LOG" || {
  echo "restore drill did not use isolated temporary Docker resources" >&2
  exit 1
}
if grep -Eq 'compose (down|stop)|/var/lib/officechat/(postgres|uploads|valkey)' "$FAKE_LOG"; then
  echo "restore drill referenced production mutation commands or data paths" >&2
  exit 1
fi
grep -q 'com.officechat.restore-drill=true' "$FAKE_LOG" || {
  echo "restore drill resources were not ownership-labeled" >&2
  exit 1
}

invalid_manifest_backup="${TMP_DIR}/invalid-manifest/officechat-backup-20260103-000000Z"
mkdir -p "$(dirname "$invalid_manifest_backup")"
cp -a "$backup_path" "$invalid_manifest_backup"
printf '{not-json\n' >"$invalid_manifest_backup/metadata/manifest.json"
generate_checksums "$invalid_manifest_backup"
if bash "${SCRIPT_DIR}/verify-backup.sh" --config "$CONFIG_FILE" \
  "$invalid_manifest_backup" >/dev/null 2>&1; then
  echo "verification accepted invalid manifest JSON" >&2
  exit 1
fi

unknown_format_backup="${TMP_DIR}/unknown-format/officechat-backup-20260104-000000Z"
mkdir -p "$(dirname "$unknown_format_backup")"
cp -a "$backup_path" "$unknown_format_backup"
python3 - "$unknown_format_backup/metadata/manifest.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    manifest = json.load(stream)
manifest["backup_format_version"] = 999
with open(sys.argv[1], "w", encoding="utf-8") as stream:
    json.dump(manifest, stream)
PY
generate_checksums "$unknown_format_backup"
if bash "${SCRIPT_DIR}/verify-backup.sh" --config "$CONFIG_FILE" \
  "$unknown_format_backup" >/dev/null 2>&1; then
  echo "verification accepted an unknown backup format" >&2
  exit 1
fi

printf 'corruption\n' >>"$backup_path/database/officechat.dump"
if bash "${SCRIPT_DIR}/verify-backup.sh" --config "$CONFIG_FILE" "$backup_path" >/dev/null 2>&1; then
  echo "verification accepted a corrupted dump" >&2
  exit 1
fi
sed -i '$d' "$backup_path/database/officechat.dump"

printf 'corruption\n' >>"$backup_path/uploads/uploads.tar.gz"
if bash "${SCRIPT_DIR}/verify-backup.sh" --config "$CONFIG_FILE" "$backup_path" >/dev/null 2>&1; then
  echo "verification accepted a corrupted archive" >&2
  exit 1
fi

failure_root="${TMP_DIR}/failed-backups"
write_config "$failure_root"
export OFFICECHAT_FAKE_DUMP_FAIL=1
if bash "${SCRIPT_DIR}/backup-production.sh" --config "$CONFIG_FILE" >/dev/null 2>&1; then
  echo "backup succeeded after pg_dump failure" >&2
  exit 1
fi
unset OFFICECHAT_FAKE_DUMP_FAIL
if find "$failure_root" -mindepth 1 -maxdepth 1 -name '*.partial' -print -quit 2>/dev/null | grep -q .; then
  echo "failed backup left a partial directory" >&2
  exit 1
fi
python3 - "$STATUS_FILE" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    status = json.load(stream)
assert status["current_result"] == "failure"
assert status["last_run"]["success"] is False
assert status["last_success"]["success"] is True
assert status["last_error"] == "Backup failed; inspect journald for the command that failed"
PY

offsite_failure_root="${TMP_DIR}/offsite-failure-backups"
write_config "$offsite_failure_root"
cat >>"$CONFIG_FILE" <<EOF
OFFSITE_ROOT=${TMP_DIR}/not-a-mountpoint
REQUIRE_OFFSITE=yes
EOF
if bash "${SCRIPT_DIR}/backup-production.sh" --config "$CONFIG_FILE" >/dev/null 2>&1; then
  echo "backup accepted a missing required off-site mount" >&2
  exit 1
fi
local_after_offsite_failure="$(
  find "$offsite_failure_root" -mindepth 1 -maxdepth 1 -type d -name 'officechat-backup-*' -print -quit
)"
[[ -n "$local_after_offsite_failure" && -f "$local_after_offsite_failure/SUCCESS" ]] || {
  echo "off-site failure removed or failed to publish the local backup" >&2
  exit 1
}
python3 - "$local_after_offsite_failure/metadata/offsite-receipt.json" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as stream:
    receipt = json.load(stream)
assert receipt["status"] == "failed"
PY

optional_offsite_root="${TMP_DIR}/optional-offsite-not-mounted"
optional_offsite_backup_root="${TMP_DIR}/optional-offsite-backups"
write_config "$optional_offsite_backup_root"
cat >>"$CONFIG_FILE" <<EOF
OFFSITE_ROOT=${optional_offsite_root}
REQUIRE_OFFSITE=no
EOF
bash "${SCRIPT_DIR}/backup-production.sh" --config "$CONFIG_FILE" >/dev/null
[[ ! -e "$optional_offsite_root" ]] || {
  echo "optional disconnected off-site path was created on the local filesystem" >&2
  exit 1
}

same_filesystem_offsite="${TMP_DIR}/same-filesystem-offsite"
mkdir "$same_filesystem_offsite"
write_config "${TMP_DIR}/same-filesystem-backups"
cat >>"$CONFIG_FILE" <<EOF
OFFSITE_ROOT=${same_filesystem_offsite}
REQUIRE_OFFSITE=yes
EOF
export OFFICECHAT_FAKE_MOUNTPOINT=1
if bash "${SCRIPT_DIR}/backup-production.sh" --config "$CONFIG_FILE" >/dev/null 2>&1; then
  echo "off-site copy accepted the backup source filesystem" >&2
  exit 1
fi
unset OFFICECHAT_FAKE_MOUNTPOINT

encrypted_policy_root="${TMP_DIR}/encrypted-policy-backups"
write_config "$encrypted_policy_root"
cat >>"$CONFIG_FILE" <<EOF
REQUIRE_ENCRYPTED_PRIVATE=yes
AGE_RECIPIENT=
EOF
if bash "${SCRIPT_DIR}/backup-production.sh" --config "$CONFIG_FILE" >/dev/null 2>&1; then
  echo "required private encryption accepted a missing age recipient" >&2
  exit 1
fi

filtered_offsite_root="${TMP_DIR}/filtered-offsite"
filtered_local_root="${TMP_DIR}/filtered-local"
mkdir "$filtered_offsite_root"
cat >"${FAKE_BIN}/stat" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "-c" && "${2:-}" == "%d" &&
  "${3:-}" == "${OFFICECHAT_FAKE_OFFSITE_DEVICE_PATH:-}" ]]; then
  printf '999999\n'
else
  exec /usr/bin/stat "$@"
fi
EOF
chmod +x "${FAKE_BIN}/stat"
write_config "$filtered_local_root"
cat >>"$CONFIG_FILE" <<EOF
OFFSITE_ROOT=${filtered_offsite_root}
REQUIRE_OFFSITE=yes
BACKUP_DEPLOYMENT_CONFIG=yes
BACKUP_PRIVATE_CONFIG=yes
EOF
export OFFICECHAT_FAKE_MOUNTPOINT=1
export OFFICECHAT_FAKE_OFFSITE_DEVICE_PATH="$filtered_offsite_root"
bash "${SCRIPT_DIR}/backup-production.sh" --config "$CONFIG_FILE" >/dev/null
filtered_local_backup="$(find "$filtered_local_root" -mindepth 1 -maxdepth 1 \
  -type d -name 'officechat-backup-*' -print -quit)"
filtered_offsite_backup="$(find "$filtered_offsite_root" -mindepth 1 -maxdepth 1 \
  -type d -name 'officechat-backup-*' -print -quit)"
[[ -s "$filtered_local_backup/config/deployment-private.tar.gz" ]] || {
  echo "local private archive was unexpectedly removed" >&2
  exit 1
}
[[ ! -e "$filtered_offsite_backup/config/deployment-private.tar.gz" ]] || {
  echo "plaintext private archive leaked to off-site storage" >&2
  exit 1
}

cat >"${FAKE_BIN}/rsync" <<'EOF'
#!/usr/bin/env bash
exit 7
EOF
chmod +x "${FAKE_BIN}/rsync"
rsync_failure_local="${TMP_DIR}/rsync-failure-local"
rsync_failure_offsite="${TMP_DIR}/rsync-failure-offsite"
mkdir "$rsync_failure_offsite"
write_config "$rsync_failure_local"
cat >>"$CONFIG_FILE" <<EOF
OFFSITE_ROOT=${rsync_failure_offsite}
REQUIRE_OFFSITE=yes
EOF
export OFFICECHAT_FAKE_OFFSITE_DEVICE_PATH="$rsync_failure_offsite"
if bash "${SCRIPT_DIR}/backup-production.sh" --config "$CONFIG_FILE" >/dev/null 2>&1; then
  echo "backup accepted an rsync off-site copy failure" >&2
  exit 1
fi
find "$rsync_failure_local" -mindepth 1 -maxdepth 1 -type d \
  -name 'officechat-backup-*' -exec test -f '{}/SUCCESS' ';' -print -quit |
  grep -q . || {
  echo "rsync failure removed or prevented the verified local backup" >&2
  exit 1
}
if find "$rsync_failure_offsite" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
  echo "rsync failure left an off-site partial directory" >&2
  exit 1
fi
rm "${FAKE_BIN}/rsync"
unset OFFICECHAT_FAKE_MOUNTPOINT OFFICECHAT_FAKE_OFFSITE_DEVICE_PATH
rm "${FAKE_BIN}/stat"

MAX_ARCHIVE_MEMBERS=100
MAX_ARCHIVE_UNCOMPRESSED_BYTES=1048576

malicious_tar="${TMP_DIR}/malicious.tar.gz"
python3 - "$malicious_tar" <<'PY'
import io
import sys
import tarfile

with tarfile.open(sys.argv[1], "w:gz") as archive:
    member = tarfile.TarInfo("../escape")
    payload = b"unsafe"
    member.size = len(payload)
    archive.addfile(member, io.BytesIO(payload))
PY
if verify_tar_paths "$malicious_tar" >/dev/null 2>&1; then
  echo "tar validation accepted path traversal" >&2
  exit 1
fi

malicious_link_tar="${TMP_DIR}/malicious-link.tar.gz"
python3 - "$malicious_link_tar" <<'PY'
import sys
import tarfile

with tarfile.open(sys.argv[1], "w:gz") as archive:
    member = tarfile.TarInfo("uploads/link")
    member.type = tarfile.SYMTYPE
    member.linkname = "/etc/passwd"
    archive.addfile(member)
PY
if verify_tar_paths "$malicious_link_tar" uploads >/dev/null 2>&1; then
  echo "tar validation accepted a symlink" >&2
  exit 1
fi

oversized_tar="${TMP_DIR}/oversized.tar.gz"
python3 - "$oversized_tar" <<'PY'
import io
import sys
import tarfile

with tarfile.open(sys.argv[1], "w:gz") as archive:
    member = tarfile.TarInfo("uploads/large")
    payload = b"x" * 32
    member.size = len(payload)
    archive.addfile(member, io.BytesIO(payload))
PY
MAX_ARCHIVE_UNCOMPRESSED_BYTES=16
if verify_tar_paths "$oversized_tar" uploads >/dev/null 2>&1; then
  echo "tar validation accepted an oversized expanded payload" >&2
  exit 1
fi
MAX_ARCHIVE_UNCOMPRESSED_BYTES=1048576

checksum_test_root="${TMP_DIR}/checksum-test"
mkdir -p "$checksum_test_root/metadata" "$checksum_test_root/database"
printf 'safe\n' >"$checksum_test_root/database/data"
generate_checksums "$checksum_test_root"
verify_checksums "$checksum_test_root"
printf '%064d  ./../escape\n' 0 >"$checksum_test_root/metadata/SHA256SUMS"
if verify_checksums "$checksum_test_root" >/dev/null 2>&1; then
  echo "checksum validation accepted path traversal" >&2
  exit 1
fi
generate_checksums "$checksum_test_root"
printf 'unexpected\n' >"$checksum_test_root/database/unexpected"
if verify_checksums "$checksum_test_root" >/dev/null 2>&1; then
  echo "checksum validation accepted an unexpected file" >&2
  exit 1
fi
KEEP_DAILY=1
KEEP_WEEKLY=0
KEEP_MONTHLY=0
rotation_root="${TMP_DIR}/rotation"
mkdir -p \
  "${rotation_root}/officechat-backup-20260101-000000Z" \
  "${rotation_root}/officechat-backup-20260102-000000Z" \
  "${rotation_root}/unrelated"
touch \
  "${rotation_root}/officechat-backup-20260101-000000Z/SUCCESS" \
  "${rotation_root}/officechat-backup-20260102-000000Z/SUCCESS"
run_rotation "$rotation_root"
[[ -d "${rotation_root}/officechat-backup-20260102-000000Z" ]] || {
  echo "rotation removed the latest backup" >&2
  exit 1
}
[[ -d "${rotation_root}/unrelated" ]] || {
  echo "rotation removed an unrelated directory" >&2
  exit 1
}

KEEP_DAILY=0
KEEP_WEEKLY=0
KEEP_MONTHLY=0
zero_retention_root="${TMP_DIR}/zero-retention"
mkdir -p \
  "${zero_retention_root}/officechat-backup-20260101-000000Z" \
  "${zero_retention_root}/officechat-backup-20260102-000000Z"
touch \
  "${zero_retention_root}/officechat-backup-20260101-000000Z/SUCCESS" \
  "${zero_retention_root}/officechat-backup-20260102-000000Z/SUCCESS"
run_rotation "$zero_retention_root"
[[ -d "${zero_retention_root}/officechat-backup-20260102-000000Z" ]] || {
  echo "zero retention removed the latest successful backup" >&2
  exit 1
}

KEEP_DAILY=1
KEEP_WEEKLY=2
KEEP_MONTHLY=3
gfs_root="${TMP_DIR}/gfs-boundaries"
for date_stamp in \
  20251231-000000Z \
  20260101-000000Z \
  20260105-000000Z \
  20260131-000000Z \
  20260201-000000Z \
  20260202-000000Z; do
  mkdir -p "${gfs_root}/officechat-backup-${date_stamp}"
  touch "${gfs_root}/officechat-backup-${date_stamp}/SUCCESS"
done
run_rotation "$gfs_root"
for retained in 20251231-000000Z 20260131-000000Z 20260201-000000Z 20260202-000000Z; do
  [[ -d "${gfs_root}/officechat-backup-${retained}" ]] || {
    echo "GFS rotation lost a year/month/week boundary representative" >&2
    exit 1
  }
done
[[ "$(find "$gfs_root" -mindepth 1 -maxdepth 1 -type d | wc -l)" == "4" ]] || {
  echo "GFS rotation retained an unexpected number of boundary backups" >&2
  exit 1
}

(
  exec 8>"${TMP_DIR}/flock-test"
  flock -n 8
  LOCK_FILE="${TMP_DIR}/flock-test"
  if (acquire_backup_lock) >/dev/null 2>&1; then
    echo "parallel flock was not rejected" >&2
    exit 1
  fi
)

echo "backup script tests passed"
