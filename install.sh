#!/usr/bin/env bash
set -euo pipefail

REPO="ggfevans/swiftbar-qmd"
# Default to the latest tagged release so curl-pipe-bash installs are
# reproducible. Pass any ref (tag, branch, SHA) as the first arg to
# override — e.g. `bash -s main` to track tip-of-tree.
REF="${1:-v1.0.0}"
PLUGIN_DIR="$HOME/Library/Application Support/SwiftBar/Plugins"
CONFIG_DIR="$HOME/.config/swiftbar-qmd"

# Preflight
command -v deno >/dev/null || { echo "ERROR: deno not found. Install from https://deno.com/"; exit 1; }

# SwiftBar can live in /Applications/, ~/Applications/, or any other
# location LaunchServices knows about (Setapp, manual install). Use
# `open -Ra` for the broadest detection — it returns 0 iff
# LaunchServices can resolve the app, regardless of install path.
if ! open -Ra "SwiftBar" >/dev/null 2>&1; then
  echo "ERROR: SwiftBar not installed. Install from https://swiftbar.app/"
  exit 1
fi

mkdir -p "$PLUGIN_DIR" "$CONFIG_DIR"

# Resolve the ref to a SHA once so the two-file download is atomic.
# Without this, the ref ($REF) could move (e.g. a push to `main`)
# between the two curls, producing a mixed install. Tags are normally
# immutable so this is a no-op for the default v1.0.0 install — but
# the cost is one HTTPS call and the guarantee is worth it. Falls
# back to the ref directly if `git ls-remote` isn't available (rare).
SHA="$REF"
if command -v git >/dev/null 2>&1; then
  # `git ls-remote` prints "<sha>\t<full-ref>" for each match. We
  # interrogate refs/heads/<REF>, refs/tags/<REF>^{} (peeled tag for
  # annotated-tag commit SHAs), and refs/tags/<REF> (the tag object).
  # The peeled ref (^{}) is listed first so annotated tags resolve to
  # the commit SHA, not the tag object SHA — GitHub raw URLs need a
  # commit-ish, and the tag object SHA would cause a 404.
  RESOLVED=$(
    git ls-remote "https://github.com/$REPO" \
      "refs/heads/$REF" "refs/tags/$REF^{}" "refs/tags/$REF" 2>/dev/null |
      awk '{print $1; exit}' || true
  )
  if [ -n "${RESOLVED:-}" ]; then
    SHA="$RESOLVED"
  fi
fi

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
  --max-time 60
)

# Download script and example config — pinned to $SHA for atomicity.
curl "${CURL_OPTS[@]}" "https://raw.githubusercontent.com/$REPO/$SHA/qmd.30s.ts" \
  -o "$PLUGIN_DIR/qmd.30s.ts"
curl "${CURL_OPTS[@]}" "https://raw.githubusercontent.com/$REPO/$SHA/config.example.yml" \
  -o "$CONFIG_DIR/config.example.yml"

chmod +x "$PLUGIN_DIR/qmd.30s.ts"

if [ ! -f "$CONFIG_DIR/config.yml" ]; then
  cp "$CONFIG_DIR/config.example.yml" "$CONFIG_DIR/config.yml"
  echo "Default config written to $CONFIG_DIR/config.yml"
fi

echo "Installed (ref=$REF, sha=${SHA:0:12}). Restart SwiftBar (Cmd-Q in the SwiftBar menu, then relaunch) to load the plugin."
