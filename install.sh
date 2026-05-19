#!/bin/bash
set -euo pipefail

REPO="ggfevans/qmd-swiftbar"
# Default to the latest GitHub Release. Pass a tag (e.g. `v1.0.0`)
# as the first arg to pin to a specific release.
TAG="${1:-latest}"
PLUGIN_DIR="$HOME/Library/Application Support/SwiftBar/Plugins"
CONFIG_DIR="$HOME/.config/qmd-swiftbar"
BINARY_NAME="qmd-swiftbar"
WRAPPER_NAME="qmd.30s.sh"

# SwiftBar can live in /Applications/, ~/Applications/, or any other
# location LaunchServices knows about (Setapp, manual install). Use
# `open -Ra` for the broadest detection — it returns 0 iff
# LaunchServices can resolve the app, regardless of install path.
if ! open -Ra "SwiftBar" >/dev/null 2>&1; then
  echo "ERROR: SwiftBar not installed. Install from https://swiftbar.app/"
  exit 1
fi

# Detect architecture. SwiftBar is macOS-only, so we only need to
# distinguish arm64 (Apple Silicon) from x86_64 (Intel). The GitHub
# Release artefacts are named qmd-swiftbar-arm64 and
# qmd-swiftbar-x86_64 to match.
ARCH=$(uname -m)
case "$ARCH" in
  arm64) ARTIFACT="qmd-swiftbar-arm64" ;;
  x86_64) ARTIFACT="qmd-swiftbar-x86_64" ;;
  *) echo "ERROR: unsupported architecture: $ARCH"; exit 1 ;;
esac

mkdir -p "$PLUGIN_DIR" "$CONFIG_DIR"

# Curl flags rationale (PR #1 D4): timeouts + retries make first-run
# UX feel grown-up on flaky connections. `--retry-all-errors` opts
# into retrying on transient HTTP failures, not just TCP setup.
CURL_OPTS=(
  --fail
  --silent
  --show-error
  --location
  --retry 3
  --retry-all-errors
  --connect-timeout 10
  --max-time 120
)

# Resolve the download URL. For the default "latest" tag, query the
# GitHub Releases API to get the tag name (needed for the
# checksum URL). For an explicit tag, use it directly.
if [ "$TAG" = "latest" ]; then
  RELEASE_TAG=$(
    curl "${CURL_OPTS[@]}" "https://api.github.com/repos/$REPO/releases/latest" |
      grep '"tag_name"' | head -1 |
      sed -E 's/.*"tag_name": *"([^"]+)".*/\1/'
  )
  if [ -z "${RELEASE_TAG:-}" ]; then
    echo "ERROR: no GitHub Release found for $REPO."
    echo "A release must exist before the binary installer can run."
    echo "Until then, install from source: https://github.com/$REPO#install"
    exit 1
  fi
else
  RELEASE_TAG="$TAG"
fi

# Download the compiled binary and its SHA256 checksum from the
# GitHub Release. The CI pipeline (build.yml) produces one binary per
# architecture plus a .sha256 file for each.
BINARY_URL="https://github.com/$REPO/releases/download/$RELEASE_TAG/$ARTIFACT"
CHECKSUM_URL="https://github.com/$REPO/releases/download/$RELEASE_TAG/$ARTIFACT.sha256"

# Avoid naming this TMPDIR — that shadows the POSIX env variable that
# mktemp(1) itself consults, which can cause subtle breakage.
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

curl "${CURL_OPTS[@]}" "$BINARY_URL" -o "$TMP_DIR/$ARTIFACT"
curl "${CURL_OPTS[@]}" "$CHECKSUM_URL" -o "$TMP_DIR/$ARTIFACT.sha256"

# Verify the checksum. `shasum` exits non-zero on mismatch, which
# `set -e` catches. Run in a subshell so we do not need to cd back.
if command -v shasum >/dev/null 2>&1; then
  (cd "$TMP_DIR" && shasum -a 256 -c "$ARTIFACT.sha256" >/dev/null)
else
  echo "WARNING: shasum not found; cannot verify binary integrity."
  echo "Proceed with caution — the download was not verified."
fi

# Download the example config from the release tag's tree. This
# file is not architecture-specific, so there is one copy per release.
curl "${CURL_OPTS[@]}" "https://raw.githubusercontent.com/$REPO/$RELEASE_TAG/config.example.yml" \
  -o "$CONFIG_DIR/config.example.yml"

# Install the binary.
chmod +x "$TMP_DIR/$ARTIFACT"
mv "$TMP_DIR/$ARTIFACT" "$PLUGIN_DIR/$BINARY_NAME"

# Download and install the shell wrapper. This is the SwiftBar entry point
# that delegates to the compiled binary. It is a small text file in the
# repo, not a release artefact, so download from raw.githubusercontent.com.
curl "${CURL_OPTS[@]}" "https://raw.githubusercontent.com/$REPO/$RELEASE_TAG/$WRAPPER_NAME" \
  -o "$PLUGIN_DIR/$WRAPPER_NAME"
chmod +x "$PLUGIN_DIR/$WRAPPER_NAME"

if [ ! -f "$CONFIG_DIR/config.yml" ]; then
  cp "$CONFIG_DIR/config.example.yml" "$CONFIG_DIR/config.yml"
  echo "Default config written to $CONFIG_DIR/config.yml"
fi

echo "Installed $BINARY_NAME ($ARTIFACT, tag=$RELEASE_TAG) to $PLUGIN_DIR."
echo "Installed $WRAPPER_NAME (SwiftBar entry point) to $PLUGIN_DIR."
echo "Restart SwiftBar (Cmd-Q in the SwiftBar menu, then relaunch) to load the plugin."
