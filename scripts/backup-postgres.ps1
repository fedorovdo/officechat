param(
    [string]$Destination = "backups",
    [int]$RetentionDays = 0,
    [string]$ComposeFile = "docker-compose.yml"
)

$ErrorActionPreference = "Stop"
$timestamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
$backupDir = Join-Path $Destination "officechat_$timestamp"
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

$dbDump = Join-Path $backupDir "officechat_$timestamp.dump"
$uploadsArchive = Join-Path $backupDir "officechat_uploads_$timestamp.tar.gz"
$metadataFile = Join-Path $backupDir "metadata.json"
$postgresUser = if ($env:POSTGRES_USER) { $env:POSTGRES_USER } else { "officechat" }
$postgresDb = if ($env:POSTGRES_DB) { $env:POSTGRES_DB } else { "officechat" }

Write-Host "Creating PostgreSQL backup: $dbDump"
docker compose -f $ComposeFile exec -T postgres pg_dump -U $postgresUser -d $postgresDb -Fc -f /tmp/officechat.dump
docker compose -f $ComposeFile cp postgres:/tmp/officechat.dump $dbDump
docker compose -f $ComposeFile exec -T postgres rm -f /tmp/officechat.dump

if ((Get-Item $dbDump).Length -le 0) {
    throw "Database dump is empty"
}

Write-Host "Creating uploads archive: $uploadsArchive"
docker compose -f $ComposeFile exec -T backend tar -czf /tmp/officechat_uploads.tar.gz -C /data uploads
docker compose -f $ComposeFile cp backend:/tmp/officechat_uploads.tar.gz $uploadsArchive
docker compose -f $ComposeFile exec -T backend rm -f /tmp/officechat_uploads.tar.gz

$revision = docker compose -f $ComposeFile exec -T backend alembic current
$metadata = [ordered]@{
    created_at = (Get-Date).ToUniversalTime().ToString("o")
    database_dump = (Split-Path $dbDump -Leaf)
    uploads_archive = (Split-Path $uploadsArchive -Leaf)
    alembic_revision = ($revision -join "`n").Trim()
}
$metadata | ConvertTo-Json | Set-Content -Encoding UTF8 -Path $metadataFile

if ($RetentionDays -gt 0) {
    Get-ChildItem -Path $Destination -Directory -Filter "officechat_*" |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$RetentionDays) } |
        Remove-Item -Recurse -Force
}

Write-Host "Backup completed: $backupDir"
