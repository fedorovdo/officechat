#!/usr/bin/env bash
set -Eeuo pipefail

VERSION="${1:-0.1.0-rc2}"
OUTPUT="${2:-officechat-images-${VERSION}.tar}"
docker pull "ghcr.io/fedorovdo/officechat-backend:${VERSION}"
docker pull "ghcr.io/fedorovdo/officechat-frontend:${VERSION}"
docker save -o "$OUTPUT" \
  "ghcr.io/fedorovdo/officechat-backend:${VERSION}" \
  "ghcr.io/fedorovdo/officechat-frontend:${VERSION}" \
  postgres:16-alpine \
  valkey/valkey:8-alpine
sha256sum "$OUTPUT" >"${OUTPUT}.sha256"
