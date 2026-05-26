#!/bin/bash
set -e

echo "==> Building client..."
npm run build

echo "==> Building CLI binaries..."
npm run cli:build:binaries

echo "==> Packaging for macOS..."
npm run dist:prepare:server
DISABLE_DEVTOOLS=1 npx electron-builder --mac

echo "==> Packaging for Windows..."
npm run dist:prepare:server
DISABLE_DEVTOOLS=1 npx electron-builder --win

echo "==> Packaging for Linux..."
npm run dist:prepare:server
DISABLE_DEVTOOLS=1 npx electron-builder --linux

echo "==> All builds complete. Output in dist/"
