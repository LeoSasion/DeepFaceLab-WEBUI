$validatorSource = Join-Path $PSScriptRoot "..\host\RuntimeManifestValidator.cs"

Describe "native host runtime manifest validation" {
    BeforeAll {
        $framework = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319"
        Add-Type -Path $validatorSource -ReferencedAssemblies @(
            (Join-Path $framework "mscorlib.dll"),
            (Join-Path $framework "System.dll"),
            (Join-Path $framework "System.Core.dll"),
            (Join-Path $framework "System.Web.Extensions.dll")
        )
        $script:validatorType = @([AppDomain]::CurrentDomain.GetAssemblies() | ForEach-Object {
            $_.GetType("DeepFaceLabSN.Launcher.RuntimeManifestValidator", $false)
        } | Where-Object { $null -ne $_ })[0]
        if ($null -eq $script:validatorType) { throw "RuntimeManifestValidator type was not loaded." }
    }

    function Invoke-HostManifestValidation {
        param([string]$ProjectRoot, [string]$ManifestPath)
        $method = $script:validatorType.GetMethod("Validate", [Reflection.BindingFlags]"Public,Static")
        return $method.Invoke($null, @($ProjectRoot, $ManifestPath))
    }

    function New-HostValidationFixture {
        param([string]$PythonOutput)
        $root = Join-Path $TestDrive ("project-" + [Guid]::NewGuid().ToString("N"))
        $cuda = Join-Path $root "_internal\CUDA"
        $python = Join-Path $root "_internal\python_common"
        $git = Join-Path $root "_internal\git"
        $node = Join-Path $root "_internal\node"
        $cudnn = Join-Path $root "_internal\CUDNN"
        New-Item -ItemType Directory -Path $cuda, $python, $git, $node, $cudnn, (Join-Path $root "launcher") -Force | Out-Null
        [IO.File]::WriteAllBytes((Join-Path $cuda "cudart64_110.dll"), [byte[]](1,2,3,4))
        [IO.File]::WriteAllBytes((Join-Path $cuda "cublas64_11.dll"), [byte[]](1,2,3))
        [IO.File]::WriteAllBytes((Join-Path $git "git.exe"), [byte[]](1))
        [IO.File]::WriteAllBytes((Join-Path $node "node.exe"), [byte[]](1))
        [IO.File]::WriteAllBytes((Join-Path $cudnn "cudnn.dll"), [byte[]](1))
        Copy-Item -LiteralPath $env:ComSpec -Destination (Join-Path $python "cmd.exe")
        $manifest = @{
            schemaVersion = 2
            components = @(
                @{ id = "mingit"; displayName = "Git"; required = $true; version = "test"; install = @{ relativePath = "_internal/git" }; validation = @{ files = @(@{ path = "git.exe"; minBytes = 1 }) } },
                @{ id = "node"; displayName = "Node"; required = $true; version = "test"; install = @{ relativePath = "_internal/node" }; validation = @{ files = @(@{ path = "node.exe"; minBytes = 1 }) } },
                @{ id = "cuda"; displayName = "CUDA"; required = $true; version = "11.8"; install = @{ relativePath = "_internal/CUDA" }; validation = @{ files = @(@{ path = "cudart64_110.dll"; minBytes = 4 }, @{ path = "cublas64_11.dll"; minBytes = 8 }) } },
                @{ id = "cudnn"; displayName = "cuDNN"; required = $true; version = "test"; install = @{ relativePath = "_internal/CUDNN" }; validation = @{ files = @(@{ path = "cudnn.dll"; minBytes = 1 }) } },
                @{ id = "python"; displayName = "Python"; required = $true; version = "3.7.1"; install = @{ relativePath = "_internal/python_common" }; validation = @{ files = @(@{ path = "cmd.exe"; minBytes = 1024 }); command = @{ path = "cmd.exe"; arguments = @("/d", "/c", "echo $PythonOutput"); outputRegex = "^3\\.7\\.1$" } } }
            )
        }
        $path = Join-Path $root "launcher\runtime-manifest.json"
        [IO.File]::WriteAllText($path, ($manifest | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
        return [pscustomobject]@{ Root = $root; Manifest = $path; Cuda = $cuda }
    }

    It "rejects a partial CUDA payload even when cudart exists" {
        $fixture = New-HostValidationFixture -PythonOutput "3.7.1"
        $validation = Invoke-HostManifestValidation -ProjectRoot $fixture.Root -ManifestPath $fixture.Manifest
        $validation.Loaded | Should Be $true
        $validation.Components["cuda"].Ready | Should Be $false
        $validation.Components["cuda"].Reason | Should Match "cublas64_11.dll"
        $validation.RequiredComponentsReady | Should Be $false
    }

    It "rejects the wrong Python version even when its executable exists" {
        $fixture = New-HostValidationFixture -PythonOutput "3.12.0"
        [IO.File]::WriteAllBytes((Join-Path $fixture.Cuda "cublas64_11.dll"), [byte[]](1,2,3,4,5,6,7,8))
        $validation = Invoke-HostManifestValidation -ProjectRoot $fixture.Root -ManifestPath $fixture.Manifest
        $validation.Components["cuda"].Ready | Should Be $true
        $validation.Components["python"].Ready | Should Be $false
        $validation.Components["python"].Reason | Should Match "3.12.0"
        $validation.RequiredComponentsReady | Should Be $false
    }

    It "fails closed when a required component is absent from the manifest" {
        $fixture = New-HostValidationFixture -PythonOutput "3.7.1"
        $manifest = Get-Content -LiteralPath $fixture.Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
        $manifest.components = @($manifest.components | Where-Object { $_.id -ne "cudnn" })
        [IO.File]::WriteAllText(
            $fixture.Manifest,
            ($manifest | ConvertTo-Json -Depth 10),
            (New-Object Text.UTF8Encoding($false)))

        $validation = Invoke-HostManifestValidation -ProjectRoot $fixture.Root -ManifestPath $fixture.Manifest
        $validation.Loaded | Should Be $false
        $validation.Error | Should Match "cudnn"
        $validation.RequiredComponentsReady | Should Be $false
        $validation.Get("cudnn").Reason | Should Be $validation.Error
    }

    It "shows missing runtime files before the first install creates the target directory" {
        $fixture = New-HostValidationFixture -PythonOutput "3.7.1"
        $missingRoot = Join-Path $TestDrive "not-created-yet\.launcher-install\runtime"
        $validation = Invoke-HostManifestValidation -ProjectRoot $missingRoot -ManifestPath $fixture.Manifest

        $validation.Loaded | Should Be $true
        $validation.Get("node").DisplayName | Should Be "Node"
        $validation.Get("node").Reason | Should Match "node.exe"
        $validation.Get("node").TargetPath | Should Be (Join-Path $missingRoot "_internal\node")
        $validation.RequiredComponentsReady | Should Be $false
        $missingRoot | Should Not Exist
    }

    It "preserves the actual manifest loading error in every missing component status" {
        $fixture = New-HostValidationFixture -PythonOutput "3.7.1"
        foreach ($manifestPath in @((Join-Path $TestDrive "missing-manifest.json"), $fixture.Manifest)) {
            if ($manifestPath -eq $fixture.Manifest) {
                [IO.File]::WriteAllText($manifestPath, '{invalid json')
            }
            $validation = Invoke-HostManifestValidation -ProjectRoot $fixture.Root -ManifestPath $manifestPath
            $validation.Loaded | Should Be $false
            $validation.Get("node").Reason | Should Be $validation.Error
            $validation.Get("python").Reason | Should Be $validation.Error
            $validation.RequiredComponentsReady | Should Be $false
        }
    }
}
