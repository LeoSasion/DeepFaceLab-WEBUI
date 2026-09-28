$ErrorActionPreference = "Stop"
$bootstrapArchiveScript = Join-Path $PSScriptRoot "..\bootstrap.ps1"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function New-ArchiveInstallFixture {
    param(
        [string]$Project,
        [hashtable]$Entries,
        [string]$ArchiveRoot = "node-v24.19.0-win-x64",
        [string]$Layout = "bin",
        [object]$ValidationCommand = $null
    )

    foreach ($directory in @("webui", "_internal\installers", "_internal\node")) {
        New-Item -ItemType Directory -Path (Join-Path $Project $directory) -Force | Out-Null
    }
    [IO.File]::WriteAllText((Join-Path $Project "_internal\node\sentinel.txt"), "previous runtime")
    $archive = Join-Path $Project "_internal\installers\node.zip"
    $zip = [IO.Compression.ZipFile]::Open($archive, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($name in $Entries.Keys) {
            $entry = $zip.CreateEntry($name)
            $writer = New-Object IO.StreamWriter($entry.Open())
            try { $writer.Write([string]$Entries[$name]) } finally { $writer.Dispose() }
        }
    } finally { $zip.Dispose() }

    $validationPath = if ($Layout -eq "bin") { "bin/node.exe" } else { "node.exe" }
    $validation = @{ files = @(@{ path = $validationPath; minBytes = 1 }) }
    if ($null -ne $ValidationCommand) { $validation.command = $ValidationCommand }
    $manifest = @{
        schemaVersion = 2
        manifestVersion = "fixture"
        components = @(@{
            id = "node"; displayName = "Portable Node.js"; required = $true; available = $true; version = "fixture"
            archive = @{
                name = "node.zip"; format = "zip"
                sha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
                urls = @{ official = @("https://example.invalid/node.zip"); china = @() }
            }
            install = @{ relativePath = "_internal/node"; archiveRoot = $ArchiveRoot; layout = $Layout; requiredFreeBytes = 1048576 }
            validation = $validation
        })
    }
    $manifestPath = Join-Path $Project "manifest.json"
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding($false)))
    return $manifestPath
}

function Invoke-ArchiveInstallFixture {
    param([string]$Project, [string]$Manifest)
    $output = @(& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $bootstrapArchiveScript `
        -ProjectRoot $Project -ManifestPath $Manifest -Mirror official -NoNetwork 2>&1)
    $exitCode = $LASTEXITCODE
    $events = @($output | ForEach-Object { [string]$_ | ConvertFrom-Json })
    return [pscustomobject]@{ ExitCode = $exitCode; Events = $events; Raw = $output }
}

function Assert-ArchiveInstallPreserved {
    param([string]$Project)
    [IO.File]::ReadAllText((Join-Path $Project "_internal\node\sentinel.txt")) | Should Be "previous runtime"
    @(Get-ChildItem -LiteralPath (Join-Path $Project "_internal") -Filter "node.installing-*" -Force).Count | Should Be 0
    @(Get-ChildItem -LiteralPath (Join-Path $Project "_internal") -Filter "node.backup-*" -Force).Count | Should Be 0
}

Describe "single-archive runtime installation" {
    It "installs npm files beyond MAX_PATH in the initial-install staging tree" {
        $project = Join-Path $TestDrive (("Install location " + ("n" * 35)) + "\DFL-WEBUI\.launcher-install\runtime")
        $npmFile = "node_modules/npm/node_modules/@sigstore/protobuf-specs/dist/__generated__/google/api/field_behavior.js"
        $entries = @{
            "node-v24.19.0-win-x64/" = ""
            "node-v24.19.0-win-x64/node.exe" = "fixture node"
            "outside-root.txt" = "must not be installed"
        }
        $entries["node-v24.19.0-win-x64/" + $npmFile] = "fixture npm dependency"
        $manifest = New-ArchiveInstallFixture -Project $project -Entries $entries
        $installedFile = Join-Path $project ("_internal\node\bin\" + $npmFile.Replace('/', '\'))
        $installedFile.Length | Should BeGreaterThan 260

        $result = Invoke-ArchiveInstallFixture -Project $project -Manifest $manifest
        $result.ExitCode | Should Be 0
        [IO.File]::ReadAllText(('\\?\' + $installedFile)) | Should Be "fixture npm dependency"
        (Join-Path $project "_internal\node\bin\node-v24.19.0-win-x64") | Should Not Exist
        (Join-Path $project "_internal\node\bin\outside-root.txt") | Should Not Exist
        (Join-Path $project "_internal\node\sentinel.txt") | Should Not Exist
        @(Get-ChildItem -LiteralPath (Join-Path $project "_internal") -Filter "node.installing-*" -Force).Count | Should Be 0
        @(Get-ChildItem -LiteralPath (Join-Path $project "_internal\.launcher\work") -Force).Count | Should Be 0
    }

    It "still installs archives with a direct layout and no outer folder" {
        $project = Join-Path $TestDrive "direct"
        $manifest = New-ArchiveInstallFixture -Project $project -ArchiveRoot "." -Layout "direct" -Entries @{ "node.exe" = "direct fixture" }
        $result = Invoke-ArchiveInstallFixture -Project $project -Manifest $manifest
        $result.ExitCode | Should Be 0
        [IO.File]::ReadAllText((Join-Path $project "_internal\node\node.exe")) | Should Be "direct fixture"
    }

    It "preserves the old runtime when the expected archive root is absent" {
        $project = Join-Path $TestDrive "missing-root"
        $manifest = New-ArchiveInstallFixture -Project $project -Entries @{ "wrong-root/node.exe" = "fixture" }
        $result = Invoke-ArchiveInstallFixture -Project $project -Manifest $manifest
        $result.ExitCode | Should Be 1
        ($result.Raw -join "`n") | Should Match "expected root"
        Assert-ArchiveInstallPreserved -Project $project
    }

    It "preserves the old runtime when staging validation fails" {
        $project = Join-Path $TestDrive "missing-file"
        $manifest = New-ArchiveInstallFixture -Project $project -Entries @{ "node-v24.19.0-win-x64/LICENSE" = "fixture" }
        $result = Invoke-ArchiveInstallFixture -Project $project -Manifest $manifest
        $result.ExitCode | Should Be 1
        ($result.Raw -join "`n") | Should Match "Staged runtime validation failed"
        Assert-ArchiveInstallPreserved -Project $project
    }

    It "rejects traversal even outside the selected archive root" {
        $project = Join-Path $TestDrive "traversal"
        $manifest = New-ArchiveInstallFixture -Project $project -Entries @{
            "node-v24.19.0-win-x64/node.exe" = "fixture"
            "unselected/../escaped.txt" = "unsafe"
        }
        $result = Invoke-ArchiveInstallFixture -Project $project -Manifest $manifest
        $result.ExitCode | Should Be 1
        ($result.Raw -join "`n") | Should Match "Unsafe ZIP path segment"
        Assert-ArchiveInstallPreserved -Project $project
    }

    It "rolls back the old runtime when final validation fails" {
        $project = Join-Path $TestDrive "rollback-archive"
        $checker = "@echo off`r`necho %~dp0| findstr /i .installing- >nul`r`nif errorlevel 1 (echo invalid) else (echo ok)`r`n"
        $manifest = New-ArchiveInstallFixture -Project $project -Entries @{
            "node-v24.19.0-win-x64/node.exe" = "fixture"
            "node-v24.19.0-win-x64/check.cmd" = $checker
        } -ValidationCommand @{ path = "bin/check.cmd"; arguments = @(); outputRegex = "^ok$" }
        $result = Invoke-ArchiveInstallFixture -Project $project -Manifest $manifest
        $result.ExitCode | Should Be 1
        @($result.Events | Where-Object { $_.id -eq "node" -and $_.status -eq "rolled-back" }).Count | Should Be 1
        Assert-ArchiveInstallPreserved -Project $project
    }
}
