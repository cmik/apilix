#!/usr/bin/env bash
# Starts the Apilix server and Vite dev client in background processes.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDFILE_SERVER="$ROOT/.pid_server"
PIDFILE_CLIENT="$ROOT/.pid_client"

echo -e "\nAPILIX - Start"
echo "Root: $ROOT"

# ── Server ─────────────────────────────────────────────────────────────────────

echo -e "\n==> Starting server (port 3001)..."
node "$ROOT/packages/server/index.js" > "$ROOT/server.log" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$PIDFILE_SERVER"
echo "  [OK] Server started (PID $SERVER_PID)"

# ── Client ─────────────────────────────────────────────────────────────────────

echo -e "\n==> Starting client (Vite dev server, port 5173)..."
(cd "$ROOT/packages/client" && npm run dev) > "$ROOT/client.log" 2>&1 &
CLIENT_PID=$!
echo "$CLIENT_PID" > "$PIDFILE_CLIENT"
echo "  [OK] Client started (PID $CLIENT_PID)"

# ── Summary ────────────────────────────────────────────────────────────────────

echo -e "\nApilix is starting up:"
echo "  API    : http://localhost:3001"
echo "  App    : http://localhost:5173"
echo -e "\nRun ./status.sh to verify services are up."
