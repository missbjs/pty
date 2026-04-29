---
name: serve-connect-loop
description: Automated TUI development workflow using pty.ts serve & connect pattern. Spawn TUI in served PTY, AI agent connects to observe screen state, detect bugs (flicker, layout, rendering), debug and fix code, loop until issues resolved. Use when developing, debugging, or testing TUI applications with automated visual inspection.
---

# Serve → Connect → Debug/Fix Loop

Automated TUI development workflow using pty.ts serve & connect pattern.

## Workflow Overview

```
┌─────────────────────────────────────────────────────────────┐
│  1. SERVE: pty.ts serve <tui-command>                       │
│     - Spawns TUI in PTY                                     │
│     - HTTP + WebSocket server for screen access             │
│     - Auto-detects HMR/restart                              │
│                                                             │
│  2. CONNECT: AI agent connects to observe                   │
│     - WebSocket connection to served PTY                    │
│     - Captures screen snapshots via HTTP API                │
│     - Detects: flicker, layout bugs, missing elements       │
│                                                             │
│  3. DEBUG/FIX: AI agent analyzes & patches                  │
│     - Reads snapshot state                                  │
│     - Identifies root cause                                 │
│     - Edits source code                                     │
│     - Waits for HMR or triggers restart                     │
│                                                             │
│  LOOP: Repeat until bugs fixed / features complete          │
└─────────────────────────────────────────────────────────────┘
```

## Prerequisites

```bash
# Ensure pty.ts is available
git clone https://github.com/missbjs/pty
cd pty && pnpm install && pnpm build
```

## Quick Start

### Terminal 1: Serve the TUI

```bash
# Using pty.ts directly
pnpm dev <your-tui-command> -- --serve --port 3000

# Example: serve an Ink-based TUI
pnpm dev node dist/index.js -- --serve --port 3000 --cols 120 --rows 40
```

**Server starts with:**
- HTTP API at `http://127.0.0.1:3000`
- WebSocket at `ws://127.0.0.1:3000`
- PTY process running your TUI

### Terminal 2: AI Agent Connects & Observes

The AI agent connects via WebSocket and uses HTTP API to capture snapshots:

```bash
# Connect to view/control
pnpm dev -- --connect --port 3000

# Or programmatically via HTTP API
curl http://127.0.0.1:3000/snapshot?color=true
```

**AI Agent Observation Loop:**

```typescript
import WebSocket from 'ws';

// Connect to served PTY
const ws = new WebSocket('ws://127.0.0.1:3000');

// Send resize to match your analysis dimensions
ws.on('open', () => {
  ws.send(JSON.stringify({
    type: 'resize',
    cols: 120,
    rows: 40
  }));
});

// Receive real-time output
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'output') {
    // Process TUI output, write to headless terminal
    term.write(msg.text);
  }
});

// Periodic snapshot analysis
setInterval(async () => {
  const res = await fetch('http://127.0.0.1:3000/snapshot?color=true');
  const snapshot = await res.json();
  analyzeSnapshot(snapshot);
}, 1000);
```

### Terminal 3: Debug Loop

AI agent analyzes snapshots and applies fixes:

```typescript
async function analyzeSnapshot(snapshot: any) {
  const issues: string[] = [];
  
  // 1. Detect line overflow (width bugs)
  for (const [i, line] of snapshot.visibleText.split('\n').entries()) {
    if (stripAnsi(line).length > snapshot.cols) {
      issues.push(`LINE_OVERFLOW: Row ${i} exceeds width`);
    }
  }
  
  // 2. Detect missing chrome (borders)
  if (!snapshot.visibleText.includes('┌') && !snapshot.visibleText.includes('│')) {
    issues.push('MISSING_CHROME: No border characters');
  }
  
  // 3. Detect flicker (compare with previous)
  if (previousSnapshot) {
    const changedRows = diffSnapshots(snapshot, previousSnapshot);
    if (changedRows > 0 && changedRows < 10) {
      issues.push(`FLICKER: ${changedRows} rows changing`);
    }
  }
  
  // 4. Detect errors
  if (snapshot.visibleText.includes('[error]') || snapshot.visibleText.includes('ERR!')) {
    issues.push('ERROR_TEXT: Error in output');
  }
  
  if (issues.length > 0) {
    await fixIssues(issues, snapshot);
  }
}

async function fixIssues(issues: string[], snapshot: any) {
  for (const issue of issues) {
    console.log(`Fixing: ${issue}`);
    
    // AI agent reads relevant source files
    // Identifies root cause
    // Applies code fixes
    // Waits for HMR
    
    if (issue.startsWith('LINE_OVERFLOW')) {
      // Fix width calculations in source
      await applyWidthFix();
    }
    
    if (issue.startsWith('FLICKER')) {
      // Find unnecessary re-renders
      await fixRenderChurn();
    }
  }
  
  // Wait for HMR to apply
  await sleep(2000);
  
  // Loop continues - next snapshot will verify fix
}
```

## HTTP API Endpoints

When running with `--serve`:

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check |
| GET | `/status` | PTY process info |
| GET | `/snapshot` | Visible screen (JSON) |
| GET | `/snapshot?color=true` | Screen with ANSI colors |
| GET | `/snapshot/visible` | Visible area only |
| GET | `/snapshot/full` | Full buffer + scrollback |
| POST | `/send` | Send keystrokes `{"text": "..."}` |
| POST | `/resize` | Resize PTY `{"cols": N, "rows": N}` |

## WebSocket Protocol

**Server → Client:**
```json
{ "type": "output", "text": "..." }
{ "type": "exit", "exitCode": 0 }
```

**Client → Server:**
```json
{ "type": "input", "text": "q" }
{ "type": "resize", "cols": 120, "rows": 40 }
```

## Complete Example: Fix Ink TUI Layout Bug

### Scenario: Output panel has 1-col gray gutter

**1. Serve the TUI:**
```bash
# Terminal 1
pnpm dev node dist/index.js -- --serve --port 3000 --cols 120 --rows 40
```

**2. AI Agent connects and detects issue:**
```bash
# Get snapshot
curl http://127.0.0.1:3000/snapshot?color=true > snapshot.json

# AI analyzes snapshot
node -e "
const snap = require('./snapshot.json');
const lines = snap.visibleText.split('\n');

// Check row widths
for (let i = 0; i < lines.length; i++) {
  const visible = lines[i].replace(/\x1b\[[0-9;]*m/g, '');
  const width = [...visible].length;
  if (width !== 120 && visible.trim().length > 50) {
    console.log(\`Row \${i}: \${width} cols (expected 120)\`);
  }
}
"
```

**3. AI reads source code and identifies bug:**
```typescript
// Reads src/app.tsx, finds:
const panelWidth = terminalWidth - agentListWidth;  // Missing border subtraction

// Should be:
const panelWidth = terminalWidth - agentListWidth - 2;  // Account for borders
```

**4. AI applies fix:**
```typescript
// Edit src/app.tsx
const panelWidth = terminalWidth - agentListWidth - 2;
```

**5. HMR restarts TUI automatically**

**6. Loop continues - AI captures new snapshot:**
```bash
# Verify fix
curl http://127.0.0.1:3000/snapshot?color=true > snapshot2.json
# Check if issue resolved
```

## Automated Loop Script

```bash
#!/bin/bash
# tui-dev-loop.sh

TUI_CMD="$1"
PORT="${2:-3000}"
MAX_ITERATIONS="${3:-20}"

echo "Starting TUI dev loop..."

# Terminal 1: Serve TUI
pnpm dev $TUI_CMD -- --serve --port $PORT &
SERVE_PID=$!

sleep 2

# Loop until fixed or max iterations
for i in $(seq 1 $MAX_ITERATIONS); do
  echo "=== Iteration $i/$MAX_ITERATIONS ==="
  
  # Capture snapshot
  curl -s http://127.0.0.1:$PORT/snapshot?color=true > .tui-snapshot.json
  
  # Analyze (AI agent does this)
  ISSUES=$(node analyze-snapshot.mjs .tui-snapshot.json)
  
  if [ -z "$ISSUES" ]; then
    echo "✓ No issues detected!"
    break
  fi
  
  echo "Issues: $ISSUES"
  
  # Fix (AI agent applies fixes)
  node apply-fixes.mjs .tui-snapshot.json
  
  # Wait for HMR
  sleep 2
done

kill $SERVE_PID
```

## Multi-Client Debugging

Multiple AI agents can connect simultaneously:

```bash
# Terminal 1: Server
pnpm dev vim src/app.tsx -- --serve --port 3000

# Terminal 2: AI agent observing layout
pnpm dev -- --connect --port 3000

# Terminal 3: AI agent testing keyboard shortcuts
pnpm dev -- --connect --port 3000

# Terminal 4: Human developer watching
pnpm dev -- --connect --port 3000
```

All clients see the same screen and can interact. Perfect for:
- Pair debugging TUI issues
- Automated visual regression testing
- Multi-aspect analysis (layout + colors + input)

## Common TUI Issues to Detect

### 1. Layout Overflow
```typescript
// Detection
const maxWidth = Math.max(...lines.map(l => stripAnsi(l).length));
if (maxWidth > snapshot.cols) {
  issues.push(`OVERFLOW: ${maxWidth} > ${snapshot.cols}`);
}

// Fix: Check width calculations
// - Panel width = termWidth - sidebarWidth - borders
// - Account for Ink padding/margins
```

### 2. Flicker/Render Churn
```typescript
// Detection: Compare consecutive snapshots
let previousHash = '';
let flickerStreak = 0;

function detectFlicker(snapshot: any) {
  const hash = hashSnapshot(snapshot);
  if (hash !== previousHash) {
    flickerStreak++;
    if (flickerStreak > 3) {
      issues.push(`FLICKER: ${flickerStreak} consecutive changes`);
    }
  } else {
    flickerStreak = 0;
  }
  previousHash = hash;
}

// Fix: Gate unnecessary re-renders
// - Check for setInterval firing at idle
// - Verify state updates are necessary
// - Use React.memo for stable components
```

### 3. Missing Borders/Chrome
```typescript
// Detection
const hasBorders = text.includes('┌') || text.includes('│');
if (!hasBorders && text.trim().length > 100) {
  issues.push('MISSING_CHROME');
}

// Fix: Check component rendering
// - Verify Box border props
// - Check conditional rendering
// - Ensure state is correct
```

### 4. Color/Style Issues
```typescript
// Detection: Check ANSI code balance
const colorCodes = (text.match(/\x1b\[\d+m/g) || []).length;
const resets = (text.match(/\x1b\[0m/g) || []).length;
if (colorCodes > resets * 2) {
  issues.push('UNBALANCED_SGR');
}

// Fix: Check SGR code emission
// - Verify reset after each styled segment
// - Check Screen.ts renderLine logic
```

## Integration with CI/CD

Use serve & connect for automated TUI testing:

```yaml
# .github/workflows/tui-test.yml
- name: TUI Visual Test
  run: |
    # Start TUI in serve mode
    pnpm dev node dist/index.js -- --serve --port 3000 &
    
    # Wait for startup
    sleep 3
    
    # Run visual tests
    node test/tui-visual.test.mjs
    
    # Capture final snapshot
    curl http://localhost:3000/snapshot?color=true > test-snapshot.json
    
    # Compare with baseline
    node test/compare-snapshots.mjs baseline.json test-snapshot.json
```

## Files in This Skill

- `SKILL.md` - This file (workflow documentation)
- `scripts/` - Helper scripts for automation
  - `serve-tui.mjs` - TUI server wrapper
  - `connect-observer.mjs` - AI agent observer
  - `analyze-snapshot.mjs` - Snapshot analysis
  - `tui-dev-loop.sh` - Complete loop orchestrator

## Notes

- **HMR Support**: Works best with TUIs that support hot reload (Vite, etc.)
- **Auto-restart**: PTY server detects process exit and can respawn
- **Multiple clients**: Multiple observers can connect simultaneously
- **Remote dev**: Serve on one machine, connect from another
- **Structured data**: `/snapshot` returns JSON with `visibleText`, `scrollbackLines`, `fullText`
