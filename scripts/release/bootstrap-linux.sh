#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

VERSION=""
HOSTNAME_VALUE=""
INSTALL_DOCKER=1
START_CADDY="auto"
CREATE_ADMIN=1
ADMIN_USERNAME="admin"
ADMIN_DISPLAY_NAME="OfficeChat Admin"
ENABLE_BACKUP_TIMER=0
DRY_RUN=0
RELEASE_BASE_URL="${OFFICECHAT_RELEASE_BASE_URL:-https://github.com/fedorovdo/officechat/releases/download}"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '%s\n' "$*"
}

usage() {
  cat <<'EOF_HELP'
Usage:
  officechat-install.sh --version VERSION [options]

Options:
  --version VERSION       Exact OfficeChat release version.
  --hostname HOSTNAME     Public HTTPS hostname.
  --install-docker        Install Docker automatically when missing (default).
  --no-install-docker     Require an existing Docker Engine and Compose v2.
  --start-caddy           Start bundled internal HTTPS; requires --hostname.
  --no-start-caddy        Do not start Caddy.
  --create-admin          Create the initial superadmin (default).
  --no-create-admin       Skip initial administrator creation.
  --admin-username NAME   Initial administrator username (default: admin).
  --admin-display-name N  Initial administrator display name.
  --enable-backup-timer   Enable the scheduled backup timer.
  --dry-run               Show prerequisite actions without applying them. If
                          prerequisites are ready, verify the bundle and run
                          the installer preflight.
  --help                  Show this help.

Supported automatic Docker installation platforms:
  Rocky Linux 10, RED OS 8, Debian 12, and Debian 13; linux/amd64.
EOF_HELP
}

require_command() {
  command -v "$1" >/dev/null 2>&1 ||
    fail "Required command not found: $1"
}

bootstrap_download_prerequisites_ready() {
  local ca_bundle
  local -a ca_bundles=(
    /etc/ssl/certs/ca-certificates.crt
    /etc/pki/tls/certs/ca-bundle.crt
  )

  if ! command -v curl >/dev/null 2>&1 ||
    ! curl --version >/dev/null 2>&1; then
    return 1
  fi

  if [[ -n "${SSL_CERT_FILE:-}" ]]; then
    ca_bundles=("$SSL_CERT_FILE")
  fi

  for ca_bundle in "${ca_bundles[@]}"; do
    [[ -s "$ca_bundle" ]] && return 0
  done

  return 1
}

read_bootstrap_os_release() {
  local key os_release_file value
  os_release_file="${OFFICECHAT_OS_RELEASE_FILE:-/etc/os-release}"
  [[ -f "$os_release_file" ]] ||
    fail "Operating system metadata is missing: ${os_release_file}"

  BOOTSTRAP_OS_ID=""
  BOOTSTRAP_OS_VERSION_ID=""

  while IFS='=' read -r key value; do
    value="${value%$'\r'}"
    case "$value" in
      \"*\")
        value="${value#\"}"
        value="${value%\"}"
        ;;
      \'*\')
        value="${value#\'}"
        value="${value%\'}"
        ;;
    esac

    case "$key" in
      ID)
        BOOTSTRAP_OS_ID="$value"
        ;;
      VERSION_ID)
        BOOTSTRAP_OS_VERSION_ID="$value"
        ;;
    esac
  done <"$os_release_file"

  [[ -n "$BOOTSTRAP_OS_ID" && -n "$BOOTSTRAP_OS_VERSION_ID" ]] ||
    fail "Operating system ID or version is missing from ${os_release_file}"
}

detect_bootstrap_docker_platform() {
  read_bootstrap_os_release

  case "${BOOTSTRAP_OS_ID}:${BOOTSTRAP_OS_VERSION_ID}" in
    rocky:10|rocky:10.*)
      BOOTSTRAP_DOCKER_PLATFORM="rocky"
      ;;
    redos:8|redos:8.*)
      BOOTSTRAP_DOCKER_PLATFORM="redos"
      ;;
    debian:12|debian:12.*|debian:13|debian:13.*)
      BOOTSTRAP_DOCKER_PLATFORM="debian"
      ;;
    *)
      fail "Automatic Docker installation supports only Rocky Linux 10, RED OS 8, Debian 12, and Debian 13; detected ${BOOTSTRAP_OS_ID} ${BOOTSTRAP_OS_VERSION_ID}"
      ;;
  esac
}

require_bootstrap_root_or_sudo() {
  if [[ "$(id -u)" -ne 0 ]] && ! command -v sudo >/dev/null 2>&1; then
    fail "Installing download prerequisites requires root or sudo."
  fi
}

bootstrap_as_root() {
  local -a command=("$@")

  if [[ "$(id -u)" -ne 0 ]]; then
    command=(sudo "${command[@]}")
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    printf 'DRY-RUN:'
    printf ' %q' "${command[@]}"
    printf '\n'
  else
    "${command[@]}"
  fi
}

ensure_bootstrap_download_prerequisites() {
  local architecture

  BOOTSTRAP_PREREQUISITES_PLANNED=0
  bootstrap_download_prerequisites_ready && return 0

  if [[ "$INSTALL_DOCKER" != "1" ]]; then
    fail "curl and trusted CA certificates are required to download OfficeChat. Install them manually, or rerun with --install-docker on a supported platform."
  fi

  detect_bootstrap_docker_platform
  architecture="$(uname -m)"
  case "$architecture" in
    x86_64|amd64) ;;
    *) fail "Only linux/amd64 is supported; detected ${architecture}" ;;
  esac
  require_bootstrap_root_or_sudo

  log "Preparing curl and trusted CA certificates on ${BOOTSTRAP_OS_ID} ${BOOTSTRAP_OS_VERSION_ID}."
  case "$BOOTSTRAP_DOCKER_PLATFORM" in
    debian)
      require_command apt-get
      bootstrap_as_root apt-get update
      bootstrap_as_root apt-get install -y ca-certificates curl
      ;;
    rocky|redos)
      require_command dnf
      bootstrap_as_root dnf -y install ca-certificates curl
      ;;
    *)
      fail "Internal error: unsupported bootstrap platform ${BOOTSTRAP_DOCKER_PLATFORM}"
      ;;
  esac

  if [[ "$DRY_RUN" == "1" ]]; then
    BOOTSTRAP_PREREQUISITES_PLANNED=1
    log "DRY-RUN: download prerequisites would be installed before any release download."
    return 0
  fi

  bootstrap_download_prerequisites_ready ||
    fail "curl or trusted CA certificates are still unavailable after prerequisite installation"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      [[ $# -ge 2 ]] || fail "--version requires a value"
      VERSION="$2"
      shift 2
      ;;
    --hostname)
      [[ $# -ge 2 ]] || fail "--hostname requires a value"
      HOSTNAME_VALUE="$2"
      shift 2
      ;;
    --install-docker)
      INSTALL_DOCKER=1
      shift
      ;;
    --no-install-docker)
      INSTALL_DOCKER=0
      shift
      ;;
    --start-caddy)
      START_CADDY=1
      shift
      ;;
    --no-start-caddy)
      START_CADDY=0
      shift
      ;;
    --create-admin)
      CREATE_ADMIN=1
      shift
      ;;
    --no-create-admin)
      CREATE_ADMIN=0
      shift
      ;;
    --admin-username)
      [[ $# -ge 2 ]] || fail "--admin-username requires a value"
      ADMIN_USERNAME="$2"
      shift 2
      ;;
    --admin-display-name)
      [[ $# -ge 2 ]] || fail "--admin-display-name requires a value"
      ADMIN_DISPLAY_NAME="$2"
      shift 2
      ;;
    --enable-backup-timer)
      ENABLE_BACKUP_TIMER=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

[[ -n "$VERSION" ]] || fail "--version is required"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9._-]+)?$ ]] ||
  fail "Invalid OfficeChat version: $VERSION"

if [[ "$CREATE_ADMIN" == "1" ]]; then
  [[ "$ADMIN_USERNAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] ||
    fail "Invalid initial administrator username"
  [[ "$ADMIN_DISPLAY_NAME" =~ [^[:space:]] ]] ||
    fail "Initial administrator display name must not be empty"
  [[ "$ADMIN_DISPLAY_NAME" != *$'\n'* &&
    "$ADMIN_DISPLAY_NAME" != *$'\r'* ]] ||
    fail "Initial administrator display name must be one line"
fi

if [[ -n "$HOSTNAME_VALUE" &&
  ! "$HOSTNAME_VALUE" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
  fail "Invalid OfficeChat hostname"
fi

if [[ "$START_CADDY" == "auto" ]]; then
  if [[ -n "$HOSTNAME_VALUE" ]]; then
    START_CADDY=1
  else
    START_CADDY=0
  fi
fi

if [[ "$START_CADDY" == "1" && -z "$HOSTNAME_VALUE" ]]; then
  fail "--start-caddy requires --hostname"
fi

[[ "$RELEASE_BASE_URL" == https://* ]] ||
  fail "Release base URL must use HTTPS"

ensure_bootstrap_download_prerequisites
if [[ "$BOOTSTRAP_PREREQUISITES_PLANNED" == "1" ]]; then
  log "DRY-RUN: release download and verification would continue after prerequisite installation."
  exit 0
fi

require_command curl
require_command tar
require_command sha256sum
require_command awk
require_command mktemp

tag="v${VERSION}"
bundle_name="officechat-${VERSION}-linux-amd64.tar.gz"
sidecar_name="${bundle_name}.sha256"
asset_base="${RELEASE_BASE_URL%/}/${tag}"

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/officechat-install.XXXXXX")"
cleanup() {
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

bundle_path="${work_dir}/${bundle_name}"
sidecar_path="${work_dir}/${sidecar_name}"
members_path="${work_dir}/archive-members.txt"
verbose_path="${work_dir}/archive-verbose.txt"
extract_dir="${work_dir}/extracted"

download_asset() {
  local asset_name="$1"
  local destination="$2"

  log "Downloading ${asset_name}"
  curl \
    --fail \
    --location \
    --silent \
    --show-error \
    --retry 3 \
    --output "$destination" \
    "${asset_base}/${asset_name}" ||
    fail "Could not download ${asset_name}"
}

download_asset "$bundle_name" "$bundle_path"
download_asset "$sidecar_name" "$sidecar_path"

sidecar_line_count="$(
  awk 'NF {count += 1} END {print count + 0}' "$sidecar_path"
)"
[[ "$sidecar_line_count" == "1" ]] ||
  fail "Bundle checksum sidecar must contain exactly one entry"

checksum_digest=""
checksum_filename=""
if ! IFS=' ' read -r checksum_digest checksum_filename <"$sidecar_path"; then
  fail "Could not read the bundle checksum sidecar"
fi
checksum_filename="${checksum_filename#\*}"

[[ "$checksum_digest" =~ ^[0-9A-Fa-f]{64}$ ]] ||
  fail "Bundle checksum sidecar contains an invalid SHA-256 digest"
[[ "$checksum_filename" == "$bundle_name" ]] ||
  fail "Bundle checksum sidecar references an unexpected file"

actual_digest=""
if ! read -r actual_digest _ < <(sha256sum "$bundle_path"); then
  fail "Could not calculate the bundle SHA-256 digest"
fi

if [[ "${actual_digest,,}" != "${checksum_digest,,}" ]]; then
  fail "Bundle SHA-256 mismatch"
fi
log "PASS: Bundle SHA-256 verified."

tar -tzf "$bundle_path" >"$members_path" ||
  fail "Could not read the release archive"

[[ -s "$members_path" ]] ||
  fail "Release archive is empty"

member_count=0
while IFS= read -r member; do
  [[ -n "$member" ]] || continue
  ((member_count += 1))

  case "$member" in
    /*|*\\*)
      fail "Unsafe archive member path: $member"
      ;;
  esac

  [[ "$member" == "release" ||
    "$member" == "release/" ||
    "$member" == release/* ]] ||
    fail "Archive member is outside the release root: $member"

  normalized_member="/${member}/"
  [[ "$normalized_member" != *"/../"* &&
    "$normalized_member" != *"/./"* ]] ||
    fail "Archive member contains path traversal: $member"
done <"$members_path"

[[ "$member_count" -gt 0 ]] ||
  fail "Release archive has no members"

tar -tvzf "$bundle_path" >"$verbose_path" ||
  fail "Could not inspect archive member types"

while IFS= read -r verbose_entry; do
  [[ -n "$verbose_entry" ]] || continue
  case "${verbose_entry:0:1}" in
    -|d) ;;
    *)
      fail "Release archive contains a link or special file"
      ;;
  esac
done <"$verbose_path"

mkdir -p "$extract_dir"
tar \
  --no-same-owner \
  --no-same-permissions \
  -xzf "$bundle_path" \
  -C "$extract_dir" ||
  fail "Could not extract the release archive"

release_dir="${extract_dir}/release"
[[ -d "$release_dir" && ! -L "$release_dir" ]] ||
  fail "Extracted release directory is missing or unsafe"

for required_file in \
  install-linux.sh \
  VERSION \
  RELEASE.json \
  CHECKSUMS.sha256; do
  [[ -f "${release_dir}/${required_file}" &&
    ! -L "${release_dir}/${required_file}" ]] ||
    fail "Required release file is missing or unsafe: ${required_file}"
done

bundled_version=""
IFS= read -r bundled_version <"${release_dir}/VERSION" ||
  fail "Could not read the bundled VERSION"
bundled_version="${bundled_version%$'\r'}"

[[ "$bundled_version" == "$VERSION" ]] ||
  fail "Downloaded bundle version does not match the requested version"

if ! (
  cd "$release_dir"
  sha256sum --check CHECKSUMS.sha256
); then
  fail "Inner release checksum validation failed"
fi
log "PASS: Inner release checksums verified."

install_args=()

if [[ "$INSTALL_DOCKER" == "1" ]]; then
  install_args+=(--install-docker)
fi
if [[ -n "$HOSTNAME_VALUE" ]]; then
  install_args+=(--hostname "$HOSTNAME_VALUE")
fi
if [[ "$START_CADDY" == "1" ]]; then
  install_args+=(--start-caddy)
fi
if [[ "$CREATE_ADMIN" == "1" ]]; then
  install_args+=(
    --create-admin
    --admin-username "$ADMIN_USERNAME"
    --admin-display-name "$ADMIN_DISPLAY_NAME"
  )
fi
if [[ "$ENABLE_BACKUP_TIMER" == "1" ]]; then
  install_args+=(--enable-backup-timer)
fi
if [[ "$DRY_RUN" == "1" ]]; then
  install_args+=(--dry-run)
fi

log "Starting verified OfficeChat ${VERSION} installer."
bash "${release_dir}/install-linux.sh" "${install_args[@]}"
log "PASS: OfficeChat ${VERSION} bootstrap completed."
