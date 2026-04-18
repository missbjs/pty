# pty.ts — Generic PTY Process Manager

Spawn any TUI application in a pseudo-terminal and interact with it via terminal passthrough, snapshot capture, or HTTP API.

## Usage

```bash
pnpm pty <command> [args...] [-- <pty-options>]
pnpm qodercli [qodercli-args...] [pty-options]
```

## Modes

| Mode | How | Description |
|---|---|---|
| **Interactive** (default) | no flags | Relay TUI to current terminal, resize passthrough (color preserved) |
| **Snapshot** | `--snapshot` | Wait, capture buffer, print, exit (ANSI stripped by default) |
| **Serve** | `--serve` | HTTP API server for upstream consumers (color via `?color=true`) |

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
| `--serve` | — | Start HTTP server |
| `--port <n>` | 3000 | Server port for --serve |
| `--host <addr>` | 127.0.0.1 | Bind address for --serve |

## Examples

```bash
# Interactive passthrough
pnpm pty top
pnpm pty htop
pnpm pty vim file.txt

# Snapshot mode
pnpm pty top -- --snapshot
pnpm pty top -- --snapshot --wait 2000 --cols 100 --rows 15
pnpm pty top -- --snapshot --color        # preserve ANSI color codes

# HTTP server mode
pnpm pty top -- --serve --port 3001
pnpm pty qodercli -- --serve --host 0.0.0.0 --port 8080

# Qodercli shortcut (qodercli pre-filled)
pnpm qodercli                          # interactive
pnpm qodercli --model auto             # interactive with model
pnpm qodercli --model auto --snapshot  # snapshot
pnpm qodercli --model auto -w /tmp --cols 120 --serve --port 3001
```

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

## Programmatic API

```typescript
import { ptySpawn, ptySnapshot, ptySend, ptyKill } from "./services/pty.js";

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

- **node-pty** — spawns the process in a real PTY
- **@xterm/headless** — parses ANSI escape sequences, maintains VT buffer
- **Snapshot** reads the xterm buffer line-by-line, strips ANSI by default (controlled by `stripAnsiCodes` param), returns structured sections (visible, scrollback, footer)
