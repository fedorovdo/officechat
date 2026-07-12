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

mkdir -p "$FAKE_BIN" "$INSTALL_DIR"
printf '0.1.0-rc2\n' >"$VERSION_FILE"
printf 'OFFICECHAT_VERSION=0.1.0-rc2\nAPP_SECRET_KEY=preserve-this-secret\n' >"$ENV_FILE"

cat >"${FAKE_BIN}/docker" <<'EOF_DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"${OFFICECHAT_FAKE_DOCKER_LOG}"
if [[ "${1:-}" == "compose" && "${2:-}" == "version" ]]; then
  echo "Docker Compose version v2.test"
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

export PATH="${FAKE_BIN}:${PATH}"
export OFFICECHAT_FAKE_DOCKER_LOG="$FAKE_LOG"
export OFFICECHAT_INSTALL_DIR="$INSTALL_DIR"
export OFFICECHAT_DATA_DIR="$DATA_DIR"
export OFFICECHAT_BACKUP_DIR="$BACKUP_DIR"
export OFFICECHAT_ENV_FILE="$ENV_FILE"
export OFFICECHAT_COMPOSE_FILE="$COMPOSE_FILE"
export OFFICECHAT_LOCK_FILE="$LOCK_DIR"

bash -n "${SCRIPT_DIR}"/*.sh
bash -n "${SCRIPT_DIR}/officechatctl"

bash "${SCRIPT_DIR}/install-linux.sh" --help >/dev/null
bash "${SCRIPT_DIR}/update-linux.sh" --help >/dev/null
bash "${SCRIPT_DIR}/rollback-linux.sh" --help >/dev/null
bash "${SCRIPT_DIR}/uninstall-linux.sh" --help >/dev/null
bash "${SCRIPT_DIR}/verify-install.sh" --help >/dev/null
bash "${SCRIPT_DIR}/officechatctl" --help >/dev/null
bash "${SCRIPT_DIR}/create-release-bundle.sh" --dry-run >/dev/null

if bash "${SCRIPT_DIR}/install-linux.sh" --bad-argument >/dev/null 2>&1; then
  echo "install-linux.sh accepted an invalid argument" >&2
  exit 1
fi

bash "${SCRIPT_DIR}/install-linux.sh" --dry-run >/dev/null
[[ ! -d "$DATA_DIR" ]] || { echo "install dry-run created data dir" >&2; exit 1; }
grep -q 'preserve-this-secret' "$ENV_FILE" || { echo "install dry-run did not preserve existing env" >&2; exit 1; }

before_version="$(cat "$VERSION_FILE")"
bash "${SCRIPT_DIR}/rollback-linux.sh" --dry-run 0.1.0-rc1 >/dev/null
after_version="$(cat "$VERSION_FILE")"
[[ "$before_version" == "$after_version" ]] || { echo "rollback dry-run changed VERSION" >&2; exit 1; }

touch "${TMP_DIR}/keep-data"
bash "${SCRIPT_DIR}/uninstall-linux.sh" --dry-run >/dev/null
[[ -f "${TMP_DIR}/keep-data" ]] || { echo "uninstall dry-run removed data" >&2; exit 1; }

bash "${SCRIPT_DIR}/update-linux.sh" --dry-run 0.1.0-rc3 >/dev/null
grep -q 'preserve-this-secret' "$ENV_FILE" || { echo "update dry-run did not preserve existing env" >&2; exit 1; }

verify_output="$(bash "${SCRIPT_DIR}/verify-install.sh" --dry-run 2>&1)"
[[ "$verify_output" == *"Uploads writable mutation probe skipped"* ]] || {
  echo "verify dry-run did not skip writable mutation probe" >&2
  exit 1
}

if grep -Eq ' pull| up | down| run | stop | rm ' "$FAKE_LOG"; then
  echo "Fake docker log contains intended compose commands; dry-run printed but did not execute real Docker."
fi

echo "release script smoke tests passed"
