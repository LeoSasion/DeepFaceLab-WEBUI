[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RarExe,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath,

    [Parameter(Mandatory = $true)]
    [string]$PortableNodeModulesPath
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$RepositoryParent = Split-Path -Parent $RepositoryRoot
$PackageRootName = Split-Path -Leaf $RepositoryRoot
$ResolvedRarExe = (Resolve-Path -LiteralPath $RarExe).Path
$ResolvedPortableNodeModules = (Resolve-Path -LiteralPath $PortableNodeModulesPath).Path
$PortableNodeModulesParent = Split-Path -Parent $ResolvedPortableNodeModules
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$OutputDirectory = Split-Path -Parent $OutputPath
$ReleaseGitRoot = $null
$ReleaseGitClone = $null

if (-not $OutputPath.EndsWith(".rar", [StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputPath must use the .rar extension."
}
if (-not (Test-Path -LiteralPath $OutputDirectory -PathType Container)) {
    throw "Output directory does not exist: $OutputDirectory"
}
if (Test-Path -LiteralPath $OutputPath) {
    throw "Refusing to overwrite an existing archive: $OutputPath"
}
if ($OutputPath.StartsWith($RepositoryRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "The release archive must be written outside the source directory."
}
if ((Split-Path -Leaf $ResolvedPortableNodeModules) -ne "node_modules") {
    throw "PortableNodeModulesPath must point to a node_modules directory."
}

function Find-ReleaseGit {
    $candidates = @(
        (Join-Path $RepositoryRoot "_internal\git\cmd\git.exe")
    )
    $fromPath = Get-Command git.exe -ErrorAction SilentlyContinue
    if ($null -ne $fromPath) {
        $candidates += $fromPath.Source
    }
    foreach ($candidate in $candidates) {
        if (-not [string]::IsNullOrWhiteSpace($candidate) -and
            (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return [IO.Path]::GetFullPath($candidate)
        }
    }
    throw "A verified Git executable is required to create clean release metadata."
}

function Invoke-ReleaseGit {
    param([Parameter(Mandatory = $true)][string[]]$GitArguments)

    $output = @(& $ReleaseGitExe @GitArguments 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "Git command failed: git $($GitArguments -join ' ')`n$($output -join [Environment]::NewLine)"
    }
    return $output
}

function Remove-ReleaseGitStaging {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Container)) {
        return
    }
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if (-not [String]::Equals((Split-Path -Parent $full), $temp, [StringComparison]::OrdinalIgnoreCase) -or
        -not (Split-Path -Leaf $full).StartsWith("dflsn-release-git-", [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove an unexpected release staging directory: $full"
    }
    $item = Get-Item -LiteralPath $full -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Refusing to remove a reparse-point release staging directory: $full"
    }
    Remove-Item -LiteralPath $full -Recurse -Force
}

$ReleaseGitExe = Find-ReleaseGit
$sourceStatus = @(Invoke-ReleaseGit -GitArguments @(
    "-C", $RepositoryRoot, "status", "--porcelain=v1", "--untracked-files=all"))
if ($sourceStatus.Count -ne 0) {
    throw "Release packaging requires a clean Git worktree. Commit or remove local changes first.`n$($sourceStatus -join [Environment]::NewLine)"
}
$sourceBranch = @(Invoke-ReleaseGit -GitArguments @("-C", $RepositoryRoot, "branch", "--show-current"))
if ($sourceBranch.Count -ne 1 -or $sourceBranch[0].Trim() -ne "main") {
    throw "Release packaging requires the main branch."
}
$sourceOrigin = @(Invoke-ReleaseGit -GitArguments @("-C", $RepositoryRoot, "remote", "get-url", "origin"))
if ($sourceOrigin.Count -ne 1 -or
    -not [String]::Equals(
        $sourceOrigin[0].Trim().TrimEnd('/'),
        "https://github.com/LeoSasion/DeepFaceLab-WEBUI.git",
        [StringComparison]::OrdinalIgnoreCase)) {
    throw "Release packaging requires the fixed public GitHub origin."
}

$requiredFiles = @(
    "启动 WebUI.bat",
    "传统命令菜单.bat",
    "webui\scripts\install-node.ps1",
    "webui\scripts\local-manager.mjs",
    "webui\dist\client\index.html",
    "webui\node_modules\vite\bin\vite.js",
    "webui\node_modules\node-pty\package.json",
    "_internal\node\bin\node.exe",
    "_internal\python_common\python.exe",
    "_internal\ffmpeg\ffmpeg.exe",
    "_internal\DeepFaceLab\main.py"
)
foreach ($relativePath in $requiredFiles) {
    $requiredPath = Join-Path $RepositoryRoot $relativePath
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required release file is missing: $relativePath"
    }
}

$nodeExe = Join-Path $RepositoryRoot "_internal\node\bin\node.exe"
$nodeVersion = (& $nodeExe -p "process.versions.node" | Select-Object -First 1)
if ($nodeVersion -ne "24.19.0") {
    throw "Portable Node.js 24.19.0 is required, found: $nodeVersion"
}

$portableRequiredFiles = @(
    "picomatch\package.json",
    "vite\package.json",
    "node-pty\package.json",
    "react\package.json",
    "ws\package.json"
)
foreach ($relativePath in $portableRequiredFiles) {
    $requiredPath = Join-Path $ResolvedPortableNodeModules $relativePath
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Portable node_modules file is missing: $relativePath"
    }
}
$portableLinks = @(Get-ChildItem -LiteralPath $ResolvedPortableNodeModules -Recurse -Force -Attributes ReparsePoint)
if ($portableLinks.Count -ne 0) {
    throw "Portable node_modules must not contain reparse points; found $($portableLinks.Count)."
}
Push-Location $PortableNodeModulesParent
try {
    & $nodeExe -e "Promise.all([import('vite'),import('node-pty')]).catch(error=>{console.error(error);process.exit(1)})"
    if ($LASTEXITCODE -ne 0) {
        throw "Portable node_modules runtime import check failed."
    }
} finally {
    Pop-Location
}

$verifyRelease = Join-Path $PSScriptRoot "verify-release.ps1"
Write-Host "[release] Running mandatory tests, build, signature policy, freshness, and smoke gates."
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $verifyRelease
if ($LASTEXITCODE -ne 0) {
    throw "Mandatory release verification failed with exit code $LASTEXITCODE."
}

# These masks intentionally keep the directory entries for workspace,
# workspaces, _internal/_e, and webui/.runtime while excluding their contents.
# Developer .git metadata is excluded here; a clean, path-scrubbed clone is
# added below so the installed package remains recognizable and updateable.
# RAR dereferences pnpm links by default because -ol is deliberately omitted.
$excludeMasks = @(
    "$PackageRootName\.git",
    "$PackageRootName\.git\*",
    "$PackageRootName\.validation",
    "$PackageRootName\.validation\*",
    "$PackageRootName\.release-webui-hoisted",
    "$PackageRootName\.release-webui-hoisted\*",
    "$PackageRootName\.impeccable\*",
    "$PackageRootName\workspace\*",
    "$PackageRootName\workspaces\*",
    "$PackageRootName\_internal\_e\*",
    "$PackageRootName\_internal\installers\*.zip",
    "$PackageRootName\webui\.runtime\*",
    "$PackageRootName\webui\design\*",
    "$PackageRootName\webui\design-qa.md",
    "$PackageRootName\webui\node_modules",
    "$PackageRootName\webui\node_modules\*",
    "$PackageRootName\legacy-cli\0-*.bat",
    "$PackageRootName\design-qa.md",
    "$PackageRootName\docs\images\qa-*.png",
    "*\__pycache__\*",
    "*.pyc",
    "*.pyo",
    "desktop.ini",
    "Thumbs.db",
    ".DS_Store"
)

$arguments = @(
    "a",
    "-cfg-",
    "-ma5",
    "-m3",
    "-md128m",
    "-s",
    "-qo+",
    "-htb",
    "-r",
    "-y",
    "-idn"
)
$arguments += $excludeMasks | ForEach-Object { "-x$_" }
$arguments += @($OutputPath, $PackageRootName)

Write-Host "[release] Source:  $RepositoryRoot"
Write-Host "[release] Output:  $OutputPath"
Write-Host "[release] Modules: $ResolvedPortableNodeModules"
Write-Host "[release] Private workspace data and local runtime state are excluded."

try {
    $ReleaseGitRoot = Join-Path ([IO.Path]::GetTempPath()) ("dflsn-release-git-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $ReleaseGitRoot | Out-Null
    $ReleaseGitRoot = (Resolve-Path -LiteralPath $ReleaseGitRoot).Path
    $ReleaseGitClone = Join-Path $ReleaseGitRoot $PackageRootName
    [void](Invoke-ReleaseGit -GitArguments @(
        "-c", "core.logAllRefUpdates=false", "clone", "--no-local", "--no-tags",
        "--single-branch", "--branch", "main", "--", $RepositoryRoot, $ReleaseGitClone))
    [void](Invoke-ReleaseGit -GitArguments @(
        "-C", $ReleaseGitClone, "remote", "set-url", "origin",
        "https://github.com/LeoSasion/DeepFaceLab-WEBUI.git"))
    [void](Invoke-ReleaseGit -GitArguments @(
        "-C", $ReleaseGitClone, "config", "core.logAllRefUpdates", "false"))
    $releaseGitLogs = Join-Path $ReleaseGitClone ".git\logs"
    if (Test-Path -LiteralPath $releaseGitLogs -PathType Container) {
        $logsFull = [IO.Path]::GetFullPath($releaseGitLogs)
        $clonePrefix = [IO.Path]::GetFullPath($ReleaseGitClone).TrimEnd('\') + '\'
        if (-not $logsFull.StartsWith($clonePrefix, [StringComparison]::OrdinalIgnoreCase) -or
            ((Get-Item -LiteralPath $logsFull -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Unsafe Git log staging path: $logsFull"
        }
        Remove-Item -LiteralPath $logsFull -Recurse -Force
    }

    Push-Location $RepositoryParent
    try {
        & $ResolvedRarExe @arguments
        if ($LASTEXITCODE -ne 0) {
            throw "RAR creation failed with exit code $LASTEXITCODE."
        }
    } finally {
        Pop-Location
    }

    $gitMetadataArguments = @(
        "a", "-cfg-", "-ma5", "-m3", "-md128m", "-s", "-qo+", "-htb",
        "-r", "-y", "-idn", "-ap$PackageRootName", $OutputPath, ".git"
    )
    Push-Location $ReleaseGitClone
    try {
        & $ResolvedRarExe @gitMetadataArguments
        if ($LASTEXITCODE -ne 0) {
            throw "Clean Git metadata archive step failed with exit code $LASTEXITCODE."
        }
    } finally {
        Pop-Location
    }
} finally {
    Remove-ReleaseGitStaging -Path $ReleaseGitRoot
}

$moduleArguments = @(
    "a",
    "-cfg-",
    "-ma5",
    "-m3",
    "-md128m",
    "-s",
    "-qo+",
    "-htb",
    "-r",
    "-y",
    "-idn",
    "-ap$PackageRootName\webui",
    "-xnode_modules\.modules.yaml",
    "-xnode_modules\.pnpm-workspace-state-v1.json",
    "-xnode_modules\.package-map.json",
    "-xnode_modules\.vite-temp\*",
    $OutputPath,
    "node_modules"
)
Push-Location $PortableNodeModulesParent
try {
    & $ResolvedRarExe @moduleArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Portable node_modules archive step failed with exit code $LASTEXITCODE."
    }
} finally {
    Pop-Location
}

& $ResolvedRarExe rr1p -cfg- -y -idq $OutputPath
if ($LASTEXITCODE -ne 0) {
    throw "Recovery record creation failed with exit code $LASTEXITCODE."
}

$archive = Get-Item -LiteralPath $OutputPath
Write-Host ("[release] Created: {0:N2} GiB" -f ($archive.Length / 1GB))
