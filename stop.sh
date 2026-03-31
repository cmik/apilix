#!/usr/bin/env bash
# Stops the Apilix server (:3001) and Vite dev client (:5173).

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDFILE_SERVER="$ROOT/.pid_server"
PIDFILE_CLIENT="$ROOT/.pid_client"

echo -e "\nAPILIX - Stop"

stop_port() {
    local port="$1"
    local label="$2"
    local pidfile="$3"

    # Try pidfile first
    if [[ -f "$pidfile" ]]; then
        local pid
        pid=$(cat "$pidfile")
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null && echo "  [OK] $label (port $port) - stopped PID $pid" || \
                echo "  [WARN] Could not stop PID $pid"
        fi
        rm -f "$pidfile"
    fi

    # Also kill any remaining processes on the port
    local pids
    pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
    if [[ -n "$pids" ]]; then
        echo "$pids" | xargs kill 2>/dev/null && \
            echo "  [OK] $label (port $port) - remaining processes stopped" || true
    else
        echo "  [--] $label (port $port) - not running"
    fi
}

stop_port 3001 "Server" "$PIDFILE_SERVER"
stop_port 5173 "Client (Vite)" "$PIDFILE_CLIENT"

echo -e "\nDone."
