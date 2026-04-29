#!/bin/bash
# TUI DEV LOOP: Complete automated serve → connect → debug/fix workflow
# Usage: bash tui-dev-loop.sh <tui-command> [port] [max-iterations]

set -e

TUI_CMD="${1:-pnpm dev}"
PORT="${2:-3000}"
MAX_ITERATIONS="${3:-20}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "====================================="
echo "TUI Development Loop"
echo "====================================="
echo "Command: $TUI_CMD"
echo "Port: $PORT"
echo "Max iterations: $MAX_ITERATIONS"
echo ""

# Cleanup function
cleanup() {
  echo ""
  echo "Stopping TUI dev loop..."
  [ -n "$SERVE_PID" ] && kill $SERVE_PID 2>/dev/null || true
  [ -n "$OBSERVE_PID" ] && kill $OBSERVE_PID 2>/dev/null || true
  exit 0
}

trap cleanup INT TERM

# Terminal 1: Serve TUI
echo "[1/3] Starting TUI server..."
node "$SCRIPT_DIR/serve-tui.mjs" $TUI_CMD --port=$PORT &
SERVE_PID=$!

# Wait for server to be ready
echo "  Waiting for server to start..."
sleep 3

# Check if server is running
if ! kill -0 $SERVE_PID 2>/dev/null; then
  echo "ERROR: TUI server failed to start"
  exit 1
fi

echo "  Server running (PID: $SERVE_PID)"
echo ""

# Terminal 2: Connect observer
echo "[2/3] Starting observer..."
node "$SCRIPT_DIR/connect-observer.mjs" "ws://localhost:$PORT" --tick=1000 --analyze &
OBSERVE_PID=$!

echo "  Observer running (PID: $OBSERVE_PID)"
echo ""

# Wait for first snapshot
echo "[3/3] Waiting for first snapshot..."
sleep 5

# Main debug loop
echo ""
echo "====================================="
echo "Debug Loop Started"
echo "====================================="
echo ""

for i in $(seq 1 $MAX_ITERATIONS); do
  echo "=== Iteration $i/$MAX_ITERATIONS ==="
  
  # Check if snapshot file exists
  if [ ! -f ".tui-snapshot.json" ]; then
    echo "  No snapshot yet, waiting..."
    sleep 2
    continue
  fi
  
  # Analyze snapshot
  echo ""
  node "$SCRIPT_DIR/analyze-snapshot.mjs" .tui-snapshot.json
  echo ""
  
  # Check if issues were found
  ISSUES=$(node -e "
    const fs = require('fs');
    try {
      const snap = JSON.parse(fs.readFileSync('.tui-snapshot.json', 'utf8'));
      console.log(snap.issues?.length || 0);
    } catch { console.log('0'); }
  ")
  
  if [ "$ISSUES" = "0" ]; then
    echo "✓ No issues detected! TUI is working correctly."
    echo ""
    echo "Loop completed successfully."
    break
  fi
  
  echo "⚠ $ISSUES issues found"
  echo ""
  echo "NEXT ACTIONS:"
  echo "  1. Review issues above"
  echo "  2. Apply fixes to source code"
  echo "  3. HMR will restart TUI automatically"
  echo "  4. Loop will capture new snapshot in next tick"
  echo ""
  
  # In automated mode, AI agent would apply fixes here
  # For now, wait for manual fixes
  echo "  Waiting for fixes (Ctrl+C to stop)..."
  sleep 10
  
  echo ""
done

echo ""
echo "====================================="
echo "TUI Dev Loop Complete"
echo "====================================="

cleanup
