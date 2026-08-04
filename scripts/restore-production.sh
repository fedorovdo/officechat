#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=backup/lib.sh
. "${SCRIPT_DIR}/backup/lib.sh"

CONFIG_FILE="${OFFICECHAT_BACKUP_CONFIG:-/etc/officechat/backup.conf}"
MODE="refuse"
CONFIRM_HOSTNAME=""
CONFIRM_BACKUP=""
BACKUP_ID=""
CONFIRMED=0
NON_INTERACTIVE=0
TEMP_CONTAINER=""
TEMP_NETWORK=""
TEMP_VOLUME=""
TEMP_UPLOADS=""
TEMP_CONTAINER_CREATED=0
TEMP_NETWORK_CREATED=0
TEMP_VOLUME_CREATED=0
RESTORE_DATABASE=""
RESTORE_DATABASE_CREATED=0
RESTORE_STAGE=""
APPLICATION_STOPPED=0
DATABASE_SWITCHED=0
ROLLBACK_DATABASE=""
ROLLBACK_UPLOADS=""

usage() {
  cat <<'EOF'
Usage:
  restore-production.sh [--config FILE] --verify-only BACKUP_PATH
  restore-production.sh [--config FILE] --verify-only --backup-id BACKUP_ID
  restore-production.sh [--config FILE] --production \
    --confirm-hostname HOSTNAME --confirm-backup BACKUP_ID --yes \
    [--non-interactive] BACKUP_PATH

The default mode refuses to modify production. --verify-only restores into an
isolated temporary PostgreSQL container without production ports or volumes.
Production restore requires root and a local TTY unless --non-interactive is
explicitly supplied together with every other confirmation.
EOF
}

while (($# > 0)); do
  case "$1" in
    --config)
      (($# >= 2)) || fail "--config requires a path"
      CONFIG_FILE="$2"
      shift 2
      ;;
    --verify-only)
      MODE="verify"
      shift
      ;;
    --production)
      MODE="production"
      shift
      ;;
    --confirm-hostname)
      (($# >= 2)) || fail "--confirm-hostname requires a value"
      CONFIRM_HOSTNAME="$2"
      shift 2
      ;;
    --confirm-backup)
      (($# >= 2)) || fail "--confirm-backup requires a value"
      CONFIRM_BACKUP="$2"
      shift 2
      ;;
    --backup-id)
      (($# >= 2)) || fail "--backup-id requires a value"
      [[ -z "$BACKUP_ID" ]] || fail "--backup-id may be supplied only once"
      BACKUP_ID="$2"
      shift 2
      ;;
    --yes)
      CONFIRMED=1
      shift
      ;;
    --non-interactive)
      NON_INTERACTIVE=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    -*)
      fail "Unknown argument: $1"
      ;;
    *)
      [[ -z "${BACKUP_PATH:-}" ]] || fail "Only one backup path is accepted"
      BACKUP_PATH="$1"
      shift
      ;;
  esac
done

[[ "$MODE" != "refuse" ]] || fail "Choose --verify-only or provide all production restore safeguards"
require_command stat
require_command realpath
require_command id
load_backup_config "$CONFIG_FILE"
if [[ -n "$BACKUP_ID" ]]; then
  [[ -z "${BACKUP_PATH:-}" ]] || fail "Use either BACKUP_PATH or --backup-id, not both"
  [[ "$BACKUP_ID" =~ ^officechat-backup-[0-9]{8}-[0-9]{6}Z$ ]] || fail "Invalid backup identifier"
  backup_root_resolved="$(realpath -m -- "$BACKUP_ROOT")"
  BACKUP_PATH="$(realpath -m -- "${BACKUP_ROOT%/}/${BACKUP_ID}")"
  [[ "$(dirname "$BACKUP_PATH")" == "$backup_root_resolved" && "$(basename "$BACKUP_PATH")" == "$BACKUP_ID" ]] ||
    fail "Backup identifier resolved outside BACKUP_ROOT"
  [[ -d "$BACKUP_PATH" && ! -L "$BACKUP_PATH" ]] || fail "Backup not found"
fi
[[ -n "${BACKUP_PATH:-}" ]] || fail "Backup path or --backup-id is required"
validate_hook "$POST_RESTORE_HOOK"
require_command docker
require_command python3
require_command tar
require_command flock
require_command mktemp
build_compose_args "$COMPOSE_FILES" "$COMPOSE_ENV_FILE" "$COMPOSE_PROJECT_NAME"
"${SCRIPT_DIR}/verify-backup.sh" --config "$CONFIG_FILE" "$BACKUP_PATH"

manifest="$BACKUP_PATH/metadata/manifest.json"
backup_id="$(basename "$BACKUP_PATH")"
readarray -t manifest_values < <(python3 - "$manifest" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    manifest = json.load(stream)
print(manifest.get("officechat_version") or "unknown")
print(manifest.get("alembic_revision") or "")
print(manifest.get("postgresql_version") or "")
print(manifest.get("compose_project_name") or "")
PY
)
backup_app_version="${manifest_values[0]}"
backup_alembic_revision="${manifest_values[1]}"
backup_postgres_version="${manifest_values[2]}"
backup_compose_project="${manifest_values[3]}"
current_app_version="$(
  if [[ -f "${OFFICECHAT_DIR}/VERSION" ]]; then
    head -n 1 "${OFFICECHAT_DIR}/VERSION"
  else
    printf unknown
  fi
)"
if [[ "$current_app_version" != "unknown" && "$backup_app_version" != "$current_app_version" ]]; then
  warn "Backup OfficeChat version ${backup_app_version} differs from installed ${current_app_version}"
fi

postgres_major() {
  sed -nE 's/.*PostgreSQL[^0-9]*([0-9]+).*/\1/p' <<<"$1" | head -n 1
}

assert_postgres_compatible() {
  local source_version="$1"
  local target_version="$2"
  local source_major target_major
  source_major="$(postgres_major "$source_version")"
  target_major="$(postgres_major "$target_version")"
  [[ "$source_major" =~ ^[0-9]+$ && "$target_major" =~ ^[0-9]+$ ]] ||
    fail "Could not determine PostgreSQL major-version compatibility"
  ((target_major >= source_major)) ||
    fail "Restore target PostgreSQL major is older than the backup source"
}

resource_has_drill_label() {
  local kind="$1"
  local name="$2"
  if [[ "$kind" == "container" ]]; then
    [[ "$(docker container inspect -f '{{ index .Config.Labels "com.officechat.restore-drill" }}' \
      "$name" 2>/dev/null || true)" == "true" ]]
  else
    [[ "$(docker "$kind" inspect -f '{{ index .Labels "com.officechat.restore-drill" }}' \
      "$name" 2>/dev/null || true)" == "true" ]]
  fi
}

cleanup_restore() {
  local exit_code=$?
  trap - EXIT INT TERM
  if [[ "$TEMP_CONTAINER_CREATED" == "1" ]] && resource_has_drill_label container "$TEMP_CONTAINER"; then
    docker rm -f "$TEMP_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [[ "$TEMP_VOLUME_CREATED" == "1" ]] && resource_has_drill_label volume "$TEMP_VOLUME"; then
    docker volume rm "$TEMP_VOLUME" >/dev/null 2>&1 || true
  fi
  if [[ "$TEMP_NETWORK_CREATED" == "1" ]] && resource_has_drill_label network "$TEMP_NETWORK"; then
    docker network rm "$TEMP_NETWORK" >/dev/null 2>&1 || true
  fi
  if [[ -n "$TEMP_UPLOADS" && -d "$TEMP_UPLOADS" ]]; then
    rm -rf --one-file-system "$TEMP_UPLOADS"
  fi
  if [[ -n "$RESTORE_STAGE" && -d "$RESTORE_STAGE" ]]; then
    rm -rf --one-file-system "$RESTORE_STAGE"
  fi
  if [[ "$RESTORE_DATABASE_CREATED" == "1" && "$DATABASE_SWITCHED" == "0" ]]; then
    compose exec -T "$POSTGRES_SERVICE" dropdb --if-exists --force \
      -U "$postgres_user" "$RESTORE_DATABASE" >/dev/null 2>&1 || true
  fi
  if [[ "$exit_code" -ne 0 && "$APPLICATION_STOPPED" == "1" ]]; then
    warn "Restore failed after application shutdown; services remain stopped for operator inspection."
    [[ -z "$ROLLBACK_DATABASE" ]] || warn "Rollback database retained: ${ROLLBACK_DATABASE}"
    [[ -z "$ROLLBACK_UPLOADS" ]] || warn "Rollback uploads retained: ${ROLLBACK_UPLOADS}"
  fi
  exit "$exit_code"
}
trap cleanup_restore EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

verify_restore() {
  local suffix password tables revision relation_count uploads_name
  local owner_mismatches extensions target_postgres_version drill_id
  suffix="$(date -u +%Y%m%d%H%M%S)-$$-${RANDOM}"
  drill_id="officechat-${suffix}"
  TEMP_CONTAINER="officechat-restore-check-${suffix}"
  TEMP_NETWORK="officechat-restore-check-${suffix}"
  TEMP_VOLUME="officechat-restore-check-${suffix}"
  TEMP_UPLOADS="$(mktemp -d)"
  password="$(python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(32))
PY
)"
  export POSTGRES_PASSWORD="$password"

  docker network create \
    --label com.officechat.restore-drill=true \
    --label "com.officechat.restore-drill-id=${drill_id}" \
    "$TEMP_NETWORK" >/dev/null
  TEMP_NETWORK_CREATED=1
  docker volume create \
    --label com.officechat.restore-drill=true \
    --label "com.officechat.restore-drill-id=${drill_id}" \
    "$TEMP_VOLUME" >/dev/null
  TEMP_VOLUME_CREATED=1
  docker run -d --name "$TEMP_CONTAINER" \
    --label com.officechat.restore-drill=true \
    --label "com.officechat.restore-drill-id=${drill_id}" \
    --network "$TEMP_NETWORK" \
    --mount "source=${TEMP_VOLUME},target=/var/lib/postgresql/data" \
    --env POSTGRES_PASSWORD \
    --env POSTGRES_USER=officechat_restore \
    --env POSTGRES_DB=officechat_restore \
    "$POSTGRES_VERIFY_IMAGE" >/dev/null
  TEMP_CONTAINER_CREATED=1
  for _ in {1..60}; do
    if docker exec "$TEMP_CONTAINER" pg_isready -q -U officechat_restore -d officechat_restore; then
      break
    fi
    sleep 1
  done
  docker exec "$TEMP_CONTAINER" pg_isready -q -U officechat_restore -d officechat_restore ||
    fail "Temporary PostgreSQL did not become ready"
  target_postgres_version="$(docker exec "$TEMP_CONTAINER" postgres --version | tr -d '\r')"
  assert_postgres_compatible "$backup_postgres_version" "$target_postgres_version"

  docker exec -i "$TEMP_CONTAINER" pg_restore \
    -U officechat_restore -d officechat_restore --no-owner --no-privileges \
    <"$BACKUP_PATH/database/officechat.dump"

  tables="$(docker exec "$TEMP_CONTAINER" psql -Atq -U officechat_restore -d officechat_restore \
    -c "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE';")"
  [[ "$tables" =~ ^[1-9][0-9]*$ ]] || fail "Restored database contains no application tables"
  revision="$(docker exec "$TEMP_CONTAINER" psql -Atq -U officechat_restore -d officechat_restore \
    -c "select coalesce((select version_num from alembic_version limit 1), '');")"
  [[ -n "$revision" ]] || fail "Restored database has no Alembic revision"
  if [[ -n "$backup_alembic_revision" && "$revision" != *"$backup_alembic_revision"* && "$backup_alembic_revision" != *"$revision"* ]]; then
    fail "Restored Alembic revision does not match the manifest"
  fi
  relation_count="$(docker exec "$TEMP_CONTAINER" psql -Atq -U officechat_restore -d officechat_restore \
    -c "select count(*) from pg_class where relnamespace='public'::regnamespace and relkind in ('r','p');")"
  [[ "$relation_count" =~ ^[1-9][0-9]*$ ]] || fail "Restored database relation smoke check failed"
  owner_mismatches="$(docker exec "$TEMP_CONTAINER" psql -Atq -U officechat_restore -d officechat_restore \
    -c "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','S','v','m') and pg_get_userbyid(c.relowner) <> current_user;")"
  [[ "$owner_mismatches" == "0" ]] || fail "Restored database contains objects owned by an unexpected role"
  extensions="$(docker exec "$TEMP_CONTAINER" psql -Atq -U officechat_restore -d officechat_restore \
    -c "select count(*) from pg_extension;")"
  [[ "$extensions" =~ ^[1-9][0-9]*$ ]] || fail "Restored database extension check failed"

  uploads_name="$(basename "$UPLOADS_DIR")"
  verify_tar_paths "$BACKUP_PATH/uploads/uploads.tar.gz" "$uploads_name"
  tar --no-same-owner --no-same-permissions -C "$TEMP_UPLOADS" \
    -xzf "$BACKUP_PATH/uploads/uploads.tar.gz"
  validate_extracted_tree "$TEMP_UPLOADS"
  [[ -d "$TEMP_UPLOADS/$uploads_name" ]] ||
    fail "Uploads restore drill did not produce the configured uploads directory"
  log "Restore drill passed: tables=${tables}, relations=${relation_count}, extensions=${extensions}, alembic=${revision}"
  log "Source PostgreSQL: ${backup_postgres_version}; verify image: ${target_postgres_version}"
}

if [[ "$MODE" == "verify" ]]; then
  verify_restore
  exit 0
fi

[[ "$(id -u)" == "0" ]] || fail "Production restore must run as root"
if [[ ! -t 0 && "$NON_INTERACTIVE" != "1" ]]; then
  fail "Production restore requires a local TTY or explicit --non-interactive"
fi
actual_hostname="$(hostname)"
[[ "$CONFIRMED" == "1" ]] || fail "Production restore requires --yes"
[[ -n "$CONFIRM_HOSTNAME" && "$CONFIRM_HOSTNAME" == "$actual_hostname" ]] ||
  fail "--confirm-hostname must exactly match this host"
[[ -n "$CONFIRM_BACKUP" && "$CONFIRM_BACKUP" == "$backup_id" ]] ||
  fail "--confirm-backup must exactly match the backup directory name"
[[ -z "$backup_compose_project" || "$backup_compose_project" == "$COMPOSE_PROJECT_NAME" ]] ||
  fail "Backup Compose project does not match the configured production project"
require_compose_service "$POSTGRES_SERVICE"
require_compose_service "$BACKEND_SERVICE"

log "Creating protected pre-restore backup"
"${SCRIPT_DIR}/backup-production.sh" --config "$CONFIG_FILE" --pre-upgrade
rollback_backup="$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d \
  -name 'officechat-backup-????????-??????Z' -exec test -f '{}/PROTECTED' ';' -print |
  sort -r | head -n 1)"
[[ -n "$rollback_backup" ]] || fail "Protected pre-restore backup was not published"
log "Protected rollback backup: ${rollback_backup}"
acquire_backup_lock

postgres_user="$(compose exec -T "$POSTGRES_SERVICE" printenv POSTGRES_USER | tr -d '\r')"
postgres_database="$(compose exec -T "$POSTGRES_SERVICE" printenv POSTGRES_DB | tr -d '\r')"
[[ "$postgres_user" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
  fail "Unsafe PostgreSQL role name from service configuration"
[[ "$postgres_database" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
  fail "Unsafe PostgreSQL database name from service configuration"
[[ "$postgres_database" != "postgres" && "$postgres_database" != "template0" && "$postgres_database" != "template1" ]] ||
  fail "Refusing to restore a PostgreSQL system database"
current_postgres_version="$(compose exec -T "$POSTGRES_SERVICE" postgres --version | tr -d '\r')"
assert_postgres_compatible "$backup_postgres_version" "$current_postgres_version"

restore_suffix="$(date -u +%Y%m%d%H%M%S)_$$"
RESTORE_DATABASE="${postgres_database}_restore_${restore_suffix}"
ROLLBACK_DATABASE="${postgres_database}_rollback_${restore_suffix}"
(( ${#RESTORE_DATABASE} <= 63 && ${#ROLLBACK_DATABASE} <= 63 )) ||
  fail "Configured PostgreSQL database name is too long for safe staged restore"

compose exec -T "$POSTGRES_SERVICE" createdb \
  -U "$postgres_user" -O "$postgres_user" "$RESTORE_DATABASE"
RESTORE_DATABASE_CREATED=1
compose exec -T "$POSTGRES_SERVICE" pg_restore \
  -U "$postgres_user" -d "$RESTORE_DATABASE" --no-owner --no-privileges \
  <"$BACKUP_PATH/database/officechat.dump"
restored_tables="$(compose exec -T "$POSTGRES_SERVICE" psql -Atq \
  -U "$postgres_user" -d "$RESTORE_DATABASE" \
  -c "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE';")"
[[ "$restored_tables" =~ ^[1-9][0-9]*$ ]] || fail "Staged database contains no application tables"
restored_revision="$(compose exec -T "$POSTGRES_SERVICE" psql -Atq \
  -U "$postgres_user" -d "$RESTORE_DATABASE" \
  -c "select coalesce((select version_num from alembic_version limit 1), '');")"
[[ -n "$restored_revision" ]] || fail "Staged database has no Alembic revision"
if [[ -n "$backup_alembic_revision" && "$restored_revision" != *"$backup_alembic_revision"* && "$backup_alembic_revision" != *"$restored_revision"* ]]; then
  fail "Staged Alembic revision differs from the backup manifest"
fi
owner_mismatches="$(compose exec -T "$POSTGRES_SERVICE" psql -Atq \
  -U "$postgres_user" -d "$RESTORE_DATABASE" \
  -c "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','S','v','m') and pg_get_userbyid(c.relowner) <> current_user;")"
[[ "$owner_mismatches" == "0" ]] || fail "Staged database contains objects owned by an unexpected role"

uploads_parent="$(dirname "$UPLOADS_DIR")"
uploads_name="$(basename "$UPLOADS_DIR")"
[[ -d "$uploads_parent" ]] || fail "Uploads parent directory does not exist: ${uploads_parent}"
verify_tar_paths "$BACKUP_PATH/uploads/uploads.tar.gz" "$uploads_name"
RESTORE_STAGE="$(mktemp -d "${uploads_parent}/.officechat-uploads-restore-XXXXXX")"
tar --no-same-owner --no-same-permissions -C "$RESTORE_STAGE" \
  -xzf "$BACKUP_PATH/uploads/uploads.tar.gz"
validate_extracted_tree "$RESTORE_STAGE"
[[ -d "$RESTORE_STAGE/$uploads_name" ]] || fail "Uploads archive has unexpected structure"
if [[ -e "$UPLOADS_DIR" ]]; then
  upload_uid="$(stat -c '%u' "$UPLOADS_DIR")"
  upload_gid="$(stat -c '%g' "$UPLOADS_DIR")"
  chown -R "$upload_uid:$upload_gid" "$RESTORE_STAGE/$uploads_name"
fi

IFS=':' read -r -a worker_services <<<"$WORKER_SERVICES"
application_services=("$BACKEND_SERVICE" "$FRONTEND_SERVICE")
for service in "${worker_services[@]}"; do
  [[ -z "$service" ]] || application_services+=("$service")
done
compose stop "${application_services[@]}"
APPLICATION_STOPPED=1

compose exec -T "$POSTGRES_SERVICE" psql -v ON_ERROR_STOP=1 \
  -U "$postgres_user" -d postgres \
  -c "select pg_terminate_backend(pid) from pg_stat_activity where datname in ('${postgres_database}','${RESTORE_DATABASE}') and pid <> pg_backend_pid();" \
  -c "alter database \"${postgres_database}\" rename to \"${ROLLBACK_DATABASE}\";" \
  -c "alter database \"${RESTORE_DATABASE}\" rename to \"${postgres_database}\";"
DATABASE_SWITCHED=1
RESTORE_DATABASE_CREATED=0
log "PostgreSQL switched atomically; rollback database: ${ROLLBACK_DATABASE}"

ROLLBACK_UPLOADS="${UPLOADS_DIR}.rollback-${restore_suffix}"
[[ ! -e "$ROLLBACK_UPLOADS" ]] || fail "Uploads rollback path already exists"
if [[ -e "$UPLOADS_DIR" ]]; then
  mv "$UPLOADS_DIR" "$ROLLBACK_UPLOADS"
fi
mv "$RESTORE_STAGE/$uploads_name" "$UPLOADS_DIR"
rm -rf --one-file-system "$RESTORE_STAGE"
RESTORE_STAGE=""
command -v restorecon >/dev/null 2>&1 && restorecon -RF "$UPLOADS_DIR" || true

compose run --rm "$BACKEND_SERVICE" alembic current
compose run --rm "$BACKEND_SERVICE" alembic upgrade head
compose run --rm "$BACKEND_SERVICE" alembic current
compose up -d "${application_services[@]}"

health_ok=0
for _ in {1..60}; do
  if compose exec -T "$BACKEND_SERVICE" python -c \
      "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/ready', timeout=3).read()" >/dev/null 2>&1 &&
    compose exec -T "$FRONTEND_SERVICE" node -e \
      "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    health_ok=1
    break
  fi
  sleep 2
done
if [[ "$health_ok" != "1" ]]; then
  compose stop "${application_services[@]}" || true
  fail "Post-restore backend/frontend health checks failed"
fi
if ! run_hook "$POST_RESTORE_HOOK" "post-restore"; then
  compose stop "${application_services[@]}" || true
  fail "Post-restore lifecycle hook failed"
fi
APPLICATION_STOPPED=0
log "Production restore completed and health checks passed."
log "Keep rollback backup ${rollback_backup}, database ${ROLLBACK_DATABASE}, and uploads ${ROLLBACK_UPLOADS} until operator acceptance."
