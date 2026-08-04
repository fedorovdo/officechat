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
export OFFICECHAT_LOCK_FILE="$LOCK_DIR"

bash -n "${SCRIPT_DIR}"/*.sh
bash -n "${SCRIPT_DIR}/officechatctl"

[[ -f "$CADDY_FILE" ]] || { echo "Caddy template is missing" >&2; exit 1; }
grep -Fq '@frontend_health path /api/health /api/health/*' "$CADDY_FILE" || {
  echo "Caddy template does not route frontend health explicitly" >&2
  exit 1
}
grep -Fq '@backend path /api /api/*' "$CADDY_FILE" || {
  echo "Caddy template does not contain the general backend API route" >&2
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
for backup_asset in \
  scripts/backup-production.sh \
  scripts/verify-backup.sh \
  scripts/restore-production.sh \
  scripts/backup_agent.py \
  deploy/backup/officechat-backup.conf.example \
  deploy/backup/officechat-backup-agent.conf.example \
  deploy/systemd/officechat-backup.service \
  deploy/systemd/officechat-backup.timer \
  deploy/systemd/officechat-backup-agent.service; do
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
grep -Fq 'BACKUP_CENTER_RU.md' "${SCRIPT_DIR}/update-linux.sh" || {
  echo "Updater does not install Backup Center documentation" >&2
  exit 1
}
grep -Fq 'rm -f /etc/systemd/system/officechat-backup-agent.service' "${SCRIPT_DIR}/uninstall-linux.sh" || {
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

bash "${SCRIPT_DIR}/install-linux.sh" --help >/dev/null
bash "${SCRIPT_DIR}/update-linux.sh" --help >/dev/null
bash "${SCRIPT_DIR}/rollback-linux.sh" --help >/dev/null
bash "${SCRIPT_DIR}/uninstall-linux.sh" --help >/dev/null
bash "${SCRIPT_DIR}/verify-install.sh" --help >/dev/null
bash "${SCRIPT_DIR}/officechatctl" --help >/dev/null
OFFICECHAT_RELEASE_REVISION=2222222222222222222222222222222222222222 \
  OFFICECHAT_RELEASE_BUILD_DATE=2026-08-04T17:00:00Z \
  bash "${SCRIPT_DIR}/create-release-bundle.sh" --dry-run >/dev/null

bundle_lib_dir="${TMP_DIR}/bundle-lib"
mkdir -p "$bundle_lib_dir"
cp "${SCRIPT_DIR}/lib.sh" "${bundle_lib_dir}/lib.sh"
printf '9.8.7-bundle-test\n' >"${bundle_lib_dir}/VERSION"
bundled_version="$(env -u OFFICECHAT_RELEASE_VERSION bash -c ". \"\$1\"; printf \"%s\" \"\$OFFICECHAT_RELEASE_VERSION\"" _ "${bundle_lib_dir}/lib.sh")"
[[ "$bundled_version" == "9.8.7-bundle-test" ]] || {
  echo "Release helpers did not use the bundled VERSION file" >&2
  exit 1
}

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
[[ "$update_output" != *"preserve-this-secret"* ]] || { echo "update dry-run leaked an env secret" >&2; exit 1; }

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
mkdir -p "$rollback_install" "$rollback_etc"
cp "$COMPOSE_FILE" "$rollback_compose"
cp "$HTTPS_OVERRIDE_FILE" "$rollback_https"
printf 'services:\n  backend:\n    image: ghcr.io/fedorovdo/officechat-backend:0.1.0-rc2\n  calendar-worker:\n    image: ghcr.io/fedorovdo/officechat-backend:0.1.0-rc2\n  frontend:\n    image: ghcr.io/fedorovdo/officechat-frontend:0.1.0-rc2\n' >"$rollback_override"
printf 'OFFICECHAT_VERSION=0.1.0-rc2\nOFFICECHAT_BUILD_SHA=old-sha\nOFFICECHAT_BUILD_DATE=old-date\nAPP_SECRET_KEY=rollback-secret\n' >"$rollback_env"
printf '0.1.0-rc2\n' >"${rollback_install}/VERSION"
printf 'old-agent\n' >"${rollback_install}/backup-agent.py"
printf '{"old":true}\n' >"${rollback_install}/RELEASE.json"
printf 'old-agent-config\n' >"$rollback_agent_config"
printf 'old-agent-unit\n' >"$rollback_agent_unit"

declare -A rollback_hashes=()
for rollback_file in "$rollback_compose" "$rollback_https" "$rollback_override" "$rollback_env" \
  "$rollback_agent_config" "$rollback_agent_unit" "${rollback_install}/backup-agent.py" \
  "${rollback_install}/RELEASE.json" "${rollback_install}/VERSION"; do
  rollback_hashes["$rollback_file"]="$(sha256sum "$rollback_file")"
done

migrations_before="$(grep -Fc 'alembic upgrade head' "$FAKE_LOG" || true)"
if env \
  OFFICECHAT_FAKE_MIGRATION_FAIL=1 \
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

verify_output="$(bash "${SCRIPT_DIR}/verify-install.sh" --dry-run 2>&1)"
[[ "$verify_output" == *"Uploads writable mutation probe skipped"* ]] || {
  echo "verify dry-run did not skip writable mutation probe" >&2
  exit 1
}

if grep -Eq ' pull| up | down| run | stop | rm ' "$FAKE_LOG"; then
  echo "Fake docker log contains intended compose commands; dry-run printed but did not execute real Docker."
fi

echo "release script smoke tests passed"
