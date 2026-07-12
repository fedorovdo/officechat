#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "${SCRIPT_DIR}/lib.sh"

PURGE_DATA=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      cat <<'EOF_HELP'
Usage: uninstall-linux.sh [--dry-run] [--purge-data]
Stops and removes OfficeChat containers. Data, backups and .env are preserved unless --purge-data is confirmed.
EOF_HELP
      exit 0
      ;;
    --dry-run) set_dry_run; shift ;;
    --purge-data) PURGE_DATA=1; shift ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

require_docker_compose
acquire_lock
run_cmd compose down
pass "Containers removed. Data, backups and .env were preserved."

if [[ "$PURGE_DATA" == "1" ]]; then
  printf 'Type DELETE OFFICECHAT DATA to remove install dir and data dir. Backups are not deleted: '
  read -r confirmation
  [[ "$confirmation" == "DELETE OFFICECHAT DATA" ]] || fail "Confirmation mismatch"
  require_safe_path "$OFFICECHAT_INSTALL_DIR"
  require_safe_path "$OFFICECHAT_DATA_DIR"
  as_root rm -rf "$OFFICECHAT_INSTALL_DIR" "$OFFICECHAT_DATA_DIR"
  pass "OfficeChat install and data directories removed. Backups preserved at ${OFFICECHAT_BACKUP_DIR}."
fi
