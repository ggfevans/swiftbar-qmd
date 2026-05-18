#!/usr/bin/env bash
set -euo pipefail

REPO="ggfevans/swiftbar-qmd"
REF="${1:-main}"  # Allow pinning a tag/branch
PLUGIN_DIR="$HOME/Library/Application Support/SwiftBar/Plugins"
CONFIG_DIR="$HOME/.config/swiftbar-qmd"

# Preflight
command -v deno >/dev/null || { echo "ERROR: deno not found. Install from https://deno.com/"; exit 1; }
test -d "/Applications/SwiftBar.app" || { echo "ERROR: SwiftBar not installed. Install from https://swiftbar.app/"; exit 1; }

mkdir -p "$PLUGIN_DIR" "$CONFIG_DIR"

# Download script and example config
curl -fsSL "https://raw.githubusercontent.com/$REPO/$REF/qmd.30s.ts" \
  -o "$PLUGIN_DIR/qmd.30s.ts"
curl -fsSL "https://raw.githubusercontent.com/$REPO/$REF/config.example.yml" \
  -o "$CONFIG_DIR/config.example.yml"

chmod +x "$PLUGIN_DIR/qmd.30s.ts"

if [ ! -f "$CONFIG_DIR/config.yml" ]; then
  cp "$CONFIG_DIR/config.example.yml" "$CONFIG_DIR/config.yml"
  echo "Default config written to $CONFIG_DIR/config.yml"
fi

echo "Installed. Restart SwiftBar (Cmd-Q in the SwiftBar menu, then relaunch) to load the plugin."
