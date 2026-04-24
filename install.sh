#!/usr/bin/env bash
# Installs all dependencies for the Apilix application.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

step() { echo -e "\n==> $1"; }
ok()   { echo "  [OK] $1"; }
fail() { echo "  [FAIL] $1" >&2; exit 1; }

echo -e "\nAPILIX - Install"
echo "Root: $ROOT"

# ── Check prerequisites ────────────────────────────────────────────────────────

step "Checking prerequisites"

command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Please install it from https://nodejs.org"
ok "Node.js $(node --version)"

command -v npm >/dev/null 2>&1 || fail "npm is not installed."
ok "npm $(npm --version)"

# ── Root dependencies ──────────────────────────────────────────────────────────

step "Installing root dependencies"
cd "$ROOT"
npm install || fail "Root npm install failed"
ok "Root dependencies installed"

# ── Done ───────────────────────────────────────────────────────────────────────

cd "$ROOT"
echo -e "\nInstallation complete. Run ./start.sh to launch Apilix."
