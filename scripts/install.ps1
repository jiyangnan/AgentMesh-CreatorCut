# AgentMesh-CreatorCut managed installer for Windows 10 22H2 and Windows 11.
#
# Usage:
#   irm https://raw.githubusercontent.com/jiyangnan/AgentMesh-CreatorCut/main/scripts/install.ps1 | iex

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProductName = "AgentMesh-CreatorCut"
$RepoUrl = if ($env:CREATORCUT_REPO_URL) {
    $env:CREATORCUT_REPO_URL
} else {
    "https://github.com/jiyangnan/AgentMesh-CreatorCut.git"
}
$LocalAppData = if ($env:LOCALAPPDATA) {
    $env:LOCALAPPDATA
} else {
    Join-Path $HOME "AppData\Local"
}
$InstallDir = if ($env:CREATORCUT_INSTALL_DIR) {
    [IO.Path]::GetFullPath($env:CREATORCUT_INSTALL_DIR)
} else {
    Join-Path $LocalAppData "AgentMesh\CreatorCut\app"
}
$DataDir = if ($env:CREATORCUT_DATA_DIR) {
    [IO.Path]::GetFullPath($env:CREATORCUT_DATA_DIR)
} else {
    Join-Path $LocalAppData "AgentMesh\CreatorCut\data"
}
$BinDir = if ($env:CREATORCUT_BIN_DIR) {
    [IO.Path]::GetFullPath($env:CREATORCUT_BIN_DIR)
} else {
    Join-Path $LocalAppData "AgentMesh\CreatorCut\bin"
}
$CoreApiBase = if ($env:CREATORCUT_CORE_API_BASE) {
    $env:CREATORCUT_CORE_API_BASE
} else {
    "https://api.agentmesh360.com"
}
$BootstrapBaseUrl = if ($env:CREATORCUT_BOOTSTRAP_BASE_URL) {
    $env:CREATORCUT_BOOTSTRAP_BASE_URL
} else {
    "https://raw.githubusercontent.com/jiyangnan/AgentMesh-CreatorCut/main"
}
$VerifierUrl = if ($env:CREATORCUT_RELEASE_VERIFIER_URL) {
    $env:CREATORCUT_RELEASE_VERIFIER_URL
} else {
    "$BootstrapBaseUrl/scripts/verify-release.mjs"
}
$RecoveryRootsUrl = if ($env:CREATORCUT_RELEASE_RECOVERY_ROOTS_URL) {
    $env:CREATORCUT_RELEASE_RECOVERY_ROOTS_URL
} else {
    "$BootstrapBaseUrl/release/recovery-roots.json"
}
$KeysetUrl = if ($env:CREATORCUT_RELEASE_KEYSET_URL) {
    $env:CREATORCUT_RELEASE_KEYSET_URL
} else {
    "$BootstrapBaseUrl/release/release-keyset.json"
}
$DirectorApiBase = if ($env:CREATORCUT_DIRECTOR_ENDPOINT) {
    $env:CREATORCUT_DIRECTOR_ENDPOINT
} else {
    "https://api.creatorcut.agentmesh360.com"
}
$DirectorKeysetUrl = if ($env:CREATORCUT_DIRECTOR_KEYSET_URL) {
    $env:CREATORCUT_DIRECTOR_KEYSET_URL
} else {
    "$DirectorApiBase/trust/director-keyset.json"
}
$DirectorRecoveryRootsUrl = if ($env:CREATORCUT_DIRECTOR_RECOVERY_ROOTS_URL) {
    $env:CREATORCUT_DIRECTOR_RECOVERY_ROOTS_URL
} else {
    "$DirectorApiBase/trust/recovery-roots.json"
}
$DirectorKeysetSha256 = if ($env:CREATORCUT_DIRECTOR_KEYSET_SHA256) {
    $env:CREATORCUT_DIRECTOR_KEYSET_SHA256
} else {
    "45bf09de1b0a9fc8c65206002b1c32c727237999446864936057cb69a17f4aab"
}
$DirectorRecoveryRootsSha256 = if ($env:CREATORCUT_DIRECTOR_RECOVERY_ROOTS_SHA256) {
    $env:CREATORCUT_DIRECTOR_RECOVERY_ROOTS_SHA256
} else {
    "e4fe757b84d327a10a4b11cfe250b2c9796c0316dc0b7f4d3b583e01e84cb87d"
}
$ProtocolBundleDigest = "sha256:97a2d98e149a5c0e442fc90b1247322a0396545450f773e27f3fe6cd59c4d858"
$NodeVersion = "24.18.0"
$NodeSha256 = "0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821"
$GitVersion = "2.55.0.3"
$GitSha256 = "f48e2d2dc74a24454adc6d8fd0ac25bf9c2386f19cfb06202b9465aaad4f9f05"
$FfmpegVersion = "8.1.2"
$FfmpegSha256 = "db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec"
$WhisperVersion = "1.9.1"
$WhisperSha256 = "7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539"
$ModelUrl = if ($env:CREATORCUT_WHISPER_MODEL_URL) {
    $env:CREATORCUT_WHISPER_MODEL_URL
} else {
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"
}
$ModelSha256 = "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe"
$ModelPath = if ($env:CREATORCUT_WHISPER_MODEL) {
    [IO.Path]::GetFullPath($env:CREATORCUT_WHISPER_MODEL)
} else {
    Join-Path $DataDir "models\ggml-base.bin"
}
$SkipDependencies = $env:CREATORCUT_SKIP_DEPENDENCY_INSTALL -eq "1"

function Write-Info([string]$Message) {
    Write-Host "▶ $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
    Write-Host "✓ $Message" -ForegroundColor Green
}

function Fail([string]$Message) {
    throw "$ProductName installer: $Message"
}

function Assert-LastExit([string]$Description) {
    if ($LASTEXITCODE -ne 0) {
        Fail "$Description failed with exit code $LASTEXITCODE"
    }
}

function Download-File(
    [string]$Url,
    [string]$Destination
) {
    $parent = Split-Path -Parent $Destination
    if ($parent) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    if ($Url.StartsWith("file://", [StringComparison]::OrdinalIgnoreCase)) {
        $source = ([Uri]$Url).LocalPath
        Copy-Item -Force -LiteralPath $source -Destination $Destination
        return
    }
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination
}

function Assert-Sha256(
    [string]$Path,
    [string]$Expected
) {
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
    if ($actual -ne $Expected) {
        Fail "downloaded dependency checksum mismatch: $Path"
    }
}

function Download-Verified(
    [string]$Url,
    [string]$Destination,
    [string]$Expected
) {
    Download-File $Url $Destination
    Assert-Sha256 $Destination $Expected
}

function Resolve-CommandPath([string]$Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }
    return $null
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    Fail "install.ps1 supports native Windows only."
}
if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne
    [Runtime.InteropServices.Architecture]::X64) {
    Fail "Windows GA support is limited to x64."
}
$WindowsVersion = [Environment]::OSVersion.Version
if ($WindowsVersion.Major -lt 10 -or $WindowsVersion.Build -lt 19045) {
    Fail "AgentMesh-CreatorCut requires Windows 10 22H2 or Windows 11."
}

$InstallRoot = [IO.Path]::GetPathRoot($InstallDir).TrimEnd("\")
$HomeRoot = [IO.Path]::GetFullPath($HOME).TrimEnd("\")
if ([string]::IsNullOrWhiteSpace($InstallDir) -or
    $InstallDir.TrimEnd("\") -eq $InstallRoot -or
    $InstallDir.TrimEnd("\") -eq $HomeRoot) {
    Fail "unsafe CREATORCUT_INSTALL_DIR: $InstallDir"
}

$WorkDir = Join-Path ([IO.Path]::GetTempPath()) ("creatorcut-install-" + [Guid]::NewGuid())
$NextDir = "$InstallDir.next-$PID"
$BackupDir = "$InstallDir.previous-$PID"
$ManagedGitRoot = Join-Path $DataDir "runtime\mingit-v$GitVersion-win-x64"
$ManagedGitPath = Join-Path $ManagedGitRoot "cmd\git.exe"
$ManagedFfmpegRoot = Join-Path $DataDir "runtime\ffmpeg-v$FfmpegVersion-win-x64"
$ManagedFfmpegPath = Join-Path $ManagedFfmpegRoot "bin\ffmpeg.exe"
$ManagedFfprobePath = Join-Path $ManagedFfmpegRoot "bin\ffprobe.exe"
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

try {
    if (-not $SkipDependencies) {
        if (-not (Resolve-CommandPath "git.exe") -and
            -not (Test-Path -LiteralPath $ManagedGitPath)) {
            Write-Info "Installing verified portable Git for Windows $GitVersion"
            $gitArchive = Join-Path $WorkDir "mingit.zip"
            Download-Verified `
                "https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.3/MinGit-2.55.0.3-64-bit.zip" `
                $gitArchive `
                $GitSha256
            $gitUnpack = Join-Path $WorkDir "mingit-runtime"
            Expand-Archive -LiteralPath $gitArchive -DestinationPath $gitUnpack -Force
            if (-not (Test-Path -LiteralPath (Join-Path $gitUnpack "cmd\git.exe"))) {
                Fail "portable Git archive does not contain cmd\git.exe."
            }
            New-Item -ItemType Directory -Force `
                -Path (Split-Path -Parent $ManagedGitRoot) | Out-Null
            Move-Item -LiteralPath $gitUnpack -Destination $ManagedGitRoot
        }
        if (-not (Resolve-CommandPath "ffmpeg.exe") -or
            -not (Resolve-CommandPath "ffprobe.exe")) {
            if (-not (Test-Path -LiteralPath $ManagedFfmpegPath) -or
                -not (Test-Path -LiteralPath $ManagedFfprobePath)) {
                Write-Info "Installing verified portable FFmpeg $FfmpegVersion"
                $ffmpegArchive = Join-Path $WorkDir "ffmpeg.zip"
                Download-Verified `
                    "https://github.com/GyanD/codexffmpeg/releases/download/8.1.2/ffmpeg-8.1.2-essentials_build.zip" `
                    $ffmpegArchive `
                    $FfmpegSha256
                $ffmpegUnpack = Join-Path $WorkDir "ffmpeg-runtime"
                Expand-Archive -LiteralPath $ffmpegArchive `
                    -DestinationPath $ffmpegUnpack -Force
                $ffmpegCandidate = Get-ChildItem -LiteralPath $ffmpegUnpack `
                    -Recurse -Filter "ffmpeg.exe" -File |
                    Select-Object -First 1
                if (-not $ffmpegCandidate) {
                    Fail "portable FFmpeg archive does not contain ffmpeg.exe."
                }
                $ffmpegCandidateRoot = Split-Path -Parent `
                    (Split-Path -Parent $ffmpegCandidate.FullName)
                if (-not (Test-Path -LiteralPath `
                    (Join-Path $ffmpegCandidateRoot "bin\ffprobe.exe"))) {
                    Fail "portable FFmpeg archive does not contain ffprobe.exe."
                }
                New-Item -ItemType Directory -Force `
                    -Path (Split-Path -Parent $ManagedFfmpegRoot) | Out-Null
                Move-Item -LiteralPath $ffmpegCandidateRoot `
                    -Destination $ManagedFfmpegRoot
            }
        }
    }

    $GitPath = Resolve-CommandPath "git.exe"
    if (-not $GitPath) {
        $GitPath = Resolve-CommandPath "git"
    }
    if (-not $GitPath -and (Test-Path -LiteralPath $ManagedGitPath)) {
        $GitPath = $ManagedGitPath
    }
    if (-not $GitPath) {
        Fail "Git installation failed."
    }

    $FfmpegPath = Resolve-CommandPath "ffmpeg.exe"
    $FfprobePath = Resolve-CommandPath "ffprobe.exe"
    if (-not $FfmpegPath -and
        (Test-Path -LiteralPath $ManagedFfmpegPath)) {
        $FfmpegPath = $ManagedFfmpegPath
    }
    if (-not $FfprobePath -and
        (Test-Path -LiteralPath $ManagedFfprobePath)) {
        $FfprobePath = $ManagedFfprobePath
    }
    if (-not $FfmpegPath -or -not $FfprobePath) {
        Fail "FFmpeg installation failed."
    }

    $NodeRuntime = Join-Path $DataDir "runtime\node-v$NodeVersion-win-x64"
    $NodePath = Join-Path $NodeRuntime "node.exe"
    if (-not (Test-Path -LiteralPath $NodePath)) {
        if ($SkipDependencies) {
            $NodePath = Resolve-CommandPath "node.exe"
            if (-not $NodePath) {
                Fail "test dependency bypass requires Node.js."
            }
        } else {
            Write-Info "Installing verified Node.js $NodeVersion runtime"
            $nodeArchive = Join-Path $WorkDir "node.zip"
            Download-Verified `
                "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" `
                $nodeArchive `
                $NodeSha256
            $nodeUnpack = Join-Path $WorkDir "node-runtime"
            Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeUnpack -Force
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $NodeRuntime) | Out-Null
            Move-Item -LiteralPath (Join-Path $nodeUnpack "node-v$NodeVersion-win-x64") `
                -Destination $NodeRuntime
        }
    }
    $nodeVersionText = (& $NodePath --version).Trim()
    Assert-LastExit "Node.js inspection"
    if ($nodeVersionText -notmatch "^v24\.") {
        Fail "verified Node.js 24 runtime is required."
    }
    $CorepackPath = Join-Path (Split-Path -Parent $NodePath) "corepack.cmd"
    if (-not (Test-Path -LiteralPath $CorepackPath)) {
        Fail "verified Node runtime is missing Corepack."
    }

    $WhisperPath = if ($env:CREATORCUT_WHISPER) {
        [IO.Path]::GetFullPath($env:CREATORCUT_WHISPER)
    } else {
        Join-Path $DataDir "runtime\whisper.cpp-v$WhisperVersion-win-x64\whisper-cli.exe"
    }
    if (-not (Test-Path -LiteralPath $WhisperPath)) {
        if ($SkipDependencies) {
            Fail "test dependency bypass requires CREATORCUT_WHISPER."
        }
        Write-Info "Installing verified whisper.cpp $WhisperVersion"
        $whisperArchive = Join-Path $WorkDir "whisper.zip"
        Download-Verified `
            "https://github.com/ggml-org/whisper.cpp/releases/download/v$WhisperVersion/whisper-bin-x64.zip" `
            $whisperArchive `
            $WhisperSha256
        $whisperUnpack = Join-Path $WorkDir "whisper-runtime"
        Expand-Archive -LiteralPath $whisperArchive -DestinationPath $whisperUnpack -Force
        $candidate = Get-ChildItem -LiteralPath $whisperUnpack -Recurse `
            -Filter "whisper-cli.exe" -File | Select-Object -First 1
        if (-not $candidate) {
            Fail "whisper.cpp archive does not contain whisper-cli.exe."
        }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $WhisperPath) | Out-Null
        Copy-Item -LiteralPath $candidate.FullName -Destination $WhisperPath
        Get-ChildItem -LiteralPath $candidate.Directory.FullName -File |
            Where-Object { $_.Extension -eq ".dll" } |
            Copy-Item -Destination (Split-Path -Parent $WhisperPath)
    }

    if (-not (Test-Path -LiteralPath $ModelPath)) {
        if ($SkipDependencies) {
            Fail "test dependency bypass requires CREATORCUT_WHISPER_MODEL."
        }
        Write-Info "Downloading verified multilingual Whisper base model (about 148 MB)"
        $modelTemporary = "$ModelPath.next-$PID"
        Download-Verified $ModelUrl $modelTemporary $ModelSha256
        Move-Item -Force -LiteralPath $modelTemporary -Destination $ModelPath
    } elseif (-not $SkipDependencies) {
        Assert-Sha256 $ModelPath $ModelSha256
    }

    Write-Ok "Local runtime, FFmpeg, whisper.cpp, model and Windows DPAPI are ready"

    Write-Info "Fetching signed $ProductName release policy"
    $verifierPath = Join-Path $WorkDir "verify-release.mjs"
    $rootsPath = Join-Path $WorkDir "recovery-roots.json"
    $keysetPath = Join-Path $WorkDir "release-keyset.json"
    $manifestPath = Join-Path $WorkDir "release-manifest.json"
    Download-File $VerifierUrl $verifierPath
    Download-File $RecoveryRootsUrl $rootsPath
    Download-File $KeysetUrl $keysetPath
    Download-File "$CoreApiBase/v1/products/creatorcut/client-release" $manifestPath

    $verifiedText = & $NodePath $verifierPath `
        --manifest $manifestPath `
        --keyset $keysetPath `
        --recovery-roots $rootsPath
    Assert-LastExit "signed release verification"
    $verified = ($verifiedText -join "`n") | ConvertFrom-Json
    $Version = [string]$verified.version
    $GitTag = [string]$verified.git_tag
    $GitCommit = [string]$verified.git_commit
    $ArchiveSha256 = [string]$verified.artifact_sha256
    $KeysetVersion = [int]$verified.release_keyset_version
    Write-Ok "Verified signed $ProductName $Version policy"

    Write-Info "Fetching exact public release $GitTag"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $InstallDir) | Out-Null
    & $GitPath init -q $NextDir
    Assert-LastExit "git init"
    & $GitPath -C $NextDir remote add origin $RepoUrl
    Assert-LastExit "git remote"
    & $GitPath -C $NextDir fetch -q --depth 1 origin "refs/tags/${GitTag}:refs/tags/${GitTag}"
    Assert-LastExit "git fetch"
    $ResolvedCommit = (& $GitPath -C $NextDir rev-parse "${GitTag}^{commit}").Trim()
    Assert-LastExit "release tag resolution"
    if ($ResolvedCommit -ne $GitCommit) {
        Fail "release tag does not resolve to the signed commit."
    }
    $archivePath = Join-Path $WorkDir "canonical-release.tar"
    & $GitPath -C $NextDir -c tar.umask=002 -c core.attributesFile=NUL `
        archive --format=tar -o $archivePath $GitCommit
    Assert-LastExit "canonical release archive"
    Assert-Sha256 $archivePath $ArchiveSha256
    & $GitPath -C $NextDir checkout -q --detach $GitCommit
    Assert-LastExit "release checkout"
    Write-Ok "Verified tag, commit and canonical source archive"

    Write-Info "Installing $ProductName packages"
    Push-Location $NextDir
    try {
        & $CorepackPath "pnpm@10.30.3" install --frozen-lockfile
        Assert-LastExit "package installation"
        & $CorepackPath "pnpm@10.30.3" --filter "!agentmesh-creatorcut" `
            -r --if-present build
        Assert-LastExit "package build"
    } finally {
        Pop-Location
    }

    $releaseDir = Join-Path $NextDir "release"
    New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
    Copy-Item -LiteralPath $rootsPath -Destination (Join-Path $releaseDir "recovery-roots.json")
    Copy-Item -LiteralPath $keysetPath -Destination (Join-Path $releaseDir "release-keyset.json")
    Download-Verified `
        $DirectorKeysetUrl `
        (Join-Path $releaseDir "director-keyset.json") `
        $DirectorKeysetSha256
    Download-Verified `
        $DirectorRecoveryRootsUrl `
        (Join-Path $releaseDir "director-recovery-roots.json") `
        $DirectorRecoveryRootsSha256
    Write-Ok "Pinned the production Director endpoint, protocol and public trust roots"

    $metadata = [ordered]@{
        schema_version = "creatorcut-managed-install/1.0"
        managed = $true
        install_type = "official-installer"
        repository = $RepoUrl
        install_dir = $InstallDir
        version = $Version
        git_tag = $GitTag
        git_commit = $GitCommit
        artifact_sha256 = $ArchiveSha256
        release_keyset_version = $KeysetVersion
        installed_at = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
        platform = "win32"
        tools = [ordered]@{
            node = $NodePath
            ffmpeg = $FfmpegPath
            ffprobe = $FfprobePath
            whisper = $WhisperPath
            whisper_model = $ModelPath
        }
    }
    $metadataPath = Join-Path $NextDir ".creatorcut-install.json"
    [IO.File]::WriteAllText(
        $metadataPath,
        (($metadata | ConvertTo-Json -Depth 5) + "`n"),
        [Text.UTF8Encoding]::new($false)
    )

    if (Test-Path -LiteralPath $InstallDir) {
        Move-Item -LiteralPath $InstallDir -Destination $BackupDir
    }
    try {
        Move-Item -LiteralPath $NextDir -Destination $InstallDir
    } catch {
        if (Test-Path -LiteralPath $BackupDir) {
            Move-Item -LiteralPath $BackupDir -Destination $InstallDir
        }
        throw
    }

    try {
        Write-Info "Rebinding Windows workspace links at the final install path"
        Push-Location $InstallDir
        try {
            & $CorepackPath "pnpm@10.30.3" install `
                --frozen-lockfile --offline --force
            Assert-LastExit "final workspace link installation"
        } finally {
            Pop-Location
        }

        New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
        $shim = Join-Path $BinDir "creatorcut.cmd"
        $shimLines = @(
            "@echo off",
            "set `"CREATORCUT_INSTALL_DIR=$InstallDir`"",
            "set `"CREATORCUT_INSTALL_METADATA=$InstallDir\.creatorcut-install.json`"",
            "set `"CREATORCUT_RELEASE_KEYSET=$InstallDir\release\release-keyset.json`"",
            "set `"CREATORCUT_RELEASE_RECOVERY_ROOTS=$InstallDir\release\recovery-roots.json`"",
            "set `"CREATORCUT_DIRECTOR_ENDPOINT=$DirectorApiBase`"",
            "set `"CREATORCUT_DIRECTOR_KEYSET=$InstallDir\release\director-keyset.json`"",
            "set `"CREATORCUT_DIRECTOR_RECOVERY_ROOTS=$InstallDir\release\director-recovery-roots.json`"",
            "set `"CREATORCUT_MINIMUM_KEYSET_VERSION=1`"",
            "set `"CREATORCUT_PROTOCOL_BUNDLE_DIGEST=$ProtocolBundleDigest`"",
            "set `"CREATORCUT_WHISPER=$WhisperPath`"",
            "set `"CREATORCUT_WHISPER_MODEL=$ModelPath`"",
            "set `"CREATORCUT_FFMPEG=$FfmpegPath`"",
            "set `"CREATORCUT_FFPROBE=$FfprobePath`"",
            "`"$NodePath`" `"$InstallDir\apps\cli\dist\src\main.js`" %*"
        )
        [IO.File]::WriteAllLines($shim, $shimLines, [Text.Encoding]::ASCII)

        $versionSmoke = & $shim version | ConvertFrom-Json
        Assert-LastExit "$ProductName version smoke"
        if (-not $versionSmoke.ok -or $versionSmoke.data.version -ne $Version) {
            Fail "$ProductName smoke returned the wrong version."
        }
        $doctorSmoke = & $shim doctor | ConvertFrom-Json
        Assert-LastExit "$ProductName doctor smoke"
        if (-not $doctorSmoke.ok -or
            $doctorSmoke.data.credential_storage -ne "Windows DPAPI") {
            Fail "$ProductName doctor did not confirm Windows DPAPI."
        }
    } catch {
        Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $BackupDir) {
            Move-Item -LiteralPath $BackupDir -Destination $InstallDir
        }
        throw
    }
    if (Test-Path -LiteralPath $BackupDir) {
        Remove-Item -LiteralPath $BackupDir -Recurse -Force
    }

    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $entries = @($userPath -split ";" | Where-Object { $_ })
    if ($entries -notcontains $BinDir) {
        [Environment]::SetEnvironmentVariable(
            "Path",
            (@($BinDir) + $entries -join ";"),
            "User"
        )
        Write-Info "Added $BinDir to the user PATH; open a new PowerShell window."
    }

    Write-Ok "$ProductName $Version installed at $InstallDir"
    Write-Host ""
    Write-Info "Starting Agent-native onboarding"
    try {
        & $shim onboard
        Assert-LastExit "$ProductName onboarding"
    } catch {
        Write-Info "This installed release predates guided onboarding."
        Write-Host "Next: creatorcut doctor; creatorcut auth login"
    }
} finally {
    Remove-Item -LiteralPath $WorkDir -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $NextDir -Recurse -Force -ErrorAction SilentlyContinue
}
