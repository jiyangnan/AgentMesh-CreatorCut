#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || "$1" != /* ]]; then
  echo "usage: $0 /absolute/caller-owned-temp-root" >&2
  exit 2
fi
if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "secure-swap prototype verification requires Darwin arm64" >&2
  exit 2
fi
if [[ ! -d "$1" || -L "$1" ]]; then
  echo "verification root must be an existing non-symlink directory" >&2
  exit 2
fi

TEMP_ROOT="$(cd "$1" && pwd -P)"
REPOSITORY_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
SOURCE_ROOT="$REPOSITORY_ROOT/packages/runtime/native/secure-swap-prototype"
BUILD_ROOT="$TEMP_ROOT/build"
COMPILER_TMP="$TEMP_ROOT/compiler-tmp"

CLANG_PATH="${CLANG_PATH:-$(xcrun --find clang)}"
SDKROOT_INPUT="${SDKROOT:-$(xcrun --sdk macosx --show-sdk-path)}"
RUSTC_PATH="${RUSTC_PATH:-$(command -v rustc)}"
NODE_PATH="${NODE_PATH:-$(command -v node)}"

for executable in "$CLANG_PATH" "$RUSTC_PATH" "$NODE_PATH"; do
  if [[ ! -x "$executable" || -L "$executable" ]]; then
    echo "verification tool is missing, non-executable, or a symlink: $executable" >&2
    exit 2
  fi
done
if [[ "$SDKROOT_INPUT" != /* || ! -d "$SDKROOT_INPUT" ]]; then
  echo "macOS SDK is missing or unsafe: $SDKROOT_INPUT" >&2
  exit 2
fi
SDKROOT_PARENT="$(cd "$(dirname "$SDKROOT_INPUT")" && pwd -P)"
SDKROOT="$(cd "$SDKROOT_INPUT" && pwd -P)"
if [[ ! -d "$SDKROOT" || -L "$SDKROOT" || "$(dirname "$SDKROOT")" != "$SDKROOT_PARENT" ]]; then
  echo "canonical macOS SDK is missing or unsafe: $SDKROOT" >&2
  exit 2
fi
if [[ "$($NODE_PATH -p 'process.versions.node.split(".")[0]')" != "24" ]]; then
  echo "secure-swap prototype verification requires Node 24" >&2
  exit 2
fi

mkdir -p "$BUILD_ROOT" "$COMPILER_TMP"
export TMPDIR="$COMPILER_TMP"
export TMP="$COMPILER_TMP"
export TEMP="$COMPILER_TMP"
export SDKROOT

"$CLANG_PATH" -std=c11 -Wall -Wextra -Werror -fno-modules \
  -arch arm64 -isysroot "$SDKROOT" \
  -c "$SOURCE_ROOT/darwin_shim.c" -o "$BUILD_ROOT/darwin_shim.o"

RUST_LINK_ARGS=(
  -C "linker=$CLANG_PATH"
  -C "link-arg=-isysroot"
  -C "link-arg=$SDKROOT"
  -C "link-arg=$BUILD_ROOT/darwin_shim.o"
)

"$RUSTC_PATH" --edition=2021 --test "$SOURCE_ROOT/sha256.rs" \
  -o "$BUILD_ROOT/sha256-tests"
"$BUILD_ROOT/sha256-tests"

"$RUSTC_PATH" --edition=2021 -A dead_code --test "$SOURCE_ROOT/main.rs" \
  "${RUST_LINK_ARGS[@]}" -o "$BUILD_ROOT/helper-tests"
"$BUILD_ROOT/helper-tests"

"$RUSTC_PATH" --edition=2021 -A dead_code "$SOURCE_ROOT/main.rs" \
  "${RUST_LINK_ARGS[@]}" -o "$BUILD_ROOT/secure-swap"
"$RUSTC_PATH" --edition=2021 -A dead_code --cfg secure_swap_synthetic \
  "$SOURCE_ROOT/main.rs" "${RUST_LINK_ARGS[@]}" \
  -o "$BUILD_ROOT/secure-swap-synthetic"

"$CLANG_PATH" -std=c11 -Wall -Wextra -Werror -fno-modules \
  -arch arm64 -isysroot "$SDKROOT" \
  "$SOURCE_ROOT/barrier_launcher.c" \
  -o "$BUILD_ROOT/secure-swap-barrier-launcher"

"$NODE_PATH" "$SOURCE_ROOT/harness.mjs" \
  --normal-helper "$BUILD_ROOT/secure-swap" \
  --synthetic-helper "$BUILD_ROOT/secure-swap-synthetic" \
  --barrier-launcher "$BUILD_ROOT/secure-swap-barrier-launcher" \
  --temp-root "$TEMP_ROOT"
