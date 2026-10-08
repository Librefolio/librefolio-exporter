#!/bin/sh
# Builds the release ZIP (the folder users load with "Load unpacked") and its SHA-256.
set -eu

cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./manifest.json').version")
NAME="librefolio-exporter-$VERSION"

npm run --silent check

mkdir -p dist
rm -f "dist/$NAME.zip" "dist/$NAME.zip.sha256"
zip -q -r -X "dist/$NAME.zip" manifest.json LICENSE THIRD_PARTY_NOTICES.md PRIVACY.md _locales icons src -x '*.DS_Store'

cd dist
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$NAME.zip" > "$NAME.zip.sha256"
else
  shasum -a 256 "$NAME.zip" > "$NAME.zip.sha256"
fi
cat "$NAME.zip.sha256"
