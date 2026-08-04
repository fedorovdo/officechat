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
Pulls the requested OfficeChat image tag, applies migrations, restarts services and records the version.
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
acquire_lock

current_version="$(read_installed_version)"
if [[ "$ALLOW_DOWNGRADE" != "1" && "$current_version" != "unknown" && "$TARGET_VERSION" < "$current_version" ]]; then
  fail "Refusing apparent downgrade from ${current_version} to ${TARGET_VERSION}; pass --allow-downgrade to override."
fi

if [[ "$NO_BACKUP" == "1" ]]; then
  warn "Proceeding without backup by user request."
elif [[ -x "${OFFICECHAT_INSTALL_DIR}/backup-production.sh" && -f /etc/officechat/backup.conf ]]; then
  run_cmd "${OFFICECHAT_INSTALL_DIR}/backup-production.sh" --config /etc/officechat/backup.conf --pre-upgrade
else
  backup_now
fi

# Refresh versioned backup tooling from a release bundle, but never replace the
# administrator-owned /etc/officechat/backup.conf.
compose_source=""
if [[ -f "${SCRIPT_DIR}/../../deploy/docker-compose.release.yml" ]]; then
  compose_source="${SCRIPT_DIR}/../../deploy/docker-compose.release.yml"
elif [[ -f "${SCRIPT_DIR}/docker-compose.yml" ]]; then
  compose_source="${SCRIPT_DIR}/docker-compose.yml"
fi
if [[ -n "$compose_source" && "$compose_source" != "$OFFICECHAT_COMPOSE_FILE" ]]; then
  as_root install -m 0644 "$compose_source" "$OFFICECHAT_COMPOSE_FILE"
fi
for backup_tool in backup-production.sh verify-backup.sh restore-production.sh; do
  if [[ -f "${SCRIPT_DIR}/${backup_tool}" && "${SCRIPT_DIR}/${backup_tool}" != "${OFFICECHAT_INSTALL_DIR}/${backup_tool}" ]]; then
    as_root install -m 0755 "${SCRIPT_DIR}/${backup_tool}" "${OFFICECHAT_INSTALL_DIR}/${backup_tool}"
  fi
done
agent_source=""
if [[ -f "${SCRIPT_DIR}/../backup_agent.py" ]]; then
  agent_source="${SCRIPT_DIR}/../backup_agent.py"
elif [[ -f "${SCRIPT_DIR}/backup-agent.py" ]]; then
  agent_source="${SCRIPT_DIR}/backup-agent.py"
fi
[[ -n "$agent_source" ]] || fail "Backup agent executable not found"
as_root install -m 0755 "$agent_source" "${OFFICECHAT_INSTALL_DIR}/backup-agent.py"
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
ensure_backup_agent_group
ensure_env_value "$OFFICECHAT_ENV_FILE" OFFICECHAT_BACKUP_GID "$OFFICECHAT_BACKUP_GID"
ensure_env_value "$OFFICECHAT_ENV_FILE" BACKUP_AGENT_RUNTIME_DIR /run/officechat-backup-agent
if [[ -f "${SCRIPT_DIR}/backup/lib.sh" && "${SCRIPT_DIR}/backup/lib.sh" != "${OFFICECHAT_INSTALL_DIR}/backup/lib.sh" ]]; then
  as_root install -d -m 0755 "${OFFICECHAT_INSTALL_DIR}/backup"
  as_root install -m 0644 "${SCRIPT_DIR}/backup/lib.sh" "${OFFICECHAT_INSTALL_DIR}/backup/lib.sh"
fi
for backup_doc in BACKUP_CENTER_RU.md BACKUP_CENTER.md BACKUP_RESTORE_RU.md BACKUP_RESTORE.md; do
  if [[ -f "${SCRIPT_DIR}/deployment/${backup_doc}" ]]; then
    as_root install -d -m 0755 "${OFFICECHAT_INSTALL_DIR}/docs"
    as_root install -m 0644 "${SCRIPT_DIR}/deployment/${backup_doc}" "${OFFICECHAT_INSTALL_DIR}/docs/${backup_doc}"
  fi
done
systemd_source=""
if [[ -d "${SCRIPT_DIR}/../../deploy/systemd" ]]; then
  systemd_source="${SCRIPT_DIR}/../../deploy/systemd"
elif [[ -d "${SCRIPT_DIR}/systemd" ]]; then
  systemd_source="${SCRIPT_DIR}/systemd"
fi
if [[ -n "$systemd_source" ]]; then
  as_root install -m 0644 "${systemd_source}/officechat-backup.service" \
    /etc/systemd/system/officechat-backup.service
  as_root install -m 0644 "${systemd_source}/officechat-backup.timer" \
    /etc/systemd/system/officechat-backup.timer
  as_root install -m 0644 "${systemd_source}/officechat-backup-agent.service" \
    /etc/systemd/system/officechat-backup-agent.service
  if is_dry_run; then
    log "DRY-RUN: restart officechat-backup-agent.service"
  elif command -v systemctl >/dev/null 2>&1; then
    as_root systemctl daemon-reload
    as_root systemctl enable --now officechat-backup-agent.service
  else
    fail "systemd is required for the read-only backup agent"
  fi
else
  fail "Backup systemd units not found"
fi

if is_dry_run; then
  echo "DRY-RUN: update OFFICECHAT_VERSION in ${OFFICECHAT_ENV_FILE} to ${TARGET_VERSION}"
else
  cp "$OFFICECHAT_ENV_FILE" "${OFFICECHAT_ENV_FILE}.previous"
  if grep -q '^OFFICECHAT_VERSION=' "$OFFICECHAT_ENV_FILE"; then
    sed -i.bak "s/^OFFICECHAT_VERSION=.*/OFFICECHAT_VERSION=${TARGET_VERSION}/" "$OFFICECHAT_ENV_FILE"
  else
    printf '\nOFFICECHAT_VERSION=%s\n' "$TARGET_VERSION" >>"$OFFICECHAT_ENV_FILE"
  fi
fi

if is_dry_run; then
  run_cmd compose config
else
  compose config >/dev/null
fi
run_cmd compose pull backend frontend calendar-worker
if ! run_cmd compose run --rm backend alembic upgrade head; then
  warn "Migration failed; restoring previous image version in .env. Database downgrade is not attempted."
  run_cmd mv "${OFFICECHAT_ENV_FILE}.previous" "$OFFICECHAT_ENV_FILE"
  run_cmd compose up -d backend calendar-worker frontend
  exit 1
fi
run_cmd compose up -d backend calendar-worker frontend
if ! wait_for_ready; then
  warn "Readiness failed; restoring previous image version in .env. Database downgrade is not attempted."
  run_cmd mv "${OFFICECHAT_ENV_FILE}.previous" "$OFFICECHAT_ENV_FILE"
  run_cmd compose up -d backend calendar-worker frontend
  exit 1
fi

run_cmd rm -f "${OFFICECHAT_ENV_FILE}.previous" "${OFFICECHAT_ENV_FILE}.bak"
record_version "$TARGET_VERSION"
pass "OfficeChat updated to ${TARGET_VERSION}."
