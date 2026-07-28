# AgentMesh-CreatorCut supported platforms

The public managed-install channel supports these native desktop environments:

| Platform                     | Architectures        | Secure API-key storage               | Installer             |
| ---------------------------- | -------------------- | ------------------------------------ | --------------------- |
| macOS 14 or newer            | Apple Silicon, Intel | macOS Keychain                       | `scripts/install.sh`  |
| Ubuntu 22.04 / 24.04         | x64, arm64           | Secret Service through `secret-tool` | `scripts/install.sh`  |
| Windows 10 22H2 / Windows 11 | x64                  | current-user Windows DPAPI           | `scripts/install.ps1` |

WSL, other Linux distributions, and Windows ARM64 are not GA product surfaces.
The source may compile elsewhere, but that does not create a support
commitment. Installers fail explicitly on unsupported operating systems or
architectures.

## Managed local dependencies

The installer owns the supported runtime combination:

- verified Node.js 24 LTS binaries under the CreatorCut data root;
- pnpm 10 through the pinned Corepack invocation;
- Git for the signed tag, commit, and canonical archive verification;
- FFmpeg and FFprobe;
- whisper.cpp `v1.9.1`;
- the multilingual Whisper base model, verified against its published
  SHA-256;
- the platform credential backend listed above.

macOS uses Homebrew for Git, FFmpeg, and whisper.cpp when they are missing.
Ubuntu uses `apt` for Git, FFmpeg, and Secret Service and downloads the pinned
official whisper.cpp binary. Windows installs SHA-256-verified portable Git,
FFmpeg, Node, and whisper.cpp archives under the CreatorCut data root, so it
does not require `winget` or administrator access. Users do not need to select
versions or discover paths.

Project media and `.creatorcut` state are not stored inside the managed
application directory. Reinstall, update, and rollback therefore leave source
recordings, timelines, transcripts, previews, exports, and saved AgentMesh API
keys untouched.
