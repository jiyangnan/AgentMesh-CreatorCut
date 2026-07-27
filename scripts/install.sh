#!/usr/bin/env bash
#
# Official macOS CreatorCut managed installer.
# A bootstrap fetched over the official GitHub HTTPS origin verifies the
# recovery-root-signed release keyset and Core ReleaseManifest before it checks
# out or executes release code.
#
set -euo pipefail

REPO_URL="${CREATORCUT_REPO_URL:-https://github.com/jiyangnan/AgentMesh-CreatorCut.git}"
INSTALL_DIR="${CREATORCUT_INSTALL_DIR:-$HOME/.local/share/creatorcut}"
BIN_DIR="${CREATORCUT_BIN_DIR:-$HOME/.local/bin}"
CORE_API_BASE="${CREATORCUT_CORE_API_BASE:-https://api.agentmesh360.com}"
BOOTSTRAP_BASE_URL="${CREATORCUT_BOOTSTRAP_BASE_URL:-https://raw.githubusercontent.com/jiyangnan/AgentMesh-CreatorCut/main}"
VERIFIER_URL="${CREATORCUT_RELEASE_VERIFIER_URL:-$BOOTSTRAP_BASE_URL/scripts/verify-release.mjs}"
RECOVERY_ROOTS_URL="${CREATORCUT_RELEASE_RECOVERY_ROOTS_URL:-$BOOTSTRAP_BASE_URL/release/recovery-roots.json}"
KEYSET_URL="${CREATORCUT_RELEASE_KEYSET_URL:-$BOOTSTRAP_BASE_URL/release/release-keyset.json}"
WHISPER_PATH="${CREATORCUT_WHISPER:-}"
MODEL_PATH="${CREATORCUT_WHISPER_MODEL:-$HOME/.local/share/creatorcut-data/models/ggml-base.bin}"

err() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[34m▶\033[0m %s\n' "$*"; }
ok() { printf '\033[32m✓\033[0m %s\n' "$*"; }

[ "$(uname -s)" = "Darwin" ] || err "CreatorCut M1 installer supports macOS only."
command -v curl >/dev/null || err "curl is required. Install the macOS command line tools."
command -v git >/dev/null || err "git is required. Run: xcode-select --install"
command -v node >/dev/null || err "Node.js 24 is required. Install it with: brew install node@24"
command -v corepack >/dev/null || err "Corepack is required. Reinstall Node.js 24 with: brew install node@24"
command -v ffmpeg >/dev/null || err "FFmpeg is required. Install it with: brew install ffmpeg"
command -v ffprobe >/dev/null || err "FFprobe is required. Install it with: brew install ffmpeg"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" = "24" ] || err "CreatorCut M1 requires Node.js 24; current Node is $(node --version)."

if [ -z "$WHISPER_PATH" ]; then
  if command -v whisper-cli >/dev/null; then
    WHISPER_PATH="$(command -v whisper-cli)"
  else
    err "whisper.cpp is required. Install it with: brew install whisper-cpp; then set CREATORCUT_WHISPER=\$(command -v whisper-cli)"
  fi
fi
[ -x "$WHISPER_PATH" ] || err "CREATORCUT_WHISPER is not executable: $WHISPER_PATH"
[ -f "$MODEL_PATH" ] || err "Whisper model is missing at $MODEL_PATH. Download an audited whisper.cpp model there or set CREATORCUT_WHISPER_MODEL to an existing model file."

ok "Node $(node --version), FFmpeg, FFprobe, whisper.cpp and model are present"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/creatorcut-install.XXXXXX")"
NEXT_DIR="${INSTALL_DIR}.next-$$"
BACKUP_DIR="${INSTALL_DIR}.previous-$$"
cleanup() {
  rm -rf "$WORK_DIR" "$NEXT_DIR"
}
trap cleanup EXIT

info "Fetching signed CreatorCut release policy"
curl -fsSL --proto '=https,file,http' "$VERIFIER_URL" -o "$WORK_DIR/verify-release.mjs"
curl -fsSL --proto '=https,file,http' "$RECOVERY_ROOTS_URL" -o "$WORK_DIR/recovery-roots.json"
curl -fsSL --proto '=https,file,http' "$KEYSET_URL" -o "$WORK_DIR/release-keyset.json"
curl -fsSL --proto '=https,http' \
  "$CORE_API_BASE/v1/products/creatorcut/client-release" \
  -o "$WORK_DIR/release-manifest.json"

node "$WORK_DIR/verify-release.mjs" \
  --manifest "$WORK_DIR/release-manifest.json" \
  --keyset "$WORK_DIR/release-keyset.json" \
  --recovery-roots "$WORK_DIR/recovery-roots.json" \
  > "$WORK_DIR/verified-release.json"

VERSION="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1])).version" "$WORK_DIR/verified-release.json")"
GIT_TAG="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1])).git_tag" "$WORK_DIR/verified-release.json")"
GIT_COMMIT="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1])).git_commit" "$WORK_DIR/verified-release.json")"
ARCHIVE_SHA256="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1])).artifact_sha256" "$WORK_DIR/verified-release.json")"
KEYSET_VERSION="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1])).release_keyset_version" "$WORK_DIR/verified-release.json")"
ok "Verified signed CreatorCut $VERSION policy"

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
    shasum -a 256 |
    awk '{print $1}'
)"
[ "$COMPUTED_SHA256" = "$ARCHIVE_SHA256" ] || err "Release archive hash does not match the signed policy."
git -C "$NEXT_DIR" checkout -q --detach "$GIT_COMMIT"
ok "Verified tag, commit and canonical source archive"

info "Installing CreatorCut dependencies"
corepack pnpm@10.30.3 --dir "$NEXT_DIR" install --frozen-lockfile
corepack pnpm@10.30.3 --dir "$NEXT_DIR" build

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
CREATORCUT_META_FFMPEG="$(command -v ffmpeg)" \
CREATORCUT_META_FFPROBE="$(command -v ffprobe)" \
CREATORCUT_META_WHISPER="$WHISPER_PATH" \
CREATORCUT_META_WHISPER_MODEL="$MODEL_PATH" \
node - "$NEXT_DIR/.creatorcut-install.json" <<'EOF'
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
  tools: {
    node: process.version,
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
  err "Failed to activate the verified CreatorCut install."
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
  printf 'exec node %q "$@"\n' "$INSTALL_DIR/apps/cli/dist/src/main.js"
} > "$SHIM"
chmod 755 "$SHIM"

if ! "$SHIM" version > "$WORK_DIR/version-smoke.json"; then
  rm -rf "$INSTALL_DIR"
  [ ! -e "$BACKUP_DIR" ] || mv "$BACKUP_DIR" "$INSTALL_DIR"
  err "CreatorCut smoke check failed; the previous install was restored."
fi
if ! node -e '
const fs = require("fs");
const response = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (response.ok !== true || response.data?.version !== process.argv[2]) {
  process.exit(1);
}
' "$WORK_DIR/version-smoke.json" "$VERSION"; then
  rm -rf "$INSTALL_DIR"
  [ ! -e "$BACKUP_DIR" ] || mv "$BACKUP_DIR" "$INSTALL_DIR"
  err "CreatorCut smoke check returned the wrong release version; the previous install was restored."
fi
rm -rf "$BACKUP_DIR"

ok "CreatorCut $VERSION installed at $INSTALL_DIR"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) info "Add $BIN_DIR to PATH: echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc" ;;
esac
printf '\nRun: creatorcut doctor\n'
