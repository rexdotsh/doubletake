#!/usr/bin/env bash
# Builds the Compose sample's release APK (debug-signed). Needs ANDROID_HOME and a JDK 17+; the wrapper fetches Gradle 9.4.1.
# Usage: build.sh <out dir> [SLOW]   ->  <out dir>/app.apk
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=${1:?out dir}; slow=false
[ "${2:-}" = SLOW ] && slow=true
"$here/gradlew" -p "$here" --console=plain -q :app:assembleRelease -Pslow=$slow
mkdir -p "$out" && cp "$here/app/build/outputs/apk/release/app-release.apk" "$out/app.apk"
echo "$out/app.apk"
