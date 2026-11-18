#!/bin/sh
# Build the zip to upload to the Chrome Web Store: dist/nibly-<version>.zip
set -eu
cd "$(dirname "$0")/.."
version=$(node -p "require('./manifest.json').version")
out="dist/nibly-${version}.zip"
mkdir -p dist
rm -f "$out"
zip -qr "$out" manifest.json src icons/icon-16.png icons/icon-32.png icons/icon-48.png icons/icon-128.png -x '*.DS_Store'
echo "Created $out"
unzip -l "$out"
