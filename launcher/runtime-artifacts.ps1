# Multi-archive runtime support for bootstrap.ps1.
# This file is intentionally ASCII so Windows PowerShell 5.1 can dot-source it
# even when a host copies the bootstrap resources without preserving a BOM.

function Test-SafeRelativeArtifactPath {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or [IO.Path]::IsPathRooted($Path) -or $Path.IndexOf(':') -ge 0) {
        return $false
    }
    foreach ($segment in @($Path -split '[\\/]')) {
        if ($segment -eq '..' -or $segment.EndsWith('.') -or $segment.EndsWith(' ')) {
            return $false
        }
    }
    return $true
}

function Assert-PackageMetadata {
    param(
        [Parameter(Mandatory = $true)][object]$Package,
        [Parameter(Mandatory = $true)][string]$OwnerId,
        [bool]$Available
    )

    if ([string](Get-OptionalProperty $Package 'format' '') -ne 'zip') {
        throw "Package $OwnerId uses an unsupported archive format."
    }
    $name = [string](Get-OptionalProperty $Package 'name' '')
    if ([string]::IsNullOrWhiteSpace($name) -or
        -not [string]::Equals([IO.Path]::GetFileName($name), $name, [StringComparison]::Ordinal) -or
        -not $name.EndsWith('.zip', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Package $OwnerId has an unsafe archive name."
    }

    $sha256 = [string](Get-OptionalProperty $Package 'sha256' '')
    $urls = Get-OptionalProperty $Package 'urls'
    $urlCount = 0
    foreach ($groupName in @('china', 'official')) {
        foreach ($urlValue in @(Get-OptionalProperty $urls $groupName @())) {
            $url = [string]$urlValue
            $uri = $null
            if ([string]::IsNullOrWhiteSpace($url) -or
                -not [Uri]::TryCreate($url, [UriKind]::Absolute, [ref]$uri) -or
                $uri.Scheme -ne 'https') {
                throw "Package $OwnerId contains a non-HTTPS or invalid download URL."
            }
            $urlCount++
        }
    }
    if ($Available -and ($sha256 -notmatch '^[a-fA-F0-9]{64}$' -or $urlCount -eq 0)) {
        throw "Available package $OwnerId needs a real HTTPS URL and a pinned SHA-256."
    }
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

    $schemaVersion = [int](Get-OptionalProperty $manifest 'schemaVersion' 0)
    if ($schemaVersion -notin @(1, 2)) {
        throw 'Unsupported runtime manifest schemaVersion. Expected 1 or 2.'
    }
    $components = @(Get-OptionalProperty $manifest 'components' @())
    if ($components.Count -eq 0) {
        throw 'Runtime manifest contains no components.'
    }

    $componentIds = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($component in $components) {
        $id = [string](Get-OptionalProperty $component 'id' '')
        if ($id -notmatch '^[a-z][a-z0-9-]*$' -or -not $componentIds.Add($id)) {
            throw "Invalid or duplicate component id: $id"
        }
        $install = Get-OptionalProperty $component 'install'
        $validation = Get-OptionalProperty $component 'validation'
        if ($null -eq $install -or $null -eq $validation) {
            throw "Component $id is missing install or validation metadata."
        }
        $relativeInstall = [string](Get-OptionalProperty $install 'relativePath' '')
        if ($relativeInstall -notmatch '^_internal[\\/].+') {
            throw "Component $id must install below _internal."
        }
        [void](Resolve-SafeChildPath -BasePath $script:ModeRoot -RelativePath $relativeInstall)
        [Int64]$freeBytes = [Int64](Get-OptionalProperty $install 'requiredFreeBytes' 0)
        if ($freeBytes -lt 1MB) {
            throw "Component $id has an invalid requiredFreeBytes value."
        }

        $files = @(Get-OptionalProperty $validation 'files' @())
        if ($files.Count -eq 0) {
            throw "Component $id has no validation files."
        }
        foreach ($file in $files) {
            if (-not (Test-SafeRelativeArtifactPath -Path ([string](Get-OptionalProperty $file 'path' '')))) {
                throw "Component $id has an unsafe validation path."
            }
        }
        $command = Get-OptionalProperty $validation 'command'
        if ($null -ne $command -and -not (Test-SafeRelativeArtifactPath -Path ([string](Get-OptionalProperty $command 'path' '')))) {
            throw "Component $id has an unsafe validation command path."
        }

        $archive = Get-OptionalProperty $component 'archive'
        $artifacts = @(Get-OptionalProperty $component 'artifacts' @())
        $wheelLock = [string](Get-OptionalProperty $component 'wheelLock' '')
        if (-not [string]::IsNullOrWhiteSpace($wheelLock)) {
            Assert-PythonWheelhouseMetadata -Component $component -ManifestPath $fullPath
            continue
        }
        $hasArchive = $null -ne $archive
        $hasArtifacts = $artifacts.Count -gt 0
        if ($hasArchive -eq $hasArtifacts) {
            throw "Component $id must define exactly one of archive or artifacts."
        }
        $available = [bool](Get-OptionalProperty $component 'available' $false)
        if ($hasArchive) {
            Assert-PackageMetadata -Package $archive -OwnerId $id -Available $available
            $archiveRoot = [string](Get-OptionalProperty $install 'archiveRoot' '')
            if (-not (Test-SafeRelativeArtifactPath -Path $archiveRoot) -and $archiveRoot -ne '.') {
                throw "Component $id has an unsafe archiveRoot."
            }
            if ([string](Get-OptionalProperty $install 'layout' '') -notin @('direct', 'bin')) {
                throw "Component $id has an unsupported single-archive layout."
            }
            continue
        }

        if ([string](Get-OptionalProperty $install 'layout' '') -ne 'merge-files') {
            throw "Multi-artifact component $id must use the merge-files layout."
        }
        $artifactIds = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        $targets = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        foreach ($artifact in $artifacts) {
            $artifactId = [string](Get-OptionalProperty $artifact 'id' '')
            if ($artifactId -notmatch '^[a-z][a-z0-9-]*$' -or -not $artifactIds.Add($artifactId)) {
                throw "Component $id has an invalid or duplicate artifact id: $artifactId"
            }
            Assert-PackageMetadata -Package $artifact -OwnerId "$id/$artifactId" -Available $available
            $archiveRoot = [string](Get-OptionalProperty $artifact 'archiveRoot' '')
            if (-not (Test-SafeRelativeArtifactPath -Path $archiveRoot) -and $archiveRoot -ne '.') {
                throw "Artifact $id/$artifactId has an unsafe archiveRoot."
            }
            $mappings = @(Get-OptionalProperty $artifact 'files' @())
            if ($mappings.Count -eq 0) {
                throw "Artifact $id/$artifactId has no selected files."
            }
            foreach ($mapping in $mappings) {
                $source = [string](Get-OptionalProperty $mapping 'source' '')
                $target = [string](Get-OptionalProperty $mapping 'target' '')
                if (-not (Test-SafeRelativeArtifactPath -Path $source) -or -not (Test-SafeRelativeArtifactPath -Path $target)) {
                    throw "Artifact $id/$artifactId has an unsafe file mapping."
                }
                if (-not $targets.Add($target)) {
                    throw "Multi-artifact component $id maps more than one file to $target."
                }
            }
            foreach ($notice in @(Get-OptionalProperty $artifact 'notices' @())) {
                $source = [string](Get-OptionalProperty $notice 'source' '')
                $target = [string](Get-OptionalProperty $notice 'target' '')
                if (-not (Test-SafeRelativeArtifactPath -Path $source) -or
                    -not (Test-SafeRelativeArtifactPath -Path $target) -or
                    -not $target.StartsWith('_licenses/', [StringComparison]::OrdinalIgnoreCase)) {
                    throw "Artifact $id/$artifactId has an unsafe license notice mapping."
                }
                if (-not $targets.Add($target)) {
                    throw "Multi-artifact component $id has a duplicate notice target: $target"
                }
            }
        }
    }
    return $manifest
}

function New-ArtifactDownloadAdapter {
    param(
        [Parameter(Mandatory = $true)][object]$Component,
        [Parameter(Mandatory = $true)][object]$Artifact
    )

    return [pscustomobject]@{
        id = [string]$Component.id
        archive = $Artifact
    }
}

function Copy-ArtifactMapping {
    param(
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$StagingRoot,
        [Parameter(Mandatory = $true)][object]$Mapping,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.HashSet[string]]$Targets,
        [Parameter(Mandatory = $true)][string]$Owner
    )

    $sourceRelative = [string]$Mapping.source
    $targetRelative = [string]$Mapping.target
    if (-not $Targets.Add($targetRelative)) {
        throw "Artifact target collision in ${Owner}: $targetRelative"
    }
    $source = Resolve-SafeChildPath -BasePath $SourceRoot -RelativePath $sourceRelative
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Artifact $Owner is missing selected file: $sourceRelative"
    }
    $target = Resolve-SafeChildPath -BasePath $StagingRoot -RelativePath $targetRelative
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $target
}

function Get-SelectedArtifactEntries {
    param([Parameter(Mandatory = $true)][object]$Artifact)

    $archiveRoot = ([string]$Artifact.archiveRoot).Replace('\', '/').Trim('/')
    $entries = @()
    foreach ($mapping in @($Artifact.files) + @(Get-OptionalProperty $Artifact 'notices' @())) {
        $source = ([string]$mapping.source).Replace('\', '/').Trim('/')
        $entries += if ($archiveRoot -eq '.') { $source } else { $archiveRoot + '/' + $source }
    }
    return @($entries)
}

function Install-MultiArtifactComponent {
    param(
        [Parameter(Mandatory = $true)][object]$Component,
        [Parameter(Mandatory = $true)][object[]]$ArtifactArchives,
        [Parameter(Mandatory = $true)][string]$TargetPath,
        [Parameter(Mandatory = $true)][string]$WorkRoot
    )

    $id = [string]$Component.id
    $token = "$PID-" + [Guid]::NewGuid().ToString('N')
    $targetParent = Split-Path -Parent $TargetPath
    New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
    $stagingPath = $TargetPath + '.installing-' + $token
    $backupPath = $TargetPath + '.backup-' + $token
    $backupCreated = $false
    $newTargetMoved = $false
    $targets = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)

    try {
        New-Item -ItemType Directory -Path $stagingPath | Out-Null
        $artifactIndex = 0
        foreach ($item in $ArtifactArchives) {
            $artifactIndex++
            $artifact = $item.Artifact
            $artifactId = [string]$artifact.id
            $extractRoot = Resolve-SafeChildPath -BasePath $WorkRoot -RelativePath ("extract-$id-$artifactId-$token")
            try {
                Write-JsonEvent -Stage 'runtime' -Id $id -Status 'extracting' -Progress ([int](10 + (55 * ($artifactIndex - 1) / $ArtifactArchives.Count))) -Message "Extracting verified artifact $artifactId ($artifactIndex/$($ArtifactArchives.Count))."
                $selectedEntries = @(Get-SelectedArtifactEntries -Artifact $artifact)
                Expand-ZipSafely -ArchivePath ([string]$item.Path) -Destination $extractRoot -Id $id -SelectedEntries $selectedEntries
                $archiveRootRule = [string]$artifact.archiveRoot
                $sourceRoot = if ($archiveRootRule -eq '.') { $extractRoot } else { Resolve-SafeChildPath -BasePath $extractRoot -RelativePath $archiveRootRule }
                if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
                    throw "Artifact $id/$artifactId does not contain archiveRoot $archiveRootRule."
                }
                foreach ($mapping in @($artifact.files)) {
                    Copy-ArtifactMapping -SourceRoot $sourceRoot -StagingRoot $stagingPath -Mapping $mapping -Targets $targets -Owner "$id/$artifactId"
                }
                foreach ($notice in @(Get-OptionalProperty $artifact 'notices' @())) {
                    Copy-ArtifactMapping -SourceRoot $sourceRoot -StagingRoot $stagingPath -Mapping $notice -Targets $targets -Owner "$id/$artifactId notice"
                }
            } finally {
                Remove-SafeDirectory -Path $extractRoot -AllowedRoot $WorkRoot -IgnoreErrors
            }
        }

        Get-ChildItem -LiteralPath $stagingPath -File -Recurse -Force | Unblock-File -ErrorAction SilentlyContinue
        $stagingValidation = Get-ValidationResult -Component $Component -TargetPath $stagingPath
        if (-not $stagingValidation.Ready) {
            throw "Merged staging validation failed: $($stagingValidation.Reason)"
        }
        Write-JsonEvent -Stage 'runtime' -Id $id -Status 'staged' -Progress 85 -Message 'All selected artifact files are present; publishing atomically.'

        if (Test-Path -LiteralPath $TargetPath -PathType Container) {
            Move-Item -LiteralPath $TargetPath -Destination $backupPath
            $backupCreated = $true
        }
        Move-Item -LiteralPath $stagingPath -Destination $TargetPath
        $newTargetMoved = $true
        $finalValidation = Get-ValidationResult -Component $Component -TargetPath $TargetPath
        if (-not $finalValidation.Ready) {
            throw "Published runtime failed final validation: $($finalValidation.Reason)"
        }

        if ($backupCreated) {
            try {
                Remove-SafeDirectory -Path $backupPath -AllowedRoot $targetParent
                $backupCreated = $false
            } catch {
                Write-JsonEvent -Stage 'runtime' -Id $id -Status 'backup-retained' -Progress 95 -Message "Runtime is ready, but the old backup was retained at $backupPath."
            }
        }
        Write-JsonEvent -Stage 'runtime' -Id $id -Status 'ready' -Progress 100 -Message "$($Component.displayName) $($Component.version) is installed and verified."
    } catch {
        $originalError = $_
        if ($newTargetMoved -and (Test-Path -LiteralPath $TargetPath -PathType Container)) {
            Remove-SafeDirectory -Path $TargetPath -AllowedRoot $targetParent -IgnoreErrors
        }
        if ($backupCreated -and (Test-Path -LiteralPath $backupPath -PathType Container)) {
            try {
                Move-Item -LiteralPath $backupPath -Destination $TargetPath
                $backupCreated = $false
                Write-JsonEvent -Stage 'runtime' -Id $id -Status 'rolled-back' -Progress 0 -Message 'Publish validation failed; the previous runtime was restored.'
            } catch {
                Write-JsonEvent -Stage 'runtime' -Id $id -Status 'rollback-failed' -Progress 0 -Message "Automatic rollback failed; the previous runtime remains at $backupPath."
            }
        }
        throw $originalError
    } finally {
        Remove-SafeDirectory -Path $stagingPath -AllowedRoot $targetParent -IgnoreErrors
    }
}

function Invoke-Bootstrap {
    param([Parameter(Mandatory = $true)][object]$Manifest)

    $selectedComponents = @(if ($GitOnly) {
        @($Manifest.components | Where-Object { $_.id -eq 'mingit' })
    } else {
        @($Manifest.components)
    })
    if ($selectedComponents.Count -eq 0) {
        throw 'The runtime manifest does not define Portable MinGit.'
    }

    $cacheRoot = if ($GitOnly) { Join-Path $script:ModeRoot 'cache' } else { Join-Path $script:ModeRoot '_internal\installers' }
    $workRoot = if ($GitOnly) { Join-Path $script:ModeRoot 'work' } else { Join-Path $script:ModeRoot '_internal\.launcher\work' }
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
        Write-JsonEvent -Stage 'runtime' -Id $id -Status 'checking' -Progress 0 -Message "Checking $($component.displayName) $($component.version)."
        $validation = Get-ValidationResult -Component $component -TargetPath $target
        if ($validation.Ready) {
            Write-JsonEvent -Stage 'runtime' -Id $id -Status 'ready' -Progress 100 -Message "$($component.displayName) $($component.version) passed validation."
            continue
        }
        if ($DryRun) {
            $status = if ([bool]$component.available) { 'planned' } else { 'unavailable' }
            Write-JsonEvent -Stage 'runtime' -Id $id -Status $status -Progress 0 -Message "Preflight: not ready ($($validation.Reason)); published=$([bool]$component.available)."
            if (-not [bool]$component.available -and [bool]$component.required) { $failures.Add("$id is unavailable") }
            continue
        }
        if (-not [bool]$component.available) {
            $todo = [string](Get-OptionalProperty $component 'hostingTodo' 'Runtime archive hosting is not configured.')
            Write-JsonEvent -Stage 'runtime' -Id $id -Status 'unavailable' -Progress 0 -Message "$($component.displayName) is unavailable. $todo"
            if ([bool]$component.required) { $failures.Add("$id unavailable: $todo") }
            continue
        }

        try {
            Write-JsonEvent -Stage 'runtime' -Id $id -Status 'repairing' -Progress 1 -Message "Runtime is missing or invalid ($($validation.Reason)); preparing a safe install."
            Assert-FreeSpace -Path (Split-Path -Parent $target) -RequiredBytes ([Int64]$component.install.requiredFreeBytes) -Id $id
            $wheelLock = [string](Get-OptionalProperty $component 'wheelLock' '')
            if (-not [string]::IsNullOrWhiteSpace($wheelLock)) {
                Install-PythonWheelhouseComponent -Component $component -TargetPath $target -WorkRoot $workRoot -CacheRoot $cacheRoot -ManifestPath ([IO.Path]::GetFullPath($ManifestPath))
                continue
            }
            $artifacts = @(Get-OptionalProperty $component 'artifacts' @())
            if ($artifacts.Count -gt 0) {
                $artifactArchives = @()
                foreach ($artifact in $artifacts) {
                    Write-JsonEvent -Stage 'runtime' -Id $id -Status 'checking' -Progress 5 -Message "Preparing artifact $($artifact.id)."
                    $adapter = New-ArtifactDownloadAdapter -Component $component -Artifact $artifact
                    $archivePath = Get-VerifiedArchive -Component $adapter -CacheRoot $cacheRoot
                    $artifactArchives += [pscustomobject]@{ Artifact = $artifact; Path = $archivePath }
                }
                Install-MultiArtifactComponent -Component $component -ArtifactArchives $artifactArchives -TargetPath $target -WorkRoot $workRoot
            } else {
                $archivePath = Get-VerifiedArchive -Component $component -CacheRoot $cacheRoot
                Install-ComponentArchive -Component $component -ArchivePath $archivePath -TargetPath $target
            }
        } catch {
            $message = $_.Exception.Message
            Write-JsonEvent -Stage 'runtime' -Id $id -Status 'failed' -Progress 0 -Message "$($component.displayName) failed: $message"
            $failures.Add("${id}: $message")
        }
    }
    if ($failures.Count -gt 0) {
        throw "One or more required components are not ready: $($failures -join ' | ')"
    }
}
