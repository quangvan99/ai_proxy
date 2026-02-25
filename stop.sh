#!/bin/bash

DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$DIR/.proxy.pid"

if [ ! -f "$PID_FILE" ]; then
    echo "Proxy is not running (no PID file)"
    exit 0
fi

PID=$(cat "$PID_FILE")

if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    rm -f "$PID_FILE"
    echo "Proxy stopped (PID $PID)"
else
    echo "Proxy was not running (stale PID $PID)"
    rm -f "$PID_FILE"
fi
