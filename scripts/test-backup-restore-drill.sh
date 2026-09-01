#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=backup/lib.sh
. "${SCRIPT_DIR}/backup/lib.sh"

for command_name in docker bash python3 tar sha256sum flock realpath; do
  require_command "$command_name"
done

suffix="$(date -u +%Y%m%d%H%M%S)-$$-${RANDOM}"
source_container="officechat-backup-source-${suffix}"
tmp_dir="$(mktemp -d)"
before_resources="${tmp_dir}/resources.before"
after_resources="${tmp_dir}/resources.after"

snapshot_drill_resources() {
  {
    docker ps -aq --filter label=com.officechat.restore-drill=true |
      sed 's/^/container:/'
    docker network ls -q --filter label=com.officechat.restore-drill=true |
      sed 's/^/network:/'
    docker volume ls -q --filter label=com.officechat.restore-drill=true |
      sed 's/^/volume:/'
  } | sort
}

owned_source_container() {
  [[ "$(docker container inspect -f '{{ index .Config.Labels "com.officechat.backup-test" }}' \
    "$source_container" 2>/dev/null || true)" == "true" ]]
}

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  if owned_source_container; then
    docker rm -f "$source_container" >/dev/null 2>&1 || true
  fi
  rm -rf --one-file-system "$tmp_dir"
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

snapshot_drill_resources >"$before_resources"

postgres_password="$(python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(32))
PY
)"
docker run -d --name "$source_container" \
  --label com.officechat.backup-test=true \
  --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_PASSWORD="$postgres_password" \
  -e POSTGRES_USER=officechat \
  -e POSTGRES_DB=officechat \
  postgres:16-alpine >/dev/null
for _ in {1..60}; do
  if docker exec "$source_container" pg_isready -q -h 127.0.0.1 -U officechat -d officechat; then
    break
  fi
  sleep 1
done
docker exec "$source_container" pg_isready -q -h 127.0.0.1 -U officechat -d officechat ||
  fail "Isolated source PostgreSQL did not become ready"
docker exec "$source_container" psql -v ON_ERROR_STOP=1 -U officechat -d officechat \
  -c "create table alembic_version (version_num varchar(64) primary key);" \
  -c "insert into alembic_version values ('drill_revision_0001');" \
  -c "create table future_application_table (id bigint primary key, value text not null);" \
  -c "insert into future_application_table values (1, 'restore-drill');" >/dev/null

backup_path="${tmp_dir}/officechat-backup-20260101-000000Z"
mkdir -p "$backup_path"/{database,uploads,metadata}
chmod 700 "$backup_path"
docker exec "$source_container" pg_dump -U officechat -d officechat -Fc \
  >"$backup_path/database/officechat.dump"
docker exec -i "$source_container" pg_restore --list \
  <"$backup_path/database/officechat.dump" >/dev/null

mkdir -p "${tmp_dir}/data/uploads"
printf 'restore drill attachment\n' >"${tmp_dir}/data/uploads/sample.txt"
tar -C "${tmp_dir}/data" -czf "$backup_path/uploads/uploads.tar.gz" uploads

postgres_version="$(docker exec "$source_container" postgres --version | tr -d '\r')"
python3 - "$backup_path/metadata/manifest.json" "$postgres_version" <<'PY'
import json
import sys
from datetime import datetime, timezone

path, postgres_version = sys.argv[1:]
with open(path, "w", encoding="utf-8") as stream:
    json.dump(
        {
            "backup_format_version": 1,
            "backup_scripts_version": "integration-test",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "officechat_version": "0.1.0-rc2",
            "build_sha": "restore-drill",
            "alembic_revision": "drill_revision_0001",
            "compose_project_name": "officechat-drill",
            "postgresql_version": postgres_version,
            "detected_components": ["database", "uploads"],
            "required_components": ["database", "uploads"],
            "optional_components": [],
            "skipped_components": [],
            "warnings": [],
            "verification_status": "pending",
        },
        stream,
        ensure_ascii=True,
        indent=2,
        sort_keys=True,
    )
    stream.write("\n")
PY
generate_checksums "$backup_path"
touch "$backup_path/SUCCESS"

install_dir="${tmp_dir}/officechat"
data_dir="${tmp_dir}/production-data"
backup_root="${tmp_dir}/backups"
mkdir -p "$install_dir" "$data_dir/uploads" "$backup_root"
printf 'services: {}\n' >"${install_dir}/docker-compose.yml"
printf 'POSTGRES_PASSWORD=integration-test-only\n' >"${install_dir}/.env"
chmod 600 "${install_dir}/.env"
config_file="${tmp_dir}/backup.conf"
cat >"$config_file" <<EOF
BACKUP_FORMAT_VERSION=1
OFFICECHAT_DIR=${install_dir}
OFFICECHAT_DATA_DIR=${data_dir}
BACKUP_ROOT=${backup_root}
OFFSITE_ROOT=
REQUIRE_OFFSITE=no
COMPOSE_ENV_FILE=${install_dir}/.env
COMPOSE_FILES=${install_dir}/docker-compose.yml
COMPOSE_PROJECT_NAME=officechat-drill
POSTGRES_SERVICE=postgres
BACKEND_SERVICE=backend
FRONTEND_SERVICE=frontend
WORKER_SERVICES=calendar-worker
VALKEY_SERVICE=valkey
VALKEY_DATA_PATH=/data/dump.rdb
UPLOADS_DIR=${data_dir}/uploads
BACKUP_EXTRA_PATHS=
PUBLIC_CONFIG_PATHS=docker-compose.yml
BACKUP_VALKEY=no
BACKUP_CADDY_CA=no
BACKUP_DEPLOYMENT_CONFIG=no
VERIFY_AFTER_BACKUP=yes
KEEP_DAILY=1
KEEP_WEEKLY=1
KEEP_MONTHLY=1
POSTGRES_VERIFY_IMAGE=postgres:16-alpine
IMAGE_SERVICES=frontend:backend
LOCK_FILE=${tmp_dir}/backup.lock
STATUS_FILE=${tmp_dir}/status/latest.json
EOF
chmod 600 "$config_file"

for _ in 1 2; do
  "${SCRIPT_DIR}/restore-production.sh" \
    --config "$config_file" \
    --verify-only \
    "$backup_path"
done

snapshot_drill_resources >"$after_resources"
cmp "$before_resources" "$after_resources" ||
  fail "Restore drill leaked or removed resources outside its ownership boundary"
log "Docker restore drill passed twice without production mounts or leaked resources"
