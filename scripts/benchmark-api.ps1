param(
    [string]$BackendUrl = "http://localhost:8100",
    [string]$Username = "admin",
    [string]$Password = "admin12345",
    [int]$Iterations = 5
)

$ErrorActionPreference = "Stop"

$loginBody = @{ username = $Username; password = $Password } | ConvertTo-Json
$login = Invoke-RestMethod -Method Post -Uri "$BackendUrl/api/auth/login" -ContentType "application/json" -Body $loginBody
$headers = @{ Authorization = "Bearer $($login.access_token)" }

$endpoints = @(
    "/api/groups",
    "/api/direct/conversations",
    "/api/unread",
    "/api/announcements",
    "/api/search/messages?q=officechat",
    "/api/auth/me"
)

foreach ($endpoint in $endpoints) {
    $samples = @()
    for ($i = 0; $i -lt $Iterations; $i++) {
        $elapsed = Measure-Command {
            Invoke-RestMethod -Method Get -Uri "$BackendUrl$endpoint" -Headers $headers | Out-Null
        }
        $samples += [math]::Round($elapsed.TotalMilliseconds, 1)
    }
    $average = [math]::Round(($samples | Measure-Object -Average).Average, 1)
    Write-Host "$endpoint average_ms=$average samples=$($samples -join ',')"
}
