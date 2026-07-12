#!/usr/bin/env bash
set -Eeuo pipefail

OFFICECHAT_RELEASE_VERSION="${OFFICECHAT_RELEASE_VERSION:-0.1.0-rc2}"
OFFICECHAT_INSTALL_DIR="${OFFICECHAT_INSTALL_DIR:-/opt/officechat}"
OFFICECHAT_DATA_DIR="${OFFICECHAT_DATA_DIR:-/var/lib/officechat}"
OFFICECHAT_BACKUP_DIR="${OFFICECHAT_BACKUP_DIR:-/var/backups/officechat}"
OFFICECHAT_COMPOSE_FILE="${OFFICECHAT_COMPOSE_FILE:-${OFFICECHAT_INSTALL_DIR}/docker-compose.yml}"
OFFICECHAT_ENV_FILE="${OFFICECHAT_ENV_FILE:-${OFFICECHAT_INSTALL_DIR}/.env}"
OFFICECHAT_LOCK_FILE="${OFFICECHAT_LOCK_FILE:-/tmp/officechat-release.lock}"
OFFICECHAT_PROJECT_NAME="${OFFICECHAT_PROJECT_NAME:-officechat}"
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
  [[ -n "$path" ]] || fail "Path must not be empty"
  [[ "$path" != "/" ]] || fail "Refusing to use / as a target path"
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

compose() {
  docker compose --project-name "$OFFICECHAT_PROJECT_NAME" --env-file "$OFFICECHAT_ENV_FILE" -f "$OFFICECHAT_COMPOSE_FILE" "$@"
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

  local postgres_password app_secret
  postgres_password="$(generate_secret)"
  app_secret="$(generate_secret)"
  umask 077
  cat >"$env_file" <<EOF_ENV
OFFICECHAT_VERSION=${OFFICECHAT_RELEASE_VERSION}
APP_NAME=OfficeChat
APP_SECRET_KEY=${app_secret}
POSTGRES_DB=officechat
POSTGRES_USER=officechat
POSTGRES_PASSWORD=${postgres_password}
DATABASE_URL=postgresql://officechat:${postgres_password}@postgres:5432/officechat
PUBLIC_FRONTEND_URL=${PUBLIC_FRONTEND_URL:-http://localhost:3100}
PUBLIC_BACKEND_URL=${PUBLIC_BACKEND_URL:-http://localhost:8100}
BACKEND_CORS_ORIGINS=${BACKEND_CORS_ORIGINS:-http://localhost:3100}
NEXT_PUBLIC_FRONTEND_URL=${NEXT_PUBLIC_FRONTEND_URL:-http://localhost:3100}
NEXT_PUBLIC_BACKEND_URL=${NEXT_PUBLIC_BACKEND_URL:-http://localhost:8100}
FRONTEND_HOST_PORT=${FRONTEND_HOST_PORT:-3100}
BACKEND_HOST_PORT=${BACKEND_HOST_PORT:-8100}
OFFICECHAT_DATA_DIR=${OFFICECHAT_DATA_DIR}
EOF_ENV
  chmod 600 "$env_file"
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
