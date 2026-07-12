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
else
  backup_now
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
