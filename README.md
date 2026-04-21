# pty.ts — Generic PTY Process Manager

Spawn any TUI application in a pseudo-terminal and interact with it via terminal passthrough, snapshot capture, HTTP API, or WebSocket for multi-client real-time access.

## Usage

```bash
pnpm dev <command> [args...] [-- <pty-options>]   # development (tsx)
pnpm start <command> [args...] [-- <pty-options>] # production (dist)
```

## Modes

| Mode | How | Description |
|---|---|---|
| **Interactive** (default) | no flags | Relay TUI to current terminal, resize passthrough (color preserved) |
| **Snapshot** | `--snapshot` | Wait, capture buffer, print, exit (ANSI stripped by default) |
| **Serve** | `--serve` | HTTP API + WebSocket server — spawn app and broadcast to multiple clients |
| **Connect** | `--connect` | WebSocket client to an existing `--serve` instance — multiple clients can view/control the same PTY |

## Flags (after `--` or auto-detected)

| Flag | Default | Description |
|---|---|---|
| `--cols <n>` | auto from TTY, fallback 200 | Terminal width |
| `--rows <n>` | auto from TTY, fallback 40 | Terminal height |
| `--cwd <dir>` | current dir | Working directory |
| `--term <name>` | xterm-256color | Terminal type |
| `--wait <ms>` | 1000 | Wait time before snapshot |
| `--color` | — | Preserve ANSI color codes in snapshot output |
| `--interactive` | — | Explicit interactive mode |
| `--snapshot` | — | Single snapshot and exit |
| `--serve` | — | Start HTTP + WebSocket server |
| `--connect` | — | Connect to existing PTY server via WebSocket |
| `--port <n>` | 3000 | Server port for --serve / --connect |
| `--host <addr>` | 127.0.0.1 | Bind address for --serve |

## Examples

```bash
# Interactive passthrough
pnpm dev top
pnpm dev htop
pnpm dev vim file.txt

# Snapshot mode
pnpm dev top -- --snapshot
pnpm dev top -- --snapshot --wait 2000 --cols 100 --rows 15
pnpm dev top -- --snapshot --color        # preserve ANSI color codes

# HTTP + WebSocket server mode (spawn app + broadcast)
pnpm dev htop -- --serve --port 3000

# Connect to existing server (multiple clients share same PTY)
pnpm dev -- --connect --port 3000
```

## Multi-client Workflow

```bash
# Terminal 1: spawn the app and start serving
pnpm dev htop -- --serve --port 3000

# Terminal 2: connect to view and interact
pnpm dev -- --connect --port 3000

# Terminal 3: another client can also connect
pnpm dev -- --connect --port 3000
```

All connected clients see the same screen in real-time and can send keystrokes. Terminal resizing is synced across all clients.

## htop Serve + Connect Example

**Terminal 1 — Server:**
```
$ pnpm dev htop -- --serve --port 3000
Spawning: htop
  Terminal: 400x40, cwd: /root/pty, term: xterm-256color
  Mode: serve on http://127.0.0.1:3000

PTY server listening on http://127.0.0.1:3000
Endpoints:
  GET  /snapshot          — visible screen
  GET  /snapshot?color=true — visible screen with ANSI color
  GET  /snapshot/visible  — visible area
  ...
  WS   ws://127.0.0.1:3000  — WebSocket for real-time I/O

Ctrl+C to stop
Client connected (1 total)
Client connected (2 total)
```

**Terminal 2 — Client (after `pnpm dev -- --connect --port 3000`):**
```
Connected to PTY server at ws://127.0.0.1:3000
Mode: remote interactive (Ctrl+C to disconnect)

    1  [|||||||||||10.3%]     Tasks: 28, 42 thr; 2 running
    2  [|||||5.8%]            Load average: 0.12 0.07 0.02
    3  [|||3.2%]              Uptime: 00:05:12
    4  [||||||||||10.1%]
  Mem[|||||||||||4.86G/14.7G]
  Swp[|||||3.84G/12.0G]

  PID USER      PRI  NI  VIRT   RES   SHR S CPU% MEM%   TIME+ Command
 1056 root       20   0 1340M  82M  29M S  0.0  0.6  5:23.69 qodercli
 3842 root       20   0   13G  82M  39M S  0.0  0.5  0:00.78 node
 3910 root       20   0 10708 3988 2068 R  0.0  0.0  0:00.34 top
  F1Help  F2Menu  F3Search F4Filter F5Tree  F6SortBy F7Nice - F8Nice + F9Kill  F10Quit
```

**Terminal 3 — Second client (also `pnpm dev -- --connect --port 3000`):**
```
Connected to PTY server at ws://127.0.0.1:3000
Mode: remote interactive (Ctrl+C to disconnect)

    1  [|||||||||||10.3%]     Tasks: 28, 42 thr; 2 running
    2  [|||||5.8%]            Load average: 0.12 0.07 0.02
  ... (same screen as Terminal 2)
```

All three terminals show the same htop screen. Pressing `F10` in any client quits htop for everyone.

## HTTP API (--serve mode)

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check |
| GET | `/status` | PTY process info |
| GET | `/snapshot` | Visible screen as JSON |
| GET | `/snapshot?color=true` | Visible screen with ANSI color codes |
| GET | `/snapshot/visible` | Visible area only |
| GET | `/snapshot/visible?color=true` | Visible area with ANSI color codes |
| GET | `/snapshot/full` | Full buffer + scrollback |
| GET | `/snapshot/full?color=true` | Full buffer + scrollback with ANSI color codes |
| POST | `/send` | Send keystrokes `{"text": "..."}` |
| POST | `/resize` | Resize PTY `{"cols": N, "rows": N}` |

## WebSocket Protocol (--serve / --connect)

Connect to `ws://<host>:<port>` for real-time bidirectional communication.

### Server → Client messages

| Type | Fields | Description |
|---|---|---|
| `output` | `{ type: "output", text: "..." }` | PTY output stream (real-time) |
| `exit` | `{ type: "exit", exitCode: N }` | PTY process exited |

### Client → Server messages

| Type | Fields | Description |
|---|---|---|
| `input` | `{ type: "input", text: "..." }` | Send keystrokes to PTY |
| `resize` | `{ type: "resize", cols: N, rows: N }` | Resize terminal dimensions |

## Connection Handshake

1. Client connects via WebSocket
2. Client sends `{ type: "resize", cols: N, rows: N }` with its terminal dimensions
3. Server resizes the PTY to match client dimensions
4. Server sends a `visibleText` snapshot (with ANSI colors preserved) at the resized dimensions
5. Server flushes any buffered realtime output that accumulated during handshake
6. Realtime bidirectional streaming begins — PTY output broadcasts to all clients, client keystrokes relay to PTY

While waiting for the resize message, the server buffers per-client PTY output so no data is lost during the handshake.

## Programmatic API

```typescript
import { ptySpawn, ptySnapshot, ptySend, ptyKill } from "./pty.js";

const instance = ptySpawn({
  command: "top",
  cols: 200,
  rows: 40,
});

await new Promise(r => setTimeout(r, 1000));

// Default: strip ANSI codes
const snap = ptySnapshot(instance);
console.log(snap.visibleText);

// Preserve ANSI color codes: ptySnapshot(instance, footerRows, stripAnsiCodes)
const coloredSnap = ptySnapshot(instance, 20, false);
console.log(coloredSnap.visibleText); // contains ANSI escape sequences

ptyKill(instance);
```

## Architecture

### Core PTY Pipeline

```
┌──────────────┐    PTY output     ┌───────────────┐    ANSI escapes    ┌─────────────────┐
│  node-pty    │ ────────────────► │ @xterm/       │ ────────────────► │  ptySnapshot()  │
│  (spawn)     │    (raw bytes)    │ headless      │    (parsed buffer) │  (text extract) │
└──────────────┘                   │ (VT buffer)   │                    └─────────────────┘
      ▲                            └───────────────┘                           │
      │ keystrokes                                                          visibleText
      │                                                                    scrollbackLines
┌─────┴──────┐                                                                fullText
│ ptySend()  │                                                              footerLines
└────────────┘
```

- **node-pty** spawns the process in a real pseudo-terminal (PTTY), providing authentic TTY behavior including line discipline, signal handling (SIGINT via Ctrl+C), and process group management
- **@xterm/headless** parses ANSI escape sequences and maintains a VT102-compatible buffer with scrollback. It processes every byte from the PTY output, interpreting color codes, cursor movements, screen clears, and alternate screen buffer switches
- **Snapshot** reads the xterm buffer line-by-line via `getLine(i).translateToString(true)`. By default strips ANSI codes via `strip-ansi`; when `stripAnsiCodes=false`, reconstructs color codes from xterm cell attributes (`getFgColor()`, `getBgColor()`) to produce full ANSI escape sequences

### Interactive Passthrough

```
┌────────┐  keystrokes  ┌────────┐  raw bytes  ┌──────────┐
│ stdin  │ ──────────► │ pty    │ ──────────► │ stdout   │
│ (raw)  │             │ write  │             │ (output) │
└────────┘             └────────┘             └──────────┘
                          ▲   │
                     resize │ │ onData
                          │   ▼
                     tty size  PTY
```

- `stdin.setRawMode(true)` puts the terminal in character-at-a-time mode (no line buffering), so every keystroke is sent immediately to the PTY
- `process.stdout.on("resize")` detects SIGWINCH and relays new dimensions to the PTY via `ptyResize()`
- PTY output flows directly to stdout with no transformation — full color and cursor control preserved

### Serve Mode (HTTP + WebSocket)

```
                     ┌─────────────────────────────────────────────┐
                     │              PTY Server                      │
                     │                                             │
┌──────────┐  HTTP   │  ┌──────────┐    ┌───────────────────────┐  │
│ Browser  │ ◄─────► │  │ Express  │    │ node-pty (htop)       │  │
│ / curl   │  REST   │  │ routes   │◄──►│ @xterm/headless       │  │
└──────────┘         │  │          │    └──────────┬────────────┘  │
                     └──────────┬─┘               │               │
                                │                 │ broadcast     │
                     ┌──────────┴─────────────────┼──────────────┐│
                     │         WebSocket          │              ││
                     │  ┌────────┐  ┌────────┐  ┌────────┐      ││
                     │  │Client A│  │Client B│  │Client C│ ...  ││
                     │  └────────┘  └────────┘  └────────┘      ││
                     └─────────────────────────────────────────────┘
```

**Per-client connection flow:**

1. WebSocket connection accepted, client added to `clients` Set
2. Server sends `visibleText` snapshot immediately (full buffer at server dimensions, colors preserved via `ptySnapshot(instance, rows, false)`)
3. `instance.process.onData()` broadcasts every PTY output byte to all connected clients as `{ type: "output", text: data }`
4. Client messages parsed: `input` → `ptySend()`, `resize` → `ptyResize()`
5. On close, client removed from Set; on PTY exit, all clients notified

The HTTP server and WebSocket server share the same port via `new WebSocketServer({ server })`.

### Connect Mode (WebSocket Client)

```
┌─────────────────────────────────────────────────────────┐
│                    Connect Client                        │
│                                                         │
│  stdin (raw mode) ──► WebSocket ──► Server PTY          │
│                        ↑              │                 │
│                        │   output     │                 │
│                        └──────────────┘                 │
│                                                         │
│  stdout ◄── process.stdout.write(snapshot + realtime)  │
│  stderr ◄── status messages (connect, disconnect)       │
│                                                         │
│  SIGWINCH (resize) ──► WebSocket ──► Server resize     │
└─────────────────────────────────────────────────────────┘
```

- `stdin.setRawMode(true)` enabled **before** WebSocket connects, so keystrokes are captured immediately
- On `ws.on("open")`, client sends `{ type: "resize", cols, rows }` with its terminal dimensions
- Server resizes the PTY and sends back a snapshot matching the client's size — screen reflows to client resolution
- Keystrokes sent as `{ type: "input", text: key }` — relayed to PTY by server
- Resize events (`SIGWINCH`) relayed to server — all clients see the reflowed screen
- Status messages go to `stderr` to avoid mixing with PTY output on `stdout`
- Ctrl+C (`\x03`) closes WebSocket and exits cleanly

### Multi-Client Shared PTY

All WebSocket clients share a **single** PTY instance. This means:

- **One process tree** — only one `htop`, one `top`, one shell instance
- **Shared dimensions** — when any client resizes, the PTY resizes for everyone (like `tmux` attach)
- **Broadcast output** — every byte from PTY output goes to all clients simultaneously
- **Any client can type** — keystrokes from any client go to the shared PTY (like pair programming)
- **Shared scrollback** — all clients see the same scrollback history

This differs from per-client PTY spawning where each client gets its own process. The shared model is ideal for monitoring dashboards, pair debugging, or broadcasting a TUI session to multiple observers.

### ANSI Color Reconstruction

When `stripAnsiCodes=false`, the snapshot reconstructs ANSI escape codes from xterm cell attributes:

```typescript
function lineToAnsiString(line: any): string {
  for (let col = 0; col < line.length; col++) {
    const cell = line.getCell(col);
    const fg = cell?.getFgColor();  // integer color value (0-255 for 256-color)
    const bg = cell?.getBgColor();
    // Emit \x1b[38;5;{fg}m for foreground
    // Emit \x1b[48;5;{bg}m for background
    // Emit \x1b[0m for reset
  }
}
```

This produces terminal-renderable output that preserves the original color scheme (directory colors in `ls --color`, syntax highlighting in `htop`, etc.).

## Comparison with Similar Projects

No single tool combines all these features. Here's the landscape:

| Feature | pty.ts | [ttyd](https://github.com/tsl0922/ttyd) | [Wetty](https://github.com/burke/wetty) | [gotty](https://github.com/yudai/gotty) | [tmux](https://github.com/tmux/tmux) | [tmate](https://tmate.io/) |
|---|---|---|---|---|---|---|
| **Purpose** | PTY library + CLI | Web terminal sharing | Web-based SSH/Terminal | Terminal sharing over web | Terminal multiplexer | Instant terminal sharing |
| **Language** | TypeScript (Node.js) | C + libwebsockets | Node.js | Go | C | C |
| **Backend PTY** | node-pty | libtty/Unix PTY | node-pty / pty.js | Unix PTY | Unix PTY | Unix PTY |
| **Frontend** | None (bring your own) | xterm.js in browser | xterm.js in browser | xterm.js in browser | Terminal emulator | Terminal emulator |
| **Multi-client** | Shared PTY via WebSocket | One client per session | One client per session | One client (abandoned) | Shared session via attach | One viewer |
| **HTTP API** | REST + snapshots | No (WebSocket only) | No (WebSocket only) | No (WebSocket only) | No | No |
| **Embeddable** | Yes (import as library) | No (standalone binary) | No (standalone server) | No (standalone binary) | No | No |
| **Buffer parsing** | @xterm/headless (structured) | xterm.js (rendering) | xterm.js (rendering) | xterm.js (rendering) | Native terminal | Native terminal |
| **Snapshot API** | JSON structured (visible/full/scrollback) | No | No | No | No | No |
| **TUI screen parser** | Built-in (qodercli parser) | No | No | No | No | No |
| **ANSI color export** | Cell-level reconstruction | Passthrough only | Passthrough only | Passthrough only | N/A | N/A |
| **CLI flags** | `--serve`, `--connect`, `--snapshot`, `--color` | `--port`, `--interface` | `--port`, `--ssh` | `--port`, `--cred` | `-S`, `-t` | `--port` |
| **Status** | Active | Active | Active | Abandoned | Active | Active |

### What pty.ts does that nothing else does

1. **Structured snapshot API** — `GET /snapshot` returns JSON with `visibleText`, `scrollbackLines`, `footerLines`, `fullText` — no tool exports the terminal buffer as structured data
2. **ANSI color reconstruction** — rebuilds color codes from xterm cell attributes (`getFgColor()`, `getBgColor()`) for export — others only passthrough raw bytes
3. **Multi-client broadcast** — one PTY, many WebSocket clients, all seeing and controlling the same session — tmux does this locally but not over HTTP/WebSocket
4. **Embeddable library** — import `ptySpawn`, `ptySnapshot`, `ptySend` into any Node.js app — ttyd/Wetty are standalone binaries you can't embed
5. **HTTP + WebSocket on same port** — REST polling endpoints alongside real-time streaming — no other tool offers both
6. **TUI screen parser** — built-in parser that extracts structured messages from TUI apps (like qodercli's conversation) — unique

### When to use pty.ts

- **You need a library, not a server** — import `ptySpawn`, `ptySnapshot`, `ptySend` into your own Node.js app
- **You want programmatic screen access** — snapshot the TUI buffer as structured JSON (visible lines, scrollback, footer sections)
- **You need multi-client broadcast** — one PTY, multiple WebSocket clients all seeing and controlling the same session
- **You want both HTTP and WebSocket APIs** — REST endpoints for polling snapshots, WebSocket for real-time streaming
- **You need ANSI color reconstruction** — export color information from the terminal buffer as structured data, not just raw passthrough
- **You're building a TUI debugger or monitor** — attach to a running PTY session, take snapshots, send keystrokes, resize — all programmatically

### When to use something else

- **ttyd** — if you want a ready-to-use binary that shares a terminal in a browser with zero code
- **Wetty** — if you want web-based SSH access to remote servers
- **tmux** — if you want terminal multiplexing on a local machine with native performance
- **tmate** — if you want instant terminal sharing over the internet with a simple URL
