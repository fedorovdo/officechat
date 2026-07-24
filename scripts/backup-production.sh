#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=backup/lib.sh
. "${SCRIPT_DIR}/backup/lib.sh"

CONFIG_FILE="${OFFICECHAT_BACKUP_CONFIG:-/etc/officechat/backup.conf}"
INCLUDE_IMAGES=0
PRE_UPGRADE=0
PARTIAL_DIR=""
OFFSITE_PARTIAL_DIR=""
STAGING_DIR=""
START_EPOCH="$(date +%s)"
LAST_ERROR=""
STATUS_WRITTEN=0
PRE_HOOK_COMPLETED=0
POST_HOOK_COMPLETED=0

usage() {
  cat <<'EOF'
Usage: backup-production.sh [--config FILE] [--dry-run] [--include-images] [--pre-upgrade]

Creates an atomic OfficeChat production backup. --pre-upgrade implies
--include-images and protects the resulting backup from automatic rotation.
EOF
}

while (($# > 0)); do
  case "$1" in
    --config)
      (($# >= 2)) || fail "--config requires a path"
      CONFIG_FILE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --include-images)
      INCLUDE_IMAGES=1
      shift
      ;;
    --pre-upgrade)
      PRE_UPGRADE=1
      INCLUDE_IMAGES=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

write_status() {
  local success="$1"
  local backup_path="${2:-}"
  local offsite_status="${3:-not_configured}"
  local verification="${4:-not_run}"
  local error_text="${5:-}"
  local duration status_parent backup_id backup_size
  duration="$(($(date +%s) - START_EPOCH))"
  is_dry_run && return
  backup_id="$(basename "${backup_path:-}")"
  backup_size=0
  if [[ -n "$backup_path" && -d "$backup_path" ]]; then
    backup_size="$(du -sb "$backup_path" | awk '{print $1}')"
  fi
  status_parent="$(dirname "$STATUS_FILE")"
  [[ ! -L "$status_parent" ]] || fail "Status directory must not be a symlink"
  mkdir -p "$status_parent"
  chmod 700 "$status_parent"
  validate_secure_directory "$status_parent" "Status"
  if [[ -e "$STATUS_FILE" || -L "$STATUS_FILE" ]]; then
    [[ -f "$STATUS_FILE" && ! -L "$STATUS_FILE" ]] ||
      fail "Status path must be a regular non-symlink file"
    [[ "$(stat -c '%u' "$STATUS_FILE")" == "$(id -u)" ]] ||
      fail "Status file must be owned by the current user"
  fi
  python3 - "$STATUS_FILE" "$success" "$backup_id" "$backup_size" "$duration" "$offsite_status" "$verification" "$error_text" <<'PY'
import json
import os
import sys
import tempfile
from datetime import datetime, timezone

path, success, backup_id, backup_size, duration, offsite, verification, error = sys.argv[1:]
now = datetime.now(timezone.utc).isoformat()
result = {
    "timestamp": now,
    "success": success == "true",
    "backup_id": backup_id or None,
    "backup_size_bytes": int(backup_size),
    "duration_seconds": int(duration),
    "offsite_status": offsite,
    "verification_status": verification,
    "last_error": error or None,
}
previous = {}
try:
    with open(path, encoding="utf-8") as stream:
        previous = json.load(stream)
except (FileNotFoundError, json.JSONDecodeError, OSError):
    pass
last_success = previous.get("last_success")
if result["success"]:
    last_success = {key: value for key, value in result.items() if key != "last_error"}
payload = {
    "timestamp": datetime.now(timezone.utc).isoformat(),
    "success": success == "true",
    "backup_id": backup_id or None,
    "backup_size_bytes": int(backup_size),
    "duration_seconds": int(duration),
    "offsite_status": offsite,
    "verification_status": verification,
    "last_error": error or None,
    "current_result": "success" if result["success"] else "failure",
    "last_run": result,
    "last_success": last_success,
}
directory = os.path.dirname(path)
fd, temporary = tempfile.mkstemp(prefix=".latest-", dir=directory)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(payload, stream, ensure_ascii=True, indent=2)
        stream.write("\n")
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY
  STATUS_WRITTEN=1
}

write_offsite_receipt() {
  local backup_path="$1"
  local status="$2"
  local destination="${3:-}"
  local detail="${4:-}"
  python3 - "$backup_path/metadata/offsite-receipt.json" "$status" "$destination" "$detail" <<'PY'
import json
import sys
from datetime import datetime, timezone

path, status, destination, detail = sys.argv[1:]
with open(path, "w", encoding="utf-8") as stream:
    json.dump(
        {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "status": status,
            "destination": destination or None,
            "detail": detail or None,
        },
        stream,
        ensure_ascii=True,
        indent=2,
    )
    stream.write("\n")
PY
  chmod 600 "$backup_path/metadata/offsite-receipt.json"
}

cleanup() {
  local exit_code=$?
  trap - EXIT
  if [[ "$exit_code" -ne 0 ]]; then
    LAST_ERROR="Backup failed; inspect journald for the command that failed"
    if [[ -n "${STATUS_FILE:-}" && "$STATUS_WRITTEN" == "0" ]]; then
      write_status false "" "failed" "failed" "$LAST_ERROR" || true
    fi
  fi
  if [[ "$PRE_HOOK_COMPLETED" == "1" && "$POST_HOOK_COMPLETED" == "0" && -n "${POST_BACKUP_HOOK:-}" ]]; then
    run_hook "$POST_BACKUP_HOOK" "post-backup-cleanup" || true
  fi
  if [[ -n "$STAGING_DIR" && -d "$STAGING_DIR" ]]; then
    rm -rf --one-file-system "$STAGING_DIR"
  fi
  if [[ -n "$PARTIAL_DIR" && -d "$PARTIAL_DIR" ]]; then
    rm -rf --one-file-system "$PARTIAL_DIR"
  fi
  if [[ -n "$OFFSITE_PARTIAL_DIR" && -d "$OFFSITE_PARTIAL_DIR" ]]; then
    [[ "$OFFSITE_PARTIAL_DIR" == "$OFFSITE_ROOT"/officechat-backup-*.partial ]] ||
      fail "Refusing to clean an unexpected off-site partial path"
    rm -rf --one-file-system "$OFFSITE_PARTIAL_DIR"
  fi
  exit "$exit_code"
}
trap cleanup EXIT

require_command stat
require_command realpath
require_command id
load_backup_config "$CONFIG_FILE"
validate_hook "$PRE_BACKUP_HOOK"
validate_hook "$POST_BACKUP_HOOK"
require_command docker
require_command flock
require_command python3
require_command sha256sum
require_command tar
require_command find
require_command mktemp
require_command du
require_command df
require_command awk
require_command timeout
require_command env
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"
build_compose_args "$COMPOSE_FILES" "$COMPOSE_ENV_FILE" "$COMPOSE_PROJECT_NAME"
compose config --services >/dev/null
require_compose_service "$POSTGRES_SERVICE"
require_compose_service "$BACKEND_SERVICE"
acquire_backup_lock
run_hook "$PRE_BACKUP_HOOK" "pre-backup"
PRE_HOOK_COMPLETED=1

if [[ "$REQUIRE_ENCRYPTED_PRIVATE" == "yes" ]]; then
  [[ -n "$AGE_RECIPIENT" ]] || fail "REQUIRE_ENCRYPTED_PRIVATE requires AGE_RECIPIENT"
  require_command age
fi

timestamp="$(date -u +%Y%m%d-%H%M%SZ)"
backup_name="officechat-backup-${timestamp}"
final_dir="${BACKUP_ROOT}/${backup_name}"
PARTIAL_DIR="${final_dir}.partial"

[[ ! -e "$final_dir" && ! -e "$PARTIAL_DIR" ]] || fail "Backup path already exists"
if is_dry_run; then
  log "DRY-RUN: create ${PARTIAL_DIR}"
  log "DRY-RUN: dump PostgreSQL through Compose service ${POSTGRES_SERVICE}"
  log "DRY-RUN: archive uploads from ${UPLOADS_DIR}"
  [[ "$INCLUDE_IMAGES" == "0" ]] || log "DRY-RUN: save images for ${IMAGE_SERVICES}"
  [[ -z "$OFFSITE_ROOT" ]] || log "DRY-RUN: copy completed backup to ${OFFSITE_ROOT}"
  run_rotation "$BACKUP_ROOT" 1
  log "Dry-run complete; no files, images, containers, or data were changed"
  exit 0
fi

[[ ! -L "$BACKUP_ROOT" ]] || fail "Backup root must not be a symlink"
mkdir -p "$BACKUP_ROOT" "$PARTIAL_DIR"/{database,uploads,config,valkey,caddy,metadata,images,extra}
chmod 700 "$BACKUP_ROOT"
validate_secure_directory "$BACKUP_ROOT" "Backup root"
chmod 700 "$PARTIAL_DIR"

database_dump="${PARTIAL_DIR}/database/officechat.dump"
postgres_user="$(compose exec -T "$POSTGRES_SERVICE" printenv POSTGRES_USER | tr -d '\r')"
database_name="$(compose exec -T "$POSTGRES_SERVICE" printenv POSTGRES_DB | tr -d '\r')"
[[ -n "$postgres_user" && -n "$database_name" ]] ||
  fail "PostgreSQL service does not expose POSTGRES_USER and POSTGRES_DB"
compose exec -T "$POSTGRES_SERVICE" pg_isready -q -U "$postgres_user" -d "$database_name"
compose exec -T "$POSTGRES_SERVICE" pg_dump -U "$postgres_user" -d "$database_name" -Fc >"$database_dump"
[[ -s "$database_dump" ]] || fail "PostgreSQL dump is empty"
compose exec -T "$POSTGRES_SERVICE" pg_restore --list <"$database_dump" >/dev/null

postgres_version="$(compose exec -T "$POSTGRES_SERVICE" postgres --version | tr -d '\r')"
alembic_revision="$(compose exec -T "$BACKEND_SERVICE" alembic current 2>/dev/null | head -n 1 | tr -d '\r')"
officechat_version="$(
  if [[ -f "${OFFICECHAT_DIR}/VERSION" ]]; then
    head -n 1 "${OFFICECHAT_DIR}/VERSION"
  else
    compose exec -T "$BACKEND_SERVICE" printenv APP_VERSION 2>/dev/null | tr -d '\r' || printf unknown
  fi
)"
build_sha="$(compose exec -T "$BACKEND_SERVICE" printenv OFFICECHAT_BUILD_SHA 2>/dev/null | tr -d '\r' || true)"

[[ -d "$UPLOADS_DIR" && ! -L "$UPLOADS_DIR" ]] ||
  fail "Uploads path must be a real non-symlink directory"
tar --acls --xattrs --selinux --numeric-owner --one-file-system \
  -C "$(dirname "$UPLOADS_DIR")" -czf "${PARTIAL_DIR}/uploads/uploads.tar.gz" "$(basename "$UPLOADS_DIR")"
verify_tar_paths "${PARTIAL_DIR}/uploads/uploads.tar.gz" "$(basename "$UPLOADS_DIR")"

components=("database" "uploads")
optional_components=("valkey" "caddy_ca" "deployment_config" "images" "extra_paths")
skipped_components=()
warnings=()

if [[ "$BACKUP_DEPLOYMENT_CONFIG" == "yes" ]]; then
  STAGING_DIR="$(mktemp -d)"
  mkdir -p "$STAGING_DIR/public" "$STAGING_DIR/private"
  IFS=':' read -r -a public_paths <<<"$PUBLIC_CONFIG_PATHS"
  for relative_path in "${public_paths[@]}"; do
    [[ -n "$relative_path" ]] || continue
    [[ "$relative_path" != /* && "/$relative_path/" != *"/../"* ]] || fail "Unsafe public config path"
    case "$(basename "$relative_path" | tr '[:upper:]' '[:lower:]')" in
      .env|backup.conf|*.key|*.pem|*.p12|*.pfx)
        fail "Private file is not allowed in PUBLIC_CONFIG_PATHS"
        ;;
    esac
    if [[ -e "${OFFICECHAT_DIR}/${relative_path}" ]]; then
      mkdir -p "${STAGING_DIR}/public/$(dirname "$relative_path")"
      [[ ! -L "${OFFICECHAT_DIR}/${relative_path}" ]] || fail "Public config path must not be a symlink"
      cp -a "${OFFICECHAT_DIR}/${relative_path}" "${STAGING_DIR}/public/${relative_path}"
    fi
  done
  tar -C "$STAGING_DIR/public" -czf "${PARTIAL_DIR}/config/deployment-public.tar.gz" .
  verify_tar_paths "${PARTIAL_DIR}/config/deployment-public.tar.gz"
  if [[ "$BACKUP_PRIVATE_CONFIG" == "yes" ]]; then
    cp --dereference --preserve=mode,timestamps "$COMPOSE_ENV_FILE" "${STAGING_DIR}/private/officechat.env"
    cp --dereference --preserve=mode,timestamps "$CONFIG_FILE" "${STAGING_DIR}/private/backup.conf"
    tar -C "$STAGING_DIR/private" -czf "${PARTIAL_DIR}/config/deployment-private.tar.gz" .
    chmod 600 "${PARTIAL_DIR}/config/deployment-private.tar.gz"
    verify_tar_paths "${PARTIAL_DIR}/config/deployment-private.tar.gz"
    if [[ -n "$AGE_RECIPIENT" ]]; then
      require_command age
      age -r "$AGE_RECIPIENT" \
        -o "${PARTIAL_DIR}/config/deployment-private.tar.gz.age" \
        "${PARTIAL_DIR}/config/deployment-private.tar.gz"
      chmod 600 "${PARTIAL_DIR}/config/deployment-private.tar.gz.age"
    else
      warnings+=("private deployment archive is local plaintext and excluded from off-site copy")
    fi
  else
    warnings+=("private deployment configuration was explicitly excluded")
  fi
  rm -rf --one-file-system "$STAGING_DIR"
  STAGING_DIR=""
  components+=("deployment_config")
else
  skipped_components+=("deployment_config")
fi

if [[ -n "$BACKUP_EXTRA_PATHS" ]]; then
  IFS=':' read -r -a extra_paths <<<"$BACKUP_EXTRA_PATHS"
  extra_index=0
  for extra_path in "${extra_paths[@]}"; do
    [[ -n "$extra_path" ]] || continue
    require_absolute_safe_path "$extra_path"
    [[ -e "$extra_path" ]] || {
      warnings+=("extra path missing: ${extra_path}")
      continue
    }
    paths_overlap "$extra_path" "$BACKUP_ROOT" &&
      fail "BACKUP_EXTRA_PATHS must not overlap BACKUP_ROOT"
    [[ "$(realpath -m -- "$extra_path")" != "$(realpath -m -- "$OFFICECHAT_DATA_DIR")" ]] ||
      fail "BACKUP_EXTRA_PATHS must not be the production data root"
    for protected_path in "$UPLOADS_DIR" "${OFFICECHAT_DATA_DIR}/postgres" "${OFFICECHAT_DATA_DIR}/valkey"; do
      paths_overlap "$extra_path" "$protected_path" &&
        fail "BACKUP_EXTRA_PATHS overlaps an already managed production component"
    done
    if [[ -n "$OFFSITE_ROOT" ]]; then
      paths_overlap "$extra_path" "$OFFSITE_ROOT" &&
        fail "BACKUP_EXTRA_PATHS must not overlap OFFSITE_ROOT"
    fi
    extra_index=$((extra_index + 1))
    extra_archive="${PARTIAL_DIR}/extra/extra-$(printf '%02d' "$extra_index")-$(basename "$extra_path").tar.gz"
    tar --acls --xattrs --selinux --numeric-owner --one-file-system \
      -C "$(dirname "$extra_path")" -czf "$extra_archive" "$(basename "$extra_path")"
    verify_tar_paths "$extra_archive" "$(basename "$extra_path")"
    chmod 600 "$extra_archive"
    if [[ -n "$AGE_RECIPIENT" ]]; then
      require_command age
      age -r "$AGE_RECIPIENT" -o "${extra_archive}.age" "$extra_archive"
      chmod 600 "${extra_archive}.age"
    else
      warnings+=("extra path archive is local plaintext and excluded from off-site copy")
    fi
  done
  ((extra_index == 0)) || components+=("extra_paths")
else
  skipped_components+=("extra_paths")
fi

if [[ "$BACKUP_VALKEY" == "yes" || "$BACKUP_VALKEY" == "auto" ]]; then
  if [[ -n "$(compose ps -q "$VALKEY_SERVICE")" ]] && \
    compose exec -T "$VALKEY_SERVICE" valkey-cli SAVE >/dev/null 2>&1 && \
    compose cp "${VALKEY_SERVICE}:${VALKEY_DATA_PATH}" "${PARTIAL_DIR}/valkey/valkey.rdb" >/dev/null 2>&1 && \
    [[ -s "${PARTIAL_DIR}/valkey/valkey.rdb" ]]; then
    components+=("valkey")
  elif [[ "$BACKUP_VALKEY" == "yes" ]]; then
    fail "Required Valkey snapshot failed"
  else
    warnings+=("Valkey snapshot skipped; Valkey is non-authoritative")
    skipped_components+=("valkey")
  fi
else
  skipped_components+=("valkey")
fi

if [[ "$BACKUP_CADDY_CA" == "yes" ]]; then
  caddy_config_available=1
  IFS=':' read -r -a configured_caddy_files <<<"$CADDY_COMPOSE_FILES"
  for caddy_file in "${configured_caddy_files[@]}"; do
    [[ -f "$caddy_file" ]] || caddy_config_available=0
  done
  if [[ "$caddy_config_available" == "1" ]] && build_caddy_compose_args && \
    [[ -n "$(caddy_compose ps -q "$CADDY_SERVICE" 2>/dev/null)" ]] && \
    caddy_compose exec -T "$CADDY_SERVICE" tar -C "$CADDY_DATA_PATH" -czf - . \
      >"${PARTIAL_DIR}/caddy/caddy-ca.tar.gz" 2>/dev/null && \
    [[ -s "${PARTIAL_DIR}/caddy/caddy-ca.tar.gz" ]]; then
    verify_tar_paths "${PARTIAL_DIR}/caddy/caddy-ca.tar.gz"
    chmod 600 "${PARTIAL_DIR}/caddy/caddy-ca.tar.gz"
    if [[ -n "$AGE_RECIPIENT" ]]; then
      require_command age
      age -r "$AGE_RECIPIENT" \
        -o "${PARTIAL_DIR}/caddy/caddy-ca.tar.gz.age" \
        "${PARTIAL_DIR}/caddy/caddy-ca.tar.gz"
      chmod 600 "${PARTIAL_DIR}/caddy/caddy-ca.tar.gz.age"
    else
      warnings+=("Caddy CA archive is local plaintext and excluded from off-site copy")
    fi
    components+=("caddy_ca")
  else
    rm -f "${PARTIAL_DIR}/caddy/caddy-ca.tar.gz"
    warnings+=("Caddy CA archive skipped")
    skipped_components+=("caddy_ca")
  fi
else
  skipped_components+=("caddy_ca")
fi

{
  printf 'compose_project_name=%s\n' "$COMPOSE_PROJECT_NAME"
  printf 'compose_env_file=%s\n' "$COMPOSE_ENV_FILE"
  printf 'compose_files=%s\n' "$COMPOSE_FILES"
  printf 'services:\n'
  compose config --services | sed 's/^/  - /'
  printf 'images:\n'
  compose config --images | sed 's/^/  - /'
} >"${PARTIAL_DIR}/metadata/compose-config.txt"
{
  printf 'database=%s\n' "$database_name"
  printf 'postgres_version=%s\n' "$postgres_version"
  printf 'alembic_revision=%s\n' "$alembic_revision"
} >"${PARTIAL_DIR}/metadata/database-info.txt"
{
  printf 'officechat_version=%s\n' "$officechat_version"
  printf 'build_sha=%s\n' "$build_sha"
  printf 'backup_scripts_version=%s\n' "$BACKUP_SCRIPT_VERSION"
  printf 'docker=%s\n' "$(docker version --format '{{.Server.Version}}' 2>/dev/null || printf unknown)"
  printf 'compose=%s\n' "$(docker compose version --short 2>/dev/null || printf unknown)"
} >"${PARTIAL_DIR}/metadata/versions.txt"

: >"${PARTIAL_DIR}/metadata/image-digests.txt"
IFS=':' read -r -a image_services <<<"$IMAGE_SERVICES"
for service in "${image_services[@]}"; do
  [[ -n "$service" ]] || continue
  image_id="$(compose images -q "$service" | head -n 1)"
  [[ -n "$image_id" ]] || {
    warnings+=("image metadata unavailable for service ${service}")
    continue
  }
  docker image inspect --format \
    "${service}"$'\t''{{join .RepoTags ","}}'$'\t''{{.Id}}'$'\t''{{join .RepoDigests ","}}'$'\t''{{.Architecture}}' \
    "$image_id" >>"${PARTIAL_DIR}/metadata/image-digests.txt"
  if [[ "$INCLUDE_IMAGES" == "1" ]]; then
    docker save -o "${PARTIAL_DIR}/images/${service}.tar" "$image_id"
  fi
done
if [[ "$INCLUDE_IMAGES" == "1" ]]; then
  components+=("images")
else
  skipped_components+=("images")
fi

components_csv="$(IFS=,; printf '%s' "${components[*]}")"
required_csv="database,uploads"
optional_csv="$(IFS=,; printf '%s' "${optional_components[*]}")"
skipped_csv="$(IFS=,; printf '%s' "${skipped_components[*]}")"
if [[ -n "$OFFSITE_ROOT" && "$ALLOW_PLAINTEXT_PRIVATE_OFFSITE" == "yes" ]]; then
  warnings+=("plaintext private archives are explicitly allowed in the off-site copy")
fi
warnings+=("PostgreSQL and uploads are captured sequentially; use lifecycle hooks to quiesce writes when strict cross-component consistency is required")
warnings_text="$(printf '%s\n' "${warnings[@]:-}")"
offsite_configured=false
[[ -z "$OFFSITE_ROOT" ]] || offsite_configured=true
verification_status="not_requested"
[[ "$VERIFY_AFTER_BACKUP" == "no" ]] || verification_status="pending"

python3 - "${PARTIAL_DIR}/metadata/manifest.json" "$BACKUP_FORMAT_VERSION" "$officechat_version" \
  "$build_sha" "$alembic_revision" "$COMPOSE_PROJECT_NAME" "$components_csv" "$required_csv" \
  "$optional_csv" "$skipped_csv" "$postgres_version" "$offsite_configured" "$PRE_UPGRADE" \
  "$BACKUP_SCRIPT_VERSION" "$warnings_text" "$PARTIAL_DIR" "$verification_status" \
  "$BACKUP_PRIVATE_CONFIG" "$AGE_RECIPIENT" "$ALLOW_PLAINTEXT_PRIVATE_OFFSITE" <<'PY'
import json
import os
import socket
import sys
from datetime import datetime, timezone

(
    path, format_version, app_version, build_sha, alembic_revision, project_name,
    detected, required, optional, skipped, postgres_version, offsite_configured,
    pre_upgrade, script_version, warnings, backup_root, verification_status,
    private_config, age_recipient, allow_plaintext_private_offsite,
) = sys.argv[1:]

def csv(value):
    return [item for item in value.split(",") if item]

sizes = {}
for root, _, files in os.walk(backup_root):
    for name in files:
        file_path = os.path.join(root, name)
        relative = os.path.relpath(file_path, backup_root)
        sizes[relative] = os.path.getsize(file_path)

payload = {
    "backup_format_version": int(format_version),
    "backup_scripts_version": script_version,
    "timestamp": datetime.now(timezone.utc).isoformat(),
    "hostname": socket.gethostname(),
    "officechat_version": app_version,
    "build_sha": build_sha or None,
    "alembic_revision": alembic_revision or None,
    "compose_project_name": project_name or None,
    "postgresql_version": postgres_version,
    "detected_components": csv(detected),
    "required_components": csv(required),
    "optional_components": csv(optional),
    "skipped_components": csv(skipped),
    "warnings": [line for line in warnings.splitlines() if line],
    "file_sizes": sizes,
    "offsite": {
        "configured": offsite_configured == "true",
        "status_source": "metadata/offsite-receipt.json",
        "plaintext_private_allowed": allow_plaintext_private_offsite == "yes",
    },
    "private_data": {
        "local_private_config_included": private_config == "yes",
        "encrypted_copy_available": bool(age_recipient),
    },
    "consistency": {
        "mode": "best_effort_live",
        "database_and_uploads_atomic_together": False,
    },
    "verification_status": verification_status,
    "pre_upgrade": pre_upgrade == "1",
    "images": [],
}
image_metadata = os.path.join(backup_root, "metadata", "image-digests.txt")
if os.path.exists(image_metadata):
    with open(image_metadata, encoding="utf-8") as stream:
        for line in stream:
            fields = line.rstrip("\n").split("\t")
            if len(fields) == 5:
                payload["images"].append({
                    "service": fields[0],
                    "references": [item for item in fields[1].split(",") if item],
                    "image_id": fields[2],
                    "digests": [item for item in fields[3].split(",") if item],
                    "architecture": fields[4],
                })
with open(path, "w", encoding="utf-8") as stream:
    json.dump(payload, stream, ensure_ascii=True, indent=2, sort_keys=True)
    stream.write("\n")
PY

generate_checksums "$PARTIAL_DIR"
verify_checksums "$PARTIAL_DIR"

if [[ "$VERIFY_AFTER_BACKUP" == "yes" ]]; then
  "${SCRIPT_DIR}/verify-backup.sh" --config "$CONFIG_FILE" --allow-partial "$PARTIAL_DIR"
  python3 - "${PARTIAL_DIR}/metadata/manifest.json" <<'PY'
import json
import os
import sys
import tempfile

path = sys.argv[1]
with open(path, encoding="utf-8") as stream:
    manifest = json.load(stream)
manifest["verification_status"] = "passed"
directory = os.path.dirname(path)
fd, temporary = tempfile.mkstemp(prefix=".manifest-", dir=directory)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(manifest, stream, ensure_ascii=True, indent=2, sort_keys=True)
        stream.write("\n")
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY
  generate_checksums "$PARTIAL_DIR"
  verify_checksums "$PARTIAL_DIR"
  verification_status="passed"
fi

touch "$PARTIAL_DIR/SUCCESS"
if [[ "$PRE_UPGRADE" == "1" ]]; then
  touch "$PARTIAL_DIR/PROTECTED"
fi
mv "$PARTIAL_DIR" "$final_dir"
PARTIAL_DIR=""

offsite_status="not_configured"
if [[ -n "$OFFSITE_ROOT" ]]; then
  offsite_status="failed"
  require_command mountpoint
  if [[ ! -d "$OFFSITE_ROOT" || -L "$OFFSITE_ROOT" ]] || ! mountpoint -q "$OFFSITE_ROOT"; then
    write_offsite_receipt "$final_dir" "skipped" "$OFFSITE_ROOT" "destination is not an active mountpoint"
    if [[ "$REQUIRE_OFFSITE" == "yes" ]]; then
      write_offsite_receipt "$final_dir" "failed" "$OFFSITE_ROOT" "required destination is not a mountpoint"
      write_status false "$final_dir" "$offsite_status" "$verification_status" "Required off-site root is not a mountpoint"
      fail "Required off-site root is not a mountpoint"
    else
      offsite_status="skipped_not_mounted"
      warn "Off-site destination is not an active mountpoint; local backup remains valid"
    fi
  else
    local_device="$(stat -c '%d' "$BACKUP_ROOT")"
    offsite_device="$(stat -c '%d' "$OFFSITE_ROOT")"
    if [[ "$local_device" == "$offsite_device" ]]; then
      write_offsite_receipt "$final_dir" "failed" "$OFFSITE_ROOT" "destination uses the backup source filesystem"
      write_status false "$final_dir" "failed" "$verification_status" "Off-site destination is not on a separate filesystem"
      fail "Off-site destination must use a separate mounted filesystem"
    fi
    required_bytes="$(du -sb "$final_dir" | awk '{print $1}')"
    available_bytes="$(df -PB1 "$OFFSITE_ROOT" | awk 'NR==2 {print $4}')"
    [[ "$required_bytes" =~ ^[0-9]+$ && "$available_bytes" =~ ^[0-9]+$ ]] ||
      fail "Could not determine off-site free space"
    ((available_bytes > required_bytes)) || fail "Insufficient free space at off-site destination"

    offsite_partial="${OFFSITE_ROOT}/${backup_name}.partial"
    offsite_final="${OFFSITE_ROOT}/${backup_name}"
    [[ ! -e "$offsite_partial" && ! -e "$offsite_final" ]] || fail "Off-site backup path already exists"
    mountpoint -q "$OFFSITE_ROOT" || fail "Off-site mount disappeared before copy"
    [[ "$(stat -c '%d' "$OFFSITE_ROOT")" == "$offsite_device" ]] ||
      fail "Off-site destination changed before copy"
    OFFSITE_PARTIAL_DIR="$offsite_partial"
    mkdir "$offsite_partial"
    chmod 700 "$offsite_partial"
    offsite_excludes=()
    if [[ "$ALLOW_PLAINTEXT_PRIVATE_OFFSITE" == "no" ]]; then
      offsite_excludes=(
        "config/deployment-private.tar.gz"
        "caddy/caddy-ca.tar.gz"
        "extra/*.tar.gz"
      )
    fi
    if command -v rsync >/dev/null 2>&1; then
      rsync_args=(-aHAX --numeric-ids)
      for excluded in "${offsite_excludes[@]}"; do
        rsync_args+=(--exclude="/${excluded}")
      done
      if ! rsync "${rsync_args[@]}" "${final_dir}/" "${offsite_partial}/"; then
        write_offsite_receipt "$final_dir" "failed" "$OFFSITE_ROOT" "copy failed"
        fail "Off-site backup copy failed"
      fi
    else
      tar_args=(-C "$final_dir")
      for excluded in "${offsite_excludes[@]}"; do
        tar_args+=("--exclude=./${excluded}")
      done
      if ! tar "${tar_args[@]}" -cf - . | tar -C "$offsite_partial" -xf -; then
        write_offsite_receipt "$final_dir" "failed" "$OFFSITE_ROOT" "copy failed"
        fail "Off-site backup copy failed"
      fi
    fi
    python3 - "${offsite_partial}/metadata/manifest.json" "$ALLOW_PLAINTEXT_PRIVATE_OFFSITE" <<'PY'
import json
import os
import sys

path, plaintext_allowed = sys.argv[1:]
root = os.path.dirname(os.path.dirname(path))
with open(path, encoding="utf-8") as stream:
    manifest = json.load(stream)
manifest["file_sizes"] = {
    relative: os.path.getsize(os.path.join(current, name))
    for current, _, files in os.walk(root)
    for name in files
    for relative in [os.path.relpath(os.path.join(current, name), root)]
    if relative not in {
        "metadata/manifest.json",
        "metadata/SHA256SUMS",
        "metadata/offsite-receipt.json",
        "SUCCESS",
        "PROTECTED",
    }
}
manifest["offsite_payload"] = {
    "plaintext_private_included": plaintext_allowed == "yes",
    "private_encrypted_copy_included": any(
        name.endswith(".age")
        for current, _, files in os.walk(root)
        for name in files
    ),
}
with open(path, "w", encoding="utf-8") as stream:
    json.dump(manifest, stream, ensure_ascii=True, indent=2, sort_keys=True)
    stream.write("\n")
PY
    generate_checksums "$offsite_partial"
    verify_checksums "$offsite_partial"
    mountpoint -q "$OFFSITE_ROOT" || fail "Off-site mount disappeared during copy"
    [[ "$(stat -c '%d' "$OFFSITE_ROOT")" == "$offsite_device" ]] ||
      fail "Off-site destination changed during copy"
    if ! "${SCRIPT_DIR}/verify-backup.sh" --config "$CONFIG_FILE" --allow-partial "$offsite_partial"; then
      write_offsite_receipt "$final_dir" "failed" "$OFFSITE_ROOT" "verification failed"
      fail "Off-site backup verification failed"
    fi
    mv "$offsite_partial" "$offsite_final"
    OFFSITE_PARTIAL_DIR=""
    offsite_status="copied"
    write_offsite_receipt "$final_dir" "copied" "$offsite_final"
  fi
elif [[ "$REQUIRE_OFFSITE" == "yes" ]]; then
  write_offsite_receipt "$final_dir" "failed" "" "off-site backup is required but not configured"
  write_status false "$final_dir" "not_configured" "$verification_status" "Off-site backup is required but not configured"
  fail "Off-site backup is required but OFFSITE_ROOT is empty"
else
  write_offsite_receipt "$final_dir" "not_configured"
  warn "No off-site destination configured; this backup does not protect against server loss"
fi

run_rotation "$BACKUP_ROOT"
[[ "$offsite_status" != "copied" ]] || run_rotation "$OFFSITE_ROOT"
run_hook "$POST_BACKUP_HOOK" "post-backup"
POST_HOOK_COMPLETED=1
write_status true "$final_dir" "$offsite_status" "$verification_status" ""
log "Backup completed: ${final_dir}"
