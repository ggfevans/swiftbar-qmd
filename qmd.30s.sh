#!/bin/bash
# SwiftBar/xbar plugin: qmd operational visibility
#
# <bitbar.title>qmd-swiftbar</bitbar.title>
# <bitbar.version>v1.0.0</bitbar.version>
# <bitbar.author>Gareth Evans</bitbar.author>
# <bitbar.author.github>ggfevans</bitbar.author.github>
# <bitbar.desc>Surface qmd operational state (collections, daemon, jobs) in the macOS menubar.</bitbar.desc>
# <bitbar.dependencies>qmd</bitbar.dependencies>
# <swiftbar.title>qmd-swiftbar</swiftbar.title>
# <swiftbar.version>v1.0.0</swiftbar.version>
# <swiftbar.author>Gareth Evans</swiftbar.author>
# <swiftbar.author.github>ggfevans</swiftbar.author.github>
# <swiftbar.desc>Surface qmd operational state (collections, daemon, jobs) in the macOS menubar.</swiftbar.desc>
# <swiftbar.dependencies>qmd</swiftbar.dependencies>
# <swiftbar.abouturl>https://github.com/ggfevans/qmd-swiftbar</swiftbar.abouturl>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>

set -euo pipefail

PLUGIN_DIR="$HOME/Library/Application Support/SwiftBar/Plugins"
BINARY_NAME="qmd-swiftbar"

# Resolve the compiled binary. Look in the plugin directory first (standard
# install location), then fall back to PATH via command -v. If neither
# finds it, render a graceful error menu instead of crashing.
if [ -x "$PLUGIN_DIR/$BINARY_NAME" ]; then
  BINARY="$PLUGIN_DIR/$BINARY_NAME"
elif BINARY="$(command -v "$BINARY_NAME" 2>/dev/null)"; then
  : # command -v already set BINARY
else
  BINARY=""
fi

if [ -z "${BINARY:-}" ]; then
  echo "| sfimage=questionmark.circle color=#9ca3af"
  echo "---"
  echo "qmd-swiftbar missing | disabled=true"
  echo "Binary not found in: | disabled=true"
  echo "$PLUGIN_DIR | disabled=true"
  echo "---"
  echo "Install | bash=open param1=https://github.com/ggfevans/qmd-swiftbar terminal=false"
  exit 0
fi

# Delegate to the compiled binary with all arguments forwarded intact.
# "$@" (quoted) prevents word splitting and glob expansion on arguments.
exec "$BINARY" "$@"