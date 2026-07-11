param(
    [Parameter(Mandatory = $true)][string]$BackupDir,
    [string]$ComposeFile = "docker-compose.yml"
)

$ErrorActionPreference = "Stop"
$metadataPath = Join-Path $BackupDir "metadata.json"
if (!(Test-Path $metadataPath)) {
    throw "metadata.json not found in $BackupDir"
}

$metadata = Get-Content -Raw $metadataPath | ConvertFrom-Json
$dbDump = Join-Path $BackupDir $metadata.database_dump
$uploadsArchive = Join-Path $BackupDir $metadata.uploads_archive
$postgresUser = if ($env:POSTGRES_USER) { $env:POSTGRES_USER } else { "officechat" }
$postgresDb = if ($env:POSTGRES_DB) { $env:POSTGRES_DB } else { "officechat" }

Write-Host "Restore target database: $postgresDb"
Write-Host "Backup directory: $BackupDir"
Write-Host "Backend should be stopped before restore."
$confirmation = Read-Host "Type RESTORE OFFICECHAT to continue"
if ($confirmation -ne "RESTORE OFFICECHAT") {
    throw "Restore cancelled"
}

docker compose -f $ComposeFile stop backend
docker compose -f $ComposeFile cp $dbDump postgres:/tmp/officechat_restore.dump
docker compose -f $ComposeFile exec -T postgres dropdb -U $postgresUser --if-exists $postgresDb
docker compose -f $ComposeFile exec -T postgres createdb -U $postgresUser $postgresDb
docker compose -f $ComposeFile exec -T postgres pg_restore -U $postgresUser -d $postgresDb --clean --if-exists /tmp/officechat_restore.dump
docker compose -f $ComposeFile exec -T postgres rm -f /tmp/officechat_restore.dump

if (Test-Path $uploadsArchive) {
    $resolvedBackupDir = (Resolve-Path $BackupDir).Path
    docker compose -f $ComposeFile run --rm --no-deps -v "${resolvedBackupDir}:/restore:ro" backend sh -c "rm -rf /data/uploads && mkdir -p /data && tar -xzf /restore/$($metadata.uploads_archive) -C /data"
}

docker compose -f $ComposeFile run --rm backend alembic current
docker compose -f $ComposeFile up -d backend
Write-Host "Restore completed. Verify readiness with: curl http://localhost:8100/ready"
