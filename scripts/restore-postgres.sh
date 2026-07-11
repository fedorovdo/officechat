#!/usr/bin/env sh
set -eu

BACKUP_DIR="${1:-}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
POSTGRES_USER="${POSTGRES_USER:-officechat}"
POSTGRES_DB="${POSTGRES_DB:-officechat}"

if [ -z "$BACKUP_DIR" ] || [ ! -f "$BACKUP_DIR/metadata.json" ]; then
  echo "Usage: $0 <backup-directory>" >&2
  exit 1
fi

DB_DUMP="$(python -c "import json,sys; print(json.load(open('$BACKUP_DIR/metadata.json'))['database_dump'])")"
UPLOADS_ARCHIVE="$(python -c "import json,sys; print(json.load(open('$BACKUP_DIR/metadata.json'))['uploads_archive'])")"

echo "Restore target database: $POSTGRES_DB"
echo "Backup directory: $BACKUP_DIR"
echo "Backend should be stopped before restore."
printf "Type RESTORE OFFICECHAT to continue: "
read -r CONFIRMATION
if [ "$CONFIRMATION" != "RESTORE OFFICECHAT" ]; then
  echo "Restore cancelled" >&2
  exit 1
fi

docker compose -f "$COMPOSE_FILE" stop backend
docker compose -f "$COMPOSE_FILE" cp "$BACKUP_DIR/$DB_DUMP" postgres:/tmp/officechat_restore.dump
docker compose -f "$COMPOSE_FILE" exec -T postgres dropdb -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB"
docker compose -f "$COMPOSE_FILE" exec -T postgres createdb -U "$POSTGRES_USER" "$POSTGRES_DB"
docker compose -f "$COMPOSE_FILE" exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists /tmp/officechat_restore.dump
docker compose -f "$COMPOSE_FILE" exec -T postgres rm -f /tmp/officechat_restore.dump

if [ -f "$BACKUP_DIR/$UPLOADS_ARCHIVE" ]; then
  ABS_BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"
  docker compose -f "$COMPOSE_FILE" run --rm --no-deps -v "$ABS_BACKUP_DIR:/restore:ro" backend sh -c "rm -rf /data/uploads && mkdir -p /data && tar -xzf /restore/$UPLOADS_ARCHIVE -C /data"
fi

docker compose -f "$COMPOSE_FILE" run --rm backend alembic current
docker compose -f "$COMPOSE_FILE" up -d backend
echo "Restore completed. Verify readiness with: curl http://localhost:8100/ready"
