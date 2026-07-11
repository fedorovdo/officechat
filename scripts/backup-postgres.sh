#!/usr/bin/env sh
set -eu

DESTINATION="${DESTINATION:-backups}"
RETENTION_DAYS="${RETENTION_DAYS:-0}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
POSTGRES_USER="${POSTGRES_USER:-officechat}"
POSTGRES_DB="${POSTGRES_DB:-officechat}"
TIMESTAMP="$(date -u +%Y-%m-%d_%H%M%S)"
BACKUP_DIR="$DESTINATION/officechat_$TIMESTAMP"
DB_DUMP="$BACKUP_DIR/officechat_$TIMESTAMP.dump"
UPLOADS_ARCHIVE="$BACKUP_DIR/officechat_uploads_$TIMESTAMP.tar.gz"
METADATA_FILE="$BACKUP_DIR/metadata.json"

mkdir -p "$BACKUP_DIR"

echo "Creating PostgreSQL backup: $DB_DUMP"
docker compose -f "$COMPOSE_FILE" exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f /tmp/officechat.dump
docker compose -f "$COMPOSE_FILE" cp postgres:/tmp/officechat.dump "$DB_DUMP"
docker compose -f "$COMPOSE_FILE" exec -T postgres rm -f /tmp/officechat.dump
test -s "$DB_DUMP"

echo "Creating uploads archive: $UPLOADS_ARCHIVE"
docker compose -f "$COMPOSE_FILE" exec -T backend tar -czf /tmp/officechat_uploads.tar.gz -C /data uploads
docker compose -f "$COMPOSE_FILE" cp backend:/tmp/officechat_uploads.tar.gz "$UPLOADS_ARCHIVE"
docker compose -f "$COMPOSE_FILE" exec -T backend rm -f /tmp/officechat_uploads.tar.gz

REVISION="$(docker compose -f "$COMPOSE_FILE" exec -T backend alembic current | tr -d '\r')"
cat > "$METADATA_FILE" <<EOF
{
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "database_dump": "$(basename "$DB_DUMP")",
  "uploads_archive": "$(basename "$UPLOADS_ARCHIVE")",
  "alembic_revision": "$REVISION"
}
EOF

if [ "$RETENTION_DAYS" -gt 0 ]; then
  find "$DESTINATION" -maxdepth 1 -type d -name "officechat_*" -mtime +"$RETENTION_DAYS" -exec rm -rf {} +
fi

echo "Backup completed: $BACKUP_DIR"
