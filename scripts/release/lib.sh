#!/usr/bin/env bash
set -Eeuo pipefail

OFFICECHAT_RELEASE_VERSION="${OFFICECHAT_RELEASE_VERSION:-}"
if [[ -z "$OFFICECHAT_RELEASE_VERSION" ]]; then
  bundled_version_file="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/VERSION"
  if [[ -f "$bundled_version_file" ]]; then
    IFS= read -r OFFICECHAT_RELEASE_VERSION <"$bundled_version_file"
  fi
  OFFICECHAT_RELEASE_VERSION="${OFFICECHAT_RELEASE_VERSION:-0.1.0-rc2}"
fi
OFFICECHAT_RELEASE_REVISION="${OFFICECHAT_RELEASE_REVISION:-}"
OFFICECHAT_RELEASE_BUILD_DATE="${OFFICECHAT_RELEASE_BUILD_DATE:-}"
OFFICECHAT_INSTALL_DIR="${OFFICECHAT_INSTALL_DIR:-/opt/officechat}"
OFFICECHAT_DATA_DIR="${OFFICECHAT_DATA_DIR:-/var/lib/officechat}"
OFFICECHAT_BACKUP_DIR="${OFFICECHAT_BACKUP_DIR:-/var/backups/officechat}"
OFFICECHAT_COMPOSE_FILE="${OFFICECHAT_COMPOSE_FILE:-${OFFICECHAT_INSTALL_DIR}/docker-compose.yml}"
OFFICECHAT_HTTPS_OVERRIDE_FILE="${OFFICECHAT_HTTPS_OVERRIDE_FILE:-${OFFICECHAT_INSTALL_DIR}/docker-compose.https-override.yml}"
OFFICECHAT_VERSION_OVERRIDE_FILE="${OFFICECHAT_VERSION_OVERRIDE_FILE:-${OFFICECHAT_INSTALL_DIR}/docker-compose.version-override.yml}"
OFFICECHAT_ENV_FILE="${OFFICECHAT_ENV_FILE:-${OFFICECHAT_INSTALL_DIR}/.env}"
OFFICECHAT_LOCK_FILE="${OFFICECHAT_LOCK_FILE:-/tmp/officechat-release.lock}"
OFFICECHAT_PROJECT_NAME="${OFFICECHAT_PROJECT_NAME:-officechat}"
OFFICECHAT_BACKUP_GROUP="${OFFICECHAT_BACKUP_GROUP:-officechat-backup}"
OFFICECHAT_BACKUP_CONFIG_FILE="${OFFICECHAT_BACKUP_CONFIG_FILE:-/etc/officechat/backup.conf}"
OFFICECHAT_BACKUP_AGENT_CONFIG_FILE="${OFFICECHAT_BACKUP_AGENT_CONFIG_FILE:-/etc/officechat/backup-agent.conf}"
OFFICECHAT_BACKUP_AGENT_UNIT_FILE="${OFFICECHAT_BACKUP_AGENT_UNIT_FILE:-/etc/systemd/system/officechat-backup-agent.service}"
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

pass() {
  printf 'PASS: %s\n' "$*"
}

is_dry_run() {
  [[ "$DRY_RUN" == "1" ]]
}

set_dry_run() {
  DRY_RUN=1
}

run_cmd() {
  if is_dry_run; then
    printf 'DRY-RUN:'
    for arg in "$@"; do
      printf ' %q' "$arg"
    done
    printf '\n'
    return 0
  else
    "$@"
  fi
}

require_root_or_sudo() {
  if [[ "$(id -u)" -ne 0 ]] && ! command -v sudo >/dev/null 2>&1; then
    fail "Run as root or install sudo."
  fi
}

as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    run_cmd "$@"
  else
    run_cmd sudo "$@"
  fi
}

require_safe_path() {
  local path="$1"
  local resolved lexical
  [[ -n "$path" ]] || fail "Path must not be empty"
  [[ "$path" == /* ]] || fail "Path must be absolute: $path"
  [[ "$path" != *$'\n'* && "$path" != *$'\r'* && "$path" != *$'\t'* ]] ||
    fail "Path contains control characters"
  [[ "$path" != *$'\\'* && "$path" != *'*'* && "$path" != *'?'* &&
    "$path" != *'['* && "$path" != *']'* && "$path" != *'|'* && "$path" != *'&'* ]] ||
    fail "Path contains unsupported shell or wildcard characters"
  require_command realpath
  resolved="$(realpath -m -- "$path")"
  lexical="$(realpath -ms -- "$path")"
  [[ "$resolved" == "$lexical" ]] || fail "Path contains a symlink component: $path"
  case "$resolved" in
    /|/var|/var/lib|/opt|/home|/root)
      fail "Refusing broad or root path: $resolved"
      ;;
  esac
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

require_docker_compose() {
  require_command docker
  docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"
}

validate_version() {
  local version="$1"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9._-]+)?$ ]] || fail "Invalid OfficeChat version: $version"
}

validate_revision() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] || fail "Invalid release revision"
}

validate_build_date() {
  local normalized
  [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
    fail "Invalid release build date"
  normalized="$(date -u -d "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)" || fail "Invalid release build date"
  [[ "$normalized" == "$1" ]] || fail "Invalid release build date"
}

require_compose_file() {
  local file="$1"
  require_safe_path "$file"
  [[ -f "$file" && ! -L "$file" ]] || fail "Compose file must be a regular non-symlink file: $file"
}

compose_with_stack() {
  local env_file="$1"
  local base_file="$2"
  local https_file="$3"
  local version_file="$4"
  shift 4
  local -a args=(docker compose --project-name "$OFFICECHAT_PROJECT_NAME" --env-file "$env_file")
  require_compose_file "$base_file"
  args+=(-f "$base_file")
  if [[ -n "$https_file" && -f "$https_file" ]]; then
    require_compose_file "$https_file"
    args+=(-f "$https_file")
  fi
  if [[ -n "$version_file" && -f "$version_file" ]]; then
    require_compose_file "$version_file"
    args+=(-f "$version_file")
  fi
  "${args[@]}" "$@"
}

compose() {
  compose_with_stack "$OFFICECHAT_ENV_FILE" "$OFFICECHAT_COMPOSE_FILE" \
    "$OFFICECHAT_HTTPS_OVERRIDE_FILE" "$OFFICECHAT_VERSION_OVERRIDE_FILE" "$@"
}

print_compose_files() {
  log "Compose files:"
  log "  $OFFICECHAT_COMPOSE_FILE"
  [[ ! -f "$OFFICECHAT_HTTPS_OVERRIDE_FILE" ]] || log "  $OFFICECHAT_HTTPS_OVERRIDE_FILE"
  [[ ! -f "$OFFICECHAT_VERSION_OVERRIDE_FILE" ]] || log "  $OFFICECHAT_VERSION_OVERRIDE_FILE"
}

write_version_override() {
  local destination="$1"
  local version="$2"
  local revision="${3:-}"
  local build_date="${4:-}"
  validate_version "$version"
  [[ -z "$revision" ]] || validate_revision "$revision"
  [[ -z "$build_date" ]] || validate_build_date "$build_date"
  cat >"$destination" <<EOF_OVERRIDE
services:
  backend:
    image: ghcr.io/fedorovdo/officechat-backend:${version}
  calendar-worker:
    image: ghcr.io/fedorovdo/officechat-backend:${version}
  frontend:
    image: ghcr.io/fedorovdo/officechat-frontend:${version}
    environment:
      NEXT_PUBLIC_OFFICECHAT_VERSION: ${version}
      NEXT_PUBLIC_OFFICECHAT_BUILD_SHA: ${revision}
      NEXT_PUBLIC_OFFICECHAT_BUILD_DATE: ${build_date}
EOF_OVERRIDE
  chmod 0644 "$destination"
}

write_env_metadata() {
  local source="$1"
  local destination="$2"
  local version="$3"
  local revision="$4"
  local build_date="$5"
  validate_version "$version"
  [[ -z "$revision" ]] || validate_revision "$revision"
  [[ -z "$build_date" ]] || validate_build_date "$build_date"
  [[ -f "$source" && ! -L "$source" ]] || fail "Environment file must be a regular non-symlink file"
  awk -v version="$version" -v revision="$revision" -v build_date="$build_date" '
    BEGIN { seen_version=0; seen_revision=0; seen_date=0 }
    /^OFFICECHAT_VERSION=/ { print "OFFICECHAT_VERSION=" version; seen_version=1; next }
    /^OFFICECHAT_BUILD_SHA=/ { print "OFFICECHAT_BUILD_SHA=" revision; seen_revision=1; next }
    /^OFFICECHAT_BUILD_DATE=/ { print "OFFICECHAT_BUILD_DATE=" build_date; seen_date=1; next }
    { print }
    END {
      if (!seen_version) print "OFFICECHAT_VERSION=" version
      if (!seen_revision) print "OFFICECHAT_BUILD_SHA=" revision
      if (!seen_date) print "OFFICECHAT_BUILD_DATE=" build_date
    }
  ' "$source" >"$destination"
  chmod --reference="$source" "$destination"
}

atomic_update_env_metadata() {
  local env_file="$1"
  local version="$2"
  local revision="$3"
  local build_date="$4"
  local temp_file
  if is_dry_run; then
    log "DRY-RUN: atomically update release metadata in ${env_file}"
    return
  fi
  temp_file="$(mktemp "$(dirname "$env_file")/.officechat-env.XXXXXX")"
  if ! write_env_metadata "$env_file" "$temp_file" "$version" "$revision" "$build_date"; then
    rm -f -- "$temp_file"
    return 1
  fi
  mv -f -- "$temp_file" "$env_file"
}

atomic_write_version_override() {
  local destination="$1"
  local version="$2"
  local revision="${3:-}"
  local build_date="${4:-}"
  local temp_file
  if is_dry_run; then
    log "DRY-RUN: atomically write ${destination}"
    return
  fi
  temp_file="$(mktemp "$(dirname "$destination")/.officechat-version-override.XXXXXX")"
  if ! write_version_override "$temp_file" "$version" "$revision" "$build_date"; then
    rm -f -- "$temp_file"
    return 1
  fi
  mv -f -- "$temp_file" "$destination"
}

read_release_metadata() {
  local metadata_file="$1"
  local -a values
  [[ -f "$metadata_file" && ! -L "$metadata_file" ]] || fail "RELEASE.json is required"
  require_command python3
  mapfile -t values < <(python3 - "$metadata_file" 2>/dev/null <<'PY_METADATA'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    data = json.load(handle)
keys = ("version", "revision", "build_date", "backend_image", "frontend_image")
if set(data) != set(keys) or any(not isinstance(data[key], str) for key in keys):
    raise SystemExit("invalid release metadata shape")
for key in keys:
    print(data[key])
PY_METADATA
  ) || fail "Malformed RELEASE.json"
  ((${#values[@]} == 5)) || fail "Malformed RELEASE.json"
  RELEASE_VERSION="${values[0]}"
  RELEASE_REVISION="${values[1]}"
  RELEASE_BUILD_DATE="${values[2]}"
  RELEASE_BACKEND_IMAGE="${values[3]}"
  RELEASE_FRONTEND_IMAGE="${values[4]}"
  validate_version "$RELEASE_VERSION"
  validate_revision "$RELEASE_REVISION"
  validate_build_date "$RELEASE_BUILD_DATE"
  [[ "$RELEASE_BACKEND_IMAGE" == "ghcr.io/fedorovdo/officechat-backend:${RELEASE_VERSION}" ]] ||
    fail "Release backend image does not match version"
  [[ "$RELEASE_FRONTEND_IMAGE" == "ghcr.io/fedorovdo/officechat-frontend:${RELEASE_VERSION}" ]] ||
    fail "Release frontend image does not match version"
}

validate_resolved_stack() {
  local env_file="$1"
  local base_file="$2"
  local https_file="$3"
  local version_file="$4"
  local version="$5"
  require_command python3
  compose_with_stack "$env_file" "$base_file" "$https_file" "$version_file" config --format json |
    python3 -c '
import json
import sys

version = sys.argv[1]
data = json.load(sys.stdin)
services = data.get("services", {})
expected = {
    "backend": f"ghcr.io/fedorovdo/officechat-backend:{version}",
    "calendar-worker": f"ghcr.io/fedorovdo/officechat-backend:{version}",
    "frontend": f"ghcr.io/fedorovdo/officechat-frontend:{version}",
}
for service, image in expected.items():
    if services.get(service, {}).get("image") != image:
        raise SystemExit(f"resolved image mismatch for {service}")

def volume(service, target):
    for item in services.get(service, {}).get("volumes", []):
        if item.get("target") == target:
            return item
    return None

required_labels = (
    ("postgres", "/var/lib/postgresql/data", "Z"),
    ("valkey", "/data", "Z"),
    ("backend", "/data/uploads", "z"),
    ("calendar-worker", "/data/uploads", "z"),
    ("backend", "/run/officechat-backup-agent", "z"),
)
for service, target, label in required_labels:
    item = volume(service, target)
    if not item or item.get("bind", {}).get("selinux") != label:
        raise SystemExit(f"missing SELinux {label} label for {service}:{target}")

socket = volume("backend", "/run/officechat-backup-agent")
if not socket.get("read_only") or not services.get("backend", {}).get("group_add"):
    raise SystemExit("backend socket access is not read-only or lacks group_add")
for service in ("calendar-worker", "frontend"):
    if volume(service, "/run/officechat-backup-agent"):
        raise SystemExit(f"{service} must not receive the backup agent socket")
if data.get("networks", {}).get("public", {}).get("name") != "officechat_public":
    raise SystemExit("public network name changed")
frontend_ports = services.get("frontend", {}).get("ports", [])
if not frontend_ports or any(port.get("host_ip") != "127.0.0.1" for port in frontend_ports):
    raise SystemExit("frontend is not bound exclusively to 127.0.0.1")
' "$version" || fail "Resolved Compose stack validation failed"
  pass "Resolved Compose stack uses the requested images and security settings"
}

acquire_lock() {
  require_command mkdir
  if is_dry_run; then
    echo "DRY-RUN: acquire lock ${OFFICECHAT_LOCK_FILE}"
    return
  fi
  if ! mkdir "$OFFICECHAT_LOCK_FILE" 2>/dev/null; then
    fail "Another OfficeChat maintenance operation is already running: $OFFICECHAT_LOCK_FILE"
  fi
  trap 'rmdir "$OFFICECHAT_LOCK_FILE" 2>/dev/null || true' EXIT
}

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 48 | tr -d '\n'
  else
    tr -dc 'A-Za-z0-9_-' </dev/urandom | head -c 64
  fi
}

write_env_if_missing() {
  local env_file="$1"
  if [[ -f "$env_file" ]]; then
    run_cmd chmod 600 "$env_file"
    return
  fi
  if is_dry_run; then
    echo "[dry-run] write ${env_file} with generated secrets"
    return
  fi

  local postgres_password app_secret public_frontend_url public_backend_url
  postgres_password="$(generate_secret)"
  app_secret="$(generate_secret)"
  if [[ -n "${OFFICECHAT_HOSTNAME:-}" ]]; then
    public_frontend_url="https://${OFFICECHAT_HOSTNAME}"
    public_backend_url="https://${OFFICECHAT_HOSTNAME}"
  else
    public_frontend_url="${PUBLIC_FRONTEND_URL:-http://localhost:3100}"
    public_backend_url="${PUBLIC_BACKEND_URL:-http://localhost:8100}"
  fi
  umask 077
  cat >"$env_file" <<EOF_ENV
OFFICECHAT_VERSION=${OFFICECHAT_RELEASE_VERSION}
OFFICECHAT_BUILD_SHA=${OFFICECHAT_RELEASE_REVISION}
OFFICECHAT_BUILD_DATE=${OFFICECHAT_RELEASE_BUILD_DATE}
APP_NAME=OfficeChat
APP_SECRET_KEY=${app_secret}
POSTGRES_DB=officechat
POSTGRES_USER=officechat
POSTGRES_PASSWORD=${postgres_password}
DATABASE_URL=postgresql://officechat:${postgres_password}@postgres:5432/officechat
OFFICECHAT_HOSTNAME=${OFFICECHAT_HOSTNAME:-}
PUBLIC_FRONTEND_URL=${public_frontend_url}
PUBLIC_BACKEND_URL=${public_backend_url}
BACKEND_CORS_ORIGINS=${BACKEND_CORS_ORIGINS:-${public_frontend_url}}
NEXT_PUBLIC_FRONTEND_URL=${NEXT_PUBLIC_FRONTEND_URL:-${public_frontend_url}}
NEXT_PUBLIC_BACKEND_URL=${NEXT_PUBLIC_BACKEND_URL:-${public_backend_url}}
FRONTEND_BIND_ADDRESS=127.0.0.1
BACKEND_BIND_ADDRESS=127.0.0.1
FRONTEND_HOST_PORT=${FRONTEND_HOST_PORT:-3100}
BACKEND_HOST_PORT=${BACKEND_HOST_PORT:-8100}
OFFICECHAT_DATA_DIR=${OFFICECHAT_DATA_DIR}
OFFICECHAT_BACKUP_GID=${OFFICECHAT_BACKUP_GID:-65530}
BACKUP_AGENT_RUNTIME_DIR=/run/officechat-backup-agent
EOF_ENV
  chmod 600 "$env_file"
}

ensure_backup_agent_group() {
  local group_entry
  if is_dry_run; then
    OFFICECHAT_BACKUP_GID="${OFFICECHAT_BACKUP_GID:-65530}"
    export OFFICECHAT_BACKUP_GID
    log "DRY-RUN: ensure system group ${OFFICECHAT_BACKUP_GROUP} (gid ${OFFICECHAT_BACKUP_GID})"
    return
  fi
  require_command getent
  group_entry="$(getent group "$OFFICECHAT_BACKUP_GROUP" || true)"
  if [[ -z "$group_entry" ]]; then
    require_command groupadd
    as_root groupadd --system "$OFFICECHAT_BACKUP_GROUP"
    group_entry="$(getent group "$OFFICECHAT_BACKUP_GROUP")"
  fi
  OFFICECHAT_BACKUP_GID="$(printf '%s\n' "$group_entry" | awk -F: '{print $3}')"
  [[ "$OFFICECHAT_BACKUP_GID" =~ ^[0-9]+$ ]] || fail "Could not determine backup agent group GID"
  export OFFICECHAT_BACKUP_GID
}

ensure_env_value() {
  local env_file="$1"
  local key="$2"
  local value="$3"
  [[ "$key" =~ ^[A-Z0-9_]+$ && "$value" != *$'\n'* && "$value" != *$'\r'* ]] ||
    fail "Invalid environment assignment"
  if is_dry_run; then
    log "DRY-RUN: ensure ${key} in ${env_file}"
    return
  fi
  if grep -q "^${key}=" "$env_file"; then
    as_root sed -i "s|^${key}=.*|${key}=${value}|" "$env_file"
  else
    printf '%s=%s\n' "$key" "$value" | as_root tee -a "$env_file" >/dev/null
  fi
  as_root chmod 600 "$env_file"
}

read_installed_version() {
  if [[ -f "${OFFICECHAT_INSTALL_DIR}/VERSION" ]]; then
    cat "${OFFICECHAT_INSTALL_DIR}/VERSION"
  else
    printf 'unknown'
  fi
}

record_version() {
  local version="$1"
  if is_dry_run; then
    echo "DRY-RUN: record OfficeChat version ${version}"
    return
  fi
  printf '%s\n' "$version" >"${OFFICECHAT_INSTALL_DIR}/VERSION"
  mkdir -p "${OFFICECHAT_INSTALL_DIR}/releases"
  printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ) ${version}" >>"${OFFICECHAT_INSTALL_DIR}/releases/history.log"
}

wait_for_ready() {
  local attempts="${1:-40}"
  local delay="${2:-3}"
  local i
  if is_dry_run; then
    echo "DRY-RUN: skip backend readiness wait"
    return 0
  fi
  for ((i = 1; i <= attempts; i++)); do
    if compose exec -T backend python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/ready', timeout=5).read()" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay"
  done
  return 1
}

backup_now() {
  local stamp backup_dir
  stamp="$(date -u +%Y%m%d_%H%M%S)"
  backup_dir="${OFFICECHAT_BACKUP_DIR}/officechat_${stamp}"
  if is_dry_run; then
    echo "[dry-run] create backup in ${backup_dir}"
    return
  fi
  as_root mkdir -p "$backup_dir"
  log "Creating backup in ${backup_dir}"
  compose exec -T postgres pg_dump -U "${POSTGRES_USER:-officechat}" -d "${POSTGRES_DB:-officechat}" -Fc >"${backup_dir}/officechat.dump"
  tar -C "$OFFICECHAT_DATA_DIR" -czf "${backup_dir}/uploads.tar.gz" uploads 2>/dev/null || warn "Uploads backup skipped or empty."
  compose exec -T backend alembic current >"${backup_dir}/alembic-current.txt" || true
  printf '{"created_at":"%s","version":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(read_installed_version)" >"${backup_dir}/metadata.json"
  pass "Backup completed: ${backup_dir}"
}
