[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ProjectRoot,

    [ValidateSet("auto", "china", "official")]
    [string]$Mirror = "auto",

    [switch]$Repair,

    [switch]$GitOnly,

    [string]$ManifestPath,

    [switch]$DryRun,

    [switch]$NoNetwork
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$script:LogPath = $null
$script:SafeRoot = $null
$script:ModeRoot = $null
$script:ResolvedMirror = $null
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

[Console]::OutputEncoding = $script:Utf8NoBom
$OutputEncoding = $script:Utf8NoBom

function Get-OptionalProperty {
    param(
        [object]$Object,
        [string]$Name,
        [object]$DefaultValue = $null
    )

    if ($null -eq $Object) {
        return $DefaultValue
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) {
        return $DefaultValue
    }
    return $property.Value
}

function Write-JsonEvent {
    param(
        [Parameter(Mandatory = $true)][string]$Stage,
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][string]$Status,
        [int]$Progress = 0,
        [Int64]$Downloaded = 0,
        [Int64]$Total = 0,
        [Parameter(Mandatory = $true)][string]$Message
    )

    if ($Progress -lt 0) { $Progress = 0 }
    if ($Progress -gt 100) { $Progress = 100 }
    if ($Downloaded -lt 0) { $Downloaded = 0 }
    if ($Total -lt 0) { $Total = 0 }

    $event = [ordered]@{
        stage      = $Stage
        id         = $Id
        status     = $Status
        progress   = [int]$Progress
        downloaded = [Int64]$Downloaded
        total      = [Int64]$Total
        message    = $Message
    }
    $line = ConvertTo-Json -InputObject $event -Compress -Depth 4
    [Console]::Out.WriteLine($line)

    if (-not [string]::IsNullOrWhiteSpace($script:LogPath)) {
        try {
            [IO.File]::AppendAllText($script:LogPath, $line + [Environment]::NewLine, $script:Utf8NoBom)
        } catch {
            # Logging must never hide the original bootstrap result.
        }
    }
}

function Resolve-SafeChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$BasePath,
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [switch]$AllowBase
    )

    if ([string]::IsNullOrWhiteSpace($RelativePath)) {
        throw "A manifest relative path is empty."
    }
    if ([IO.Path]::IsPathRooted($RelativePath) -or $RelativePath.IndexOf(':') -ge 0) {
        throw "Manifest path must be relative: $RelativePath"
    }

    $baseFull = [IO.Path]::GetFullPath($BasePath).TrimEnd('\', '/')
    $candidate = [IO.Path]::GetFullPath((Join-Path $baseFull $RelativePath)).TrimEnd('\', '/')
    $prefix = $baseFull + [IO.Path]::DirectorySeparatorChar
    $isChild = $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
    $isBase = [string]::Equals($candidate, $baseFull, [StringComparison]::OrdinalIgnoreCase)
    if (-not $isChild -and -not ($AllowBase -and $isBase)) {
        throw "Manifest path escapes its allowed directory: $RelativePath"
    }
    return $candidate
}

function Assert-SafeModeRoot {
    param(
        [Parameter(Mandatory = $true)][string]$RequestedPath,
        [switch]$Standalone,
        [switch]$ReadOnly
    )

    $expanded = [Environment]::ExpandEnvironmentVariables($RequestedPath)
    $fullPath = [IO.Path]::GetFullPath($expanded).TrimEnd('\', '/')
    if ([string]::IsNullOrWhiteSpace($fullPath)) {
        throw "ProjectRoot cannot be empty."
    }

    $driveRoot = [IO.Path]::GetPathRoot($fullPath).TrimEnd('\', '/')
    if ([string]::Equals($fullPath, $driveRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "A drive root cannot be used as ProjectRoot."
    }
    if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
        throw "ProjectRoot points to a file, not a directory: $fullPath"
    }

    $protected = @(
        [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows),
        [Environment]::GetFolderPath([Environment+SpecialFolder]::System),
        [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles),
        [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86),
        [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile),
        [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    )
    foreach ($protectedPath in $protected) {
        if (-not [string]::IsNullOrWhiteSpace($protectedPath)) {
            $protectedFull = [IO.Path]::GetFullPath($protectedPath).TrimEnd('\', '/')
            if ([string]::Equals($fullPath, $protectedFull, [StringComparison]::OrdinalIgnoreCase)) {
                throw "A protected broad directory cannot be used as ProjectRoot: $fullPath"
            }
        }
    }

    if ($Standalone) {
        if (-not (Test-Path -LiteralPath $fullPath -PathType Container) -and -not $ReadOnly) {
            New-Item -ItemType Directory -Path $fullPath -Force | Out-Null
        }
        return $fullPath
    }

    if (-not (Test-Path -LiteralPath $fullPath -PathType Container)) {
        throw "The project directory does not exist. Repository cloning is owned by the native host: $fullPath"
    }
    # The single-file launcher can bootstrap older GitHub checkouts that do not
    # yet contain the launcher source directory. Runtime scripts and the manifest
    # are supplied by the EXE payload in that case.
    foreach ($requiredDirectory in @("_internal", "webui")) {
        if (-not (Test-Path -LiteralPath (Join-Path $fullPath $requiredDirectory) -PathType Container)) {
            throw "The selected directory is not a complete DeepFaceLabSN project (missing $requiredDirectory): $fullPath"
        }
    }
    return $fullPath
}

function Initialize-Log {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [switch]$Standalone,
        [switch]$ReadOnly
    )

    if ($ReadOnly) {
        return
    }
    $stateRoot = if ($Standalone) {
        Join-Path $Root "logs"
    } else {
        Join-Path $Root "_internal\.launcher\logs"
    }
    New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
    $name = "bootstrap-{0}-{1}.jsonl" -f (Get-Date -Format "yyyyMMdd-HHmmss"), $PID
    $script:LogPath = Join-Path $stateRoot $name
}

function Read-RuntimeManifest {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw "Runtime manifest not found: $fullPath"
    }
    try {
        $manifest = Get-Content -LiteralPath $fullPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        throw "Runtime manifest is not valid JSON: $($_.Exception.Message)"
    }

    if ([int](Get-OptionalProperty $manifest "schemaVersion" 0) -ne 1) {
        throw "Unsupported runtime manifest schemaVersion. Expected 1."
    }
    $components = @(Get-OptionalProperty $manifest "components" @())
    if ($components.Count -eq 0) {
        throw "Runtime manifest contains no components."
    }

    $ids = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($component in $components) {
        $id = [string](Get-OptionalProperty $component "id" "")
        if ($id -notmatch '^[a-z][a-z0-9-]*$') {
            throw "Invalid component id: $id"
        }
        if (-not $ids.Add($id)) {
            throw "Duplicate component id: $id"
        }

        $archive = Get-OptionalProperty $component "archive"
        $install = Get-OptionalProperty $component "install"
        $validation = Get-OptionalProperty $component "validation"
        if ($null -eq $archive -or $null -eq $install -or $null -eq $validation) {
            throw "Component $id is missing archive, install, or validation metadata."
        }
        if ([string](Get-OptionalProperty $archive "format" "") -ne "zip") {
            throw "Component $id uses an unsupported archive format."
        }
        $archiveName = [string](Get-OptionalProperty $archive "name" "")
        if ([string]::IsNullOrWhiteSpace($archiveName) -or
            -not [string]::Equals([IO.Path]::GetFileName($archiveName), $archiveName, [StringComparison]::Ordinal)) {
            throw "Component $id has an unsafe archive name."
        }

        $relativeInstall = [string](Get-OptionalProperty $install "relativePath" "")
        if ($relativeInstall -notmatch '^_internal[\\/].+') {
            throw "Component $id must install below _internal."
        }
        [void](Resolve-SafeChildPath -BasePath $script:ModeRoot -RelativePath $relativeInstall)

        $archiveRoot = [string](Get-OptionalProperty $install "archiveRoot" "")
        if ([string]::IsNullOrWhiteSpace($archiveRoot) -or [IO.Path]::IsPathRooted($archiveRoot) -or $archiveRoot.IndexOf(':') -ge 0) {
            throw "Component $id has an unsafe archiveRoot."
        }
        $layout = [string](Get-OptionalProperty $install "layout" "")
        if ($layout -notin @("direct", "bin")) {
            throw "Component $id has an unsupported install layout: $layout"
        }

        $files = @(Get-OptionalProperty $validation "files" @())
        if ($files.Count -eq 0) {
            throw "Component $id has no validation files."
        }
        foreach ($file in $files) {
            $validationPath = [string](Get-OptionalProperty $file "path" "")
            if ([string]::IsNullOrWhiteSpace($validationPath) -or [IO.Path]::IsPathRooted($validationPath) -or $validationPath.IndexOf(':') -ge 0) {
                throw "Component $id has an unsafe validation path."
            }
        }

        $available = [bool](Get-OptionalProperty $component "available" $false)
        $sha256 = [string](Get-OptionalProperty $archive "sha256" "")
        $urls = Get-OptionalProperty $archive "urls"
        $urlCount = 0
        foreach ($groupName in @("china", "official")) {
            $group = @(Get-OptionalProperty $urls $groupName @())
            foreach ($url in $group) {
                if ([string]::IsNullOrWhiteSpace([string]$url) -or -not ([string]$url).StartsWith("https://", [StringComparison]::OrdinalIgnoreCase)) {
                    throw "Component $id contains a non-HTTPS or empty download URL."
                }
                $urlCount++
            }
        }
        if ($available -and ($sha256 -notmatch '^[a-fA-F0-9]{64}$' -or $urlCount -eq 0)) {
            throw "Available component $id must have at least one real HTTPS URL and a 64-character SHA-256."
        }
    }

    return $manifest
}

function Get-InstallTarget {
    param([Parameter(Mandatory = $true)][object]$Component)

    $id = [string]$Component.id
    if ($GitOnly) {
        if ($id -ne "mingit") {
            throw "GitOnly cannot resolve a non-Git component."
        }
        return Resolve-SafeChildPath -BasePath $script:ModeRoot -RelativePath "git"
    }

    $target = Resolve-SafeChildPath -BasePath $script:ModeRoot -RelativePath ([string]$Component.install.relativePath)
    $internalRoot = [IO.Path]::GetFullPath((Join-Path $script:ModeRoot "_internal")).TrimEnd('\', '/')
    $prefix = $internalRoot + [IO.Path]::DirectorySeparatorChar
    if (-not $target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to install $($Component.id) outside the project _internal directory."
    }
    return $target
}

function Get-ValidationResult {
    param(
        [Parameter(Mandatory = $true)][object]$Component,
        [Parameter(Mandatory = $true)][string]$TargetPath
    )

    if (-not (Test-Path -LiteralPath $TargetPath -PathType Container)) {
        return [pscustomobject]@{ Ready = $false; Reason = "install directory is missing"; Version = $null }
    }

    try {
        foreach ($fileRule in @($Component.validation.files)) {
            $relativePath = [string]$fileRule.path
            $candidate = Resolve-SafeChildPath -BasePath $TargetPath -RelativePath $relativePath
            $kind = [string](Get-OptionalProperty $fileRule "kind" "file")
            if ($kind -eq "directory") {
                if (-not (Test-Path -LiteralPath $candidate -PathType Container)) {
                    return [pscustomobject]@{ Ready = $false; Reason = "missing directory: $relativePath"; Version = $null }
                }
            } else {
                if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
                    return [pscustomobject]@{ Ready = $false; Reason = "missing file: $relativePath"; Version = $null }
                }
                [Int64]$minimum = [Int64](Get-OptionalProperty $fileRule "minBytes" 0)
                if ((Get-Item -LiteralPath $candidate).Length -lt $minimum) {
                    return [pscustomobject]@{ Ready = $false; Reason = "file is unexpectedly small: $relativePath"; Version = $null }
                }
            }
        }

        $commandRule = Get-OptionalProperty $Component.validation "command"
        if ($null -ne $commandRule) {
            $commandPath = Resolve-SafeChildPath -BasePath $TargetPath -RelativePath ([string]$commandRule.path)
            if (-not (Test-Path -LiteralPath $commandPath -PathType Leaf)) {
                return [pscustomobject]@{ Ready = $false; Reason = "validation executable is missing"; Version = $null }
            }
            $arguments = @()
            foreach ($argument in @(Get-OptionalProperty $commandRule "arguments" @())) {
                $arguments += [string]$argument
            }
            $commandOutput = @(& $commandPath @arguments 2>$null)
            $versionText = (($commandOutput | ForEach-Object { [string]$_ }) -join "`n").Trim()
            $pattern = [string]$commandRule.outputRegex
            if (-not [regex]::IsMatch($versionText, $pattern, [Text.RegularExpressions.RegexOptions]::CultureInvariant)) {
                return [pscustomobject]@{ Ready = $false; Reason = "version validation failed (reported '$versionText')"; Version = $versionText }
            }
            return [pscustomobject]@{ Ready = $true; Reason = "validation passed"; Version = $versionText }
        }
        return [pscustomobject]@{ Ready = $true; Reason = "validation passed"; Version = [string]$Component.version }
    } catch {
        return [pscustomobject]@{ Ready = $false; Reason = $_.Exception.Message; Version = $null }
    }
}

function Format-ByteCount {
    param([Int64]$Bytes)

    if ($Bytes -ge 1TB) { return "{0:N1} TiB" -f ($Bytes / 1TB) }
    if ($Bytes -ge 1GB) { return "{0:N1} GiB" -f ($Bytes / 1GB) }
    if ($Bytes -ge 1MB) { return "{0:N1} MiB" -f ($Bytes / 1MB) }
    if ($Bytes -ge 1KB) { return "{0:N1} KiB" -f ($Bytes / 1KB) }
    return "$Bytes B"
}

function Assert-FreeSpace {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Int64]$RequiredBytes,
        [Parameter(Mandatory = $true)][string]$Id
    )

    $probePath = $Path
    while (-not (Test-Path -LiteralPath $probePath -PathType Container)) {
        $parent = Split-Path -Parent $probePath
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $probePath) {
            throw "Unable to resolve the target drive for $Path"
        }
        $probePath = $parent
    }
    $root = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($probePath))
    $drive = New-Object IO.DriveInfo($root)
    [Int64]$free = $drive.AvailableFreeSpace
    if ($free -lt $RequiredBytes) {
        throw "Insufficient free space for $Id. Required at least $(Format-ByteCount $RequiredBytes); available $(Format-ByteCount $free)."
    }
    Write-JsonEvent -Stage "runtime" -Id $Id -Status "space-ok" -Progress 5 -Downloaded $free -Total $RequiredBytes -Message "磁盘空间检查通过：可用 $(Format-ByteCount $free)。"
}

function Test-UrlQuickly {
    param([Parameter(Mandatory = $true)][string]$Url)

    $response = $null
    try {
        $request = [Net.HttpWebRequest]::Create($Url)
        $request.Method = "GET"
        $request.UserAgent = "DeepFaceLabSN-Launcher/1.0"
        $request.AllowAutoRedirect = $true
        $request.Timeout = 3500
        $request.ReadWriteTimeout = 3500
        $request.AddRange(0, 0)
        $response = [Net.HttpWebResponse]$request.GetResponse()
        return ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 400)
    } catch {
        return $false
    } finally {
        if ($null -ne $response) { $response.Dispose() }
    }
}

function Resolve-MirrorSelection {
    param([Parameter(Mandatory = $true)][string]$Requested)

    if ($Requested -ne "auto") {
        Write-JsonEvent -Stage "mirror" -Id "selection" -Status "selected" -Progress 100 -Message "已使用 $Requested 下载源策略。"
        return $Requested
    }
    if ($NoNetwork -or $DryRun) {
        Write-JsonEvent -Stage "mirror" -Id "selection" -Status "selected" -Progress 100 -Message "离线/预检模式未探测网络，自动策略暂用 official。"
        return "official"
    }

    Write-JsonEvent -Stage "mirror" -Id "selection" -Status "probing" -Progress 20 -Message "正在探测国内镜像可用性…"
    if (Test-UrlQuickly -Url "https://registry.npmmirror.com/-/ping") {
        Write-JsonEvent -Stage "mirror" -Id "selection" -Status "selected" -Progress 100 -Message "国内镜像可用；优先使用 china，失败时回退官方源。"
        return "china"
    }
    Write-JsonEvent -Stage "mirror" -Id "selection" -Status "selected" -Progress 100 -Message "国内镜像探测未通过；使用 official。"
    return "official"
}

function Get-DownloadUrls {
    param(
        [Parameter(Mandatory = $true)][object]$Component,
        [Parameter(Mandatory = $true)][string]$SelectedMirror
    )

    $result = New-Object 'System.Collections.Generic.List[string]'
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $groupOrder = if ($SelectedMirror -eq "china") { @("china", "official") } else { @("official") }
    foreach ($groupName in $groupOrder) {
        foreach ($urlValue in @(Get-OptionalProperty $Component.archive.urls $groupName @())) {
            $url = [string]$urlValue
            if (-not [string]::IsNullOrWhiteSpace($url) -and $seen.Add($url)) {
                $result.Add($url)
            }
        }
    }
    return $result.ToArray()
}

function Test-FileSha256 {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Expected
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $false
    }
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    return [string]::Equals($actual, $Expected, [StringComparison]::OrdinalIgnoreCase)
}

function Move-InvalidDownload {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $invalidPath = $Path + ".invalid-" + (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + [Guid]::NewGuid().ToString("N").Substring(0, 8)
        Move-Item -LiteralPath $Path -Destination $invalidPath
        return $invalidPath
    }
    return $null
}

function Invoke-HttpResumableDownload {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$Id
    )

    [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    for ($attempt = 0; $attempt -lt 2; $attempt++) {
        [Int64]$existing = 0
        if (Test-Path -LiteralPath $Destination -PathType Leaf) {
            $existing = (Get-Item -LiteralPath $Destination).Length
        }

        $response = $null
        $inputStream = $null
        $outputStream = $null
        try {
            $request = [Net.HttpWebRequest]::Create($Url)
            $request.Method = "GET"
            $request.UserAgent = "DeepFaceLabSN-Launcher/1.0"
            $request.AllowAutoRedirect = $true
            $request.Timeout = 20000
            $request.ReadWriteTimeout = 60000
            if ($existing -gt 0) {
                $request.AddRange($existing)
            }
            $response = [Net.HttpWebResponse]$request.GetResponse()
            $statusCode = [int]$response.StatusCode

            if ($existing -gt 0 -and $statusCode -ne 206) {
                $response.Dispose()
                $response = $null
                [void](Move-InvalidDownload -Path $Destination)
                Write-JsonEvent -Stage "download" -Id $Id -Status "restart" -Progress 0 -Message "下载源不支持续传，已安全保留旧分片并从头重试。"
                continue
            }

            [Int64]$total = 0
            if ($response.ContentLength -gt 0) {
                $total = if ($statusCode -eq 206) { $existing + $response.ContentLength } else { $response.ContentLength }
            }
            $mode = if ($existing -gt 0) { [IO.FileMode]::Append } else { [IO.FileMode]::Create }
            $outputStream = New-Object IO.FileStream($Destination, $mode, [IO.FileAccess]::Write, [IO.FileShare]::None)
            $inputStream = $response.GetResponseStream()
            $buffer = New-Object byte[] (1024 * 1024)
            [Int64]$downloaded = $existing
            [Int64]$lastReportedBytes = -1
            $lastReport = [DateTime]::UtcNow.AddSeconds(-2)

            Write-JsonEvent -Stage "download" -Id $Id -Status "downloading" -Progress $(if ($total -gt 0) { [int](($downloaded * 100L) / $total) } else { 0 }) -Downloaded $downloaded -Total $total -Message $(if ($existing -gt 0) { "正在从 $(Format-ByteCount $existing) 继续下载…" } else { "正在下载运行时归档…" })
            while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $outputStream.Write($buffer, 0, $read)
                $downloaded += $read
                $elapsed = ([DateTime]::UtcNow - $lastReport).TotalMilliseconds
                if (($downloaded - $lastReportedBytes) -ge 8MB -or $elapsed -ge 750) {
                    $progress = if ($total -gt 0) { [int][Math]::Min(99, (($downloaded * 100L) / $total)) } else { 0 }
                    Write-JsonEvent -Stage "download" -Id $Id -Status "downloading" -Progress $progress -Downloaded $downloaded -Total $total -Message "已下载 $(Format-ByteCount $downloaded)$(if ($total -gt 0) { ' / ' + (Format-ByteCount $total) } else { '' })。"
                    $lastReportedBytes = $downloaded
                    $lastReport = [DateTime]::UtcNow
                }
            }
            $outputStream.Flush()
            Write-JsonEvent -Stage "download" -Id $Id -Status "downloaded" -Progress 100 -Downloaded $downloaded -Total $(if ($total -gt 0) { $total } else { $downloaded }) -Message "下载完成，正在校验 SHA-256。"
            return
        } catch [Net.WebException] {
            $webResponse = $_.Exception.Response
            $rangeRejected = $false
            if ($null -ne $webResponse) {
                try { $rangeRejected = ([int]$webResponse.StatusCode -eq 416) } catch { $rangeRejected = $false }
            }
            if ($rangeRejected -and $existing -gt 0 -and $attempt -eq 0) {
                [void](Move-InvalidDownload -Path $Destination)
                Write-JsonEvent -Stage "download" -Id $Id -Status "restart" -Progress 0 -Message "服务器拒绝现有续传分片，已保留该分片并从头重试。"
                continue
            }
            throw
        } finally {
            if ($null -ne $outputStream) { $outputStream.Dispose() }
            if ($null -ne $inputStream) { $inputStream.Dispose() }
            if ($null -ne $response) { $response.Dispose() }
        }
    }
    throw "HTTP download could not be restarted safely."
}

function Invoke-BitsDownload {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][string]$Sha256,
        [ValidateRange(0, 3600)][int]$StallTimeoutSeconds = 90
    )

    if ($null -eq (Get-Command Start-BitsTransfer -ErrorAction SilentlyContinue)) {
        throw "BITS is unavailable on this Windows installation."
    }

    $bitsPath = $Destination + ".bits"
    if (Test-FileSha256 -Path $bitsPath -Expected $Sha256) {
        Move-Item -LiteralPath $bitsPath -Destination $Destination -Force
        return
    }
    if (Test-Path -LiteralPath $bitsPath -PathType Leaf) {
        [void](Move-InvalidDownload -Path $bitsPath)
    }

    $urlHasher = [Security.Cryptography.SHA256]::Create()
    try {
        $urlFingerprint = ([BitConverter]::ToString($urlHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($Url)))).Replace("-", "").Substring(0, 10).ToLowerInvariant()
    } finally {
        $urlHasher.Dispose()
    }
    $legacyDisplayName = "DeepFaceLabSN-{0}-{1}" -f $Id, $Sha256.Substring(0, 12)
    $displayName = "{0}-{1}" -f $legacyDisplayName, $urlFingerprint
    $allJobs = @(Get-BitsTransfer -ErrorAction SilentlyContinue)

    # Builds before 2026-08-20 did not include the source URL in the job name and
    # could reuse a permanently stalled job for every fallback mirror.
    foreach ($legacyJob in @($allJobs | Where-Object { $_.DisplayName -eq $legacyDisplayName })) {
        try {
            Remove-BitsTransfer -BitsJob $legacyJob -ErrorAction SilentlyContinue
        } catch {
            # The new source-specific job below must still be allowed to proceed.
        }
    }

    $job = @($allJobs | Where-Object { $_.DisplayName -eq $displayName } | Select-Object -First 1)
    if ($job.Count -eq 0) {
        $job = Start-BitsTransfer -Source $Url -Destination $bitsPath -DisplayName $displayName -Description "DeepFaceLabSN project-local runtime" -Priority Foreground -Asynchronous
    } else {
        $job = $job[0]
    }

    $deadline = [DateTime]::UtcNow.AddHours(24)
    $lastProgressAt = [DateTime]::UtcNow
    [Int64]$lastProgressBytes = -1
    $lastReportAt = [DateTime]::UtcNow.AddSeconds(-10)
    [Int64]$lastReportedBytes = -1
    $lastReportedState = ""
    $lastResumeAt = [DateTime]::UtcNow.AddSeconds(-30)

    try {
        while ([DateTime]::UtcNow -lt $deadline) {
            $job = Get-BitsTransfer -Id $job.JobId -ErrorAction Stop
            $state = [string]$job.JobState
            [Int64]$downloaded = [Int64]$job.BytesTransferred
            [Int64]$total = 0
            if ([UInt64]$job.BytesTotal -lt [UInt64]::MaxValue) {
                $total = [Int64]$job.BytesTotal
            }
            $progress = if ($total -gt 0) { [int][Math]::Min(99, (($downloaded * 100L) / $total)) } else { 0 }
            $now = [DateTime]::UtcNow

            if ($downloaded -gt $lastProgressBytes) {
                $lastProgressBytes = $downloaded
                $lastProgressAt = $now
            }

            if ($state -eq "Transferred") {
                Complete-BitsTransfer -BitsJob $job
                if (-not (Test-Path -LiteralPath $bitsPath -PathType Leaf)) {
                    throw "BITS reported completion but the destination file is missing."
                }
                Move-Item -LiteralPath $bitsPath -Destination $Destination -Force
                Write-JsonEvent -Stage "download" -Id $Id -Status "downloaded" -Progress 100 -Downloaded $downloaded -Total $(if ($total -gt 0) { $total } else { $downloaded }) -Message "BITS 下载完成，正在校验 SHA-256。"
                return
            }
            if ($state -eq "Error" -or $state -eq "Cancelled" -or $state -eq "Acknowledged") {
                $terminalDetail = if ([string]::IsNullOrWhiteSpace([string]$job.ErrorDescription)) { $state } else { "$state - $($job.ErrorDescription)" }
                throw "BITS download failed: $terminalDetail"
            }
            if (($state -eq "Suspended" -or $state -eq "TransientError") -and (($now - $lastResumeAt).TotalSeconds -ge 10)) {
                Resume-BitsTransfer -BitsJob $job -Asynchronous | Out-Null
                $lastResumeAt = $now
            }

            $stalledFor = ($now - $lastProgressAt).TotalSeconds
            if ($stalledFor -ge $StallTimeoutSeconds) {
                $stallDetail = if ([string]::IsNullOrWhiteSpace([string]$job.ErrorDescription)) { $state } else { "$state - $($job.ErrorDescription)" }
                throw "BITS 在 $StallTimeoutSeconds 秒内没有收到数据（状态：$stallDetail）。"
            }

            if ($state -ne $lastReportedState -or $downloaded -ne $lastReportedBytes -or (($now - $lastReportAt).TotalSeconds -ge 5)) {
                $detailSuffix = if (-not [string]::IsNullOrWhiteSpace([string]$job.ErrorDescription)) { "；$($job.ErrorDescription)" } else { "" }
                Write-JsonEvent -Stage "download" -Id $Id -Status "bits-$($state.ToLowerInvariant())" -Progress $progress -Downloaded $downloaded -Total $total -Message "BITS 后台下载（$state$detailSuffix；连续 $StallTimeoutSeconds 秒无进展将切换下载源）：$(Format-ByteCount $downloaded)$(if ($total -gt 0) { ' / ' + (Format-ByteCount $total) } else { '' })。"
                $lastReportedState = $state
                $lastReportedBytes = $downloaded
                $lastReportAt = $now
            }
            Start-Sleep -Milliseconds 750
        }
        throw "BITS download timed out after 24 hours."
    } catch {
        $originalError = $_
        if ($null -ne $job) {
            try {
                $cleanupJob = Get-BitsTransfer -Id $job.JobId -ErrorAction SilentlyContinue
                if ($null -eq $cleanupJob) { $cleanupJob = $job }
                Remove-BitsTransfer -BitsJob $cleanupJob -ErrorAction SilentlyContinue
            } catch {
                # Preserve the actual download failure; cleanup is best-effort.
            }
        }
        if (Test-Path -LiteralPath $bitsPath -PathType Leaf) {
            try { [void](Move-InvalidDownload -Path $bitsPath) } catch { }
        }
        throw $originalError
    }
}

function Get-VerifiedArchive {
    param(
        [Parameter(Mandatory = $true)][object]$Component,
        [Parameter(Mandatory = $true)][string]$CacheRoot
    )

    New-Item -ItemType Directory -Path $CacheRoot -Force | Out-Null
    $archivePath = Resolve-SafeChildPath -BasePath $CacheRoot -RelativePath ([string]$Component.archive.name)
    $partialPath = $archivePath + ".part"
    $expectedSha = ([string]$Component.archive.sha256).ToLowerInvariant()

    if (Test-Path -LiteralPath $archivePath -PathType Leaf) {
        Write-JsonEvent -Stage "download" -Id $Component.id -Status "verifying-cache" -Progress 0 -Message "正在校验本地缓存归档…"
        if (Test-FileSha256 -Path $archivePath -Expected $expectedSha) {
            Write-JsonEvent -Stage "download" -Id $Component.id -Status "cached" -Progress 100 -Downloaded (Get-Item -LiteralPath $archivePath).Length -Total (Get-Item -LiteralPath $archivePath).Length -Message "缓存归档 SHA-256 校验通过。"
            return $archivePath
        }
        $invalid = Move-InvalidDownload -Path $archivePath
        Write-JsonEvent -Stage "download" -Id $Component.id -Status "cache-rejected" -Progress 0 -Message "缓存哈希不匹配，已保留为 $([IO.Path]::GetFileName($invalid))。"
    }

    if (Test-FileSha256 -Path $partialPath -Expected $expectedSha) {
        Move-Item -LiteralPath $partialPath -Destination $archivePath -Force
        Write-JsonEvent -Stage "download" -Id $Component.id -Status "resumed" -Progress 100 -Downloaded (Get-Item -LiteralPath $archivePath).Length -Total (Get-Item -LiteralPath $archivePath).Length -Message "已有分片实际完整且哈希正确，已直接复用。"
        return $archivePath
    }

    if ($NoNetwork) {
        throw "Network access is disabled and no verified cached archive is available for $($Component.id)."
    }
    $urls = @(Get-DownloadUrls -Component $Component -SelectedMirror $script:ResolvedMirror)
    if ($urls.Count -eq 0) {
        throw "No real download URL is published for $($Component.id)."
    }

    $failures = New-Object 'System.Collections.Generic.List[string]'
    foreach ($url in $urls) {
        Write-JsonEvent -Stage "download" -Id $Component.id -Status "connecting" -Progress 0 -Message "正在连接 $(([Uri]$url).Host)…"
        try {
            Invoke-HttpResumableDownload -Url $url -Destination $partialPath -Id ([string]$Component.id)
        } catch {
            $httpMessage = $_.Exception.Message
            $failures.Add("$url => HTTP: $httpMessage")
            Write-JsonEvent -Stage "download" -Id $Component.id -Status "http-failed" -Progress 0 -Message "HTTP 下载失败，尝试 Windows BITS：$httpMessage"
            try {
                Invoke-BitsDownload -Url $url -Destination $partialPath -Id ([string]$Component.id) -Sha256 $expectedSha
            } catch {
                $bitsMessage = $_.Exception.Message
                $failures.Add("$url => BITS: $bitsMessage")
                Write-JsonEvent -Stage "download" -Id $Component.id -Status "source-failed" -Progress 0 -Message "当前下载源失败，准备尝试后备源：$bitsMessage"
                continue
            }
        }

        Write-JsonEvent -Stage "download" -Id $Component.id -Status "verifying" -Progress 100 -Downloaded (Get-Item -LiteralPath $partialPath).Length -Total (Get-Item -LiteralPath $partialPath).Length -Message "正在校验 SHA-256…"
        if (Test-FileSha256 -Path $partialPath -Expected $expectedSha) {
            Move-Item -LiteralPath $partialPath -Destination $archivePath -Force
            Write-JsonEvent -Stage "download" -Id $Component.id -Status "verified" -Progress 100 -Downloaded (Get-Item -LiteralPath $archivePath).Length -Total (Get-Item -LiteralPath $archivePath).Length -Message "下载归档 SHA-256 校验通过。"
            return $archivePath
        }
        $invalid = Move-InvalidDownload -Path $partialPath
        $failures.Add("$url => SHA-256 mismatch")
        Write-JsonEvent -Stage "download" -Id $Component.id -Status "hash-mismatch" -Progress 0 -Message "SHA-256 不匹配；可疑文件已保留为 $([IO.Path]::GetFileName($invalid))，不会安装。"
    }

    throw "Every download source failed for $($Component.id): $($failures -join ' | ')"
}

function ConvertTo-ExtendedWindowsPath {
    param([Parameter(Mandatory = $true)][string]$FullPath)

    # Call only after canonicalizing and validating the path. Explicit extended
    # paths work without enabling the machine-wide Windows long-path policy.
    if ($FullPath.StartsWith('\\?\')) { return $FullPath }
    if ($FullPath.StartsWith('\\')) { return '\\?\UNC\' + $FullPath.Substring(2) }
    return '\\?\' + $FullPath
}

function Expand-ZipSafely {
    param(
        [Parameter(Mandatory = $true)][string]$ArchivePath,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$Id,
        [string[]]$SelectedEntries,
        [string]$ArchiveRoot = "."
    )

    Add-Type -AssemblyName System.IO.Compression | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    $destinationFull = [IO.Path]::GetFullPath($Destination).TrimEnd('\', '/')
    $destinationPrefix = $destinationFull + [IO.Path]::DirectorySeparatorChar
    $archivePrefix = $null
    $foundArchiveRoot = $ArchiveRoot -eq "."
    if (-not $foundArchiveRoot) {
        [void](Resolve-SafeChildPath -BasePath $destinationFull -RelativePath $ArchiveRoot)
        $archivePrefix = $ArchiveRoot.Replace('\', '/').TrimEnd('/') + '/'
    }
    $selectedSet = $null
    $foundSelected = $null
    if ($PSBoundParameters.ContainsKey('SelectedEntries')) {
        $selectedSet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        $foundSelected = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        foreach ($selectedEntry in @($SelectedEntries)) {
            $normalizedSelected = ([string]$selectedEntry).Replace('\', '/').Trim('/')
            if ([string]::IsNullOrWhiteSpace($normalizedSelected) -or -not $selectedSet.Add($normalizedSelected)) {
                throw "Selected ZIP entry is empty or duplicated: $selectedEntry"
            }
        }
    }
    $zip = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        $entries = @($zip.Entries)
        $count = $entries.Count
        for ($index = 0; $index -lt $count; $index++) {
            $entry = $entries[$index]
            $entryName = [string]$entry.FullName
            if ([string]::IsNullOrWhiteSpace($entryName)) {
                continue
            }
            if ($entryName.StartsWith("/") -or $entryName.StartsWith("\") -or $entryName.IndexOf(':') -ge 0) {
                throw "Unsafe rooted ZIP entry: $entryName"
            }
            $segments = @($entryName -split '[\\/]')
            foreach ($segment in $segments) {
                if ($segment -eq ".." -or $segment.EndsWith(".") -or $segment.EndsWith(" ")) {
                    throw "Unsafe ZIP path segment in: $entryName"
                }
            }
            $unixType = (($entry.ExternalAttributes -shr 16) -band 0xF000)
            if ($unixType -eq 0xA000) {
                throw "Symbolic links are not allowed in runtime ZIP files: $entryName"
            }

            $normalizedEntry = $entryName.Replace('\', '/').TrimEnd('/')
            $isDirectory = [string]::IsNullOrEmpty($entry.Name)
            $relativeEntry = $normalizedEntry
            $inArchiveRoot = $true
            if ($null -ne $archivePrefix) {
                $inArchiveRoot = $normalizedEntry.StartsWith($archivePrefix, [StringComparison]::OrdinalIgnoreCase)
                if ($inArchiveRoot) {
                    $foundArchiveRoot = $true
                    $relativeEntry = $normalizedEntry.Substring($archivePrefix.Length)
                } elseif ($isDirectory -and [string]::Equals($normalizedEntry, $archivePrefix.TrimEnd('/'), [StringComparison]::OrdinalIgnoreCase)) {
                    $foundArchiveRoot = $true
                }
            }
            $shouldExtract = $null -eq $selectedSet -or (-not $isDirectory -and $selectedSet.Contains($normalizedEntry))
            if ($shouldExtract -and $inArchiveRoot) {
                $relativeWindows = $relativeEntry.Replace('/', [IO.Path]::DirectorySeparatorChar)
                $targetPath = [IO.Path]::GetFullPath((Join-Path $destinationFull $relativeWindows))
                if (-not $targetPath.StartsWith($destinationPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                    throw "ZIP entry escapes the staging directory: $entryName"
                }
                $nativeTarget = ConvertTo-ExtendedWindowsPath -FullPath $targetPath
                if ($isDirectory) {
                    [IO.Directory]::CreateDirectory($nativeTarget) | Out-Null
                } else {
                    if ($null -ne $foundSelected -and -not $foundSelected.Add($normalizedEntry)) {
                        throw "Selected ZIP entry occurs more than once: $entryName"
                    }
                    $parent = Split-Path -Parent $targetPath
                    [IO.Directory]::CreateDirectory((ConvertTo-ExtendedWindowsPath -FullPath $parent)) | Out-Null
                    $entryStream = $null
                    $fileStream = $null
                    try {
                        $entryStream = $entry.Open()
                        $fileStream = New-Object IO.FileStream($nativeTarget, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                        $entryStream.CopyTo($fileStream)
                    } finally {
                        if ($null -ne $fileStream) { $fileStream.Dispose() }
                        if ($null -ne $entryStream) { $entryStream.Dispose() }
                    }
                }
            }

            if ($count -gt 0 -and (($index % 100) -eq 0 -or $index -eq ($count - 1))) {
                $progress = [int][Math]::Min(99, ((($index + 1) * 100L) / $count))
                $message = if ($null -eq $selectedSet) {
                    "正在安全解压：$($index + 1) / $count 项。"
                } else {
                    "正在扫描归档：$($index + 1) / $count 项；仅提取 $($selectedSet.Count) 个必需文件。"
                }
                Write-JsonEvent -Stage "runtime" -Id $Id -Status "extracting" -Progress $progress -Message $message
            }
        }
        if (-not $foundArchiveRoot) {
            throw "Verified archive does not contain the expected root: $ArchiveRoot"
        }
        if ($null -ne $selectedSet -and $foundSelected.Count -ne $selectedSet.Count) {
            $missing = @($selectedSet | Where-Object { -not $foundSelected.Contains($_) })
            throw "Verified ZIP is missing selected entry: $($missing[0])"
        }
    } finally {
        $zip.Dispose()
    }
}

function Remove-SafeDirectory {
    param(
        [string]$Path,
        [Parameter(Mandatory = $true)][string]$AllowedRoot,
        [switch]$IgnoreErrors
    )

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
        return
    }
    try {
        $allowed = [IO.Path]::GetFullPath($AllowedRoot).TrimEnd('\', '/')
        $target = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
        $prefix = $allowed + [IO.Path]::DirectorySeparatorChar
        if (-not $target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove a directory outside the allowed runtime root: $target"
        }
        Remove-Item -LiteralPath $target -Recurse -Force
    } catch {
        if (-not $IgnoreErrors) { throw }
    }
}

function Install-ComponentArchive {
    param(
        [Parameter(Mandatory = $true)][object]$Component,
        [Parameter(Mandatory = $true)][string]$ArchivePath,
        [Parameter(Mandatory = $true)][string]$TargetPath
    )

    $id = [string]$Component.id
    $token = "$PID-" + [Guid]::NewGuid().ToString("N")
    $targetParent = Split-Path -Parent $TargetPath
    New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
    $stagingPath = $TargetPath + ".installing-" + $token
    $backupPath = $TargetPath + ".backup-" + $token
    $backupCreated = $false
    $newTargetMoved = $false

    try {
        New-Item -ItemType Directory -Path $stagingPath | Out-Null
        $payloadTarget = if ([string]$Component.install.layout -eq "bin") {
            Join-Path $stagingPath "bin"
        } else {
            $stagingPath
        }
        New-Item -ItemType Directory -Path $payloadTarget -Force | Out-Null
        # Extract straight into the atomic replacement directory. Keeping the
        # archive's outer folder in a second deep work tree can push npm files
        # beyond MAX_PATH even when the final installation path is short.
        Write-JsonEvent -Stage "runtime" -Id $id -Status "extracting" -Progress 10 -Message "正在解压到同磁盘临时目录并检查 ZIP 路径…"
        Expand-ZipSafely -ArchivePath $ArchivePath -Destination $payloadTarget -Id $id -ArchiveRoot ([string]$Component.install.archiveRoot)
        Get-ChildItem -LiteralPath $stagingPath -File -Recurse -Force | Unblock-File -ErrorAction SilentlyContinue

        $stagingValidation = Get-ValidationResult -Component $Component -TargetPath $stagingPath
        if (-not $stagingValidation.Ready) {
            throw "Staged runtime validation failed: $($stagingValidation.Reason)"
        }
        Write-JsonEvent -Stage "runtime" -Id $id -Status "staged" -Progress 85 -Message "暂存运行时验证通过，正在原子替换。"

        if (Test-Path -LiteralPath $TargetPath -PathType Container) {
            Move-Item -LiteralPath $TargetPath -Destination $backupPath
            $backupCreated = $true
        }
        Move-Item -LiteralPath $stagingPath -Destination $TargetPath
        $newTargetMoved = $true

        $finalValidation = Get-ValidationResult -Component $Component -TargetPath $TargetPath
        if (-not $finalValidation.Ready) {
            throw "Installed runtime failed final validation: $($finalValidation.Reason)"
        }

        if ($backupCreated) {
            try {
                Remove-SafeDirectory -Path $backupPath -AllowedRoot $targetParent
                $backupCreated = $false
            } catch {
                Write-JsonEvent -Stage "runtime" -Id $id -Status "backup-retained" -Progress 95 -Message "新运行时已就绪，但旧备份暂时无法删除：$([IO.Path]::GetFileName($backupPath))"
            }
        }
        Write-JsonEvent -Stage "runtime" -Id $id -Status "ready" -Progress 100 -Message "$($Component.displayName) $($Component.version) 已安装并通过校验。"
    } catch {
        $originalError = $_
        if ($newTargetMoved -and (Test-Path -LiteralPath $TargetPath -PathType Container)) {
            Remove-SafeDirectory -Path $TargetPath -AllowedRoot $targetParent -IgnoreErrors
        }
        if ($backupCreated -and (Test-Path -LiteralPath $backupPath -PathType Container)) {
            try {
                Move-Item -LiteralPath $backupPath -Destination $TargetPath
                $backupCreated = $false
                Write-JsonEvent -Stage "runtime" -Id $id -Status "rolled-back" -Progress 0 -Message "安装失败，已恢复原运行时。"
            } catch {
                Write-JsonEvent -Stage "runtime" -Id $id -Status "rollback-failed" -Progress 0 -Message "自动回滚失败；旧运行时仍保留在 $backupPath。"
            }
        }
        throw $originalError
    } finally {
        Remove-SafeDirectory -Path $stagingPath -AllowedRoot $targetParent -IgnoreErrors
    }
}

function Write-ManagedConfigFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content,
        [Parameter(Mandatory = $true)][string]$Id
    )

    $marker = "DeepFaceLabSN launcher managed mirror settings"
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $existing = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
        if ($existing.IndexOf($marker, [StringComparison]::Ordinal) -lt 0) {
            Write-JsonEvent -Stage "mirror" -Id $Id -Status "preserved" -Progress 100 -Message "发现用户自定义配置，已保留且未覆盖：$Path"
            return
        }
    }
    if ($DryRun) {
        Write-JsonEvent -Stage "mirror" -Id $Id -Status "planned" -Progress 100 -Message "预检：将写入项目本地镜像配置 $Path"
        return
    }

    $parent = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $temporary = $Path + ".tmp-" + $PID + "-" + [Guid]::NewGuid().ToString("N")
    try {
        [IO.File]::WriteAllText($temporary, $Content, $script:Utf8NoBom)
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $temporary -PathType Leaf) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
    }
    Write-JsonEvent -Stage "mirror" -Id $Id -Status "configured" -Progress 100 -Message "已写入项目本地镜像配置，不修改系统或用户全局源。"
}

function Set-ProjectLocalMirrors {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$SelectedMirror
    )

    $localProfile = Join-Path $Root "_internal\_e\u"
    $npmPath = Join-Path $localProfile ".npmrc"
    $pipPath = Join-Path $localProfile "AppData\Roaming\pip\pip.ini"
    if ($SelectedMirror -eq "china") {
        $npmRegistry = "https://registry.npmmirror.com/"
        $pipIndex = "https://pypi.tuna.tsinghua.edu.cn/simple"
        $pipTrusted = "trusted-host = pypi.tuna.tsinghua.edu.cn`r`n"
    } else {
        $npmRegistry = "https://registry.npmjs.org/"
        $pipIndex = "https://pypi.org/simple"
        $pipTrusted = ""
    }

    $npmContent = @"
# DeepFaceLabSN launcher managed mirror settings
registry=$npmRegistry
fetch-retries=4
fetch-retry-mintimeout=10000
fetch-retry-maxtimeout=120000
"@
    $pipContent = @"
# DeepFaceLabSN launcher managed mirror settings
[global]
index-url = $pipIndex
${pipTrusted}timeout = 60
disable-pip-version-check = true
"@
    Write-ManagedConfigFile -Path $npmPath -Content $npmContent -Id "npm"
    Write-ManagedConfigFile -Path $pipPath -Content $pipContent -Id "pip"
}

function Invoke-Bootstrap {
    param([Parameter(Mandatory = $true)][object]$Manifest)

    $selectedComponents = @(if ($GitOnly) {
        @($Manifest.components | Where-Object { $_.id -eq "mingit" })
    } else {
        @($Manifest.components)
    })
    if ($selectedComponents.Count -eq 0) {
        throw "The runtime manifest does not define Portable MinGit."
    }

    $cacheRoot = if ($GitOnly) {
        Join-Path $script:ModeRoot "cache"
    } else {
        Join-Path $script:ModeRoot "_internal\installers"
    }
    $workRoot = if ($GitOnly) {
        Join-Path $script:ModeRoot "work"
    } else {
        Join-Path $script:ModeRoot "_internal\.launcher\work"
    }
    if (-not $DryRun) {
        New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
        New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
    }

    if (-not $GitOnly) {
        Set-ProjectLocalMirrors -Root $script:ModeRoot -SelectedMirror $script:ResolvedMirror
    }

    $failures = New-Object 'System.Collections.Generic.List[string]'
    foreach ($component in $selectedComponents) {
        $id = [string]$component.id
        $target = Get-InstallTarget -Component $component
        Write-JsonEvent -Stage "runtime" -Id $id -Status "checking" -Progress 0 -Message "正在检查 $($component.displayName) $($component.version)…"
        $validation = Get-ValidationResult -Component $component -TargetPath $target
        if ($validation.Ready) {
            $repairMessage = if ($Repair) { "修复校验通过，无需替换" } else { "已就绪" }
            Write-JsonEvent -Stage "runtime" -Id $id -Status "ready" -Progress 100 -Message "$($component.displayName) $($component.version) $repairMessage。"
            continue
        }

        if ($DryRun) {
            $status = if ([bool]$component.available) { "planned" } else { "unavailable" }
            Write-JsonEvent -Stage "runtime" -Id $id -Status $status -Progress 0 -Message "预检：当前未就绪（$($validation.Reason)）；发布状态：$(if ([bool]$component.available) { '可下载' } else { '尚无真实归档 URL/SHA' })。"
            if (-not [bool]$component.available -and [bool]$component.required) {
                $failures.Add("$id is unavailable")
            }
            continue
        }

        if (-not [bool]$component.available) {
            $todo = [string](Get-OptionalProperty $component "hostingTodo" "Runtime archive hosting is not configured.")
            Write-JsonEvent -Stage "runtime" -Id $id -Status "unavailable" -Progress 0 -Message "$($component.displayName) 未就绪，且清单没有可验证的真实下载地址。$todo"
            if ([bool]$component.required) {
                $failures.Add("$id unavailable: $todo")
            }
            continue
        }

        try {
            Write-JsonEvent -Stage "runtime" -Id $id -Status "repairing" -Progress 1 -Message "检测到缺失或损坏（$($validation.Reason)），准备安全安装。"
            Assert-FreeSpace -Path (Split-Path -Parent $target) -RequiredBytes ([Int64]$component.install.requiredFreeBytes) -Id $id
            $archive = Get-VerifiedArchive -Component $component -CacheRoot $cacheRoot
            Install-ComponentArchive -Component $component -ArchivePath $archive -TargetPath $target
        } catch {
            $message = $_.Exception.Message
            Write-JsonEvent -Stage "runtime" -Id $id -Status "failed" -Progress 0 -Message "$($component.displayName) 安装失败：$message"
            $failures.Add("${id}: $message")
        }
    }

    if ($failures.Count -gt 0) {
        throw "One or more required components are not ready: $($failures -join ' | ')"
    }
}

. (Join-Path $PSScriptRoot "runtime-artifacts.ps1")
. (Join-Path $PSScriptRoot "python-wheelhouse.ps1")

$exitCode = 0
try {
    $script:ModeRoot = Assert-SafeModeRoot -RequestedPath $ProjectRoot -Standalone:$GitOnly -ReadOnly:$DryRun
    $script:SafeRoot = $script:ModeRoot
    Initialize-Log -Root $script:ModeRoot -Standalone:$GitOnly -ReadOnly:$DryRun
    Write-JsonEvent -Stage "bootstrap" -Id "start" -Status "running" -Progress 0 -Message $(if ($GitOnly) { "正在准备独立 Portable MinGit 工具目录。" } else { "正在检查现有 DeepFaceLabSN 项目；脚本不会克隆或覆盖源码。" })

    if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
        $ManifestPath = Join-Path $PSScriptRoot "runtime-manifest.json"
    }
    $manifest = Read-RuntimeManifest -Path $ManifestPath
    Write-JsonEvent -Stage "bootstrap" -Id "manifest" -Status "verified" -Progress 5 -Message "运行时清单结构校验通过：$($manifest.manifestVersion)。"

    $script:ResolvedMirror = Resolve-MirrorSelection -Requested $Mirror
    Invoke-Bootstrap -Manifest $manifest
    $completionMessage = if ($DryRun) { "预检完成；未下载、安装或替换任何运行时。" } elseif ($GitOnly) { "Portable MinGit 已就绪。" } else { "所有已发布且必需的项目运行时均已就绪。" }
    Write-JsonEvent -Stage "bootstrap" -Id "complete" -Status "complete" -Progress 100 -Message $completionMessage
} catch {
    $exitCode = 1
    Write-JsonEvent -Stage "bootstrap" -Id "fatal" -Status "failed" -Progress 0 -Message $_.Exception.Message
}

exit $exitCode
