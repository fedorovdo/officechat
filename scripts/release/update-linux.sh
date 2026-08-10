#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "${SCRIPT_DIR}/lib.sh"

ALLOW_DOWNGRADE=0
NO_BACKUP=0
TARGET_VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      cat <<'EOF_HELP'
Usage: update-linux.sh VERSION [--dry-run] [--allow-downgrade] [--no-backup]
Validates bundled release metadata and the complete layered Compose stack before
pulling images, applying migrations, restarting services, and recording VERSION.
EOF_HELP
      exit 0
      ;;
    --dry-run) set_dry_run; shift ;;
    --allow-downgrade) ALLOW_DOWNGRADE=1; shift ;;
    --no-backup) NO_BACKUP=1; shift ;;
    *)
      if [[ -z "$TARGET_VERSION" ]]; then TARGET_VERSION="$1"; shift; else fail "Unknown argument: $1"; fi
      ;;
  esac
done

[[ -n "$TARGET_VERSION" ]] || fail "Target version is required"
validate_version "$TARGET_VERSION"
require_docker_compose
require_command mktemp
require_command python3
[[ "$(id -u)" -eq 0 ]] || fail "Run update-linux.sh as root"
acquire_lock

metadata_source="${OFFICECHAT_RELEASE_METADATA_FILE:-${SCRIPT_DIR}/RELEASE.json}"
read_release_metadata "$metadata_source"
[[ "$TARGET_VERSION" == "$RELEASE_VERSION" ]] || fail "Requested version does not match RELEASE.json"

current_version="$(read_installed_version)"
if [[ "$ALLOW_DOWNGRADE" != "1" && "$current_version" != "unknown" && "$TARGET_VERSION" < "$current_version" ]]; then
  fail "Refusing apparent downgrade from ${current_version} to ${TARGET_VERSION}; pass --allow-downgrade to override."
fi

compose_source=""
if [[ -f "${SCRIPT_DIR}/../../deploy/docker-compose.release.yml" ]]; then
  compose_source="${SCRIPT_DIR}/../../deploy/docker-compose.release.yml"
elif [[ -f "${SCRIPT_DIR}/docker-compose.yml" ]]; then
  compose_source="${SCRIPT_DIR}/docker-compose.yml"
fi
[[ -n "$compose_source" ]] || fail "Release Compose file not found"

agent_source=""
if [[ -f "${SCRIPT_DIR}/../backup_agent.py" ]]; then
  agent_source="${SCRIPT_DIR}/../backup_agent.py"
elif [[ -f "${SCRIPT_DIR}/backup-agent.py" ]]; then
  agent_source="${SCRIPT_DIR}/backup-agent.py"
fi
[[ -n "$agent_source" ]] || fail "Backup agent executable not found"

agent_config_source=""
if [[ -f "${SCRIPT_DIR}/../../deploy/backup/officechat-backup-agent.conf.example" ]]; then
  agent_config_source="${SCRIPT_DIR}/../../deploy/backup/officechat-backup-agent.conf.example"
elif [[ -f "${SCRIPT_DIR}/backup/officechat-backup-agent.conf.example" ]]; then
  agent_config_source="${SCRIPT_DIR}/backup/officechat-backup-agent.conf.example"
fi
[[ -n "$agent_config_source" ]] || fail "Backup agent configuration template not found"

systemd_source=""
if [[ -d "${SCRIPT_DIR}/../../deploy/systemd" ]]; then
  systemd_source="${SCRIPT_DIR}/../../deploy/systemd"
elif [[ -d "${SCRIPT_DIR}/systemd" ]]; then
  systemd_source="${SCRIPT_DIR}/systemd"
fi
[[ -n "$systemd_source" ]] || fail "Backup systemd units not found"

staging_dir="$(mktemp -d)"
chmod 0700 "$staging_dir"
cleanup() {
  rm -rf -- "$staging_dir"
  rmdir "$OFFICECHAT_LOCK_FILE" 2>/dev/null || true
}
trap cleanup EXIT

staging_env="${staging_dir}/officechat.env"
staging_override="${staging_dir}/docker-compose.version-override.yml"
write_env_metadata "$OFFICECHAT_ENV_FILE" "$staging_env" "$RELEASE_VERSION" "$RELEASE_REVISION" "$RELEASE_BUILD_DATE"
write_version_override "$staging_override" "$RELEASE_VERSION" "$RELEASE_REVISION" "$RELEASE_BUILD_DATE"

log "Planned release version: ${RELEASE_VERSION}"
log "Planned revision: ${RELEASE_REVISION}"
log "Planned build date: ${RELEASE_BUILD_DATE}"
log "Planned backend image: ${RELEASE_BACKEND_IMAGE}"
log "Planned frontend image: ${RELEASE_FRONTEND_IMAGE}"
log "Preflight Compose files:"
log "  ${compose_source}"
[[ ! -f "$OFFICECHAT_HTTPS_OVERRIDE_FILE" ]] || log "  ${OFFICECHAT_HTTPS_OVERRIDE_FILE}"
log "  ${staging_override} (generated final override)"
if command -v getenforce >/dev/null 2>&1; then
  log "SELinux mode: $(getenforce)"
else
  log "SELinux mode: unavailable"
fi

compose_with_stack "$staging_env" "$compose_source" "$OFFICECHAT_HTTPS_OVERRIDE_FILE" \
  "$staging_override" config --quiet
validate_resolved_stack "$staging_env" "$compose_source" "$OFFICECHAT_HTTPS_OVERRIDE_FILE" \
  "$staging_override" "$RELEASE_VERSION"

if is_dry_run; then
  if [[ "$NO_BACKUP" == "1" ]]; then
    warn "Dry-run: update would proceed without a backup by user request."
  else
    log "DRY-RUN: create protected pre-upgrade backup"
  fi
  log "DRY-RUN: preserve current Compose, version override, .env, agent unit/config and executable"
  atomic_update_env_metadata "$OFFICECHAT_ENV_FILE" "$RELEASE_VERSION" "$RELEASE_REVISION" "$RELEASE_BUILD_DATE"
  atomic_write_version_override "$OFFICECHAT_VERSION_OVERRIDE_FILE" "$RELEASE_VERSION" "$RELEASE_REVISION" "$RELEASE_BUILD_DATE"
  log "DRY-RUN: install release Compose and agent assets"
  log "DRY-RUN: pull images, run Alembic upgrade, restart services and verify readiness"
  pass "OfficeChat update preflight completed; no production files or containers were changed."
  exit 0
fi

if [[ "$NO_BACKUP" == "1" ]]; then
  warn "Proceeding without backup by user request."
elif [[ -x "${OFFICECHAT_INSTALL_DIR}/backup-production.sh" && -f "$OFFICECHAT_BACKUP_CONFIG_FILE" ]]; then
  "${OFFICECHAT_INSTALL_DIR}/backup-production.sh" --config "$OFFICECHAT_BACKUP_CONFIG_FILE" --pre-upgrade
else
  backup_now
fi

snapshot_dir="${staging_dir}/previous"
mkdir -m 0700 "$snapshot_dir"
snapshot_file() {
  local path="$1"
  local name="$2"
  if [[ -e "$path" ]]; then
    [[ -f "$path" && ! -L "$path" ]] || fail "Refusing non-regular update target: $path"
    cp -a -- "$path" "${snapshot_dir}/${name}"
  fi
}
restore_file() {
  local path="$1"
  local name="$2"
  if [[ -f "${snapshot_dir}/${name}" ]]; then
    cp -a -- "${snapshot_dir}/${name}" "$path"
  else
    rm -f -- "$path"
  fi
}

snapshot_file "$OFFICECHAT_COMPOSE_FILE" docker-compose.yml
snapshot_file "$OFFICECHAT_VERSION_OVERRIDE_FILE" docker-compose.version-override.yml
snapshot_file "$OFFICECHAT_ENV_FILE" officechat.env
snapshot_file "$OFFICECHAT_BACKUP_AGENT_UNIT_FILE" officechat-backup-agent.service
snapshot_file "$OFFICECHAT_BACKUP_AGENT_CONFIG_FILE" backup-agent.conf
snapshot_file "${OFFICECHAT_INSTALL_DIR}/backup-agent.py" backup-agent.py
snapshot_file "${OFFICECHAT_INSTALL_DIR}/RELEASE.json" RELEASE.json

rollback_update() {
  rollback_armed=0
  trap - ERR
  warn "Restoring pre-update files and services; database downgrade is not attempted."
  restore_file "$OFFICECHAT_COMPOSE_FILE" docker-compose.yml
  restore_file "$OFFICECHAT_VERSION_OVERRIDE_FILE" docker-compose.version-override.yml
  restore_file "$OFFICECHAT_ENV_FILE" officechat.env
  restore_file "$OFFICECHAT_BACKUP_AGENT_UNIT_FILE" officechat-backup-agent.service
  restore_file "$OFFICECHAT_BACKUP_AGENT_CONFIG_FILE" backup-agent.conf
  restore_file "${OFFICECHAT_INSTALL_DIR}/backup-agent.py" backup-agent.py
  restore_file "${OFFICECHAT_INSTALL_DIR}/RELEASE.json" RELEASE.json
  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload || true
    systemctl restart officechat-backup-agent.service || true
  fi
  compose config --quiet || warn "Restored Compose stack did not validate"
  compose up -d backend calendar-worker frontend || warn "Previous containers could not be restarted automatically"
}

rollback_armed=1
on_update_error() {
  local status=$?
  trap - ERR
  if [[ "$rollback_armed" == "1" ]]; then
    rollback_update
  fi
  exit "$status"
}
trap on_update_error ERR

install -m 0644 "$compose_source" "$OFFICECHAT_COMPOSE_FILE"
atomic_update_env_metadata "$OFFICECHAT_ENV_FILE" "$RELEASE_VERSION" "$RELEASE_REVISION" "$RELEASE_BUILD_DATE"
atomic_write_version_override "$OFFICECHAT_VERSION_OVERRIDE_FILE" "$RELEASE_VERSION" "$RELEASE_REVISION" "$RELEASE_BUILD_DATE"
install -m 0644 "$metadata_source" "${OFFICECHAT_INSTALL_DIR}/RELEASE.json"

ensure_backup_agent_group
ensure_env_value "$OFFICECHAT_ENV_FILE" OFFICECHAT_BACKUP_GID "$OFFICECHAT_BACKUP_GID"
ensure_env_value "$OFFICECHAT_ENV_FILE" BACKUP_AGENT_RUNTIME_DIR /run/officechat-backup-agent
install -m 0755 "$agent_source" "${OFFICECHAT_INSTALL_DIR}/backup-agent.py"
if [[ -L "$OFFICECHAT_BACKUP_AGENT_CONFIG_FILE" ]]; then
  rollback_update
  fail "Refusing symlink backup agent configuration"
fi
if [[ ! -f "$OFFICECHAT_BACKUP_AGENT_CONFIG_FILE" ]]; then
  install -o root -g root -m 0600 "$agent_config_source" "$OFFICECHAT_BACKUP_AGENT_CONFIG_FILE"
  sed -i "s|/var/backups/officechat|${OFFICECHAT_BACKUP_DIR}|g" "$OFFICECHAT_BACKUP_AGENT_CONFIG_FILE"
fi
chown root:root "$OFFICECHAT_BACKUP_AGENT_CONFIG_FILE"
chmod 600 "$OFFICECHAT_BACKUP_AGENT_CONFIG_FILE"
install -m 0644 "${systemd_source}/officechat-backup-agent.service" \
  "$OFFICECHAT_BACKUP_AGENT_UNIT_FILE"

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload
  systemctl enable --now officechat-backup-agent.service
else
  rollback_update
  fail "systemd is required for the backup agent"
fi

if ! validate_resolved_stack "$OFFICECHAT_ENV_FILE" "$OFFICECHAT_COMPOSE_FILE" \
  "$OFFICECHAT_HTTPS_OVERRIDE_FILE" "$OFFICECHAT_VERSION_OVERRIDE_FILE" "$RELEASE_VERSION"; then
  rollback_update
  fail "Installed Compose stack does not resolve to the requested release"
fi

compose pull backend frontend calendar-worker
if ! compose run --rm backend alembic upgrade head; then
  rollback_update
  fail "Migration failed"
fi
compose up -d backend calendar-worker frontend
if ! wait_for_ready; then
  rollback_update
  fail "Readiness failed"
fi

for backup_tool in backup-production.sh verify-backup.sh restore-production.sh; do
  if [[ -f "${SCRIPT_DIR}/${backup_tool}" && "${SCRIPT_DIR}/${backup_tool}" != "${OFFICECHAT_INSTALL_DIR}/${backup_tool}" ]]; then
    install -m 0755 "${SCRIPT_DIR}/${backup_tool}" "${OFFICECHAT_INSTALL_DIR}/${backup_tool}"
  fi
done
if [[ -f "${SCRIPT_DIR}/backup/lib.sh" && "${SCRIPT_DIR}/backup/lib.sh" != "${OFFICECHAT_INSTALL_DIR}/backup/lib.sh" ]]; then
  install -d -m 0755 "${OFFICECHAT_INSTALL_DIR}/backup"
  install -m 0644 "${SCRIPT_DIR}/backup/lib.sh" "${OFFICECHAT_INSTALL_DIR}/backup/lib.sh"
fi
for backup_doc in BACKUP_CENTER_RU.md BACKUP_CENTER.md BACKUP_RESTORE_RU.md BACKUP_RESTORE.md; do
  if [[ -f "${SCRIPT_DIR}/deployment/${backup_doc}" ]]; then
    install -d -m 0755 "${OFFICECHAT_INSTALL_DIR}/docs"
    install -m 0644 "${SCRIPT_DIR}/deployment/${backup_doc}" "${OFFICECHAT_INSTALL_DIR}/docs/${backup_doc}"
  fi
done
for release_tool in lib.sh install-linux.sh update-linux.sh rollback-linux.sh uninstall-linux.sh verify-install.sh officechatctl collect-diagnostics.sh; do
  if [[ -f "${SCRIPT_DIR}/${release_tool}" && "${SCRIPT_DIR}/${release_tool}" != "${OFFICECHAT_INSTALL_DIR}/${release_tool}" ]]; then
    install -m 0755 "${SCRIPT_DIR}/${release_tool}" "${OFFICECHAT_INSTALL_DIR}/${release_tool}"
  fi
done

record_version "$TARGET_VERSION"
rollback_armed=0
trap - ERR
pass "OfficeChat updated to ${TARGET_VERSION}."
