# pty.ts — PTY Service Manager

Spawn and manage multiple TUI applications in pseudo-terminals. Interact via terminal passthrough, snapshot capture, HTTP API, or WebSocket for multi-client real-time access.

## Quick Start

```bash
# Start service manager
pnpm dev -- --serve --port 3000

# In another terminal:
pnpm dev -- --start htop        # spawn htop
pnpm dev -- --list              # list running apps
pnpm dev -- --connect           # connect to first app
pnpm dev -- --kill <id>         # kill app by ID
```

## Modes

| Mode | How | Description |
|------|-----|-------------|
| **Serve** | `--serve` | Multi-app service manager (HTTP + WebSocket) |
| **Start** | `--start <cmd>` | Spawn new TUI app via service manager |
| **List** | `--list` | List all running apps |
| **Kill** | `--kill <id>` | Kill app by ID (supports short IDs) |
| **Connect** | `--connect [id]` | Connect to app interactively |
| **Interactive** | `<cmd>` | Run command directly (no server) |
| **Snapshot** | `--snapshot` | Capture buffer and exit |

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--serve` | — | Start service manager |
| `--start <cmd>` | — | Spawn new app (requires running server) |
| `--list` | — | List running apps |
| `--kill <id>` | — | Kill app by ID |
| `--connect [id]` | — | Connect to app (default: first) |
| `--port <n>` | 3000 | Server port |
| `--host <addr>` | 127.0.0.1 | Bind address |
| `--cols <n>` | 400 | Terminal width |
| `--rows <n>` | 40 | Terminal height |
| `--cwd <dir>` | current | Working directory |
| `--term <name>` | xterm-256color | Terminal type |
| `--snapshot` | — | Snapshot mode (direct only) |
| `--color` | — | Preserve ANSI codes |

## Examples

```bash
# Service manager workflow
pnpm dev -- --serve --port 3000           # start manager
pnpm dev -- --start htop                  # spawn htop
pnpm dev -- --start top                   # spawn top
pnpm dev -- --list                        # list apps
pnpm dev -- --connect                     # connect to first app
pnpm dev -- --kill abc123                 # kill by short ID

# Direct mode (no server)
pnpm dev htop                             # run htop directly
pnpm dev vim file.txt -- --snapshot       # snapshot and exit
```

## Multi-App Workflow

```bash
# Terminal 1: start service manager
$ pnpm dev -- --serve --port 3000
PTY service manager listening on http://127.0.0.1:3000
Endpoints:
  GET  /apps              — list all running apps
  POST /start             — spawn new app
  POST /kill              — kill app
  GET  /app/:id/snapshot  — get app snapshot
  WS   ws://127.0.0.1:3000/app/:id  — WebSocket for real-time I/O

# Terminal 2: spawn apps
$ pnpm dev -- --start htop --port 3000
Started app: 3b1a8fd4 (pid: 12345)

$ pnpm dev -- --start top --port 3000
Started app: 7c2e9af1 (pid: 12367)

$ pnpm dev -- --list --port 3000
Running applications:
  3b1a8fd4  htop                  pid:12345  400x40  5s
  7c2e9af1  top                   pid:12367  400x40  2s

# Terminal 3: connect to htop
$ pnpm dev -- --connect 3b1a8fd4 --port 3000
Connected to app 3b1a8fd4 at ws://127.0.0.1:3000

# Terminal 4: another client connects to same htop
$ pnpm dev -- --connect 3b1a8fd4 --port 3000
Connected to app 3b1a8fd4 at ws://127.0.0.1:3000
```

Both Terminal 3 and 4 see the same htop screen. Either can type — all clients see the result.

## HTTP API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/apps` | List all running apps |
| POST | `/start` | Spawn app `{ "command": "htop", "args": [] }` |
| POST | `/kill` | Kill app `{ "id": "abc123" }` |
| GET | `/app/:id/snapshot` | Get app snapshot |
| GET | `/app/:id/status` | Get app status |
| POST | `/app/:id/send` | Send keystrokes `{ "text": "q" }` |
| POST | `/app/:id/resize` | Resize `{ "cols": 120, "rows": 30 }` |
| WS | `/app/:id` | WebSocket for real-time I/O |

## WebSocket Protocol

### Client → Server

```json
{"type": "input", "text": "q"}              // Send keystroke
{"type": "resize", "cols": 120, "rows": 30} // Resize terminal
```

### Server → Client

```json
{"type": "output", "text": "..."}           // PTY output
{"type": "exit", "exitCode": 0, "id": "..."} // App exited
{"type": "error", "message": "..."}         // Error
```

## Multi-Client Features

- **Multiple apps** — Run htop, top, vim, etc. simultaneously
- **Multiple clients per app** — All clients see same screen, any can type
- **Isolated output** — Clients only see output from their connected app
- **Short IDs** — Use first 8 chars of ID for commands
- **Kill propagation** — All clients receive exit message when app killed
- **Client tracking** — Server tracks client count per app

## Programmatic API

```typescript
import { ptySpawn, ptySnapshot, ptySend, ptyKill, ptyList } from "./pty.js";

// Spawn app
const app = ptySpawn({ command: "htop", cols: 120, rows: 30 });

// Get snapshot
const snap = ptySnapshot(app);
console.log(snap.visibleText);

// Send keystrokes
ptySend(app, "q");  // quit htop

// List all apps
const apps = ptyList();

// Kill app
ptyKill(app);
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Service Manager                           │
│                                                             │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐                     │
│  │ App 1   │  │ App 2   │  │ App 3   │  ...                │
│  │ (htop)  │  │ (top)   │  │ (vim)   │                     │
│  │ PTY+WS  │  │ PTY+WS  │  │ PTY+WS  │                     │
│  └────┬────┘  └────┬────┘  └────┬────┘                     │
│       │            │            │                           │
│  ┌────┴────┐  ┌────┴────┐  ┌────┴────┐                     │
│  │Clients  │  │Clients  │  │Clients  │                     │
│  │ A, B    │  │ C       │  │ D, E, F │                     │
│  └─────────┘  └─────────┘  └─────────┘                     │
└─────────────────────────────────────────────────────────────┘
```

- Each app has its own PTY process and xterm buffer
- Multiple WebSocket clients can connect to same app
- Output is broadcast to all clients of that app
- Apps are isolated — no cross-talk

## Testing

```bash
# Run multi-client test suite
node test-multi-client.js

# Tests: 16/16 pass
# - Single app, multiple clients
# - Multiple apps, isolated clients
# - Kill propagation
# - Short ID resolution
# - Client disconnect tracking
# - Concurrent app starts
# - Interactive editor (nano) multi-client
# - Client reconnect
```

## Comparison

| Feature | pty.ts | ttyd | tmux |
|---------|--------|------|------|
| Multi-app manager | ✅ | ❌ | ✅ |
| HTTP API | ✅ | ❌ | ❌ |
| WebSocket | ✅ | ✅ | ❌ |
| Structured snapshots | ✅ | ❌ | ❌ |
| Embeddable library | ✅ | ❌ | ❌ |
| Short ID support | ✅ | — | — |
| Client tracking | ✅ | — | — |
