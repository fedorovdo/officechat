#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "${SCRIPT_DIR}/lib.sh"

SHOW_HELP=0
INSTALL_DOCKER=0
ENABLE_BACKUP_TIMER=0
OFFICECHAT_HOSTNAME="${OFFICECHAT_HOSTNAME:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) SHOW_HELP=1; shift ;;
    --dry-run) set_dry_run; shift ;;
    --install-docker) INSTALL_DOCKER=1; shift ;;
    --enable-backup-timer) ENABLE_BACKUP_TIMER=1; shift ;;
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
                        [--enable-backup-timer]

Installs OfficeChat into /opt/officechat and data into /var/lib/officechat.
Production requires HTTPS. --hostname configures the public HTTPS origin for a new install.
The backup timer is installed but enabled only with --enable-backup-timer.
EOF_HELP
  exit 0
fi

release_metadata_source="${SCRIPT_DIR}/RELEASE.json"
if [[ -f "$release_metadata_source" ]]; then
  read_release_metadata "$release_metadata_source"
  [[ "$RELEASE_VERSION" == "$OFFICECHAT_RELEASE_VERSION" ]] ||
    fail "Bundled VERSION and RELEASE.json do not match"
  OFFICECHAT_RELEASE_REVISION="$RELEASE_REVISION"
  OFFICECHAT_RELEASE_BUILD_DATE="$RELEASE_BUILD_DATE"
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

[[ ! -L /etc/officechat ]] || fail "Refusing symlink /etc/officechat directory"
as_root install -d -o root -g root -m 0755 "$OFFICECHAT_INSTALL_DIR" "${OFFICECHAT_INSTALL_DIR}/backup" "${OFFICECHAT_INSTALL_DIR}/docs"
as_root install -d -o root -g root -m 0755 "$OFFICECHAT_DATA_DIR"
as_root install -d -o root -g root -m 0755 "$OFFICECHAT_DATA_DIR/uploads"
as_root install -d -o root -g root -m 0700 "$OFFICECHAT_DATA_DIR/postgres" "$OFFICECHAT_DATA_DIR/valkey" "$OFFICECHAT_BACKUP_DIR"
as_root install -d -o root -g root -m 0755 /etc/officechat
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
if [[ -f "$release_metadata_source" ]]; then
  as_root install -m 0644 "$release_metadata_source" "${OFFICECHAT_INSTALL_DIR}/RELEASE.json"
fi
for backup_tool in backup-production.sh verify-backup.sh restore-production.sh; do
  if [[ -f "${SCRIPT_DIR}/../../scripts/${backup_tool}" ]]; then
    as_root cp "${SCRIPT_DIR}/../../scripts/${backup_tool}" "${OFFICECHAT_INSTALL_DIR}/${backup_tool}"
  elif [[ -f "${SCRIPT_DIR}/${backup_tool}" ]]; then
    as_root cp "${SCRIPT_DIR}/${backup_tool}" "${OFFICECHAT_INSTALL_DIR}/${backup_tool}"
  fi
done
if [[ -f "${SCRIPT_DIR}/../../scripts/backup_agent.py" ]]; then
  as_root cp "${SCRIPT_DIR}/../../scripts/backup_agent.py" "${OFFICECHAT_INSTALL_DIR}/backup-agent.py"
elif [[ -f "${SCRIPT_DIR}/backup-agent.py" ]]; then
  as_root cp "${SCRIPT_DIR}/backup-agent.py" "${OFFICECHAT_INSTALL_DIR}/backup-agent.py"
fi
if [[ -f "${SCRIPT_DIR}/../../scripts/backup/lib.sh" ]]; then
  as_root cp "${SCRIPT_DIR}/../../scripts/backup/lib.sh" "${OFFICECHAT_INSTALL_DIR}/backup/lib.sh"
elif [[ -f "${SCRIPT_DIR}/backup/lib.sh" ]]; then
  as_root cp "${SCRIPT_DIR}/backup/lib.sh" "${OFFICECHAT_INSTALL_DIR}/backup/lib.sh"
fi
backup_config_source=""
if [[ -f "${SCRIPT_DIR}/../../deploy/backup/officechat-backup.conf.example" ]]; then
  backup_config_source="${SCRIPT_DIR}/../../deploy/backup/officechat-backup.conf.example"
elif [[ -f "${SCRIPT_DIR}/backup/officechat-backup.conf.example" ]]; then
  backup_config_source="${SCRIPT_DIR}/backup/officechat-backup.conf.example"
fi
if [[ -L /etc/officechat/backup.conf ]]; then
  fail "Refusing symlink backup configuration"
fi
if [[ ! -f /etc/officechat/backup.conf ]]; then
  [[ -n "$backup_config_source" ]] || fail "Backup configuration template not found"
  as_root install -o root -g root -m 0600 "$backup_config_source" /etc/officechat/backup.conf
  as_root sed -i \
    -e "s|/opt/officechat|${OFFICECHAT_INSTALL_DIR}|g" \
    -e "s|/var/lib/officechat|${OFFICECHAT_DATA_DIR}|g" \
    -e "s|/var/backups/officechat|${OFFICECHAT_BACKUP_DIR}|g" \
    -e "s|^COMPOSE_ENV_FILE=.*|COMPOSE_ENV_FILE=${OFFICECHAT_ENV_FILE}|" \
    /etc/officechat/backup.conf
  if [[ ! -f "${OFFICECHAT_INSTALL_DIR}/docker-compose.https-override.yml" ]]; then
    as_root sed -i "s|^COMPOSE_FILES=.*|COMPOSE_FILES=${OFFICECHAT_COMPOSE_FILE}|" /etc/officechat/backup.conf
  fi
fi
as_root chown root:root /etc/officechat/backup.conf
as_root chmod 600 /etc/officechat/backup.conf
agent_config_source=""
if [[ -f "${SCRIPT_DIR}/../../deploy/backup/officechat-backup-agent.conf.example" ]]; then
  agent_config_source="${SCRIPT_DIR}/../../deploy/backup/officechat-backup-agent.conf.example"
elif [[ -f "${SCRIPT_DIR}/backup/officechat-backup-agent.conf.example" ]]; then
  agent_config_source="${SCRIPT_DIR}/backup/officechat-backup-agent.conf.example"
fi
if [[ -L /etc/officechat/backup-agent.conf ]]; then
  fail "Refusing symlink backup agent configuration"
fi
if [[ ! -f /etc/officechat/backup-agent.conf ]]; then
  [[ -n "$agent_config_source" ]] || fail "Backup agent configuration template not found"
  as_root install -o root -g root -m 0600 "$agent_config_source" /etc/officechat/backup-agent.conf
  as_root sed -i "s|/var/backups/officechat|${OFFICECHAT_BACKUP_DIR}|g" /etc/officechat/backup-agent.conf
fi
as_root chown root:root /etc/officechat/backup-agent.conf
as_root chmod 600 /etc/officechat/backup-agent.conf
for backup_doc in BACKUP_RESTORE_RU.md BACKUP_RESTORE.md BACKUP_CENTER_RU.md BACKUP_CENTER.md; do
  if [[ -f "${SCRIPT_DIR}/../../docs/${backup_doc}" ]]; then
    as_root cp "${SCRIPT_DIR}/../../docs/${backup_doc}" "${OFFICECHAT_INSTALL_DIR}/docs/${backup_doc}"
  elif [[ -f "${SCRIPT_DIR}/deployment/${backup_doc}" ]]; then
    as_root cp "${SCRIPT_DIR}/deployment/${backup_doc}" "${OFFICECHAT_INSTALL_DIR}/docs/${backup_doc}"
  fi
done
systemd_source=""
if [[ -d "${SCRIPT_DIR}/../../deploy/systemd" ]]; then
  systemd_source="${SCRIPT_DIR}/../../deploy/systemd"
elif [[ -d "${SCRIPT_DIR}/systemd" ]]; then
  systemd_source="${SCRIPT_DIR}/systemd"
fi
if [[ -n "$systemd_source" ]]; then
  as_root install -m 0644 "${systemd_source}/officechat-backup.service" /etc/systemd/system/officechat-backup.service
  as_root install -m 0644 "${systemd_source}/officechat-backup.timer" /etc/systemd/system/officechat-backup.timer
  as_root install -m 0644 "${systemd_source}/officechat-backup-agent.service" /etc/systemd/system/officechat-backup-agent.service
fi
if [[ -d "${SCRIPT_DIR}/../../deploy/caddy" ]]; then
  as_root mkdir -p "${OFFICECHAT_INSTALL_DIR}/caddy"
  as_root cp "${SCRIPT_DIR}/../../deploy/caddy/Caddyfile.example" "${OFFICECHAT_INSTALL_DIR}/caddy/Caddyfile.example"
  as_root cp "${SCRIPT_DIR}/../../deploy/caddy/docker-compose.caddy.yml" "${OFFICECHAT_INSTALL_DIR}/caddy/docker-compose.caddy.yml"
elif [[ -d "${SCRIPT_DIR}/caddy" ]]; then
  as_root mkdir -p "${OFFICECHAT_INSTALL_DIR}/caddy"
  as_root cp "${SCRIPT_DIR}/caddy/Caddyfile.example" "${OFFICECHAT_INSTALL_DIR}/caddy/Caddyfile.example"
  as_root cp "${SCRIPT_DIR}/caddy/docker-compose.caddy.yml" "${OFFICECHAT_INSTALL_DIR}/caddy/docker-compose.caddy.yml"
fi
as_root chmod +x "${OFFICECHAT_INSTALL_DIR}/install-linux.sh" "${OFFICECHAT_INSTALL_DIR}/update-linux.sh" "${OFFICECHAT_INSTALL_DIR}/rollback-linux.sh" "${OFFICECHAT_INSTALL_DIR}/uninstall-linux.sh" "${OFFICECHAT_INSTALL_DIR}/verify-install.sh" "${OFFICECHAT_INSTALL_DIR}/officechatctl" "${OFFICECHAT_INSTALL_DIR}/backup-production.sh" "${OFFICECHAT_INSTALL_DIR}/verify-backup.sh" "${OFFICECHAT_INSTALL_DIR}/restore-production.sh" "${OFFICECHAT_INSTALL_DIR}/backup-agent.py"
as_root chmod 644 "${OFFICECHAT_INSTALL_DIR}/backup/lib.sh"
as_root chmod 755 "$OFFICECHAT_INSTALL_DIR"
ensure_backup_agent_group
write_env_if_missing "$OFFICECHAT_ENV_FILE"
ensure_env_value "$OFFICECHAT_ENV_FILE" OFFICECHAT_BACKUP_GID "$OFFICECHAT_BACKUP_GID"
ensure_env_value "$OFFICECHAT_ENV_FILE" BACKUP_AGENT_RUNTIME_DIR /run/officechat-backup-agent
if [[ -n "$OFFICECHAT_RELEASE_REVISION" && -n "$OFFICECHAT_RELEASE_BUILD_DATE" ]]; then
  atomic_update_env_metadata "$OFFICECHAT_ENV_FILE" "$OFFICECHAT_RELEASE_VERSION" \
    "$OFFICECHAT_RELEASE_REVISION" "$OFFICECHAT_RELEASE_BUILD_DATE"
fi
atomic_write_version_override "$OFFICECHAT_VERSION_OVERRIDE_FILE" "$OFFICECHAT_RELEASE_VERSION" \
  "$OFFICECHAT_RELEASE_REVISION" "$OFFICECHAT_RELEASE_BUILD_DATE"

[[ -n "$systemd_source" ]] || fail "Backup systemd units not found"
if is_dry_run; then
  log "DRY-RUN: enable and start officechat-backup-agent.service"
elif command -v systemctl >/dev/null 2>&1; then
  as_root systemctl daemon-reload
  as_root systemctl enable --now officechat-backup-agent.service
else
  fail "systemd is required for the read-only backup agent"
fi

print_compose_files
if is_dry_run; then
  log "DRY-RUN: preflight Compose config and resolved image/security validation"
else
  validate_resolved_stack "$OFFICECHAT_ENV_FILE" "$OFFICECHAT_COMPOSE_FILE" \
    "$OFFICECHAT_HTTPS_OVERRIDE_FILE" "$OFFICECHAT_VERSION_OVERRIDE_FILE" "$OFFICECHAT_RELEASE_VERSION"
fi
run_cmd compose pull
if ! is_dry_run; then
  backend_uid="$(compose run --rm --no-deps --entrypoint id backend -u | tail -n 1 | tr -d '\r')"
  backend_gid="$(compose run --rm --no-deps --entrypoint id backend -g | tail -n 1 | tr -d '\r')"
  [[ "$backend_uid" =~ ^[0-9]+$ && "$backend_gid" =~ ^[0-9]+$ ]] ||
    fail "Could not determine backend runtime UID/GID"
  as_root chown "${backend_uid}:${backend_gid}" "$OFFICECHAT_DATA_DIR/uploads"
  as_root chmod 0750 "$OFFICECHAT_DATA_DIR/uploads"
fi
run_cmd compose run --rm backend alembic upgrade head
run_cmd compose run --rm backend alembic current
run_cmd compose up -d postgres valkey backend calendar-worker frontend
wait_for_ready || fail "Backend readiness check failed"
record_version "$OFFICECHAT_RELEASE_VERSION"
if command -v systemctl >/dev/null 2>&1 && [[ -n "$systemd_source" ]]; then
  if [[ "$ENABLE_BACKUP_TIMER" == "1" ]]; then
    as_root systemctl enable --now officechat-backup.timer
  else
    warn "Backup timer is installed but disabled; review /etc/officechat/backup.conf, then enable it explicitly."
  fi
else
  warn "systemd is unavailable; backup units were not enabled."
fi

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
