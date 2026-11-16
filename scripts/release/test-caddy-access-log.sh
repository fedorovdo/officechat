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

# The isolated proxy has no backend/frontend, so HTTP 502 is expected here.
# A version command can succeed before the HTTPS listener and CA are ready.
# Require an actual HTTP response, including for the credential probes below.
caddy_https_responds() {
  local response
  response="$(docker exec "$CONTAINER_NAME" wget -S -T 10 \
    --no-check-certificate -O /dev/null "$1" 2>&1)" || true
  [[ "$response" =~ HTTP/[0-9.]+[[:space:]]+[1-5][0-9]{2} ]]
}

https_ready=0
for _ in {1..30}; do
  if caddy_https_responds "https://localhost/"; then
    https_ready=1
    break
  fi
  sleep 1
done
[[ "$https_ready" == "1" ]] || {
  echo "Caddy HTTPS listener did not become ready" >&2
  exit 1
}

caddy_https_responds \
  "https://localhost/api/ws/me?token=${SYNTHETIC_QUERY_SECRET}&access_token=${SYNTHETIC_SECOND_QUERY_SECRET}&view=all" || {
  echo "Caddy did not return an HTTP response to the query redaction probe" >&2
  exit 1
}
caddy_https_responds "https://localhost/api/bots/incoming/${SYNTHETIC_PATH_SECRET}" || {
  echo "Caddy did not return an HTTP response to the path redaction probe" >&2
  exit 1
}

for _ in {1..30}; do
  logs="$(docker logs "$CONTAINER_NAME" 2>&1)"
  if [[ "$logs" == *"token=REDACTED"* &&
        "$logs" == *"/api/bots/incoming/REDACTED"* ]]; then
    break
  fi
  sleep 1
done
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
