#!/bin/bash

DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$DIR/.proxy.pid"
LOG_FILE="$DIR/.proxy.log"

if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        echo "Proxy already running (PID $PID)"
        exit 0
    fi
    rm -f "$PID_FILE"
fi

cd "$DIR"
nohup node src/index.js > "$LOG_FILE" 2>&1 &
PID=$!
echo $PID > "$PID_FILE"

# Wait a moment and verify it started
sleep 2
if kill -0 "$PID" 2>/dev/null; then
    echo "Proxy started (PID $PID) — log: $LOG_FILE"
else
    echo "Failed to start proxy. Check $LOG_FILE"
    rm -f "$PID_FILE"
    exit 1
fi
