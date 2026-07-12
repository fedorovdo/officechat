#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "${SCRIPT_DIR}/lib.sh"

OUTPUT_DIR="${1:-officechat-diagnostics-$(date -u +%Y%m%d_%H%M%S)}"
mkdir -p "$OUTPUT_DIR"
{
  echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "installed_version=$(read_installed_version)"
  uname -a
  docker version
  docker compose version
  df -h "$OFFICECHAT_DATA_DIR" || true
} >"${OUTPUT_DIR}/system.txt" 2>&1
compose ps >"${OUTPUT_DIR}/compose-ps.txt" 2>&1 || true
compose config --no-interpolate >"${OUTPUT_DIR}/compose-config.txt" 2>&1 || true
compose exec -T backend alembic current >"${OUTPUT_DIR}/alembic-current.txt" 2>&1 || true
compose logs --tail=300 backend frontend calendar-worker >"${OUTPUT_DIR}/logs-sanitized.txt" 2>&1 || true
sed -i -E 's/(APP_SECRET_KEY|POSTGRES_PASSWORD|DATABASE_URL)=.*/\1=<redacted>/g' "${OUTPUT_DIR}/compose-config.txt" "${OUTPUT_DIR}/logs-sanitized.txt" 2>/dev/null || true
tar -czf "${OUTPUT_DIR}.tar.gz" "$OUTPUT_DIR"
echo "Diagnostics written to ${OUTPUT_DIR}.tar.gz"
