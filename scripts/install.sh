#!/usr/bin/env bash
#
# AgentMesh-CreatorCut managed installer for macOS and Ubuntu.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/jiyangnan/AgentMesh-CreatorCut/main/scripts/install.sh | bash
#
set -euo pipefail

PRODUCT_NAME="AgentMesh-CreatorCut"
REPO_URL="${CREATORCUT_REPO_URL:-https://github.com/jiyangnan/AgentMesh-CreatorCut.git}"
INSTALL_DIR="${CREATORCUT_INSTALL_DIR:-$HOME/.local/share/creatorcut}"
DATA_DIR="${CREATORCUT_DATA_DIR:-$HOME/.local/share/creatorcut-data}"
BIN_DIR="${CREATORCUT_BIN_DIR:-$HOME/.local/bin}"
CORE_API_BASE="${CREATORCUT_CORE_API_BASE:-https://api.agentmesh360.com}"
BOOTSTRAP_BASE_URL="${CREATORCUT_BOOTSTRAP_BASE_URL:-https://raw.githubusercontent.com/jiyangnan/AgentMesh-CreatorCut/main}"
VERIFIER_URL="${CREATORCUT_RELEASE_VERIFIER_URL:-$BOOTSTRAP_BASE_URL/scripts/verify-release.mjs}"
RECOVERY_ROOTS_URL="${CREATORCUT_RELEASE_RECOVERY_ROOTS_URL:-$BOOTSTRAP_BASE_URL/release/recovery-roots.json}"
KEYSET_URL="${CREATORCUT_RELEASE_KEYSET_URL:-$BOOTSTRAP_BASE_URL/release/release-keyset.json}"
NODE_VERSION="24.18.0"
WHISPER_VERSION="1.9.1"
MODEL_URL="${CREATORCUT_WHISPER_MODEL_URL:-https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin}"
MODEL_SHA256="60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe"
MODEL_PATH="${CREATORCUT_WHISPER_MODEL:-$DATA_DIR/models/ggml-base.bin}"
WHISPER_PATH="${CREATORCUT_WHISPER:-}"
SKIP_DEPENDENCIES="${CREATORCUT_SKIP_DEPENDENCY_INSTALL:-0}"

err() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[34m▶\033[0m %s\n' "$*"; }
ok() { printf '\033[32m✓\033[0m %s\n' "$*"; }

case "$INSTALL_DIR" in
  ""|"/"|"$HOME") err "Unsafe CREATORCUT_INSTALL_DIR: $INSTALL_DIR" ;;
esac
case "$DATA_DIR" in
  ""|"/"|"$HOME") err "Unsafe CREATORCUT_DATA_DIR: $DATA_DIR" ;;
esac

command -v curl >/dev/null || err "curl is required to start the installer."
command -v tar >/dev/null || err "tar is required to start the installer."

sha256_file() {
  if command -v shasum >/dev/null; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null; then
    sha256sum "$1" | awk '{print $1}'
  else
    err "A SHA-256 tool (shasum or sha256sum) is required."
  fi
}

download() {
  local url="$1"
  local output="$2"
  curl -fsSL --retry 3 --retry-all-errors --connect-timeout 15 \
    --proto '=https,file,http' "$url" -o "$output"
}

download_verified() {
  local url="$1"
  local output="$2"
  local expected="$3"
  download "$url" "$output"
  local actual
  actual="$(sha256_file "$output")"
  [ "$actual" = "$expected" ] || err "Downloaded dependency checksum mismatch: $url"
}

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS/$ARCH" in
  Darwin/arm64) PLATFORM="darwin"; NODE_TARGET="darwin-arm64"; NODE_SHA256="e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1" ;;
  Darwin/x86_64) PLATFORM="darwin"; NODE_TARGET="darwin-x64"; NODE_SHA256="dfd0dbd3e721503434df7b7205e719f61b3a3a31b2bcf9729b8b91fea240f080" ;;
  Linux/x86_64) PLATFORM="linux"; NODE_TARGET="linux-x64"; NODE_SHA256="783130984963db7ba9cbd01089eaf2c2efb055c7c1693c943174b967b3050cb8"; WHISPER_TARGET="ubuntu-x64"; WHISPER_SHA256="f3bf3b4369a99b54665b0f19b88483b30de27f25963b0414235dea03198515c5" ;;
  Linux/aarch64|Linux/arm64) PLATFORM="linux"; NODE_TARGET="linux-arm64"; NODE_SHA256="6b4484c2190274175df9aa8f28e2d758a819cb1c1fe6ab481e2f95b463ab8508"; WHISPER_TARGET="ubuntu-arm64"; WHISPER_SHA256="e0b66cd551ff6f2a28fabe3c6e89691eea037bb76833493abb9a71ca788994b3" ;;
  *) err "$PRODUCT_NAME does not support $OS/$ARCH. See docs/SUPPORTED-PLATFORMS.md." ;;
esac

if [ "$PLATFORM" = "darwin" ]; then
  MACOS_MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
  [ "$MACOS_MAJOR" -ge 14 ] ||
    err "$PRODUCT_NAME requires macOS 14 or newer."
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/creatorcut-install.XXXXXX")"
NEXT_DIR="${INSTALL_DIR}.next-$$"
BACKUP_DIR="${INSTALL_DIR}.previous-$$"
cleanup() {
  rm -rf "$WORK_DIR" "$NEXT_DIR"
}
trap cleanup EXIT

ensure_homebrew() {
  if command -v brew >/dev/null; then
    return
  fi
  info "Installing Homebrew so local media dependencies can be managed"
  NONINTERACTIVE=1 /bin/bash -c \
    "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [ -x /usr/local/bin/brew ]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
  command -v brew >/dev/null || err "Homebrew installation did not complete."
}

install_macos_dependencies() {
  ensure_homebrew
  local packages=()
  command -v git >/dev/null || packages+=("git")
  if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
    packages+=("ffmpeg")
  fi
  command -v whisper-cli >/dev/null || packages+=("whisper-cpp")
  if [ "${#packages[@]}" -gt 0 ]; then
    info "Installing local media dependencies with Homebrew"
    brew install "${packages[@]}"
  fi
}

install_ubuntu_dependencies() {
  [ -r /etc/os-release ] || err "Linux support requires Ubuntu 22.04 or 24.04."
  # shellcheck disable=SC1091
  . /etc/os-release
  [ "${ID:-}" = "ubuntu" ] || err "Linux GA support is limited to Ubuntu 22.04 and 24.04."
  case "${VERSION_ID:-}" in
    22.04|24.04) ;;
    *) err "Ubuntu ${VERSION_ID:-unknown} is not in the GA support matrix." ;;
  esac
  local sudo_command=()
  if [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null || err "sudo is required to install Ubuntu dependencies."
    sudo_command=("sudo")
  fi
  info "Installing Git, FFmpeg and Secret Service support"
  "${sudo_command[@]}" apt-get update -qq
  if [ "${#sudo_command[@]}" -eq 0 ]; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
      ca-certificates git ffmpeg libsecret-tools
  else
    sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
      ca-certificates git ffmpeg libsecret-tools
  fi
}

install_node_runtime() {
  local runtime_root="$DATA_DIR/runtime"
  local runtime_dir="$runtime_root/node-v$NODE_VERSION-$NODE_TARGET"
  local runtime_node="$runtime_dir/bin/node"
  if [ -x "$runtime_node" ]; then
    NODE_PATH="$runtime_node"
    return
  fi
  info "Installing verified Node.js $NODE_VERSION runtime"
  mkdir -p "$runtime_root"
  local archive="$WORK_DIR/node.tar.gz"
  download_verified \
    "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$NODE_TARGET.tar.gz" \
    "$archive" \
    "$NODE_SHA256"
  local unpacked="$WORK_DIR/node-runtime"
  mkdir -p "$unpacked"
  tar -xzf "$archive" -C "$unpacked"
  rm -rf "$runtime_dir"
  mv "$unpacked/node-v$NODE_VERSION-$NODE_TARGET" "$runtime_dir"
  NODE_PATH="$runtime_node"
}

install_linux_whisper() {
  if [ -n "$WHISPER_PATH" ]; then
    return
  fi
  if command -v whisper-cli >/dev/null; then
    WHISPER_PATH="$(command -v whisper-cli)"
    return
  fi
  local runtime_dir="$DATA_DIR/runtime/whisper.cpp-v$WHISPER_VERSION-$WHISPER_TARGET"
  local candidate="$runtime_dir/whisper-cli"
  if [ ! -x "$candidate" ]; then
    info "Installing verified whisper.cpp $WHISPER_VERSION"
    local archive="$WORK_DIR/whisper.tar.gz"
    download_verified \
      "https://github.com/ggml-org/whisper.cpp/releases/download/v$WHISPER_VERSION/whisper-bin-$WHISPER_TARGET.tar.gz" \
      "$archive" \
      "$WHISPER_SHA256"
    local unpacked="$WORK_DIR/whisper-runtime"
    mkdir -p "$unpacked" "$runtime_dir"
    tar -xzf "$archive" -C "$unpacked"
    candidate="$(find "$unpacked" -type f -name whisper-cli -perm -u+x -print -quit)"
    [ -n "$candidate" ] || err "whisper.cpp archive does not contain whisper-cli."
    cp "$candidate" "$runtime_dir/whisper-cli"
    chmod 755 "$runtime_dir/whisper-cli"
    candidate="$runtime_dir/whisper-cli"
  fi
  WHISPER_PATH="$candidate"
}

install_model() {
  if [ -f "$MODEL_PATH" ]; then
    [ "$(sha256_file "$MODEL_PATH")" = "$MODEL_SHA256" ] ||
      err "Existing Whisper model checksum is invalid: $MODEL_PATH"
    return
  fi
  info "Downloading verified multilingual Whisper base model (about 148 MB)"
  mkdir -p "$(dirname "$MODEL_PATH")"
  local temporary="$MODEL_PATH.next-$$"
  download_verified "$MODEL_URL" "$temporary" "$MODEL_SHA256"
  chmod 600 "$temporary"
  mv "$temporary" "$MODEL_PATH"
}

if [ "$SKIP_DEPENDENCIES" = "1" ]; then
  command -v node >/dev/null || err "Test dependency bypass requires Node.js."
  NODE_PATH="$(node -p 'process.execPath')"
else
  if [ "$PLATFORM" = "darwin" ]; then
    install_macos_dependencies
  else
    install_ubuntu_dependencies
  fi
  install_node_runtime
  [ "$PLATFORM" = "darwin" ] || install_linux_whisper
  install_model
fi

command -v git >/dev/null || err "Git installation failed."
command -v ffmpeg >/dev/null || err "FFmpeg installation failed."
command -v ffprobe >/dev/null || err "FFprobe installation failed."
[ -x "$NODE_PATH" ] || err "CreatorCut Node runtime is unavailable: $NODE_PATH"
[ "$("$NODE_PATH" -p 'process.versions.node.split(".")[0]')" = "24" ] ||
  err "CreatorCut requires its verified Node.js 24 runtime."

if [ -z "$WHISPER_PATH" ]; then
  WHISPER_PATH="$(command -v whisper-cli || true)"
fi
[ -x "$WHISPER_PATH" ] || err "whisper.cpp installation failed."
[ -f "$MODEL_PATH" ] || err "Whisper model installation failed."
NODE_BIN_DIR="$(dirname "$NODE_PATH")"
COREPACK_PATH="$NODE_BIN_DIR/corepack"
[ -x "$COREPACK_PATH" ] || err "Verified Node runtime is missing Corepack."
ok "Local runtime, FFmpeg, whisper.cpp, model and credential backend are ready"

info "Fetching signed $PRODUCT_NAME release policy"
download "$VERIFIER_URL" "$WORK_DIR/verify-release.mjs"
download "$RECOVERY_ROOTS_URL" "$WORK_DIR/recovery-roots.json"
download "$KEYSET_URL" "$WORK_DIR/release-keyset.json"
curl -fsSL --retry 3 --retry-all-errors --connect-timeout 15 \
  --proto '=https,http' \
  "$CORE_API_BASE/v1/products/creatorcut/client-release" \
  -o "$WORK_DIR/release-manifest.json"

"$NODE_PATH" "$WORK_DIR/verify-release.mjs" \
  --manifest "$WORK_DIR/release-manifest.json" \
  --keyset "$WORK_DIR/release-keyset.json" \
  --recovery-roots "$WORK_DIR/recovery-roots.json" \
  > "$WORK_DIR/verified-release.json"

VERSION="$("$NODE_PATH" -p "JSON.parse(require('fs').readFileSync(process.argv[1])).version" "$WORK_DIR/verified-release.json")"
GIT_TAG="$("$NODE_PATH" -p "JSON.parse(require('fs').readFileSync(process.argv[1])).git_tag" "$WORK_DIR/verified-release.json")"
GIT_COMMIT="$("$NODE_PATH" -p "JSON.parse(require('fs').readFileSync(process.argv[1])).git_commit" "$WORK_DIR/verified-release.json")"
ARCHIVE_SHA256="$("$NODE_PATH" -p "JSON.parse(require('fs').readFileSync(process.argv[1])).artifact_sha256" "$WORK_DIR/verified-release.json")"
KEYSET_VERSION="$("$NODE_PATH" -p "JSON.parse(require('fs').readFileSync(process.argv[1])).release_keyset_version" "$WORK_DIR/verified-release.json")"
ok "Verified signed $PRODUCT_NAME $VERSION policy"

info "Fetching exact public release $GIT_TAG"
mkdir -p "$(dirname "$INSTALL_DIR")"
git init -q "$NEXT_DIR"
git -C "$NEXT_DIR" remote add origin "$REPO_URL"
git -C "$NEXT_DIR" fetch -q --depth 1 origin "refs/tags/$GIT_TAG:refs/tags/$GIT_TAG"
RESOLVED_COMMIT="$(git -C "$NEXT_DIR" rev-parse "$GIT_TAG^{commit}")"
[ "$RESOLVED_COMMIT" = "$GIT_COMMIT" ] || err "Release tag does not resolve to the signed commit."

COMPUTED_SHA256="$(
  GIT_CONFIG_NOSYSTEM=1 GIT_ATTR_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 \
    git -C "$NEXT_DIR" \
      -c tar.umask=002 \
      -c core.attributesFile=/dev/null \
      archive --format=tar "$GIT_COMMIT" |
    if command -v shasum >/dev/null; then shasum -a 256; else sha256sum; fi |
    awk '{print $1}'
)"
[ "$COMPUTED_SHA256" = "$ARCHIVE_SHA256" ] || err "Release archive hash does not match the signed policy."
git -C "$NEXT_DIR" checkout -q --detach "$GIT_COMMIT"
ok "Verified tag, commit and canonical source archive"

info "Installing $PRODUCT_NAME packages"
(
  cd "$NEXT_DIR"
  "$COREPACK_PATH" pnpm@10.30.3 install --frozen-lockfile
  "$COREPACK_PATH" pnpm@10.30.3 --filter '!agentmesh-creatorcut' -r --if-present build
)

mkdir -p "$NEXT_DIR/release"
cp "$WORK_DIR/recovery-roots.json" "$NEXT_DIR/release/recovery-roots.json"
cp "$WORK_DIR/release-keyset.json" "$NEXT_DIR/release/release-keyset.json"

INSTALLED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
CREATORCUT_META_REPOSITORY="$REPO_URL" \
CREATORCUT_META_INSTALL_DIR="$INSTALL_DIR" \
CREATORCUT_META_VERSION="$VERSION" \
CREATORCUT_META_GIT_TAG="$GIT_TAG" \
CREATORCUT_META_GIT_COMMIT="$GIT_COMMIT" \
CREATORCUT_META_ARCHIVE_SHA256="$ARCHIVE_SHA256" \
CREATORCUT_META_KEYSET_VERSION="$KEYSET_VERSION" \
CREATORCUT_META_INSTALLED_AT="$INSTALLED_AT" \
CREATORCUT_META_PLATFORM="$PLATFORM" \
CREATORCUT_META_NODE="$NODE_PATH" \
CREATORCUT_META_FFMPEG="$(command -v ffmpeg)" \
CREATORCUT_META_FFPROBE="$(command -v ffprobe)" \
CREATORCUT_META_WHISPER="$WHISPER_PATH" \
CREATORCUT_META_WHISPER_MODEL="$MODEL_PATH" \
"$NODE_PATH" - "$NEXT_DIR/.creatorcut-install.json" <<'EOF'
const fs = require("fs");
const path = process.argv[2];
fs.writeFileSync(path, JSON.stringify({
  schema_version: "creatorcut-managed-install/1.0",
  managed: true,
  install_type: "official-installer",
  repository: process.env.CREATORCUT_META_REPOSITORY,
  install_dir: process.env.CREATORCUT_META_INSTALL_DIR,
  version: process.env.CREATORCUT_META_VERSION,
  git_tag: process.env.CREATORCUT_META_GIT_TAG,
  git_commit: process.env.CREATORCUT_META_GIT_COMMIT,
  artifact_sha256: process.env.CREATORCUT_META_ARCHIVE_SHA256,
  release_keyset_version: Number(process.env.CREATORCUT_META_KEYSET_VERSION),
  installed_at: process.env.CREATORCUT_META_INSTALLED_AT,
  platform: process.env.CREATORCUT_META_PLATFORM,
  tools: {
    node: process.env.CREATORCUT_META_NODE,
    ffmpeg: process.env.CREATORCUT_META_FFMPEG,
    ffprobe: process.env.CREATORCUT_META_FFPROBE,
    whisper: process.env.CREATORCUT_META_WHISPER,
    whisper_model: process.env.CREATORCUT_META_WHISPER_MODEL
  }
}, null, 2) + "\n", { mode: 0o600 });
EOF

if [ -e "$INSTALL_DIR" ]; then
  mv "$INSTALL_DIR" "$BACKUP_DIR"
fi
if ! mv "$NEXT_DIR" "$INSTALL_DIR"; then
  [ ! -e "$BACKUP_DIR" ] || mv "$BACKUP_DIR" "$INSTALL_DIR"
  err "Failed to activate the verified $PRODUCT_NAME install."
fi

mkdir -p "$BIN_DIR"
SHIM="$BIN_DIR/creatorcut"
{
  printf '%s\n' '#!/usr/bin/env bash'
  printf 'export CREATORCUT_INSTALL_DIR=%q\n' "$INSTALL_DIR"
  printf 'export CREATORCUT_INSTALL_METADATA=%q\n' "$INSTALL_DIR/.creatorcut-install.json"
  printf 'export CREATORCUT_RELEASE_KEYSET=%q\n' "$INSTALL_DIR/release/release-keyset.json"
  printf 'export CREATORCUT_RELEASE_RECOVERY_ROOTS=%q\n' "$INSTALL_DIR/release/recovery-roots.json"
  printf 'export CREATORCUT_WHISPER=%q\n' "$WHISPER_PATH"
  printf 'export CREATORCUT_WHISPER_MODEL=%q\n' "$MODEL_PATH"
  printf 'export CREATORCUT_FFMPEG=%q\n' "$(command -v ffmpeg)"
  printf 'export CREATORCUT_FFPROBE=%q\n' "$(command -v ffprobe)"
  if [ -n "${CREATORCUT_KEYCHAIN_PATH:-}" ]; then
    printf 'export CREATORCUT_KEYCHAIN_PATH=%q\n' "$CREATORCUT_KEYCHAIN_PATH"
  fi
  printf 'export PATH=%q:"$PATH"\n' "$NODE_BIN_DIR"
  printf 'exec %q %q "$@"\n' "$NODE_PATH" "$INSTALL_DIR/apps/cli/dist/src/main.js"
} > "$SHIM"
chmod 755 "$SHIM"

if ! "$SHIM" version > "$WORK_DIR/version-smoke.json"; then
  rm -rf "$INSTALL_DIR"
  [ ! -e "$BACKUP_DIR" ] || mv "$BACKUP_DIR" "$INSTALL_DIR"
  err "$PRODUCT_NAME smoke check failed; the previous install was restored."
fi
if ! "$NODE_PATH" -e '
const fs = require("fs");
const response = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (response.ok !== true || response.data?.version !== process.argv[2]) {
  process.exit(1);
}
' "$WORK_DIR/version-smoke.json" "$VERSION"; then
  rm -rf "$INSTALL_DIR"
  [ ! -e "$BACKUP_DIR" ] || mv "$BACKUP_DIR" "$INSTALL_DIR"
  err "$PRODUCT_NAME smoke check returned the wrong version; the previous install was restored."
fi
rm -rf "$BACKUP_DIR"

"$SHIM" doctor > "$WORK_DIR/doctor-smoke.json"
ok "$PRODUCT_NAME $VERSION installed at $INSTALL_DIR"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    info "Add $BIN_DIR to PATH:"
    printf "    echo 'export PATH=\"%s:\\$PATH\"' >> ~/.zshrc\n" "$BIN_DIR"
    printf "    echo 'export PATH=\"%s:\\$PATH\"' >> ~/.bashrc\n" "$BIN_DIR"
    ;;
esac
printf '\nNext: creatorcut auth login\n'
