#!/bin/bash
set -e

echo "==> Building client..."
npm run build

echo "==> Packaging for macOS..."
npx electron-builder --mac

echo "==> Packaging for Windows..."
npx electron-builder --win

echo "==> Packaging for Linux..."
npx electron-builder --linux

echo "==> All builds complete. Output in dist/"
