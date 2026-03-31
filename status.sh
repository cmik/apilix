#!/usr/bin/env bash
# Shows the running status of Apilix services and performs a quick health check.

echo -e "\nAPILIX - Status"
echo "Time: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

SERVER_UP=false
CLIENT_UP=false

port_status() {
    local port="$1"
    local label="$2"
    local pids
    pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
    if [[ -n "$pids" ]]; then
        local pid
        pid=$(echo "$pids" | head -1)
        local name
        name=$(ps -p "$pid" -o comm= 2>/dev/null || echo "unknown")
        echo "  [UP]   $label (port $port) - PID $pid ($name)"
        return 0
    else
        echo "  [DOWN] $label (port $port) - not listening"
        return 1
    fi
}

port_status 3001 "Server (API)"  && SERVER_UP=true || true
port_status 5173 "Client (Vite)" && CLIENT_UP=true || true

# ── Health check ───────────────────────────────────────────────────────────────

if [[ "$SERVER_UP" == true ]]; then
    echo ""
    echo "  Health check -> http://localhost:3001/api/health"
    if command -v curl >/dev/null 2>&1; then
        response=$(curl -s --max-time 5 http://localhost:3001/api/health 2>/dev/null || true)
        if [[ -n "$response" ]]; then
            echo "  [OK]   API responded: $response"
        else
            echo "  [WARN] API health check failed or returned empty response"
        fi
    else
        echo "  [WARN] curl not found, skipping health check"
    fi
fi

echo ""
