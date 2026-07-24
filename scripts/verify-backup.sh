#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=backup/lib.sh
. "${SCRIPT_DIR}/backup/lib.sh"

CONFIG_FILE="${OFFICECHAT_BACKUP_CONFIG:-/etc/officechat/backup.conf}"
ALLOW_PARTIAL=0

usage() {
  cat <<'EOF'
Usage: verify-backup.sh [--config FILE] BACKUP_PATH

Verifies the manifest, checksums, PostgreSQL custom dump, and tar archives.
EOF
}

while (($# > 0)); do
  case "$1" in
    --config)
      (($# >= 2)) || fail "--config requires a path"
      CONFIG_FILE="$2"
      shift 2
      ;;
    --allow-partial)
      ALLOW_PARTIAL=1
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

[[ -n "${BACKUP_PATH:-}" ]] || fail "Backup path is required"
require_command stat
require_command realpath
require_command id
load_backup_config "$CONFIG_FILE"
require_command docker
require_command python3
require_command sha256sum
require_command tar
require_command find
docker version >/dev/null 2>&1 || fail "Docker Engine is required"

backup_basename="$(basename "$BACKUP_PATH")"
if [[ "$ALLOW_PARTIAL" == "1" && "$backup_basename" == *.partial ]]; then
  backup_basename="${backup_basename%.partial}"
fi
safe_backup_name "$backup_basename" || fail "Unexpected backup directory name"
[[ -d "$BACKUP_PATH" && ! -L "$BACKUP_PATH" ]] || fail "Backup path must be a real directory"
require_absolute_safe_path "$(realpath -m -- "$BACKUP_PATH")"
validate_secure_directory "$BACKUP_PATH" "Backup"
if [[ "$ALLOW_PARTIAL" != "1" ]]; then
  [[ -f "$BACKUP_PATH/SUCCESS" ]] || fail "Backup is incomplete: SUCCESS marker is missing"
fi

manifest="$BACKUP_PATH/metadata/manifest.json"
checksums="$BACKUP_PATH/metadata/SHA256SUMS"
dump="$BACKUP_PATH/database/officechat.dump"
uploads="$BACKUP_PATH/uploads/uploads.tar.gz"
[[ -s "$manifest" ]] || fail "Backup manifest is missing or empty"
[[ -s "$checksums" ]] || fail "SHA256SUMS is missing or empty"
[[ -s "$dump" ]] || fail "PostgreSQL dump is missing or empty"
[[ -s "$uploads" ]] || fail "Uploads archive is missing or empty"
(( $(stat -c '%s' "$manifest") <= 16777216 )) || fail "Backup manifest is unreasonably large"
(( $(stat -c '%s' "$checksums") <= 67108864 )) || fail "SHA256SUMS is unreasonably large"

verify_checksums "$BACKUP_PATH"

python3 - "$manifest" "$SUPPORTED_BACKUP_FORMAT_VERSION" <<'PY'
import json
import sys

path, supported = sys.argv[1:]
with open(path, encoding="utf-8") as stream:
    manifest = json.load(stream)
if not isinstance(manifest, dict):
    raise SystemExit("Manifest root must be an object")
if manifest.get("backup_format_version") != int(supported):
    raise SystemExit("Unsupported backup_format_version")
required_keys = {
    "backup_scripts_version",
    "timestamp",
    "officechat_version",
    "alembic_revision",
    "compose_project_name",
    "postgresql_version",
    "detected_components",
    "required_components",
    "optional_components",
}
missing = sorted(required_keys - manifest.keys())
if missing:
    raise SystemExit("Manifest fields missing: " + ", ".join(missing))
list_fields = ("detected_components", "required_components", "optional_components")
if any(not isinstance(manifest[field], list) for field in list_fields):
    raise SystemExit("Manifest component fields must be arrays")
if any(not isinstance(item, str) for field in list_fields for item in manifest[field]):
    raise SystemExit("Manifest component names must be strings")
for field in (
    "backup_scripts_version",
    "timestamp",
    "officechat_version",
    "postgresql_version",
):
    if not isinstance(manifest[field], str) or not manifest[field]:
        raise SystemExit(f"Manifest field {field} must be a non-empty string")
for field in ("alembic_revision", "compose_project_name"):
    if manifest[field] is not None and not isinstance(manifest[field], str):
        raise SystemExit(f"Manifest field {field} has an invalid type")
known = {
    "database", "uploads", "valkey", "caddy_ca", "deployment_config",
    "images", "extra_paths",
}
detected = set(manifest["detected_components"])
required = set(manifest["required_components"])
optional = set(manifest["optional_components"])
if any(len(manifest[field]) != len(set(manifest[field])) for field in list_fields):
    raise SystemExit("Manifest component arrays contain duplicates")
if not detected <= known or not required <= known or not optional <= known:
    raise SystemExit("Manifest contains unknown component names")
if required != {"database", "uploads"}:
    raise SystemExit("Manifest required component policy is incompatible")
if not required.issubset(detected):
    raise SystemExit("Required components are not present in the backup")
PY

docker run --rm -i "$POSTGRES_VERIFY_IMAGE" pg_restore --list <"$dump" >/dev/null
verify_tar_paths "$uploads" "$(basename "$UPLOADS_DIR")"
tar -tzf "$uploads" >/dev/null

while IFS= read -r -d '' archive; do
  [[ -s "$archive" ]] || fail "Archive is empty: $archive"
  verify_tar_paths "$archive"
  tar -tzf "$archive" >/dev/null
done < <(
  find "$BACKUP_PATH/config" "$BACKUP_PATH/caddy" "$BACKUP_PATH/extra" \
    -type f -name '*.tar.gz' -print0 2>/dev/null
)

log "Backup verified: ${BACKUP_PATH}"
