#!/usr/bin/env bash
set -Eeuo pipefail

ARCHIVE="${1:-}"
[[ -n "$ARCHIVE" && -f "$ARCHIVE" ]] || { echo "Usage: import-images.sh officechat-images-VERSION.tar" >&2; exit 2; }
docker load -i "$ARCHIVE"
