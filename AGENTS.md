# AGENTS.md

Guide for AI agents working in this codebase.

## Project Overview

**pty** is a generic PTY (pseudo-terminal) process manager for Node.js. It spawns TUI applications in a pseudo-terminal, captures buffer snapshots, and exposes them via HTTP/WebSocket. Used for headless TUI testing, automated visual inspection, and wrapping interactive CLIs as APIs.

## Essential Commands

```bash
# Development (installed globally the same commands are `pty ...`)
pnpm dev <command> [args...] [-- <pty-options>]   # Run TUI in PTY (interactive mode)
pnpm build                                         # Build dist/pty.js + dist/pty.d.ts (Vite + tsc)
pnpm test                                          # Build, then run tests (vitest, ~1 min)

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

**Important:** `dist/` is **committed** (the package is installed straight from GitHub, which runs no build). Run `pnpm build` (or `pnpm test`, whose `pretest` builds) and commit `dist/` together with any change to `pty.ts`.

`node-pty` is a native module with prebuilt binaries for Windows/macOS; on Linux it compiles from source (python3, make, g++). `package.json` has `pnpm.onlyBuiltDependencies: ["node-pty"]` so a local `pnpm install` runs its install script; a *global* install from GitHub cannot grant that, which is harmless where prebuilds exist.

### Test Structure

Tests live in `pty.harness.test.ts` (keys, paste, wait, exit status, colour snapshots, tree kill, auth/CSRF guards, in-process server and CLI subprocess; needs only `node`; ports 3160-3169) and `pty.test.ts` (core API + WebSocket scenarios, uses Unix tools via Git Bash on Windows; port 3190). Test files run one after the other (`fileParallelism: false`).

Tests require the built artifact (`dist/pty.js`). The `pretest` script runs `pnpm build` automatically.

## Architecture

### Single-File Design

All code is in `pty.ts`. No separate modules. Exports:

- **Core API** (1.2.0 adds `ptyOutputSince`, `ptyFilterLines`, `PtyPreconditionError`): `ptySpawn`, `ptySnapshot`, `ptyScreenText`, `ptySend`, `ptyInput` (text/paste/named keys), `keyToSequence`, `ptyWait`, `ptyWaitExit`, `ptySignal`, `ptyResize`, `ptyKill`, `ptyGet`, `ptyGetAny`, `ptyList`, `ptyFinished`, `ptyCleanup`, `resolveCommand`
- **Server**: `createPtyServer({ host, port, token })` -> `{ server, wss, listen(), close() }`
- **CLI helpers**: `splitCliArgs`, `parseEnvPairs`, `isLoopbackHost`
- **Types**: `PtyInstance`, `BufferSnapshot`, `PtySpawnOptions`, `PtyWaitOptions`, `PtyInputOptions`
- **CLI**: runs only when this file is the executed program (`realpath(process.argv[1]) === realpath(import.meta.url)`). Do NOT gate it on `NODE_ENV`/`VITEST` — child servers spawned by tests inherit those variables.

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

When `stripAnsiCodes: false`, the snapshot reconstructs ANSI codes from xterm cell attributes (`cellSgr()` / `lineToAnsiString()`): bold, dim, italic, underline, blink, inverse, invisible, strikethrough, 256-palette (`38;5;N`) and truecolor (`38;2;r;g;b`) foreground/background. Trailing blank unstyled cells are trimmed and wide-char continuation cells skipped. Still lossy for underline colour/style variants and hyperlinks.

### Stream offsets, guards, killed flag (1.2.0)

- `instance.outputBytes` is a monotonically increasing count of PTY output characters = the stream **offset**. Each app also keeps the last ~2M chars of raw output (`tail`/`tailStart`). `ptyWait({ after | newOnly, minNewBytes })` matches `text`/`regex` against `ptyOutputSince(inst, offset)` (ANSI-stripped raw output) instead of the screen, so stale on-screen text can't match. `/send` returns the pre-send offset, `/wait` the offset at return.
- `ptyInput({ require })` throws `PtyPreconditionError` (HTTP 412) when the visible screen lacks the text; `GET /snapshot?expect=` does the same for reads. CLI exit code 3.
- `ptyInput({ paste, newlineAs })`: any key name (or `lf`) types the paste line by line with that key between lines (ConPTY drops bracketed-paste markers, so this is the reliable multi-line entry); `literal` = untouched; default = CR-joined + bracketed markers.
- `instance.killed` is set by `ptyKill`/`ptySignal`; status/kill replies expose `killed` and `exitStatus` ("running" | "exited" | "killed"). Raw `exitCode` of a killed app is `-1073741510` on Windows.
- SGR mouse wheel buttons are 64/65/66/67 (+16 with Ctrl), not the X11 4/5/6/7.
- `--screen --tail/--grep` and `snapshot?tail=&grep=` use `ptyFilterLines` (trim trailing blanks, grep on ANSI-stripped text, then tail).

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

- Windows/macOS use prebuilt binaries (no compiler needed); Linux must compile (python3, make, g++) and rebuild on Node version change
- `pnpm.onlyBuiltDependencies: ["node-pty"]` in package.json lets pnpm >= 10 run its install script locally
- Windows ConPTY quirks: input is re-encoded (`ESC O A` -> `ESC [ A`), bracketed-paste markers on input are dropped, there are no POSIX signals (`ptySignal` kills), and a node process holding a ConPTY child will not exit by itself — use `process.exit`.

### Terminal Size Defaults

Default is 400 cols × 40 rows (very wide). This prevents line wrapping for most apps. If you need realistic sizes, pass `--cols` and `--rows` or let it detect from TTY.

### Arg Splitting

CLI splits args at `--` separator, or at first PTY flag if no `--`:

```bash
pnpm dev my-app --model auto --snapshot
# → command: "my-app", args: ["--model", "auto"], ptyOpts: ["--snapshot"]
```

PTY flags: `--cols`, `--rows`, `--cwd`, `--term`, `--wait`, `--color`, `--interactive`, `--snapshot`, `--serve`, `--connect`, `--port`, `--host`, plus the client flags (`--start --list --kill --screen --status --send --wait-for --env --token --json ...`; see `splitCliArgs()`). When the first token is a command, only the historic flags split without a `--`. `--start <cmd> a b c` takes `a b c` as the command's args until the next pty flag (`--` forces the rest).

### Process Exit Detection

On POSIX `node-pty` doesn't throw for non-existent commands — it spawns successfully, then the process exits immediately with non-zero code (on Windows `ptySpawn` throws `Failed to spawn ...`). The code detects this via:

1. Exit code ≠ 0
2. Output < 500 bytes
3. Output contains "not found" / "No such file" / "execvp"

### Instance Cleanup

Running instances are tracked in `instances`; on exit they move to `finished` (last 20 kept, with final screen, `exitCode`, `signal`) so harnesses can read the result after the app died. On shutdown:
- `process.on("exit")` → `ptyCleanup()` kills all
- `process.on("SIGINT/SIGTERM")` → cleanup + exit
- `ptyKill()` is a no-op for exited apps, closes the pseudo-console (kills the tree on Windows) and escalates to `taskkill /T /F` / process-group SIGKILL after 1.5 s.

## Skills

This repo includes skills for TUI development workflows:

- **tui-debugging**: Debug TUI apps across frameworks (Ratatui, Bubbletea, Textual, Ink, ncurses, blessed)
- **tui-to-api**: Wrap TUI CLIs as HTTP APIs (spawnSync patterns, SSE streaming, PRoot constraints)
- **serve-connect-loop**: Automated TUI dev workflow — serve TUI, AI connects to observe, debug/fix, loop

Skills are in `skills/<name>/SKILL.md`. Each includes scripts and reference docs.

## Testing Notes

### WebSocket Tests

The WebSocket test suite spawns a real server process (`dist/pty.js`) on port 3190. Tests:
- HTTP endpoints (`/health`, `/snapshot`, `/status`, `/send`, `/resize`)
- WebSocket connection and message protocol
- Multi-client broadcast

If port 3190 is in use, tests will fail. Kill any lingering processes:

```bash
lsof -i :3190  # or check /proc on systems without lsof
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
