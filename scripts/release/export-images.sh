#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -lt 1 || -z "$1" ]]; then
  echo "Usage: export-images.sh VERSION [OUTPUT]" >&2
  exit 2
fi

VERSION="$1"
OUTPUT="${2:-officechat-images-${VERSION}.tar}"
docker pull "ghcr.io/fedorovdo/officechat-backend:${VERSION}"
docker pull "ghcr.io/fedorovdo/officechat-frontend:${VERSION}"
docker save -o "$OUTPUT" \
  "ghcr.io/fedorovdo/officechat-backend:${VERSION}" \
  "ghcr.io/fedorovdo/officechat-frontend:${VERSION}" \
  postgres:16-alpine \
  valkey/valkey:8-alpine
sha256sum "$OUTPUT" >"${OUTPUT}.sha256"
