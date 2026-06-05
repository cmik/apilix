#!/bin/bash
set -e

echo "==> Building client..."
npm run build

HOST_OS="$(uname -s)"

if [[ "$HOST_OS" == "Darwin" ]]; then
	echo "==> Building macOS CLI binary..."
	npm run cli:build:mac
elif [[ "$HOST_OS" == "Linux" ]]; then
	echo "==> Building Linux CLI binary..."
	npm run cli:build:linux
elif [[ "$HOST_OS" == MINGW* || "$HOST_OS" == MSYS* || "$HOST_OS" == CYGWIN* ]]; then
	echo "==> Building Windows CLI binary..."
	npm run cli:build:win
else
	echo "Unsupported host OS: $HOST_OS"
	exit 1
fi

if [[ "$HOST_OS" == "Darwin" ]]; then
	echo "==> Packaging for macOS (host-native only)..."
	npm run dist:prepare:server
	DISABLE_DEVTOOLS=1 npx electron-builder --mac
elif [[ "$HOST_OS" == "Linux" ]]; then
	echo "==> Packaging for Linux (host-native only)..."
	npm run dist:prepare:server
	DISABLE_DEVTOOLS=1 npx electron-builder --linux
elif [[ "$HOST_OS" == MINGW* || "$HOST_OS" == MSYS* || "$HOST_OS" == CYGWIN* ]]; then
	echo "==> Packaging for Windows (host-native only)..."
	npm run dist:prepare:server
	DISABLE_DEVTOOLS=1 npx electron-builder --win
else
	echo "Unsupported host OS: $HOST_OS"
	exit 1
fi

echo "==> Host-native build complete. Output in dist/"
echo "==> For additional OS installers, run this script on each target OS (or use CI matrix builds)."
