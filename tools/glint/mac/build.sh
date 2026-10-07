#!/bin/bash
# Builds Glint.app, the macOS panel, into tools/glint/mac/build/. Needs the Xcode command line tools
# (xcode-select --install). The app runs the panel page and the plugin's scripts from this clone, so
# keep the clone where it is (the app itself can move, e.g. to /Applications).
#
#   bash tools/glint/mac/build.sh
#   open tools/glint/mac/build/Glint.app
#
# GLINT_SIGN_IDENTITY: a code signing identity to sign with. The default, "-", signs it ad hoc, so
# after each rebuild macOS asks for Accessibility permission again.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
APP="$HERE/build/Glint.app"
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/plugins/glint/.claude-plugin/plugin.json")"
xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
swiftc -O -swift-version 5 -parse-as-library -target "$(uname -m)-apple-macos12.0" \
  "$HERE/GlintPanel.swift" -o "$APP/Contents/MacOS/Glint"

cat >"$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>io.github.ccdr4gon.glint</string>
  <key>CFBundleName</key><string>Glint</string>
  <key>CFBundleExecutable</key><string>Glint</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$(xml "$VERSION")</string>
  <key>CFBundleVersion</key><string>$(xml "$VERSION")</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>GlintRoot</key><string>$(xml "$ROOT")</string>
</dict>
</plist>
EOF

codesign --force --sign "${GLINT_SIGN_IDENTITY:--}" "$APP"
echo "Built $APP"
