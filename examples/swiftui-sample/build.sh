#!/usr/bin/env bash
# Builds the SwiftUI sample for the iOS Simulator without an Xcode project: swiftc, an Info.plist, an ad-hoc
# signature. Usage: build.sh <out dir> [SLOW]   ->  <out dir>/DTNative.app
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=${1:?out dir}; flags=()
[ "${2:-}" = SLOW ] && flags+=(-D SLOW)
app="$out/DTNative.app"
rm -rf "$app" && mkdir -p "$app"
sdk=$(xcrun --sdk iphonesimulator --show-sdk-path)
xcrun --sdk iphonesimulator swiftc -O -parse-as-library -sdk "$sdk" -target arm64-apple-ios17.0-simulator ${flags[@]+"${flags[@]}"} \
  "$here/App.swift" "$here/../../sdk/swift/Doubletake.swift" -o "$app/DTNative"
cat > "$app/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>dev.doubletake.native</string>
  <key>CFBundleExecutable</key><string>DTNative</string>
  <key>CFBundleName</key><string>DT Native</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>MinimumOSVersion</key><string>17.0</string>
  <key>UILaunchScreen</key><dict/>
  <key>UIApplicationSceneManifest</key><dict><key>UIApplicationSupportsMultipleScenes</key><false/></dict>
  <key>CFBundleSupportedPlatforms</key><array><string>iPhoneSimulator</string></array>
  <key>UIDeviceFamily</key><array><integer>1</integer></array>
</dict></plist>
PLIST
codesign --force --sign - --timestamp=none "$app" >/dev/null
echo "$app"
