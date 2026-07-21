#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "${SCRIPT_DIR}/lib.sh"

SHOW_HELP=0
INSTALL_DOCKER=0
OFFICECHAT_HOSTNAME="${OFFICECHAT_HOSTNAME:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) SHOW_HELP=1; shift ;;
    --dry-run) set_dry_run; shift ;;
    --install-docker) INSTALL_DOCKER=1; shift ;;
    --hostname)
      [[ $# -ge 2 ]] || fail "--hostname requires a value"
      OFFICECHAT_HOSTNAME="$2"
      shift 2
      ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

if [[ "$SHOW_HELP" == "1" ]]; then
  cat <<'EOF_HELP'
Usage: install-linux.sh [--dry-run] [--install-docker] [--hostname HOSTNAME]

Installs OfficeChat into /opt/officechat and data into /var/lib/officechat.
Production requires HTTPS. --hostname configures the public HTTPS origin for a new install.
EOF_HELP
  exit 0
fi

validate_version "$OFFICECHAT_RELEASE_VERSION"
if [[ -n "$OFFICECHAT_HOSTNAME" && ! "$OFFICECHAT_HOSTNAME" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
  fail "Invalid OfficeChat hostname"
fi
require_safe_path "$OFFICECHAT_INSTALL_DIR"
require_safe_path "$OFFICECHAT_DATA_DIR"
require_safe_path "$OFFICECHAT_BACKUP_DIR"
require_root_or_sudo
acquire_lock

arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) ;;
  *) fail "Only linux/amd64 is supported by this release bundle; detected ${arch}" ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  if [[ "$INSTALL_DOCKER" == "1" ]]; then
    fail "Automatic Docker installation is intentionally not implemented. Install Docker Engine and Compose v2, then rerun."
  fi
  fail "Docker is not installed. Install Docker Engine and Compose v2 first."
fi
require_docker_compose
require_command tar

available_kb="$(df -Pk / | awk 'NR==2 {print $4}')"
if [[ "${available_kb:-0}" -lt 2097152 ]]; then
  warn "Less than 2 GB free disk space detected."
fi

as_root mkdir -p "$OFFICECHAT_INSTALL_DIR" "$OFFICECHAT_DATA_DIR/uploads" "$OFFICECHAT_DATA_DIR/postgres" "$OFFICECHAT_DATA_DIR/valkey" "$OFFICECHAT_BACKUP_DIR"
if [[ -f "${SCRIPT_DIR}/../../deploy/docker-compose.release.yml" ]]; then
  as_root cp "${SCRIPT_DIR}/../../deploy/docker-compose.release.yml" "$OFFICECHAT_COMPOSE_FILE"
elif [[ -f "${SCRIPT_DIR}/docker-compose.yml" ]]; then
  as_root cp "${SCRIPT_DIR}/docker-compose.yml" "$OFFICECHAT_COMPOSE_FILE"
else
  fail "Release compose file not found"
fi
for release_tool in lib.sh install-linux.sh update-linux.sh rollback-linux.sh uninstall-linux.sh verify-install.sh officechatctl collect-diagnostics.sh; do
  if [[ -f "${SCRIPT_DIR}/${release_tool}" ]]; then
    as_root cp "${SCRIPT_DIR}/${release_tool}" "${OFFICECHAT_INSTALL_DIR}/${release_tool}"
  fi
done
if [[ -d "${SCRIPT_DIR}/../../deploy/caddy" ]]; then
  as_root mkdir -p "${OFFICECHAT_INSTALL_DIR}/caddy"
  as_root cp "${SCRIPT_DIR}/../../deploy/caddy/Caddyfile.example" "${OFFICECHAT_INSTALL_DIR}/caddy/Caddyfile.example"
  as_root cp "${SCRIPT_DIR}/../../deploy/caddy/docker-compose.caddy.yml" "${OFFICECHAT_INSTALL_DIR}/caddy/docker-compose.caddy.yml"
elif [[ -d "${SCRIPT_DIR}/caddy" ]]; then
  as_root mkdir -p "${OFFICECHAT_INSTALL_DIR}/caddy"
  as_root cp "${SCRIPT_DIR}/caddy/Caddyfile.example" "${OFFICECHAT_INSTALL_DIR}/caddy/Caddyfile.example"
  as_root cp "${SCRIPT_DIR}/caddy/docker-compose.caddy.yml" "${OFFICECHAT_INSTALL_DIR}/caddy/docker-compose.caddy.yml"
fi
as_root chmod +x "${OFFICECHAT_INSTALL_DIR}/install-linux.sh" "${OFFICECHAT_INSTALL_DIR}/update-linux.sh" "${OFFICECHAT_INSTALL_DIR}/rollback-linux.sh" "${OFFICECHAT_INSTALL_DIR}/uninstall-linux.sh" "${OFFICECHAT_INSTALL_DIR}/verify-install.sh" "${OFFICECHAT_INSTALL_DIR}/officechatctl"
as_root chmod 755 "$OFFICECHAT_INSTALL_DIR"
write_env_if_missing "$OFFICECHAT_ENV_FILE"

if is_dry_run; then
  run_cmd compose config
else
  compose config >/dev/null
fi
run_cmd compose pull
run_cmd compose run --rm backend alembic upgrade head
run_cmd compose run --rm backend alembic current
run_cmd compose up -d postgres valkey backend calendar-worker frontend
wait_for_ready || fail "Backend readiness check failed"
record_version "$OFFICECHAT_RELEASE_VERSION"

if [[ -n "${OFFICECHAT_ADMIN_USERNAME:-}" && -n "${OFFICECHAT_ADMIN_DISPLAY_NAME:-}" && -n "${OFFICECHAT_ADMIN_PASSWORD_FILE:-}" ]]; then
  run_cmd compose run --rm backend python -m app.cli create-admin \
    --username "$OFFICECHAT_ADMIN_USERNAME" \
    --display-name "$OFFICECHAT_ADMIN_DISPLAY_NAME" \
    --password-file "$OFFICECHAT_ADMIN_PASSWORD_FILE"
fi

pass "OfficeChat ${OFFICECHAT_RELEASE_VERSION} installed."
warn "Production access requires HTTPS; do not expose ports 3100 or 8100 to the LAN."
if [[ -n "$OFFICECHAT_HOSTNAME" ]]; then
  log "Start internal HTTPS after DNS is ready:"
  log "  docker compose --env-file ${OFFICECHAT_ENV_FILE} -f ${OFFICECHAT_INSTALL_DIR}/caddy/docker-compose.caddy.yml up -d"
  log "Export only the public CA certificate:"
  log "  docker compose --env-file ${OFFICECHAT_ENV_FILE} -f ${OFFICECHAT_INSTALL_DIR}/caddy/docker-compose.caddy.yml cp caddy:/data/caddy/pki/authorities/local/root.crt ./officechat-root.crt"
fi
