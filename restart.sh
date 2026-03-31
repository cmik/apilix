#!/usr/bin/env bash
# Stops any running Apilix processes then starts them again.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$ROOT/stop.sh"

sleep 0.5

"$ROOT/start.sh"
