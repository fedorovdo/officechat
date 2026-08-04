#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION="${OFFICECHAT_RELEASE_VERSION:-0.1.0-rc2}"
ARCH="${OFFICECHAT_RELEASE_ARCH:-linux-amd64}"
RELEASE_DIR="${ROOT_DIR}/release"
DIST_DIR="${ROOT_DIR}/dist"
ARCHIVE_NAME="officechat-${VERSION}-${ARCH}.tar.gz"

usage() {
  cat <<'EOF_HELP'
Usage: create-release-bundle.sh [--dry-run]

Creates release/ and dist/officechat-VERSION-linux-amd64.tar.gz.
EOF_HELP
}

DRY_RUN=0
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] %q' "$1"
    shift || true
    for arg in "$@"; do printf ' %q' "$arg"; done
    printf '\n'
  else
    "$@"
  fi
}

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9._-]+)?$ ]] || { echo "Invalid version: $VERSION" >&2; exit 2; }

run mkdir -p "$RELEASE_DIR" "$DIST_DIR"
run mkdir -p "${RELEASE_DIR}/caddy"
run mkdir -p "${RELEASE_DIR}/backup"
run mkdir -p "${RELEASE_DIR}/deployment"
run mkdir -p "${RELEASE_DIR}/systemd"
run cp "${ROOT_DIR}/deploy/docker-compose.release.yml" "${RELEASE_DIR}/docker-compose.yml"
run cp "${ROOT_DIR}/.env.production.example" "${RELEASE_DIR}/.env.example"
run sed -i \
  -e "s/^APP_VERSION=.*/APP_VERSION=${VERSION}/" \
  -e "s/^OFFICECHAT_VERSION=.*/OFFICECHAT_VERSION=${VERSION}/" \
  -e "s/^NEXT_PUBLIC_OFFICECHAT_VERSION=.*/NEXT_PUBLIC_OFFICECHAT_VERSION=${VERSION}/" \
  "${RELEASE_DIR}/.env.example"
run cp "${ROOT_DIR}/scripts/release/install-linux.sh" "${RELEASE_DIR}/install-linux.sh"
run cp "${ROOT_DIR}/scripts/release/update-linux.sh" "${RELEASE_DIR}/update-linux.sh"
run cp "${ROOT_DIR}/scripts/release/rollback-linux.sh" "${RELEASE_DIR}/rollback-linux.sh"
run cp "${ROOT_DIR}/scripts/release/uninstall-linux.sh" "${RELEASE_DIR}/uninstall-linux.sh"
run cp "${ROOT_DIR}/scripts/release/verify-install.sh" "${RELEASE_DIR}/verify-install.sh"
run cp "${ROOT_DIR}/scripts/release/officechatctl" "${RELEASE_DIR}/officechatctl"
run cp "${ROOT_DIR}/scripts/release/lib.sh" "${RELEASE_DIR}/lib.sh"
run cp "${ROOT_DIR}/scripts/release/collect-diagnostics.sh" "${RELEASE_DIR}/collect-diagnostics.sh"
run cp "${ROOT_DIR}/scripts/backup-production.sh" "${RELEASE_DIR}/backup-production.sh"
run cp "${ROOT_DIR}/scripts/verify-backup.sh" "${RELEASE_DIR}/verify-backup.sh"
run cp "${ROOT_DIR}/scripts/restore-production.sh" "${RELEASE_DIR}/restore-production.sh"
run cp "${ROOT_DIR}/scripts/backup_agent.py" "${RELEASE_DIR}/backup-agent.py"
run cp "${ROOT_DIR}/scripts/backup/lib.sh" "${RELEASE_DIR}/backup/lib.sh"
run cp "${ROOT_DIR}/deploy/backup/officechat-backup.conf.example" "${RELEASE_DIR}/backup/officechat-backup.conf.example"
run cp "${ROOT_DIR}/deploy/backup/officechat-backup-agent.conf.example" "${RELEASE_DIR}/backup/officechat-backup-agent.conf.example"
run cp "${ROOT_DIR}/deploy/systemd/officechat-backup.service" "${RELEASE_DIR}/systemd/officechat-backup.service"
run cp "${ROOT_DIR}/deploy/systemd/officechat-backup.timer" "${RELEASE_DIR}/systemd/officechat-backup.timer"
run cp "${ROOT_DIR}/deploy/systemd/officechat-backup-agent.service" "${RELEASE_DIR}/systemd/officechat-backup-agent.service"
run cp "${ROOT_DIR}/docs/BACKUP_RESTORE_RU.md" "${RELEASE_DIR}/deployment/BACKUP_RESTORE_RU.md"
run cp "${ROOT_DIR}/docs/BACKUP_RESTORE.md" "${RELEASE_DIR}/deployment/BACKUP_RESTORE.md"
run cp "${ROOT_DIR}/docs/BACKUP_CENTER_RU.md" "${RELEASE_DIR}/deployment/BACKUP_CENTER_RU.md"
run cp "${ROOT_DIR}/docs/BACKUP_CENTER.md" "${RELEASE_DIR}/deployment/BACKUP_CENTER.md"
run cp "${ROOT_DIR}/deploy/caddy/Caddyfile.example" "${RELEASE_DIR}/caddy/Caddyfile.example"
run cp "${ROOT_DIR}/deploy/caddy/docker-compose.caddy.yml" "${RELEASE_DIR}/caddy/docker-compose.caddy.yml"
for deployment_doc in production-installation.md internal-https.md windows-certificate-installation.md caddy-ca-backup-restore.md; do
  run cp "${ROOT_DIR}/docs/deployment/${deployment_doc}" "${RELEASE_DIR}/deployment/${deployment_doc}"
done
if [[ -f "${ROOT_DIR}/docs/INSTALL_RU.md" ]]; then
  run cp "${ROOT_DIR}/docs/INSTALL_RU.md" "${RELEASE_DIR}/README_INSTALL_RU.md"
fi
if [[ "$DRY_RUN" == "1" ]]; then
  echo "[dry-run] write ${RELEASE_DIR}/VERSION"
else
  printf '%s\n' "$VERSION" >"${RELEASE_DIR}/VERSION"
fi
run chmod +x "${RELEASE_DIR}/install-linux.sh" "${RELEASE_DIR}/update-linux.sh" "${RELEASE_DIR}/rollback-linux.sh" "${RELEASE_DIR}/uninstall-linux.sh" "${RELEASE_DIR}/verify-install.sh" "${RELEASE_DIR}/officechatctl" "${RELEASE_DIR}/collect-diagnostics.sh" "${RELEASE_DIR}/backup-production.sh" "${RELEASE_DIR}/verify-backup.sh" "${RELEASE_DIR}/restore-production.sh" "${RELEASE_DIR}/backup-agent.py"
run chmod 0644 \
  "${RELEASE_DIR}/backup/lib.sh" \
  "${RELEASE_DIR}/backup/officechat-backup.conf.example" \
  "${RELEASE_DIR}/backup/officechat-backup-agent.conf.example" \
  "${RELEASE_DIR}/systemd/officechat-backup.service" \
  "${RELEASE_DIR}/systemd/officechat-backup.timer" \
  "${RELEASE_DIR}/systemd/officechat-backup-agent.service"

if [[ "$DRY_RUN" != "1" ]]; then
  (
    cd "$RELEASE_DIR"
    sha256sum docker-compose.yml .env.example caddy/Caddyfile.example caddy/docker-compose.caddy.yml backup/* systemd/* deployment/*.md install-linux.sh update-linux.sh rollback-linux.sh uninstall-linux.sh verify-install.sh officechatctl collect-diagnostics.sh backup-production.sh verify-backup.sh restore-production.sh backup-agent.py VERSION README_INSTALL_RU.md 2>/dev/null >CHECKSUMS.sha256
  )
  (
    archive_stage="$(mktemp -d)"
    trap 'rm -rf -- "$archive_stage"' EXIT
    cp -a "$RELEASE_DIR" "${archive_stage}/release"
    find "${archive_stage}/release" -type d -exec chmod 0755 {} +
    find "${archive_stage}/release" -type f -exec chmod 0644 {} +
    chmod 0755 \
      "${archive_stage}/release/install-linux.sh" \
      "${archive_stage}/release/update-linux.sh" \
      "${archive_stage}/release/rollback-linux.sh" \
      "${archive_stage}/release/uninstall-linux.sh" \
      "${archive_stage}/release/verify-install.sh" \
      "${archive_stage}/release/officechatctl" \
      "${archive_stage}/release/collect-diagnostics.sh" \
      "${archive_stage}/release/backup-production.sh" \
      "${archive_stage}/release/verify-backup.sh" \
      "${archive_stage}/release/restore-production.sh" \
      "${archive_stage}/release/backup-agent.py"
    tar -C "$archive_stage" -czf "${DIST_DIR}/${ARCHIVE_NAME}" release
    sha256sum "${DIST_DIR}/${ARCHIVE_NAME}" >"${DIST_DIR}/${ARCHIVE_NAME}.sha256"
  )
fi

echo "Release bundle ready: ${DIST_DIR}/${ARCHIVE_NAME}"
