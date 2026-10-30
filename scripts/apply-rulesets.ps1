[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Position = 0)][string] $Repo,
    [switch] $Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Show-Usage { Write-Host 'usage: apply-rulesets.ps1 -Repo <owner/repo> [-Apply]' }

if ($Repo -in @('help', '-h', '--help')) {
    Show-Usage
    exit 0
}
if ([string]::IsNullOrWhiteSpace($Repo)) {
    Show-Usage
    exit 2
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$rulesetDir = Join-Path $repoRoot 'rulesets'

$visibility = (& gh api "repos/$Repo" --jq .visibility)
if ($LASTEXITCODE -ne 0) { throw "Could not read $Repo. Check gh authentication." }

if ($visibility -ne 'public') {
    Write-Host "$Repo is $visibility. Rulesets stay unenforced until the repository is public."
    Get-ChildItem -LiteralPath $rulesetDir -Filter '*.json' | Sort-Object Name | ForEach-Object {
        Write-Host "  would apply $($_.Name)"
    }
    return
}

# Resolve only a selectable access level. Legacy and unknown values must be
# migrated explicitly; never upgrade them to full during application.
$short = $Repo.Split('/')[-1]
$level = (& node (Join-Path $repoRoot 'scripts/agent-access.mjs') $short 2>$null)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($level)) { throw "Could not resolve a selectable access level for $Repo" }
$level = $level.Trim()

$existing = @()
foreach ($line in (& gh api "repos/$Repo/rulesets" --jq '.[] | [.id, .name] | @tsv')) {
    if (-not $line) { continue }
    $parts = $line -split "`t"
    $existing += [pscustomobject]@{ Id = $parts[0]; Name = $parts[1] }
}

foreach ($file in Get-ChildItem -LiteralPath $rulesetDir -Filter '*.json' | Sort-Object Name) {
    $payloadArgs = @($file.FullName, '--level', $level, '--repo', $Repo)
    $payloadFile = [System.IO.Path]::GetTempFileName()
    & node (Join-Path $repoRoot 'scripts/ruleset-payload.mjs') @payloadArgs | Set-Content -LiteralPath $payloadFile
    if ($LASTEXITCODE -ne 0) { throw "Failed to build the payload for $($file.Name)" }

    $data = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
    $matches = @($existing | Where-Object { $_.Name -eq $data.name })
    if ($matches.Count -gt 1) {
        Remove-Item -LiteralPath $payloadFile -Force
        throw "Multiple $($data.name) rulesets found"
    }
    $match = $matches | Select-Object -First 1
    if (-not $Apply) {
        if ($match) { Write-Host "would update $($data.name)" } else { Write-Host "would create $($data.name)" }
        Remove-Item -LiteralPath $payloadFile -Force
        continue
    }
    if ($match) {
        & gh api -X PUT "repos/$Repo/rulesets/$($match.Id)" --input $payloadFile | Out-Null
    } else {
        & gh api -X POST "repos/$Repo/rulesets" --input $payloadFile | Out-Null
    }
    $applyExitCode = $LASTEXITCODE
    Remove-Item -LiteralPath $payloadFile -Force
    if ($applyExitCode -ne 0) { throw "Failed to apply $($file.Name)" }
    if ($match) { Write-Host "updated $($data.name)" } else { Write-Host "created $($data.name)" }
}
