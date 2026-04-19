#!/bin/bash
set -e

echo "==> Building client..."
npm run build

echo "==> Packaging for macOS..."
DISABLE_DEVTOOLS=1 npx electron-builder --mac

echo "==> Packaging for Windows..."
DISABLE_DEVTOOLS=1 npx electron-builder --win

echo "==> Packaging for Linux..."
DISABLE_DEVTOOLS=1 npx electron-builder --linux

echo "==> All builds complete. Output in dist/"
