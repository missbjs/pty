# AGENTS.md

Guide for AI agents working in this codebase.

## Project Overview

**pty** is a generic PTY (pseudo-terminal) process manager for Node.js. It spawns TUI applications in a pseudo-terminal, captures buffer snapshots, and exposes them via HTTP/WebSocket. Used for headless TUI testing, automated visual inspection, and wrapping interactive CLIs as APIs.

## Essential Commands

```bash
# Development
pnpm dev <command> [args...] [-- <pty-options>]   # Run TUI in PTY (interactive mode)
pnpm build                                         # Build dist/pty.js (Vite + tsc)
pnpm test                                          # Run tests (vitest)

# Examples
pnpm dev top                                       # Run top in PTY
pnpm dev htop -- --serve --port 3000               # Serve htop over HTTP+WS
pnpm dev vim file.txt -- --snapshot                # Capture snapshot and exit
pnpm dev -- --connect --port 3000                  # Connect to existing server
```

### Build Process

The build is two-step:
1. `vite build` — bundles to ESM, externalizes native deps
2. `tsc --emitDeclarationOnly` — generates `.d.ts` types

**Important:** `node-pty` is a native module. It must be rebuilt when Node version changes. If `pnpm install` fails with node-gyp errors, ensure build tools are available (python3, make, g++).

### Test Structure

Tests are in `pty.test.ts`. Two test suites:
- Core PTY API tests (spawn, snapshot, send, resize, etc.)
- WebSocket serve/connect integration tests (spawn server process, test HTTP endpoints)

Tests require the built artifact (`dist/pty.js`). The `pretest` script runs `vite build` automatically.

## Architecture

### Single-File Design

All code is in `pty.ts` (~800 lines). No separate modules. Exports:

- **Core API**: `ptySpawn`, `ptySnapshot`, `ptySend`, `ptySignal`, `ptyResize`, `ptyKill`, `ptyGet`, `ptyList`, `ptyCleanup`
- **Types**: `PtyInstance`, `BufferSnapshot`, `PtySpawnOptions`
- **CLI**: Runs when `import.meta.url === file://${process.argv[1]}`

### Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│  ptySpawn({ command, args, cols, rows })                    │
│    ↓                                                         │
│  node-pty.spawn() → PTY process                              │
│    ↓                                                         │
│  @xterm/headless Terminal (buffer renderer)                  │
│    ↓ onData                                                  │
│  vt.write(data) → xterm buffer updates                       │
│    ↓                                                         │
│  ptySnapshot() → BufferSnapshot                              │
│    { fullLines, visibleLines, scrollbackLines, fullText, ... }│
└─────────────────────────────────────────────────────────────┘
```

### Key Components

1. **PTY Process** (`node-pty`): Spawns the child process with a PTY attached
2. **xterm Headless** (`@xterm/headless`): Renders PTY output into a buffer (no display)
3. **Buffer Snapshot**: Extracts text from xterm buffer, with scrollback support
4. **ANSI Reconstruction**: `lineToAnsiString()` rebuilds ANSI codes from xterm cell attributes
5. **Output Accumulator**: Bounded at 2KB — used only for early-exit error detection

### CLI Modes

| Mode | Flag | Description |
|------|------|-------------|
| Interactive | (default) | Relay TUI to current terminal (stdin/stdout) |
| Snapshot | `--snapshot` | Capture buffer once, print, exit |
| Serve | `--serve` | HTTP API + WebSocket server |
| Connect | `--connect` | WebSocket client to existing server |

## Important Patterns

### Cursor Position Request Handling

Many TUIs send `\x1b[6n` (CPR) and wait for a response. If not answered, they hang. The code auto-responds:

```typescript
if (data.includes("\x1b[6n") || data.endsWith("\x1b[")) {
  setTimeout(() => ptyProcess.write("\x1b[1;1R"), 50);
}
```

The `data.endsWith("\x1b[")` check handles chunk boundaries where CPR is split across reads.

### Output Accumulator Cap

The `outputAccum` is capped at 2KB (`ACCUM_CAP = 2048`). This is intentional — it's only used to detect "command not found" errors on early exit (< 500 bytes). The xterm buffer has no cap and captures all output.

### ANSI Color Reconstruction

When `stripAnsiCodes: false`, the snapshot reconstructs ANSI codes from xterm cell attributes:

```typescript
function lineToAnsiString(line: any): string {
  // For each cell: getFgColor(), getBgColor() → emit \e[38;5;Nm codes
}
```

This is lossy — only 256-color palette is reconstructed, not truecolor (RGB).

### WebSocket Multi-Client

In serve mode, all WebSocket clients share the same PTY. Output is broadcast to all. When a client sends resize, it affects all clients (PTY has one size).

Clients must send `{ type: "resize", cols, rows }` before receiving output — this triggers initial snapshot send and flushes buffered output.

## Gotchas

### pnpm Install Issues

pnpm's strict dependency hoisting causes issues with native modules and Vite. The fix is to use `node-linker=hoisted` in `.npmrc`:

```bash
# .npmrc
node-linker=hoisted
```

Then install and build normally:
```bash
pnpm install --ignore-scripts
cd node_modules/node-pty && node-gyp rebuild
pnpm build
```

**Why this works**: `node-linker=hoisted` makes pnpm create a flat node_modules like npm/yarn, which allows Vite and node-pty to find their dependencies.

### node-pty Native Module

- Must rebuild on Node version change
- Fails if build tools missing (python3, make, g++)
- `approvedBuilds: ["node-pty"]` in package.json signals it's safe to run postinstall scripts

### Terminal Size Defaults

Default is 400 cols × 40 rows (very wide). This prevents line wrapping for most apps. If you need realistic sizes, pass `--cols` and `--rows` or let it detect from TTY.

### Arg Splitting

CLI splits args at `--` separator, or at first PTY flag if no `--`:

```bash
pnpm dev my-app --model auto --snapshot
# → command: "my-app", args: ["--model", "auto"], ptyOpts: ["--snapshot"]
```

PTY flags: `--cols`, `--rows`, `--cwd`, `--term`, `--wait`, `--color`, `--interactive`, `--snapshot`, `--serve`, `--connect`, `--port`, `--host`

### Process Exit Detection

`node-pty` doesn't throw for non-existent commands — it spawns successfully, then the process exits immediately with non-zero code. The code detects this via:

1. Exit code ≠ 0
2. Output < 500 bytes
3. Output contains "not found" / "No such file" / "execvp"

### Instance Cleanup

Instances are tracked in a `Map<string, PtyInstance>`. On exit:
- `process.on("exit")` → `ptyCleanup()` kills all
- `process.on("SIGINT/SIGTERM")` → cleanup + exit
- Individual `ptyKill()` removes from map

After process exit, instance is deleted after 5 second delay (allows late snapshot).

## Skills

This repo includes skills for TUI development workflows:

- **tui-debugging**: Debug TUI apps across frameworks (Ratatui, Bubbletea, Textual, Ink, ncurses, blessed)
- **tui-to-api**: Wrap TUI CLIs as HTTP APIs (spawnSync patterns, SSE streaming, PRoot constraints)
- **serve-connect-loop**: Automated TUI dev workflow — serve TUI, AI connects to observe, debug/fix, loop

Skills are in `skills/<name>/SKILL.md`. Each includes scripts and reference docs.

## Testing Notes

### WebSocket Tests

The WebSocket test suite spawns a real server process (`dist/pty.js`) on port 13099. Tests:
- HTTP endpoints (`/health`, `/snapshot`, `/status`, `/send`, `/resize`)
- WebSocket connection and message protocol
- Multi-client broadcast

If port 13099 is in use, tests will fail. Kill any lingering processes:

```bash
lsof -i :13099  # or check /proc on systems without lsof
```

### Timing Dependencies

Tests use `setTimeout` to wait for process output. If tests flake:
- Increase wait times (process spawn/render takes time)
- Check if CI environment is slower

## Code Style

- TypeScript with ES2022 target, ESNext modules
- Strict mode enabled
- No runtime type checking (types are for dev only)
- Comments explain non-obvious logic (e.g., CPR handling, accum cap)
- No external validation libraries — manual checks in HTTP handlers
