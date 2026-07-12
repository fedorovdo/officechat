#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "${SCRIPT_DIR}/lib.sh"

FULL_RESTORE=0
BACKUP_DIR=""
TARGET_VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      cat <<'EOF_HELP'
Usage: rollback-linux.sh VERSION [--dry-run]
       rollback-linux.sh --full-restore BACKUP_DIR

Image rollback does not downgrade the database. Full restore requires typing RESTORE OFFICECHAT.
EOF_HELP
      exit 0
      ;;
    --dry-run) set_dry_run; shift ;;
    --full-restore) FULL_RESTORE=1; BACKUP_DIR="${2:-}"; shift 2 ;;
    *)
      if [[ -z "$TARGET_VERSION" ]]; then TARGET_VERSION="$1"; shift; else fail "Unknown argument: $1"; fi
      ;;
  esac
done

require_docker_compose
acquire_lock

if [[ "$FULL_RESTORE" == "1" ]]; then
  [[ -n "$BACKUP_DIR" && -d "$BACKUP_DIR" ]] || fail "Backup directory is required"
  printf 'Type RESTORE OFFICECHAT to restore database and uploads: '
  read -r confirmation
  [[ "$confirmation" == "RESTORE OFFICECHAT" ]] || fail "Confirmation mismatch"
  run_cmd compose stop backend calendar-worker frontend
  run_cmd compose exec -T postgres dropdb -U "${POSTGRES_USER:-officechat}" --if-exists "${POSTGRES_DB:-officechat}"
  run_cmd compose exec -T postgres createdb -U "${POSTGRES_USER:-officechat}" "${POSTGRES_DB:-officechat}"
  if is_dry_run; then
    echo "DRY-RUN: restore database from ${BACKUP_DIR}/officechat.dump"
  else
    compose exec -T postgres pg_restore -U "${POSTGRES_USER:-officechat}" -d "${POSTGRES_DB:-officechat}" --clean --if-exists <"${BACKUP_DIR}/officechat.dump"
  fi
  if [[ -f "${BACKUP_DIR}/uploads.tar.gz" ]]; then
    run_cmd tar -C "$OFFICECHAT_DATA_DIR" -xzf "${BACKUP_DIR}/uploads.tar.gz"
  fi
  run_cmd compose up -d
  wait_for_ready || fail "Readiness failed after full restore"
  pass "Full restore completed."
  exit 0
fi

[[ -n "$TARGET_VERSION" ]] || fail "Rollback target version is required"
validate_version "$TARGET_VERSION"
run_cmd sed -i.bak "s/^OFFICECHAT_VERSION=.*/OFFICECHAT_VERSION=${TARGET_VERSION}/" "$OFFICECHAT_ENV_FILE"
run_cmd compose pull backend frontend calendar-worker
run_cmd compose up -d backend calendar-worker frontend
wait_for_ready || fail "Readiness failed after image rollback"
record_version "$TARGET_VERSION"
pass "OfficeChat image rollback completed: ${TARGET_VERSION}."
