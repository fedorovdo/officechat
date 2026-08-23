#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

FAKE_BIN="${TMP_DIR}/bin"
FAKE_LOG="${TMP_DIR}/docker.log"
INSTALL_DIR="${TMP_DIR}/install"
DATA_DIR="${TMP_DIR}/data"
BACKUP_DIR="${TMP_DIR}/backups"
ENV_FILE="${TMP_DIR}/officechat.env"
COMPOSE_FILE="${ROOT_DIR}/deploy/docker-compose.release.yml"
LOCK_DIR="${TMP_DIR}/officechat.lock"
VERSION_FILE="${INSTALL_DIR}/VERSION"
CADDY_FILE="${ROOT_DIR}/deploy/caddy/Caddyfile.example"
RELEASE_WORKFLOW_FILE="${ROOT_DIR}/.github/workflows/release-images.yml"
HTTPS_OVERRIDE_FILE="${INSTALL_DIR}/docker-compose.https-override.yml"
VERSION_OVERRIDE_FILE="${INSTALL_DIR}/docker-compose.version-override.yml"
RELEASE_METADATA_FILE="${TMP_DIR}/RELEASE.json"

mkdir -p "$FAKE_BIN" "$INSTALL_DIR"
printf '0.1.0-rc2\n' >"$VERSION_FILE"
printf 'OFFICECHAT_VERSION=0.1.0-rc2\nOFFICECHAT_BUILD_SHA=old-sha\nOFFICECHAT_BUILD_DATE=old-date\nAPP_SECRET_KEY=preserve-this-secret\n' >"$ENV_FILE"
cat >"$HTTPS_OVERRIDE_FILE" <<'EOF_HTTPS'
services:
  backend:
    image: ghcr.io/fedorovdo/officechat-backend:0.1.0-rc9
  calendar-worker:
    image: ghcr.io/fedorovdo/officechat-backend:0.1.0-rc9
  frontend:
    image: ghcr.io/fedorovdo/officechat-frontend:0.1.0-rc11
    environment:
      NEXT_PUBLIC_OFFICECHAT_VERSION: 0.1.0-rc11
EOF_HTTPS
cat >"$RELEASE_METADATA_FILE" <<'EOF_RELEASE'
{
  "version": "0.1.0-rc3",
  "revision": "3333333333333333333333333333333333333333",
  "build_date": "2026-08-04T18:00:00Z",
  "backend_image": "ghcr.io/fedorovdo/officechat-backend:0.1.0-rc3",
  "frontend_image": "ghcr.io/fedorovdo/officechat-frontend:0.1.0-rc3"
}
EOF_RELEASE

cat >"${FAKE_BIN}/docker" <<'EOF_DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"${OFFICECHAT_FAKE_DOCKER_LOG}"
if [[ "${OFFICECHAT_FAKE_MIGRATION_FAIL:-0}" == "1" && "$*" == *"alembic upgrade head"* ]]; then
  exit 7
fi
if [[ "${1:-}" == "compose" && "${2:-}" == "version" ]]; then
  echo "Docker Compose version v2.test"
  exit 0
fi
if [[ "${1:-}" == "compose" && "$*" == *"ps -q caddy"* && "${OFFICECHAT_FAKE_CADDY_RUNNING:-0}" == "1" ]]; then
  echo "officechat-caddy-test"
  exit 0
fi
if [[ "${1:-}" == "compose" && "$*" == *"logs --tail=300"* ]]; then
  echo 'GET /api/ws/me?token=synthetic-diagnostics-query&view=all'
  echo 'POST /api/bots/incoming/synthetic-diagnostics-path'
  exit 0
fi
if [[ "${1:-}" == "compose" && "$*" == *"config --format json"* ]]; then
  version_override=""
  args=("$@")
  for ((i = 0; i < ${#args[@]}; i++)); do
    if [[ "${args[$i]}" == "-f" ]]; then
      version_override="${args[$((i + 1))]}"
    fi
  done
  version="$(sed -n 's|.*officechat-backend:\([^[:space:]]*\)|\1|p' "$version_override" | head -n 1)"
  cat <<EOF_JSON
{"networks":{"public":{"name":"officechat_public"}},"services":{"postgres":{"volumes":[{"target":"/var/lib/postgresql/data","bind":{"selinux":"Z"}}]},"valkey":{"volumes":[{"target":"/data","bind":{"selinux":"Z"}}]},"backend":{"image":"ghcr.io/fedorovdo/officechat-backend:${version}","group_add":["65530"],"volumes":[{"target":"/data/uploads","bind":{"selinux":"z"}},{"target":"/run/officechat-backup-agent","read_only":true,"bind":{"selinux":"z"}}]},"calendar-worker":{"image":"ghcr.io/fedorovdo/officechat-backend:${version}","volumes":[{"target":"/data/uploads","bind":{"selinux":"z"}}]},"frontend":{"image":"ghcr.io/fedorovdo/officechat-frontend:${version}","ports":[{"host_ip":"127.0.0.1"}]}}}
EOF_JSON
fi
exit 0
EOF_DOCKER
chmod +x "${FAKE_BIN}/docker"

cat >"${FAKE_BIN}/sudo" <<'EOF_SUDO'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'sudo %s\n' "$*" >>"${OFFICECHAT_FAKE_DOCKER_LOG}"
exit 0
EOF_SUDO
chmod +x "${FAKE_BIN}/sudo"

cat >"${FAKE_BIN}/systemctl" <<'EOF_SYSTEMCTL'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'systemctl %s\n' "$*" >>"${OFFICECHAT_FAKE_DOCKER_LOG}"
if [[ "${1:-}" == "is-enabled" ]]; then
  exit "${OFFICECHAT_FAKE_AGENT_ENABLED_STATUS:-0}"
fi
if [[ "${1:-}" == "is-active" ]]; then
  exit "${OFFICECHAT_FAKE_AGENT_ACTIVE_STATUS:-0}"
fi
if [[ "${1:-}" == "restart" && "${2:-}" == "officechat-backup-agent.service" && -n "${OFFICECHAT_BACKUP_AGENT_SOCKET_FILE:-}" ]]; then
  rm -f -- "$OFFICECHAT_BACKUP_AGENT_SOCKET_FILE"
  python3 - "$OFFICECHAT_BACKUP_AGENT_SOCKET_FILE" <<'PY_SOCKET'
import os
import socket
import sys

listener = socket.socket(socket.AF_UNIX)
listener.bind(sys.argv[1])
listener.close()
os.chmod(sys.argv[1], 0o660)
PY_SOCKET
fi
exit 0
EOF_SYSTEMCTL
chmod +x "${FAKE_BIN}/systemctl"

export PATH="${FAKE_BIN}:${PATH}"
export OFFICECHAT_FAKE_DOCKER_LOG="$FAKE_LOG"
export OFFICECHAT_INSTALL_DIR="$INSTALL_DIR"
export OFFICECHAT_DATA_DIR="$DATA_DIR"
export OFFICECHAT_BACKUP_DIR="$BACKUP_DIR"
export OFFICECHAT_ENV_FILE="$ENV_FILE"
export OFFICECHAT_COMPOSE_FILE="$COMPOSE_FILE"
export OFFICECHAT_HTTPS_OVERRIDE_FILE="$HTTPS_OVERRIDE_FILE"
export OFFICECHAT_VERSION_OVERRIDE_FILE="$VERSION_OVERRIDE_FILE"
export OFFICECHAT_RELEASE_METADATA_FILE="$RELEASE_METADATA_FILE"
export OFFICECHAT_RELEASE_VERSION="0.1.0-rc3"
export OFFICECHAT_LOCK_FILE="$LOCK_DIR"
export OFFICECHAT_BACKUP_AGENT_SOCKET_FILE="${TMP_DIR}/agent.sock"

bash -n "${SCRIPT_DIR}"/*.sh
bash -n "${SCRIPT_DIR}/officechatctl"

python3 - "$RELEASE_WORKFLOW_FILE" <<'PY_WORKFLOW_ORDER'
import sys
from pathlib import Path

workflow = Path(sys.argv[1]).read_text(encoding="utf-8")
needles = (
    "docker compose up -d --wait postgres valkey",
    "docker compose run --rm backend alembic upgrade head",
    'heads = revisions("heads")',
    'current = revisions("current")',
    "docker compose run --rm backend python -m pytest -q",
    "docker compose --env-file .env.production.example",
    "bash scripts/release/test-compose-stack.sh",
    "- name: Build and push backend image",
)
for needle in needles:
    if workflow.count(needle) != 1:
        raise SystemExit(f"release workflow must contain exactly one {needle!r}")
positions = [workflow.index(needle) for needle in needles]
if positions != sorted(positions):
    raise SystemExit("release workflow does not migrate and verify the database before tests and publication")
migration_block = workflow[positions[1] : positions[4]]
if "continue-on-error" in migration_block:
    raise SystemExit("release database migration or verification may ignore failures")
if "source .env.production.example" in workflow or "set -a" in workflow:
    raise SystemExit("release workflow must treat the production example as Compose dotenv data")
PY_WORKFLOW_ORDER

[[ -f "$CADDY_FILE" ]] || { echo "Caddy template is missing" >&2; exit 1; }
grep -Fq '@frontend_health path /api/health /api/health/*' "$CADDY_FILE" || {
  echo "Caddy template does not route frontend health explicitly" >&2
  exit 1
}
grep -Fq '@backend path /api /api/*' "$CADDY_FILE" || {
  echo "Caddy template does not contain the general backend API route" >&2
  exit 1
}
grep -Fq 'format filter {' "$CADDY_FILE" || {
  echo "Caddy access log does not use the filter encoder" >&2
  exit 1
}
grep -Fq 'request>uri query {' "$CADDY_FILE" || {
  echo "Caddy access log does not filter the request URI query" >&2
  exit 1
}
grep -Fq 'replace token REDACTED' "$CADDY_FILE" || {
  echo "Caddy access log does not redact WebSocket token query values" >&2
  exit 1
}
grep -Fq 'log default {' "$CADDY_FILE" || {
  echo "Caddy runtime logger is not configured independently" >&2
  exit 1
}
grep -Fq 'request>uri regexp' "$CADDY_FILE" || {
  echo "Caddy runtime/error log does not filter request URI credentials" >&2
  exit 1
}
grep -Fq '/api/bots/incoming/' "$CADDY_FILE" || {
  echo "Caddy runtime/error filter does not cover bot webhook path credentials" >&2
  exit 1
}
grep -Fq 'wrap console' "$CADDY_FILE" || {
  echo "Caddy access log no longer preserves console formatting" >&2
  exit 1
}
grep -Fq '@bot_webhook path /api/bots/incoming/*' "$CADDY_FILE" || {
  echo "Caddy does not identify the token-bearing bot webhook path" >&2
  exit 1
}
grep -Fq 'log_skip @bot_webhook' "$CADDY_FILE" || {
  echo "Caddy may log bot webhook path credentials" >&2
  exit 1
}
frontend_health_line="$(grep -n '^[[:space:]]*handle @frontend_health' "$CADDY_FILE" | head -n 1 | cut -d: -f1)"
backend_line="$(grep -n '^[[:space:]]*handle @backend' "$CADDY_FILE" | head -n 1 | cut -d: -f1)"
if [[ -z "$frontend_health_line" || -z "$backend_line" || "$frontend_health_line" -ge "$backend_line" ]]; then
  echo "Caddy frontend health handle must precede the general backend handle" >&2
  exit 1
fi
grep -Fq 'deploy/caddy/Caddyfile.example' "${SCRIPT_DIR}/create-release-bundle.sh" || {
  echo "Release bundle does not include the Caddy template" >&2
  exit 1
}
grep -Fq "s/^OFFICECHAT_VERSION=.*/OFFICECHAT_VERSION=\${VERSION}/" "${SCRIPT_DIR}/create-release-bundle.sh" || {
  echo "Release bundle does not pin its image version in .env.example" >&2
  exit 1
}
grep -Fq "s/^NEXT_PUBLIC_OFFICECHAT_VERSION=.*/NEXT_PUBLIC_OFFICECHAT_VERSION=\${VERSION}/" "${SCRIPT_DIR}/create-release-bundle.sh" || {
  echo "Release bundle does not pin its frontend version in .env.example" >&2
  exit 1
}
grep -Fq 'bundled_version_file=' "${SCRIPT_DIR}/lib.sh" || {
  echo "Release helpers do not read the bundled VERSION file" >&2
  exit 1
}
grep -Fq 'RELEASE.json' "${SCRIPT_DIR}/create-release-bundle.sh" || {
  echo "Release bundle does not generate RELEASE.json" >&2
  exit 1
}
grep -Fq 'RELEASE.json README_INSTALL_RU.md' "${SCRIPT_DIR}/create-release-bundle.sh" || {
  echo "Release checksum manifest does not include RELEASE.json" >&2
  exit 1
}
grep -Fq "sha256sum \"\$ARCHIVE_NAME\" >\"\${ARCHIVE_NAME}.sha256\"" "${SCRIPT_DIR}/create-release-bundle.sh" || {
  echo "Release archive checksum is not portable" >&2
  exit 1
}
grep -Fq 'production-update.md production-update_RU.md' "${SCRIPT_DIR}/create-release-bundle.sh" || {
  echo "Release bundle does not include deploy hotfix documentation" >&2
  exit 1
}
grep -Fq 'Caddyfile.example' "${SCRIPT_DIR}/install-linux.sh" || {
  echo "Installer does not copy the Caddy template" >&2
  exit 1
}
grep -Fq '(token|access_token|authorization|ticket|q)' "${SCRIPT_DIR}/collect-diagnostics.sh" || {
  echo "Diagnostics collection does not independently redact sensitive query values" >&2
  exit 1
}
grep -Fq '/api/bots/incoming/' "${SCRIPT_DIR}/collect-diagnostics.sh" || {
  echo "Diagnostics collection does not redact bot webhook path credentials" >&2
  exit 1
}
diagnostics_dir="${TMP_DIR}/diagnostics"
bash "${SCRIPT_DIR}/collect-diagnostics.sh" "$diagnostics_dir" >/dev/null
if grep -R -E 'synthetic-diagnostics-(query|path)' "$diagnostics_dir" >/dev/null; then
  echo "Diagnostics collection exposed a synthetic URL credential" >&2
  exit 1
fi
grep -Fq 'token=<redacted>' "${diagnostics_dir}/logs-sanitized.txt" || {
  echo "Diagnostics collection omitted the redacted query marker" >&2
  exit 1
}
grep -Fq '/api/bots/incoming/<redacted>' "${diagnostics_dir}/logs-sanitized.txt" || {
  echo "Diagnostics collection omitted the redacted bot webhook marker" >&2
  exit 1
}
for backup_asset in \
  scripts/backup-production.sh \
  scripts/verify-backup.sh \
  scripts/restore-production.sh \
  scripts/backup_agent.py \
  deploy/backup/officechat-backup.conf.example \
  deploy/backup/officechat-backup-agent.conf.example \
  deploy/systemd/officechat-backup.service \
  deploy/systemd/officechat-backup.timer \
  deploy/systemd/officechat-backup-agent.service \
  deploy/systemd/officechat-backup-job.service \
  deploy/systemd/officechat-backup-verify@.service; do
  grep -Fq "$backup_asset" "${SCRIPT_DIR}/create-release-bundle.sh" || {
    echo "Release bundle does not include ${backup_asset}" >&2
    exit 1
  }
done
grep -Fq '[[ ! -f /etc/officechat/backup-agent.conf ]]' "${SCRIPT_DIR}/install-linux.sh" || {
  echo "Installer does not preserve an existing backup-agent.conf" >&2
  exit 1
}
grep -Fq 'ensure_backup_agent_group' "${SCRIPT_DIR}/install-linux.sh" || {
  echo "Installer does not create the backup agent group" >&2
  exit 1
}
grep -Fq 'enable --now officechat-backup-agent.service' "${SCRIPT_DIR}/install-linux.sh" || {
  echo "Installer does not start the backup agent" >&2
  exit 1
}
grep -Fq "[[ ! -f \"\$OFFICECHAT_BACKUP_AGENT_CONFIG_FILE\"" "${SCRIPT_DIR}/update-linux.sh" || {
  echo "Updater does not preserve an existing backup-agent.conf" >&2
  exit 1
}
grep -Fq 'docker-compose.release.yml' "${SCRIPT_DIR}/update-linux.sh" || {
  echo "Updater does not refresh the versioned release Compose file" >&2
  exit 1
}
grep -Fq 'caddy/Caddyfile.example' "${SCRIPT_DIR}/update-linux.sh" || {
  echo "Updater does not install the release Caddy security template" >&2
  exit 1
}
grep -Fq 'caddy reload --config /etc/caddy/Caddyfile' "${SCRIPT_DIR}/update-linux.sh" || {
  echo "Updater does not reload a running Caddy service after security updates" >&2
  exit 1
}
grep -Fq 'BACKUP_CENTER_RU.md' "${SCRIPT_DIR}/update-linux.sh" || {
  echo "Updater does not install Backup Center documentation" >&2
  exit 1
}
grep -Fq '/etc/systemd/system/officechat-backup-agent.service' "${SCRIPT_DIR}/uninstall-linux.sh" || {
  echo "Uninstaller does not remove the stopped backup agent unit" >&2
  exit 1
}
grep -Fq 'Backups preserved' "${SCRIPT_DIR}/uninstall-linux.sh" || {
  echo "Uninstaller does not preserve backup data" >&2
  exit 1
}
grep -Fq 'RestrictAddressFamilies=AF_UNIX' "${ROOT_DIR}/deploy/systemd/officechat-backup-agent.service" || {
  echo "Backup agent unit is not restricted to Unix sockets" >&2
  exit 1
}
grep -Fq 'CapabilityBoundingSet=' "${ROOT_DIR}/deploy/systemd/officechat-backup-agent.service" || {
  echo "Backup agent unit does not clear its capability bounding set" >&2
  exit 1
}
grep -Fq 'StateDirectory=officechat-backup-agent' "${ROOT_DIR}/deploy/systemd/officechat-backup-agent.service" || {
  echo "Backup agent unit does not persist bounded job state" >&2
  exit 1
}
grep -Fq 'StateDirectoryMode=0700' "${ROOT_DIR}/deploy/systemd/officechat-backup-agent.service" || {
  echo "Backup agent state directory mode is not private" >&2
  exit 1
}
if grep -Fq 'ReadWritePaths=' "${ROOT_DIR}/deploy/systemd/officechat-backup-agent.service" &&
  grep -Eq 'ReadWritePaths=.*(/var/backups/officechat|/run/lock|/var/lib/officechat([[:space:]]|$))' \
    "${ROOT_DIR}/deploy/systemd/officechat-backup-agent.service"; then
  echo "Socket-facing backup agent retains executor write paths" >&2
  exit 1
fi
grep -Fq 'NoNewPrivileges=true' "${ROOT_DIR}/deploy/systemd/officechat-backup-agent.service" || {
  echo "Backup agent must retain NoNewPrivileges=true" >&2
  exit 1
}
for executor_unit in officechat-backup-job.service 'officechat-backup-verify@.service'; do
  grep -Fq 'NoNewPrivileges=false' "${ROOT_DIR}/deploy/systemd/${executor_unit}" || {
    echo "Executor unit ${executor_unit} does not declare the approved SELinux tradeoff" >&2
    exit 1
  }
  grep -Fq 'User=root' "${ROOT_DIR}/deploy/systemd/${executor_unit}" || {
    echo "Executor unit ${executor_unit} is not fixed to root" >&2
    exit 1
  }
done
[[ "$(grep -Rhc '^NoNewPrivileges=false$' "${ROOT_DIR}/deploy/systemd" | awk '{total += $1} END {print total + 0}')" == "2" ]] || {
  echo "NoNewPrivileges=false must appear in exactly two executor units" >&2
  exit 1
}
grep -Fq 'ExecStart=/opt/officechat/backup-production.sh --config /etc/officechat/backup.conf' \
  "${ROOT_DIR}/deploy/systemd/officechat-backup-job.service" || {
  echo "Manual backup executor command is not fixed" >&2
  exit 1
}
grep -Fq 'ExecStart=/opt/officechat/restore-production.sh --config /etc/officechat/backup.conf --verify-only --backup-id %i' \
  "${ROOT_DIR}/deploy/systemd/officechat-backup-verify@.service" || {
  echo "Verification executor command is not fixed" >&2
  exit 1
}
for unit_name in officechat-backup.service officechat-backup.timer officechat-backup-agent.service officechat-backup-job.service 'officechat-backup-verify@.service'; do
  grep -Fq "install -o root -g root -m 0644 \"\${systemd_source}/${unit_name}\"" \
    "${SCRIPT_DIR}/install-linux.sh" || {
    echo "Installer does not explicitly install ${unit_name} as root-owned" >&2
    exit 1
  }
done
grep -Fq "as_root chown root:root \"\${OFFICECHAT_INSTALL_DIR}/backup-production.sh\"" \
  "${SCRIPT_DIR}/install-linux.sh" || {
  echo "Installer does not enforce root ownership for privileged backup scripts" >&2
  exit 1
}
grep -Fq "as_root chmod 0755 \"\${OFFICECHAT_INSTALL_DIR}/install-linux.sh\"" \
  "${SCRIPT_DIR}/install-linux.sh" || {
  echo "Installer does not remove group/other write bits from privileged scripts" >&2
  exit 1
}
grep -Fq "as_root chmod 644 \"\${OFFICECHAT_INSTALL_DIR}/backup/lib.sh\"" \
  "${SCRIPT_DIR}/install-linux.sh" || {
  echo "Installer does not set a non-writable mode on the backup helper library" >&2
  exit 1
}
grep -Fq "install -o root -g root -m 0755 \"\$agent_source\"" "${SCRIPT_DIR}/update-linux.sh" || {
  echo "Updater does not preserve root ownership for the backup agent executable" >&2
  exit 1
}
grep -Fq "install -o root -g root -m 0755 \"\${SCRIPT_DIR}/\${backup_tool}\"" \
  "${SCRIPT_DIR}/update-linux.sh" || {
  echo "Updater does not preserve root ownership for backup executor scripts" >&2
  exit 1
}
grep -Fq 'STATE_DIRECTORY=/var/lib/officechat-backup-agent' "${ROOT_DIR}/deploy/backup/officechat-backup-agent.conf.example" || {
  echo "Backup agent config does not use the systemd state directory" >&2
  exit 1
}
backend_block="$(sed -n '/^  backend:/,/^  calendar-worker:/p' "$COMPOSE_FILE")"
worker_block="$(sed -n '/^  calendar-worker:/,/^  frontend:/p' "$COMPOSE_FILE")"
[[ "$backend_block" == *'BACKUP_AGENT_SOCKET'* && "$backend_block" == *'group_add:'* && "$backend_block" == *'officechat-backup-agent'* ]] || {
  echo "Backend does not receive the backup agent socket and group" >&2
  exit 1
}
[[ "$worker_block" != *'BACKUP_AGENT_SOCKET'* && "$worker_block" != *'officechat-backup-agent'* && "$worker_block" != *'group_add:'* ]] || {
  echo "Calendar worker must not receive backup agent access" >&2
  exit 1
}
[[ "$backend_block" != *'/var/backups/officechat'* && "$backend_block" != *'docker.sock'* && "$backend_block" != *'/var/lib/officechat-backup-agent'* ]] || {
  echo "Backend must not receive backup storage, Docker, or agent state" >&2
  exit 1
}
grep -Fq '/postgres:/var/lib/postgresql/data:Z' "$COMPOSE_FILE" || {
  echo "PostgreSQL release bind is missing its private SELinux label" >&2
  exit 1
}
grep -Fq '/valkey:/data:Z' "$COMPOSE_FILE" || {
  echo "Valkey release bind is missing its private SELinux label" >&2
  exit 1
}
[[ "$(grep -Fc '/uploads:/data/uploads:z' "$COMPOSE_FILE")" == "2" ]] || {
  echo "Uploads binds are missing shared SELinux labels" >&2
  exit 1
}
grep -Fq ':/run/officechat-backup-agent:ro,z' "$COMPOSE_FILE" || {
  echo "Backup agent socket bind is missing its shared SELinux label" >&2
  exit 1
}
grep -Fq -- '--backup-id)' "${ROOT_DIR}/scripts/restore-production.sh" || {
  echo "Restore CLI does not support the documented backup-id selector" >&2
  exit 1
}
grep -Fq '[[ ! -f /etc/officechat/backup.conf ]]' "${SCRIPT_DIR}/install-linux.sh" || {
  echo "Installer does not preserve an existing backup.conf" >&2
  exit 1
}
grep -Fq 'ENABLE_BACKUP_TIMER' "${SCRIPT_DIR}/install-linux.sh" || {
  echo "Installer does not require explicit backup timer opt-in" >&2
  exit 1
}
if grep -Eq 'systemctl enable --now officechat-backup.timer' "${SCRIPT_DIR}/install-linux.sh" &&
  ! grep -Fq 'ENABLE_BACKUP_TIMER" == "1' "${SCRIPT_DIR}/install-linux.sh"; then
  echo "Installer enables the backup timer without explicit opt-in" >&2
  exit 1
fi
grep -Fq -- '--pre-upgrade' "${SCRIPT_DIR}/update-linux.sh" || {
  echo "Updater does not create a protected pre-upgrade backup" >&2
  exit 1
}
grep -Fq 'docker-compose.version-override.yml' "${SCRIPT_DIR}/lib.sh" || {
  echo "Release helpers do not support the final version override" >&2
  exit 1
}
grep -Fq 'COMPOSE_OPTIONAL_FILES' "${ROOT_DIR}/scripts/backup/lib.sh" || {
  echo "Backup and restore helpers do not discover optional Compose layers" >&2
  exit 1
}
grep -Fq 'rollback_update' "${SCRIPT_DIR}/update-linux.sh" || {
  echo "Updater does not restore pre-update files on failure" >&2
  exit 1
}
grep -Fq 'systemctl restart officechat-backup-agent.service' "${SCRIPT_DIR}/update-linux.sh" || {
  echo "Updater does not restart a previously active backup agent" >&2
  exit 1
}
grep -Fq 'compose up -d --force-recreate backend' "${SCRIPT_DIR}/update-linux.sh" || {
  echo "Updater does not recreate backend after the agent socket is replaced" >&2
  exit 1
}
if grep -Fq 'systemctl enable --now officechat-backup-agent.service' "${SCRIPT_DIR}/update-linux.sh"; then
  echo "Updater must not unconditionally enable or start the backup agent" >&2
  exit 1
fi

bash "${SCRIPT_DIR}/install-linux.sh" --help >/dev/null
bash "${SCRIPT_DIR}/update-linux.sh" --help >/dev/null
bash "${SCRIPT_DIR}/rollback-linux.sh" --help >/dev/null
bash "${SCRIPT_DIR}/uninstall-linux.sh" --help >/dev/null
bash "${SCRIPT_DIR}/verify-install.sh" --help >/dev/null
bash "${SCRIPT_DIR}/officechatctl" --help >/dev/null
bundle_dry_run_output="$(OFFICECHAT_RELEASE_VERSION=0.1.0-test-release \
  OFFICECHAT_RELEASE_REVISION=2222222222222222222222222222222222222222 \
  OFFICECHAT_RELEASE_BUILD_DATE=2026-08-04T17:00:00Z \
  bash "${SCRIPT_DIR}/create-release-bundle.sh" --dry-run)"
[[ "$bundle_dry_run_output" == *"RELEASE.json for 0.1.0-test-release 2222222222222222222222222222222222222222"* ]] || {
  echo "Bundle dry-run did not use the exact supplied release metadata" >&2
  exit 1
}
[[ "$bundle_dry_run_output" == *"officechat-0.1.0-test-release-linux-amd64.tar.gz"* ]] || {
  echo "Bundle dry-run did not use the supplied version in the archive name" >&2
  exit 1
}
if env -u OFFICECHAT_RELEASE_VERSION \
  OFFICECHAT_RELEASE_REVISION=2222222222222222222222222222222222222222 \
  OFFICECHAT_RELEASE_BUILD_DATE=2026-08-04T17:00:00Z \
  bash "${SCRIPT_DIR}/create-release-bundle.sh" --dry-run >/dev/null 2>&1; then
  echo "Bundle creation accepted missing release version metadata" >&2
  exit 1
fi

source_default_version="$(env -u OFFICECHAT_RELEASE_VERSION bash -c ". \"\$1\"; printf '%s' \"\$OFFICECHAT_RELEASE_VERSION\"" _ "${SCRIPT_DIR}/lib.sh")"
[[ "$source_default_version" == "development" ]] || {
  echo "Source release helpers use an unsafe fallback version" >&2
  exit 1
}

bundle_lib_dir="${TMP_DIR}/bundle-lib"
mkdir -p "$bundle_lib_dir"
cp "${SCRIPT_DIR}/lib.sh" "${bundle_lib_dir}/lib.sh"
printf '9.8.7-bundle-test\n' >"${bundle_lib_dir}/VERSION"
bundled_version="$(env -u OFFICECHAT_RELEASE_VERSION bash -c ". \"\$1\"; printf \"%s\" \"\$OFFICECHAT_RELEASE_VERSION\"" _ "${bundle_lib_dir}/lib.sh")"
[[ "$bundled_version" == "9.8.7-bundle-test" ]] || {
  echo "Release helpers did not use the bundled VERSION file" >&2
  exit 1
}

production_current='0.1.0-rc13-backup-jobs'
production_target='0.1.0-rc13.1-backup-jobs-executor-fix'
actual_lower='0.1.0-rc12-backup-jobs'
comparison_signature() {
  local locale_name="$1"
  local locale_variable="$2"
  (
    local signature=""
    local pair left right
    unset LC_ALL LC_COLLATE LANG
    export "${locale_variable}=${locale_name}"
    # shellcheck source=lib.sh
    . "${SCRIPT_DIR}/lib.sh"
    for pair in \
      "$production_target|$production_current" \
      "$production_target|$production_target" \
      "$actual_lower|$production_current"; do
      left="${pair%%|*}"
      right="${pair#*|}"
      if version_precedes "$left" "$right"; then
        signature="${signature}1"
      else
        signature="${signature}0"
      fi
    done
    printf '%s' "$signature"
  )
}

mapfile -t tested_locales < <(
  locale -a | awk '
    $0 == "C" ||
    tolower($0) == "c.utf8" ||
    tolower($0) == "c.utf-8" ||
    tolower($0) == "ru_ru.utf8" ||
    tolower($0) == "ru_ru.utf-8"
  '
)
for locale_name in "${tested_locales[@]}"; do
  for locale_variable in LC_ALL LC_COLLATE LANG; do
    signature="$(comparison_signature "$locale_name" "$locale_variable")"
    [[ "$signature" == "001" ]] || {
      echo "Version ordering changed under ${locale_variable}=${locale_name}: ${signature}" >&2
      exit 1
    }
  done
  printf 'version ordering locale passed: %s\n' "$locale_name"
done

if bash "${SCRIPT_DIR}/install-linux.sh" --bad-argument >/dev/null 2>&1; then
  echo "install-linux.sh accepted an invalid argument" >&2
  exit 1
fi

bash "${SCRIPT_DIR}/install-linux.sh" --dry-run >/dev/null
[[ ! -d "$DATA_DIR" ]] || { echo "install dry-run created data dir" >&2; exit 1; }
grep -q 'preserve-this-secret' "$ENV_FILE" || { echo "install dry-run did not preserve existing env" >&2; exit 1; }

bash "${SCRIPT_DIR}/install-linux.sh" --dry-run --hostname officechat.example.local >/dev/null
bash "${SCRIPT_DIR}/install-linux.sh" --dry-run --enable-backup-timer >/dev/null
if bash "${SCRIPT_DIR}/install-linux.sh" --dry-run --hostname 'https://invalid.example.local' >/dev/null 2>&1; then
  echo "install-linux.sh accepted an invalid hostname" >&2
  exit 1
fi

before_version="$(cat "$VERSION_FILE")"
bash "${SCRIPT_DIR}/rollback-linux.sh" --dry-run 0.1.0-rc1 >/dev/null
after_version="$(cat "$VERSION_FILE")"
[[ "$before_version" == "$after_version" ]] || { echo "rollback dry-run changed VERSION" >&2; exit 1; }

touch "${TMP_DIR}/keep-data"
bash "${SCRIPT_DIR}/uninstall-linux.sh" --dry-run >/dev/null
[[ -f "${TMP_DIR}/keep-data" ]] || { echo "uninstall dry-run removed data" >&2; exit 1; }

env_before="$(sha256sum "$ENV_FILE")"
https_before="$(sha256sum "$HTTPS_OVERRIDE_FILE")"
update_output="$(bash "${SCRIPT_DIR}/update-linux.sh" --dry-run 0.1.0-rc3)"
grep -q 'preserve-this-secret' "$ENV_FILE" || { echo "update dry-run did not preserve existing env" >&2; exit 1; }
[[ "$env_before" == "$(sha256sum "$ENV_FILE")" ]] || { echo "update dry-run changed .env" >&2; exit 1; }
[[ "$https_before" == "$(sha256sum "$HTTPS_OVERRIDE_FILE")" ]] || { echo "update changed legacy HTTPS override" >&2; exit 1; }
[[ ! -e "$VERSION_OVERRIDE_FILE" ]] || { echo "update dry-run wrote version override" >&2; exit 1; }
[[ "$update_output" == *"Planned revision: 3333333333333333333333333333333333333333"* ]] || {
  echo "update dry-run omitted planned revision" >&2
  exit 1
}
[[ "$update_output" == *"docker-compose.release.yml"* && "$update_output" == *"${HTTPS_OVERRIDE_FILE}"* && "$update_output" == *"generated final override"* ]] || {
  echo "update dry-run omitted layered Compose files" >&2
  exit 1
}
[[ "$update_output" == *"install the release Caddy template"* ]] || {
  echo "Update dry-run omitted the Caddy security template lifecycle" >&2
  exit 1
}
[[ "$update_output" != *"preserve-this-secret"* ]] || { echo "update dry-run leaked an env secret" >&2; exit 1; }

original_version="$(cat "$VERSION_FILE")"
original_metadata="$(cat "$RELEASE_METADATA_FILE")"
write_test_release_metadata() {
  local version="$1"
  cat >"$RELEASE_METADATA_FILE" <<EOF_RELEASE_VERSION
{
  "version": "${version}",
  "revision": "3333333333333333333333333333333333333333",
  "build_date": "2026-08-04T18:00:00Z",
  "backend_image": "ghcr.io/fedorovdo/officechat-backend:${version}",
  "frontend_image": "ghcr.io/fedorovdo/officechat-frontend:${version}"
}
EOF_RELEASE_VERSION
}

printf '%s\n' "$production_current" >"$VERSION_FILE"
write_test_release_metadata "$production_target"
for locale_name in "${tested_locales[@]}"; do
  LC_ALL="$locale_name" LANG="$locale_name" \
    bash "${SCRIPT_DIR}/update-linux.sh" --dry-run "$production_target" >/dev/null
done

write_test_release_metadata "$production_current"
bash "${SCRIPT_DIR}/update-linux.sh" --dry-run "$production_current" >/dev/null

write_test_release_metadata "$actual_lower"
if bash "${SCRIPT_DIR}/update-linux.sh" --dry-run "$actual_lower" >/dev/null 2>&1; then
  echo "Updater accepted an actual downgrade without --allow-downgrade" >&2
  exit 1
fi
bash "${SCRIPT_DIR}/update-linux.sh" --dry-run --allow-downgrade "$actual_lower" >/dev/null

printf '%s\n' "$original_version" >"$VERSION_FILE"
printf '%s\n' "$original_metadata" >"$RELEASE_METADATA_FILE"

bad_metadata="${TMP_DIR}/bad-release.json"
sed 's/3333333333333333333333333333333333333333/not-a-sha/' "$RELEASE_METADATA_FILE" >"$bad_metadata"
if OFFICECHAT_RELEASE_METADATA_FILE="$bad_metadata" bash "${SCRIPT_DIR}/update-linux.sh" --dry-run 0.1.0-rc3 >/dev/null 2>&1; then
  echo "update accepted malformed release SHA" >&2
  exit 1
fi
sed 's/2026-08-04T18:00:00Z/not-a-date/' "$RELEASE_METADATA_FILE" >"$bad_metadata"
if OFFICECHAT_RELEASE_METADATA_FILE="$bad_metadata" bash "${SCRIPT_DIR}/update-linux.sh" --dry-run 0.1.0-rc3 >/dev/null 2>&1; then
  echo "update accepted malformed release build date" >&2
  exit 1
fi

rollback_root="${TMP_DIR}/rollback-test"
rollback_install="${rollback_root}/install"
rollback_etc="${rollback_root}/etc"
rollback_env="${rollback_install}/.env"
rollback_compose="${rollback_install}/docker-compose.yml"
rollback_https="${rollback_install}/docker-compose.https-override.yml"
rollback_override="${rollback_install}/docker-compose.version-override.yml"
rollback_agent_config="${rollback_etc}/backup-agent.conf"
rollback_agent_unit="${rollback_etc}/officechat-backup-agent.service"
rollback_job_unit="${rollback_etc}/officechat-backup-job.service"
rollback_verify_unit="${rollback_etc}/officechat-backup-verify@.service"
rollback_caddy_file="${rollback_install}/caddy/Caddyfile.example"
rollback_caddy_compose="${rollback_install}/caddy/docker-compose.caddy.yml"
mkdir -p "${rollback_install}/backup" "${rollback_install}/caddy" "$rollback_etc"
cp "$COMPOSE_FILE" "$rollback_compose"
cp "$HTTPS_OVERRIDE_FILE" "$rollback_https"
printf 'services:\n  backend:\n    image: ghcr.io/fedorovdo/officechat-backend:0.1.0-rc2\n  calendar-worker:\n    image: ghcr.io/fedorovdo/officechat-backend:0.1.0-rc2\n  frontend:\n    image: ghcr.io/fedorovdo/officechat-frontend:0.1.0-rc2\n' >"$rollback_override"
printf 'OFFICECHAT_VERSION=0.1.0-rc2\nOFFICECHAT_BUILD_SHA=old-sha\nOFFICECHAT_BUILD_DATE=old-date\nAPP_SECRET_KEY=rollback-secret\n' >"$rollback_env"
printf '0.1.0-rc2\n' >"${rollback_install}/VERSION"
printf 'old-agent\n' >"${rollback_install}/backup-agent.py"
printf '{"old":true}\n' >"${rollback_install}/RELEASE.json"
printf 'old-agent-config\n' >"$rollback_agent_config"
printf 'old-agent-unit\n' >"$rollback_agent_unit"
printf 'old-job-unit\n' >"$rollback_job_unit"
printf 'old-verify-unit\n' >"$rollback_verify_unit"
printf 'old-backup-script\n' >"${rollback_install}/backup-production.sh"
printf 'old-verify-script\n' >"${rollback_install}/verify-backup.sh"
printf 'old-restore-script\n' >"${rollback_install}/restore-production.sh"
printf 'old-backup-lib\n' >"${rollback_install}/backup/lib.sh"
printf 'old-caddy-config\n' >"$rollback_caddy_file"
printf 'services:\n  caddy: {}\n' >"$rollback_caddy_compose"

declare -A rollback_hashes=()
for rollback_file in "$rollback_compose" "$rollback_https" "$rollback_override" "$rollback_env" \
  "$rollback_agent_config" "$rollback_agent_unit" "${rollback_install}/backup-agent.py" \
  "$rollback_job_unit" "$rollback_verify_unit" "${rollback_install}/backup-production.sh" \
  "${rollback_install}/verify-backup.sh" \
  "${rollback_install}/restore-production.sh" "${rollback_install}/backup/lib.sh" \
  "${rollback_install}/RELEASE.json" "${rollback_install}/VERSION" \
  "$rollback_caddy_file" "$rollback_caddy_compose"; do
  rollback_hashes["$rollback_file"]="$(sha256sum "$rollback_file")"
done

migrations_before="$(grep -Fc 'alembic upgrade head' "$FAKE_LOG" || true)"
if env \
  OFFICECHAT_FAKE_MIGRATION_FAIL=1 \
  OFFICECHAT_FAKE_CADDY_RUNNING=1 \
  OFFICECHAT_INSTALL_DIR="$rollback_install" \
  OFFICECHAT_DATA_DIR="${rollback_root}/data" \
  OFFICECHAT_BACKUP_DIR="${rollback_root}/backups" \
  OFFICECHAT_ENV_FILE="$rollback_env" \
  OFFICECHAT_COMPOSE_FILE="$rollback_compose" \
  OFFICECHAT_HTTPS_OVERRIDE_FILE="$rollback_https" \
  OFFICECHAT_VERSION_OVERRIDE_FILE="$rollback_override" \
  OFFICECHAT_RELEASE_METADATA_FILE="$RELEASE_METADATA_FILE" \
  OFFICECHAT_LOCK_FILE="${rollback_root}/update.lock" \
  OFFICECHAT_BACKUP_GROUP=root \
  OFFICECHAT_BACKUP_CONFIG_FILE="${rollback_etc}/backup.conf" \
  OFFICECHAT_BACKUP_AGENT_CONFIG_FILE="$rollback_agent_config" \
  OFFICECHAT_BACKUP_AGENT_UNIT_FILE="$rollback_agent_unit" \
  OFFICECHAT_BACKUP_JOB_UNIT_FILE="$rollback_job_unit" \
  OFFICECHAT_BACKUP_VERIFY_UNIT_FILE="$rollback_verify_unit" \
  OFFICECHAT_BACKUP_AGENT_SOCKET_FILE="${rollback_root}/agent.sock" \
  bash "${SCRIPT_DIR}/update-linux.sh" --no-backup 0.1.0-rc3 >/dev/null 2>&1; then
  echo "update unexpectedly succeeded with a simulated migration failure" >&2
  exit 1
fi
migrations_after="$(grep -Fc 'alembic upgrade head' "$FAKE_LOG" || true)"
[[ "$migrations_after" -eq $((migrations_before + 1)) ]] || {
  echo "rollback test did not reach the simulated migration failure" >&2
  exit 1
}

for rollback_file in "${!rollback_hashes[@]}"; do
  [[ "${rollback_hashes[$rollback_file]}" == "$(sha256sum "$rollback_file")" ]] || {
    echo "update rollback did not restore ${rollback_file}" >&2
    exit 1
  }
done
grep -Fq 'systemctl restart officechat-backup-agent.service' "$FAKE_LOG" || {
  echo "update did not restart the previously active backup agent" >&2
  exit 1
}
grep -Fq -- '--force-recreate backend' "$FAKE_LOG" || {
  echo "update rollback did not recreate backend for the current socket inode" >&2
  exit 1
}
[[ "$(grep -Fc 'caddy reload --config /etc/caddy/Caddyfile' "$FAKE_LOG" || true)" -ge 2 ]] || {
  echo "Update did not reload the new and restored Caddy configurations" >&2
  exit 1
}

for enabled_status in 0 1; do
  for active_status in 0 1; do
    lifecycle_log="${TMP_DIR}/agent-state-${enabled_status}-${active_status}.log"
    lifecycle_socket="${rollback_root}/agent-state-${enabled_status}-${active_status}.sock"
    : >"$lifecycle_log"
    if env \
      OFFICECHAT_FAKE_DOCKER_LOG="$lifecycle_log" \
      OFFICECHAT_FAKE_MIGRATION_FAIL=1 \
      OFFICECHAT_FAKE_AGENT_ENABLED_STATUS="$enabled_status" \
      OFFICECHAT_FAKE_AGENT_ACTIVE_STATUS="$active_status" \
      OFFICECHAT_INSTALL_DIR="$rollback_install" \
      OFFICECHAT_DATA_DIR="${rollback_root}/data" \
      OFFICECHAT_BACKUP_DIR="${rollback_root}/backups" \
      OFFICECHAT_ENV_FILE="$rollback_env" \
      OFFICECHAT_COMPOSE_FILE="$rollback_compose" \
      OFFICECHAT_HTTPS_OVERRIDE_FILE="$rollback_https" \
      OFFICECHAT_VERSION_OVERRIDE_FILE="$rollback_override" \
      OFFICECHAT_RELEASE_METADATA_FILE="$RELEASE_METADATA_FILE" \
      OFFICECHAT_LOCK_FILE="${rollback_root}/agent-state-${enabled_status}-${active_status}.lock" \
      OFFICECHAT_BACKUP_GROUP=root \
      OFFICECHAT_BACKUP_CONFIG_FILE="${rollback_etc}/backup.conf" \
      OFFICECHAT_BACKUP_AGENT_CONFIG_FILE="$rollback_agent_config" \
      OFFICECHAT_BACKUP_AGENT_UNIT_FILE="$rollback_agent_unit" \
      OFFICECHAT_BACKUP_JOB_UNIT_FILE="$rollback_job_unit" \
      OFFICECHAT_BACKUP_VERIFY_UNIT_FILE="$rollback_verify_unit" \
      OFFICECHAT_BACKUP_AGENT_SOCKET_FILE="$lifecycle_socket" \
      bash "${SCRIPT_DIR}/update-linux.sh" --no-backup 0.1.0-rc3 >/dev/null 2>&1; then
      echo "agent lifecycle test unexpectedly succeeded past simulated migration failure" >&2
      exit 1
    fi
    expected_enabled_action="disable"
    unexpected_enabled_action="enable"
    if [[ "$enabled_status" == "0" ]]; then
      expected_enabled_action="enable"
      unexpected_enabled_action="disable"
    fi
    expected_active_action="stop"
    unexpected_active_action="restart"
    if [[ "$active_status" == "0" ]]; then
      expected_active_action="restart"
      unexpected_active_action="stop"
    fi
    grep -Fq "systemctl ${expected_enabled_action} officechat-backup-agent.service" "$lifecycle_log" || {
      echo "updater did not preserve backup agent enabled state" >&2
      exit 1
    }
    if grep -Fq "systemctl ${unexpected_enabled_action} officechat-backup-agent.service" "$lifecycle_log"; then
      echo "updater changed backup agent enabled state" >&2
      exit 1
    fi
    grep -Fq "systemctl ${expected_active_action} officechat-backup-agent.service" "$lifecycle_log" || {
      echo "updater did not preserve backup agent active state" >&2
      exit 1
    }
    if grep -Fq "systemctl ${unexpected_active_action} officechat-backup-agent.service" "$lifecycle_log"; then
      echo "updater changed backup agent active state" >&2
      exit 1
    fi
    if grep -Fq 'officechat-backup.timer' "$lifecycle_log"; then
      echo "updater changed backup timer state" >&2
      exit 1
    fi
  done
done

verify_output="$(bash "${SCRIPT_DIR}/verify-install.sh" --dry-run 2>&1)"
[[ "$verify_output" == *"Uploads writable mutation probe skipped"* ]] || {
  echo "verify dry-run did not skip writable mutation probe" >&2
  exit 1
}

if grep -Eq ' pull| up | down| run | stop | rm ' "$FAKE_LOG"; then
  echo "Fake docker log contains intended compose commands; dry-run printed but did not execute real Docker."
fi

echo "release script smoke tests passed"
