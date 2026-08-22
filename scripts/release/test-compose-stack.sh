#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# shellcheck source=lib.sh
. "${SCRIPT_DIR}/lib.sh"

require_docker_compose
tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "$tmp_dir"' EXIT
env_file="${tmp_dir}/officechat.env"
version_override="${tmp_dir}/docker-compose.version-override.yml"
legacy_override="${tmp_dir}/docker-compose.https-override.yml"
version="0.1.0-rc12.1-backup-center-deployfix"
revision="1212121212121212121212121212121212121212"
build_date="2026-08-04T19:00:00Z"

cp "${ROOT_DIR}/.env.production.example" "$env_file"
chmod 0600 "$env_file"

missing_version_env="${tmp_dir}/missing-version.env"
cp "${ROOT_DIR}/.env.production.example" "$missing_version_env"
if env -u OFFICECHAT_VERSION docker compose --env-file "$missing_version_env" \
  -f "${ROOT_DIR}/deploy/docker-compose.release.yml" config --quiet >/dev/null 2>&1; then
  fail "Release Compose accepted a missing OFFICECHAT_VERSION"
fi

write_env_metadata "$env_file" "${tmp_dir}/updated.env" "$version" "$revision" "$build_date"
mv "${tmp_dir}/updated.env" "$env_file"
write_version_override "$version_override" "$version" "$revision" "$build_date"
cat >"$legacy_override" <<'EOF_HTTPS'
services:
  backend:
    image: ghcr.io/fedorovdo/officechat-backend:0.1.0-rc9
  calendar-worker:
    image: ghcr.io/fedorovdo/officechat-backend:0.1.0-rc9
  frontend:
    image: ghcr.io/fedorovdo/officechat-frontend:0.1.0-rc11
    environment:
      NEXT_PUBLIC_OFFICECHAT_VERSION: 0.1.0-rc11
      NEXT_PUBLIC_OFFICECHAT_BUILD_SHA: old-revision
EOF_HTTPS
legacy_before="$(sha256sum "$legacy_override")"

compose_with_stack "$env_file" "${ROOT_DIR}/deploy/docker-compose.release.yml" \
  "$legacy_override" "$version_override" config --quiet
validate_resolved_stack "$env_file" "${ROOT_DIR}/deploy/docker-compose.release.yml" \
  "$legacy_override" "$version_override" "$version"
[[ "$legacy_before" == "$(sha256sum "$legacy_override")" ]] || fail "Legacy HTTPS override was modified"

compose_with_stack "$env_file" "${ROOT_DIR}/deploy/docker-compose.release.yml" \
  "${tmp_dir}/missing-https.yml" "$version_override" config --quiet
validate_resolved_stack "$env_file" "${ROOT_DIR}/deploy/docker-compose.release.yml" \
  "${tmp_dir}/missing-https.yml" "$version_override" "$version"

pass "Layered Compose fixtures passed with and without the legacy HTTPS override"
