#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CADDY_IMAGE="${CADDY_TEST_IMAGE:-caddy:2.10-alpine}"
CONTAINER_NAME="officechat-caddy-log-test-${RANDOM}-$$"
SYNTHETIC_QUERY_SECRET="synthetic-secret-token"
SYNTHETIC_SECOND_QUERY_SECRET="synthetic-second-secret"
SYNTHETIC_PATH_SECRET="synthetic-bot-secret"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker run --rm \
  -e OFFICECHAT_HOSTNAME=localhost \
  -v "${ROOT_DIR}/deploy/caddy/Caddyfile.example:/etc/caddy/Caddyfile:ro" \
  "$CADDY_IMAGE" caddy validate --config /etc/caddy/Caddyfile

docker run -d --name "$CONTAINER_NAME" \
  -e OFFICECHAT_HOSTNAME=localhost \
  -v "${ROOT_DIR}/deploy/caddy/Caddyfile.example:/etc/caddy/Caddyfile:ro" \
  "$CADDY_IMAGE" >/dev/null

for _ in {1..30}; do
  if docker exec "$CONTAINER_NAME" caddy version >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

docker exec "$CONTAINER_NAME" wget -q --no-check-certificate -O /dev/null \
  "https://localhost/api/ws/me?token=${SYNTHETIC_QUERY_SECRET}&access_token=${SYNTHETIC_SECOND_QUERY_SECRET}&view=all" || true
docker exec "$CONTAINER_NAME" wget -q --no-check-certificate -O /dev/null \
  "https://localhost/api/bots/incoming/${SYNTHETIC_PATH_SECRET}" || true
sleep 1

logs="$(docker logs "$CONTAINER_NAME" 2>&1)"
[[ "$logs" != *"$SYNTHETIC_QUERY_SECRET"* ]] || {
  echo "Caddy logs exposed the synthetic WebSocket token" >&2
  exit 1
}
[[ "$logs" != *"$SYNTHETIC_SECOND_QUERY_SECRET"* ]] || {
  echo "Caddy logs exposed a secondary synthetic query credential" >&2
  exit 1
}
[[ "$logs" == *"token=REDACTED"* ]] || {
  echo "Caddy logs did not retain the redacted token marker" >&2
  exit 1
}
[[ "$logs" != *"$SYNTHETIC_PATH_SECRET"* ]] || {
  echo "Caddy logs exposed the synthetic bot webhook path token" >&2
  exit 1
}
[[ "$logs" == *"/api/bots/incoming/REDACTED"* ]] || {
  echo "Caddy runtime log did not redact the bot webhook path token" >&2
  exit 1
}

echo "Caddy access/runtime log secret redaction passed"
