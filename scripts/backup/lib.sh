#!/usr/bin/env bash
set -Eeuo pipefail

export BACKUP_SCRIPT_VERSION="1.0.0"
SUPPORTED_BACKUP_FORMAT_VERSION="1"
DRY_RUN="${DRY_RUN:-0}"

log() {
  printf '%s\n' "$*"
}

warn() {
  printf 'WARN: %s\n' "$*" >&2
}

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

is_dry_run() {
  [[ "$DRY_RUN" == "1" ]]
}

run_cmd() {
  if is_dry_run; then
    printf 'DRY-RUN:'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

require_absolute_safe_path() {
  local path="$1"
  local resolved lexical
  [[ -n "$path" ]] || fail "Path must not be empty"
  [[ "$path" == /* ]] || fail "Path must be absolute: $path"
  [[ "$path" != *$'\n'* && "$path" != *$'\r'* && "$path" != *$'\t'* ]] ||
    fail "Path contains control characters"
  [[ "$path" != *$'\\'* && "$path" != *'*'* && "$path" != *'?'* && "$path" != *'['* && "$path" != *']'* ]] ||
    fail "Path contains unsupported wildcard or backslash characters"
  command -v realpath >/dev/null 2>&1 || fail "Required command not found: realpath"
  resolved="$(realpath -m -- "$path")"
  lexical="$(realpath -ms -- "$path")"
  [[ "$resolved" == "$lexical" ]] || fail "Path contains a symlink component: $path"
  case "$resolved" in
    /|/var|/var/lib|/opt|/home|/root)
      fail "Refusing broad or root path: $resolved"
      ;;
  esac
}

validate_yes_no() {
  local name="$1"
  local value="$2"
  [[ "$value" == "yes" || "$value" == "no" ]] || fail "${name} must be yes or no"
}

path_is_within() {
  local child parent
  child="$(realpath -m -- "$1")"
  parent="$(realpath -m -- "$2")"
  [[ "$child" == "$parent" || "$child" == "$parent"/* ]]
}

paths_overlap() {
  path_is_within "$1" "$2" || path_is_within "$2" "$1"
}

validate_secure_directory() {
  local directory="$1"
  local label="$2"
  local owner mode
  [[ -d "$directory" && ! -L "$directory" ]] || fail "${label} directory must be a real directory"
  owner="$(stat -c '%u' "$directory")"
  mode="$(stat -c '%a' "$directory")"
  [[ "$owner" == "$(id -u)" ]] || fail "${label} directory must be owned by the current user"
  (( (8#$mode & 0022) == 0 )) || fail "${label} directory must not be group/world writable"
}

validate_secure_file() {
  local path="$1"
  local label="$2"
  local owner mode parent
  [[ -f "$path" && ! -L "$path" ]] || fail "${label} must be a regular non-symlink file"
  owner="$(stat -c '%u' "$path")"
  mode="$(stat -c '%a' "$path")"
  [[ "$owner" == "$(id -u)" ]] || fail "${label} must be owned by the current user"
  (( (8#$mode & 0077) == 0 )) || fail "${label} permissions must not grant group/world access"
  parent="$(dirname "$(realpath -- "$path")")"
  validate_secure_directory "$parent" "$label"
}

strip_config_quotes() {
  local value="$1"
  if [[ "$value" =~ ^\"(.*)\"$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  elif [[ "$value" =~ ^\'(.*)\'$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  else
    printf '%s' "$value"
  fi
}

set_config_value() {
  local key="$1"
  local value="$2"
  case "$key" in
    BACKUP_FORMAT_VERSION|OFFICECHAT_DIR|OFFICECHAT_DATA_DIR|BACKUP_ROOT|OFFSITE_ROOT|REQUIRE_OFFSITE|\
    KEEP_DAILY|KEEP_WEEKLY|KEEP_MONTHLY|BACKUP_VALKEY|BACKUP_CADDY_CA|BACKUP_DEPLOYMENT_CONFIG|\
    BACKUP_PRIVATE_CONFIG|REQUIRE_ENCRYPTED_PRIVATE|ALLOW_PLAINTEXT_PRIVATE_OFFSITE|AGE_RECIPIENT|\
    HOOK_TIMEOUT_SECONDS|MAX_ARCHIVE_MEMBERS|MAX_ARCHIVE_UNCOMPRESSED_BYTES|\
    VERIFY_AFTER_BACKUP|BACKUP_EXTRA_PATHS|PRE_BACKUP_HOOK|POST_BACKUP_HOOK|POST_RESTORE_HOOK|\
    COMPOSE_ENV_FILE|COMPOSE_FILES|COMPOSE_PROJECT_NAME|POSTGRES_SERVICE|BACKEND_SERVICE|\
    FRONTEND_SERVICE|WORKER_SERVICES|VALKEY_SERVICE|VALKEY_DATA_PATH|UPLOADS_DIR|PUBLIC_CONFIG_PATHS|\
    CADDY_COMPOSE_ENV_FILE|CADDY_COMPOSE_FILES|CADDY_COMPOSE_PROJECT_NAME|CADDY_SERVICE|\
    CADDY_DATA_PATH|POSTGRES_VERIFY_IMAGE|LOCK_FILE|STATUS_FILE|IMAGE_SERVICES)
      printf -v "$key" '%s' "$value"
      ;;
    "")
      ;;
    *)
      fail "Unknown backup configuration key: $key"
      ;;
  esac
}

load_backup_config() {
  local config_file="$1"
  local line key value
  require_absolute_safe_path "$config_file"
  validate_secure_file "$config_file" "Backup configuration"

  BACKUP_FORMAT_VERSION="1"
  OFFICECHAT_DIR="/opt/officechat"
  OFFICECHAT_DATA_DIR="/var/lib/officechat"
  BACKUP_ROOT="/var/backups/officechat/production"
  OFFSITE_ROOT=""
  export REQUIRE_OFFSITE="no"
  KEEP_DAILY="14"
  KEEP_WEEKLY="8"
  KEEP_MONTHLY="12"
  export BACKUP_VALKEY="auto"
  export BACKUP_CADDY_CA="yes"
  export BACKUP_DEPLOYMENT_CONFIG="yes"
  export BACKUP_PRIVATE_CONFIG="yes"
  export REQUIRE_ENCRYPTED_PRIVATE="no"
  export ALLOW_PLAINTEXT_PRIVATE_OFFSITE="no"
  export AGE_RECIPIENT=""
  export HOOK_TIMEOUT_SECONDS="300"
  export MAX_ARCHIVE_MEMBERS="2000000"
  export MAX_ARCHIVE_UNCOMPRESSED_BYTES="1099511627776"
  export VERIFY_AFTER_BACKUP="yes"
  export BACKUP_EXTRA_PATHS=""
  export PRE_BACKUP_HOOK=""
  export POST_BACKUP_HOOK=""
  export POST_RESTORE_HOOK=""
  COMPOSE_ENV_FILE="/opt/officechat/.env"
  export COMPOSE_FILES="/opt/officechat/docker-compose.yml:/opt/officechat/docker-compose.https-override.yml"
  export COMPOSE_PROJECT_NAME="officechat"
  export POSTGRES_SERVICE="postgres"
  export BACKEND_SERVICE="backend"
  export FRONTEND_SERVICE="frontend"
  export WORKER_SERVICES="calendar-worker"
  export VALKEY_SERVICE="valkey"
  export VALKEY_DATA_PATH="/data/dump.rdb"
  UPLOADS_DIR="/var/lib/officechat/uploads"
  export PUBLIC_CONFIG_PATHS="docker-compose.yml:docker-compose.https-override.yml:caddy/docker-compose.caddy.yml:caddy/Caddyfile.example"
  CADDY_COMPOSE_ENV_FILE="/opt/officechat/.env"
  CADDY_COMPOSE_FILES="/opt/officechat/caddy/docker-compose.caddy.yml"
  CADDY_COMPOSE_PROJECT_NAME="officechat-caddy"
  export CADDY_SERVICE="caddy"
  export CADDY_DATA_PATH="/data/caddy/pki"
  export POSTGRES_VERIFY_IMAGE="postgres:16-alpine"
  LOCK_FILE="/run/lock/officechat/backup.lock"
  STATUS_FILE="/var/backups/officechat/status/latest.json"
  export IMAGE_SERVICES="frontend:backend"

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" == *"="* ]] || fail "Invalid backup configuration line"
    key="${line%%=*}"
    value="${line#*=}"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    value="$(strip_config_quotes "$value")"
    set_config_value "$key" "$value"
  done <"$config_file"

  [[ "$BACKUP_FORMAT_VERSION" == "$SUPPORTED_BACKUP_FORMAT_VERSION" ]] || {
    fail "Unsupported configured backup format version: $BACKUP_FORMAT_VERSION"
  }
  validate_secure_file "$COMPOSE_ENV_FILE" "Compose environment"
  require_absolute_safe_path "$OFFICECHAT_DIR"
  require_absolute_safe_path "$OFFICECHAT_DATA_DIR"
  require_absolute_safe_path "$BACKUP_ROOT"
  require_absolute_safe_path "$COMPOSE_ENV_FILE"
  require_absolute_safe_path "$UPLOADS_DIR"
  require_absolute_safe_path "$LOCK_FILE"
  require_absolute_safe_path "$STATUS_FILE"
  [[ -z "$OFFSITE_ROOT" ]] || require_absolute_safe_path "$OFFSITE_ROOT"
  for protected_path in "$OFFICECHAT_DIR" "$OFFICECHAT_DATA_DIR" "$BACKUP_ROOT" "$UPLOADS_DIR" "$LOCK_FILE" "$STATUS_FILE"; do
    [[ ! -L "$protected_path" ]] || fail "Configured path must not be a symlink: $protected_path"
  done
  if [[ -n "$OFFSITE_ROOT" && -L "$OFFSITE_ROOT" ]]; then
    fail "OFFSITE_ROOT must not be a symlink"
  fi
  [[ "$KEEP_DAILY" =~ ^[0-9]+$ ]] || fail "KEEP_DAILY must be a non-negative integer"
  [[ "$KEEP_WEEKLY" =~ ^[0-9]+$ ]] || fail "KEEP_WEEKLY must be a non-negative integer"
  [[ "$KEEP_MONTHLY" =~ ^[0-9]+$ ]] || fail "KEEP_MONTHLY must be a non-negative integer"
  [[ "$HOOK_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || fail "HOOK_TIMEOUT_SECONDS must be a positive integer"
  [[ "$MAX_ARCHIVE_MEMBERS" =~ ^[1-9][0-9]*$ ]] || fail "MAX_ARCHIVE_MEMBERS must be a positive integer"
  [[ "$MAX_ARCHIVE_UNCOMPRESSED_BYTES" =~ ^[1-9][0-9]*$ ]] ||
    fail "MAX_ARCHIVE_UNCOMPRESSED_BYTES must be a positive integer"
  validate_yes_no "REQUIRE_OFFSITE" "$REQUIRE_OFFSITE"
  validate_yes_no "BACKUP_PRIVATE_CONFIG" "$BACKUP_PRIVATE_CONFIG"
  validate_yes_no "REQUIRE_ENCRYPTED_PRIVATE" "$REQUIRE_ENCRYPTED_PRIVATE"
  validate_yes_no "ALLOW_PLAINTEXT_PRIVATE_OFFSITE" "$ALLOW_PLAINTEXT_PRIVATE_OFFSITE"
  validate_yes_no "BACKUP_CADDY_CA" "$BACKUP_CADDY_CA"
  validate_yes_no "BACKUP_DEPLOYMENT_CONFIG" "$BACKUP_DEPLOYMENT_CONFIG"
  validate_yes_no "VERIFY_AFTER_BACKUP" "$VERIFY_AFTER_BACKUP"
  [[ "$BACKUP_VALKEY" == "yes" || "$BACKUP_VALKEY" == "no" || "$BACKUP_VALKEY" == "auto" ]] ||
    fail "BACKUP_VALKEY must be yes, no, or auto"

  paths_overlap "$BACKUP_ROOT" "$OFFICECHAT_DATA_DIR" &&
    fail "BACKUP_ROOT must be outside OFFICECHAT_DATA_DIR"
  paths_overlap "$BACKUP_ROOT" "$UPLOADS_DIR" &&
    fail "BACKUP_ROOT must not overlap UPLOADS_DIR"
  if [[ -n "$OFFSITE_ROOT" ]]; then
    paths_overlap "$OFFSITE_ROOT" "$BACKUP_ROOT" &&
      fail "OFFSITE_ROOT and BACKUP_ROOT must not overlap"
    paths_overlap "$OFFSITE_ROOT" "$OFFICECHAT_DATA_DIR" &&
      fail "OFFSITE_ROOT must be outside OFFICECHAT_DATA_DIR"
  fi
  paths_overlap "$STATUS_FILE" "$OFFICECHAT_DATA_DIR" &&
    fail "STATUS_FILE must be outside OFFICECHAT_DATA_DIR"
  path_is_within "$STATUS_FILE" "$BACKUP_ROOT" &&
    fail "STATUS_FILE must be outside BACKUP_ROOT"
  paths_overlap "$LOCK_FILE" "$OFFICECHAT_DATA_DIR" &&
    fail "LOCK_FILE must be outside OFFICECHAT_DATA_DIR"
  return 0
}

build_compose_args() {
  local compose_files="$1"
  local env_file="$2"
  local project_name="$3"
  local file
  COMPOSE_ARGS=(docker compose --env-file "$env_file")
  [[ -z "$project_name" ]] || COMPOSE_ARGS+=(--project-name "$project_name")
  IFS=':' read -r -a compose_file_list <<<"$compose_files"
  ((${#compose_file_list[@]} > 0)) || fail "No Compose files configured"
  for file in "${compose_file_list[@]}"; do
    require_absolute_safe_path "$file"
    [[ -f "$file" && ! -L "$file" ]] || fail "Compose file must be a regular non-symlink file: $file"
    COMPOSE_ARGS+=(-f "$file")
  done
}

compose() {
  "${COMPOSE_ARGS[@]}" "$@"
}

build_caddy_compose_args() {
  local file
  CADDY_COMPOSE_ARGS=(docker compose --env-file "$CADDY_COMPOSE_ENV_FILE")
  [[ -z "$CADDY_COMPOSE_PROJECT_NAME" ]] || CADDY_COMPOSE_ARGS+=(--project-name "$CADDY_COMPOSE_PROJECT_NAME")
  IFS=':' read -r -a caddy_compose_file_list <<<"$CADDY_COMPOSE_FILES"
  for file in "${caddy_compose_file_list[@]}"; do
    require_absolute_safe_path "$file"
    [[ -f "$file" ]] || fail "Caddy Compose file not found: $file"
    CADDY_COMPOSE_ARGS+=(-f "$file")
  done
}

caddy_compose() {
  "${CADDY_COMPOSE_ARGS[@]}" "$@"
}

require_compose_service() {
  local service="$1"
  local container_id
  container_id="$(compose ps -q "$service")"
  [[ -n "$container_id" ]] || fail "Compose service is not running: $service"
}

acquire_backup_lock() {
  local lock_parent
  if is_dry_run; then
    log "DRY-RUN: acquire flock ${LOCK_FILE}"
    return
  fi
  lock_parent="$(dirname "$LOCK_FILE")"
  [[ -d "$lock_parent" ]] || mkdir -p "$lock_parent"
  validate_secure_directory "$lock_parent" "Lock"
  [[ ! -L "$LOCK_FILE" ]] || fail "Lock file must not be a symlink"
  if [[ -e "$LOCK_FILE" ]]; then
    [[ -f "$LOCK_FILE" ]] || fail "Lock path must be a regular file"
    [[ "$(stat -c '%u' "$LOCK_FILE")" == "$(id -u)" ]] ||
      fail "Lock file must be owned by the current user"
  fi
  exec 9>"$LOCK_FILE"
  chmod 600 "$LOCK_FILE"
  flock -n 9 || fail "Another OfficeChat backup or restore operation is running"
}

validate_hook() {
  local hook="$1"
  local owner mode parent
  [[ -z "$hook" ]] && return
  require_absolute_safe_path "$hook"
  [[ -f "$hook" && ! -L "$hook" ]] || fail "Lifecycle hook must be a regular non-symlink file"
  owner="$(stat -c '%u' "$hook")"
  mode="$(stat -c '%a' "$hook")"
  [[ "$owner" == "$(id -u)" ]] || fail "Lifecycle hook must be owned by the current user"
  (( (8#$mode & 0022) == 0 )) || fail "Lifecycle hook must not be group/world writable"
  parent="$(dirname "$(realpath -- "$hook")")"
  validate_secure_directory "$parent" "Lifecycle hook"
  [[ -x "$hook" ]] || fail "Lifecycle hook is not executable: $hook"
}

run_hook() {
  local hook="$1"
  local name="$2"
  [[ -z "$hook" ]] && return
  validate_hook "$hook"
  log "Running ${name} hook"
  if is_dry_run; then
    log "DRY-RUN: lifecycle hook ${name} (${hook})"
    return
  fi
  timeout --foreground "${HOOK_TIMEOUT_SECONDS}s" \
    env -i PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    HOME="/root" OFFICECHAT_BACKUP_PHASE="$name" "$hook"
}

safe_backup_name() {
  [[ "$1" =~ ^officechat-backup-[0-9]{8}-[0-9]{6}Z$ ]]
}

validate_backup_directory() {
  local backup_path="$1"
  [[ -d "$backup_path" ]] || fail "Backup directory not found: $backup_path"
  safe_backup_name "$(basename "$backup_path")" || fail "Unexpected backup directory name"
  [[ ! -L "$backup_path" ]] || fail "Refusing symlink backup directory"
  validate_secure_directory "$backup_path" "Backup"
}

verify_tar_paths() {
  local archive="$1"
  local expected_root="${2:-}"
  python3 - "$archive" "$expected_root" "$MAX_ARCHIVE_MEMBERS" "$MAX_ARCHIVE_UNCOMPRESSED_BYTES" <<'PY'
import pathlib
import sys
import tarfile

archive, expected_root, max_members, max_bytes = sys.argv[1:]
max_members = int(max_members)
max_bytes = int(max_bytes)
seen = set()
total_size = 0
top_levels = set()

with tarfile.open(archive, "r:*") as stream:
    for index, member in enumerate(stream, start=1):
        if index > max_members:
            raise SystemExit("Archive contains too many members")
        path = pathlib.PurePosixPath(member.name)
        if "\\" in member.name or any(ord(character) < 32 for character in member.name):
            raise SystemExit("Archive member name contains unsupported characters")
        if member.name in (".", "./"):
            if not member.isdir():
                raise SystemExit("Archive root entry must be a directory")
            if "." in seen:
                raise SystemExit("Archive contains duplicate member names")
            seen.add(".")
            continue
        if path.is_absolute() or ".." in path.parts or not path.parts:
            raise SystemExit("Archive contains an unsafe member path")
        normalized = path.as_posix()
        if normalized in seen:
            raise SystemExit("Archive contains duplicate member names")
        seen.add(normalized)
        meaningful = [part for part in path.parts if part not in ("", ".")]
        if meaningful:
            top_levels.add(meaningful[0])
        if member.issym() or member.islnk():
            raise SystemExit("Archive links are not allowed")
        if member.isdev() or member.isfifo() or not (member.isfile() or member.isdir()):
            raise SystemExit("Archive contains a special file")
        if member.mode & 0o6000:
            raise SystemExit("Archive contains setuid/setgid permissions")
        if member.uid < 0 or member.gid < 0 or member.uid > 2**31 - 1 or member.gid > 2**31 - 1:
            raise SystemExit("Archive contains an invalid owner")
        total_size += member.size
        if total_size > max_bytes:
            raise SystemExit("Archive uncompressed size exceeds the configured limit")

if expected_root and top_levels != {expected_root}:
    raise SystemExit("Archive does not contain exactly the configured top-level directory")
PY
}

validate_extracted_tree() {
  local root="$1"
  python3 - "$root" <<'PY'
import os
import pathlib
import stat
import sys

root = pathlib.Path(sys.argv[1]).resolve(strict=True)
for current, directories, files in os.walk(root, followlinks=False):
    for name in [*directories, *files]:
        path = pathlib.Path(current, name)
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
            raise SystemExit("Extracted tree contains a link or special file")
        resolved = path.resolve(strict=True)
        if os.path.commonpath((str(root), str(resolved))) != str(root):
            raise SystemExit("Extracted path escaped the destination")
PY
}

generate_checksums() {
  local backup_path="$1"
  (
    cd "$backup_path"
    find . -type f \
      ! -path './metadata/SHA256SUMS' \
      ! -path './SUCCESS' \
      ! -path './PROTECTED' \
      ! -path './metadata/offsite-receipt.json' \
      -print0 | sort -z | xargs -0 sha256sum >metadata/SHA256SUMS
  )
}

verify_checksums() {
  local backup_path="$1"
  python3 - "$backup_path" <<'PY' || return 1
import os
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1]).resolve(strict=True)
checksum_path = root / "metadata" / "SHA256SUMS"
if not checksum_path.is_file() or checksum_path.is_symlink():
    raise SystemExit("SHA256SUMS must be a regular non-symlink file")
pattern = re.compile(r"^([0-9a-f]{64}) [ *](\./.+)$")
listed = set()
for line in checksum_path.read_text(encoding="utf-8").splitlines():
    match = pattern.fullmatch(line)
    if not match:
        raise SystemExit("Invalid SHA256SUMS line")
    relative_text = match.group(2)
    relative = pathlib.PurePosixPath(relative_text[2:])
    if relative.is_absolute() or ".." in relative.parts:
        raise SystemExit("Unsafe SHA256SUMS path")
    normalized = "./" + relative.as_posix()
    if normalized in listed:
        raise SystemExit("Duplicate SHA256SUMS path")
    listed.add(normalized)

excluded = {
    "./metadata/SHA256SUMS",
    "./metadata/offsite-receipt.json",
    "./SUCCESS",
    "./PROTECTED",
}
actual = set()
for current, directories, files in os.walk(root, followlinks=False):
    for name in [*directories, *files]:
        candidate = pathlib.Path(current, name)
        if candidate.is_symlink():
            raise SystemExit("Backup tree contains a symlink")
    for name in files:
        candidate = pathlib.Path(current, name)
        relative = "./" + candidate.relative_to(root).as_posix()
        if relative not in excluded:
            actual.add(relative)
if listed != actual:
    missing = sorted(actual - listed)
    unexpected = sorted(listed - actual)
    raise SystemExit(
        "SHA256SUMS file set mismatch; missing=%r unexpected=%r" % (missing, unexpected)
    )
PY
  (
    cd "$backup_path"
    sha256sum --strict -c metadata/SHA256SUMS >/dev/null
  )
}

run_rotation() {
  local root="$1"
  local dry_run="${2:-0}"
  local backup name day week month keep
  local latest_kept=0
  local -A kept_day=()
  local -A kept_week=()
  local -A kept_month=()
  local -a backups=()
  local -a delete_candidates=()

  require_absolute_safe_path "$root"
  [[ -d "$root" ]] || return 0
  while IFS= read -r backup; do
    backups+=("$backup")
  done < <(find "$root" -mindepth 1 -maxdepth 1 -type d -name 'officechat-backup-????????-??????Z' -print | sort -r)
  ((${#backups[@]} <= 1)) && return 0

  for backup in "${backups[@]}"; do
    [[ ! -L "$backup" && -f "$backup/SUCCESS" ]] || continue
    [[ ! -f "$backup/PROTECTED" ]] || continue
    name="$(basename "$backup")"
    day="${name:18:8}"
    week="$(date -u -d "${day:0:4}-${day:4:2}-${day:6:2}" +%G-%V)"
    month="${day:0:6}"
    keep=0
    if [[ -z "${kept_day[$day]:-}" ]] && ((${#kept_day[@]} < KEEP_DAILY)); then
      kept_day["$day"]=1
      keep=1
    fi
    if [[ -z "${kept_week[$week]:-}" ]] && ((${#kept_week[@]} < KEEP_WEEKLY)); then
      kept_week["$week"]=1
      keep=1
    fi
    if [[ -z "${kept_month[$month]:-}" ]] && ((${#kept_month[@]} < KEEP_MONTHLY)); then
      kept_month["$month"]=1
      keep=1
    fi
    if [[ "$latest_kept" == "0" ]]; then
      latest_kept=1
      keep=1
    fi
    [[ "$keep" == "1" ]] || delete_candidates+=("$backup")
  done

  for backup in "${delete_candidates[@]}"; do
    [[ "$backup" == "$root"/officechat-backup-* ]] || fail "Rotation path escaped backup root"
    [[ ! -L "$backup" && -f "$backup/SUCCESS" ]] || continue
    if [[ "$dry_run" == "1" || "$DRY_RUN" == "1" ]]; then
      log "DRY-RUN: rotate ${backup}"
    else
      log "Rotating old backup: ${backup}"
      rm -rf --one-file-system "$backup"
    fi
  done
}
