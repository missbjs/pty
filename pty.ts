#!/usr/bin/env node
// PTY Utility Service — a mini OS for TUI applications
// Spawn any process in a PTY, send keystrokes, read full buffer, take snapshots.
import * as pty from "node-pty";
import xtermHeadless from "@xterm/headless";
import stripAnsi from "strip-ansi";
import { randomUUID } from "crypto";
import { WebSocketServer, WebSocket as WsClient } from "ws";
import { existsSync } from "node:fs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Terminal = (xtermHeadless as any).Terminal;

// ── Constants ───────────────────────────────────────────────────────────────
const DEFAULT_COLS = 400;
const DEFAULT_ROWS = 40;
const MAX_PENDING_OUTPUT = 1000;
const MAX_DIMENSION = 10000; // Max cols or rows per dimension (allows 10000x10000 = 100M cells)

// ── Types ──────────────────────────────────────────────────────────────────

export interface PtyInstance {
  id: string;
  name: string; // human-readable name (command)
  command: string;
  args: string[];
  process: pty.IPty;
  terminal: any; // xterm headless terminal
  cols: number;
  rows: number;
  cwd: string;
  createdAt: number;
  clients: Set<WsClient>; // connected WebSocket clients
  applicationCursorKeys: boolean; // DECCKM mode - translate ESC[ to ESCO for arrow keys
}

export interface BufferSnapshot {
  /** Full buffer: all lines including scrollback */
  fullLines: string[];
  /** Only the visible area (bottom `rows` lines) */
  visibleLines: string[];
  /** Everything above the visible area */
  scrollbackLines: string[];
  /** Full buffer as single string (clean, no ANSI) */
  fullText: string;
  /** Visible area as single string */
  visibleText: string;
  /** Footer N lines */
  footerLines: string[];
  /** Footer as string */
  footerText: string;
  /** Raw buffer dimensions */
  bufLength: number;
  bufCols: number;
  bufRows: number;
  baseY: number; // how many lines scrolled off top
}

export interface PtySpawnOptions {
  command: string;
  args?: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string | undefined>;
  /** Terminal type name */
  term?: string;
}

// ── ANSI Color Reconstruction ──────────────────────────────────────────

/**
 * Convert an xterm.js line to a string with ANSI escape codes reconstructed
 * from cell color attributes.
 */
function lineToAnsiString(line: any): string {
  let result = "";
  let lastFg: number | null = null;
  let lastBg: number | null = null;

  for (let col = 0; col < line.length; col++) {
    const cell = line.getCell(col);
    const chars = cell?.getChars() ?? "";
    const fg = cell?.getFgColor() ?? -1;
    const bg = cell?.getBgColor() ?? -1;

    if (fg !== lastFg || bg !== lastBg) {
      // Reset if back to defaults
      if (fg === -1 && bg === -1) {
        result += "\x1b[0m";
      } else {
        const codes: number[] = [];
        if (fg !== -1 && fg !== lastFg) {
          codes.push(38, 5, fg);
        }
        if (bg !== -1 && bg !== lastBg) {
          codes.push(48, 5, bg);
        }
        if (codes.length > 0) {
          result += `\x1b[${codes.join(";")}m`;
        }
      }
      lastFg = fg;
      lastBg = bg;
    }

    result += chars || " ";
  }

  // Reset at end of line
  if (lastFg !== null || lastBg !== null) {
    result += "\x1b[0m";
  }

  return result;
}

// ── Service ────────────────────────────────────────────────────────────────

const instances = new Map<string, PtyInstance>();
let defaultInstance: PtyInstance | null = null; // for backward compat with single-app mode

/** Resolve a command to its full path using Windows PATH */
function resolveCommand(cmd: string): string {
  // If already a full path or has extension, return as-is
  if (cmd.includes("/") || cmd.includes("\\") || cmd.includes(".")) {
    return cmd;
  }
  // Search PATH manually
  const pathDirs = (process.env.PATH || "").split(process.platform === "win32" ? ";" : ":");
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ".com"] : [""];
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const ext of extensions) {
      const fullPath = `${dir}\\${cmd}${ext}`;
      if (existsSync(fullPath)) {
        return fullPath;
      }
    }
  }
  return cmd;
}

/** Spawn a new process in a PTY and return the instance */
export function ptySpawn(opts: PtySpawnOptions): PtyInstance {
  const id = randomUUID();

  const cols = opts.cols ?? DEFAULT_COLS; // wide default to avoid line wrapping
  const rows = opts.rows ?? DEFAULT_ROWS;
  const term = opts.term ?? "xterm-256color";
  const cwd = opts.cwd ?? process.cwd();
  const resolvedCommand = resolveCommand(opts.command);

  let ptyProcess: pty.IPty;
  try {
    ptyProcess = pty.spawn(resolvedCommand, opts.args ?? [], {
      name: term,
      cols,
      rows,
      cwd,
      env: { ...process.env, COLORTERM: "truecolor", TERM: term, ...(opts.env ?? {}) },
    });
  } catch (err: any) {
    throw new Error(`Failed to spawn "${opts.command}": ${err.message}`);
  }

  const vt = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 10000 });

  // Feed PTY output into xterm buffer and respond to terminal probes.
  // outputAccum is bounded — only used to detect early-exit "command not found"
  // errors (the threshold check on exit is < 500 bytes), so stop accumulating
  // past a small cap to avoid unbounded growth on long-running PTYs.
  const ACCUM_CAP = 2048;
  let outputAccum = "";
  ptyProcess.onData((data) => {
    if (outputAccum.length < ACCUM_CAP) {
      outputAccum += data;
      if (outputAccum.length > ACCUM_CAP) outputAccum = outputAccum.slice(0, ACCUM_CAP);
    }
    vt.write(data);

    // Respond to terminal probe sequences so TUI apps render properly:
    // \x1b[6n = Cursor Position Request → respond with \x1b[1;1R
    // The trailing-\x1b[ check covers chunk boundaries that split the CPR
    // sequence — many TUIs hang waiting for the reply if it's missed.
    if (data.includes("\x1b[6n") || data.endsWith("\x1b[")) {
      setTimeout(() => ptyProcess.write("\x1b[1;1R"), 50);
    }
  });

  const instance: PtyInstance = {
    id,
    name: opts.command,
    command: opts.command,
    args: opts.args ?? [],
    process: ptyProcess,
    terminal: vt,
    cols,
    rows,
    cwd,
    createdAt: Date.now(),
    clients: new Set(),
    applicationCursorKeys: false,
  };

  // Track DECCKM (application cursor keys mode) from app output
  const trackModes = (data: string) => {
    // \x1b[?1h = enable application cursor keys (ESC O A/B/C/D)
    // \x1b[?1l = disable (standard ESC [ A/B/C/D)
    if (data.includes("\x1b[?1h") && !instance.applicationCursorKeys) {
      instance.applicationCursorKeys = true;
      // Broadcast mode change to all connected clients
      for (const client of instance.clients) {
        if (client.readyState === WsClient.OPEN) {
          client.send(JSON.stringify({ type: "mode", applicationCursorKeys: true }));
        }
      }
    }
    if (data.includes("\x1b[?1l") && instance.applicationCursorKeys) {
      instance.applicationCursorKeys = false;
      // Broadcast mode change to all connected clients
      for (const client of instance.clients) {
        if (client.readyState === WsClient.OPEN) {
          client.send(JSON.stringify({ type: "mode", applicationCursorKeys: false }));
        }
      }
    }
  };
  ptyProcess.onData(trackModes);

  instances.set(id, instance);

  ptyProcess.onExit(({ exitCode }) => {
    // Notify connected clients
    for (const client of instance.clients) {
      if (client.readyState === WsClient.OPEN) {
        client.send(JSON.stringify({ type: "exit", exitCode, id }));
        client.close();
      }
    }
    instance.clients.clear();
    instances.delete(id);
    
    if (exitCode !== 0 && outputAccum.trim().length < 500) {
      const clean = outputAccum.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").trim();
      if (clean.includes("No such file") || clean.includes("not found") || clean.includes("execvp")) {
        console.error(`Error: command "${opts.command}" not found`);
      }
    }
  });

  return instance;
}

/** Get a snapshot of the full buffer */
export function ptySnapshot(instance: PtyInstance, footerRows: number = 20, stripAnsiCodes: boolean = true): BufferSnapshot {
  const buf = instance.terminal.buffer.active;

  // Read FULL buffer (scrollback + visible)
  const fullLines: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) {
      fullLines.push("");
      continue;
    }
    if (stripAnsiCodes) {
      fullLines.push(stripAnsi(line.translateToString(true)));
    } else {
      // Reconstruct ANSI codes from xterm cell attributes
      fullLines.push(lineToAnsiString(line));
    }
  }

  // Visible = last `rows` lines
  const visibleLines = fullLines.slice(-instance.rows);
  // Scrollback = everything above visible
  const scrollbackLines = fullLines.slice(0, -instance.rows);
  // Footer = last N lines of the FULL buffer
  const footerLines = fullLines.slice(-footerRows);

  return {
    fullLines,
    visibleLines,
    scrollbackLines,
    fullText: fullLines.join("\n"),
    visibleText: visibleLines.join("\n"),
    footerLines,
    footerText: footerLines.join("\n"),
    bufLength: buf.length,
    bufCols: instance.cols,
    bufRows: instance.rows,
    baseY: buf.baseY,
  };
}

/** Send keystrokes to the PTY */
export function ptySend(instance: PtyInstance, text: string): void {
  // Note: Arrow key translation is handled by WebSocket clients based on mode
  // HTTP /send endpoint clients should send correct sequences for the app
  instance.process.write(text);
}

/** Send a signal to the PTY process */
export function ptySignal(instance: PtyInstance, signal: string): void {
  try {
    instance.process.kill(signal);
  } catch {
    // already dead
  }
}

/** Resize the PTY */
export function ptyResize(instance: PtyInstance, cols: number, rows: number): void {
  instance.process.resize(cols, rows);
  instance.terminal.resize(cols, rows);
  instance.cols = cols;
  instance.rows = rows;
}

/** Kill the PTY process */
export function ptyKill(instance: PtyInstance): void {
  try { instance.process.kill(); } catch {}
  // Don't clear clients here - let onExit handler notify them first
  // instances.delete will happen in onExit handler after notification
}

/** Get a PTY instance by ID */
export function ptyGet(id: string): PtyInstance | undefined {
  return instances.get(id);
}

/** List all active PTY instances */
export function ptyList(): PtyInstance[] {
  return [...instances.values()];
}

/** Get the first/default instance */
export function ptyDefault(): PtyInstance | undefined {
  return defaultInstance ?? instances.values().next().value;
}

/** Set the default instance */
export function ptySetDefault(instance: PtyInstance | null): void {
  defaultInstance = instance;
}

/** Cleanup all PTY instances */
export function ptyCleanup(): void {
  for (const [, inst] of instances) {
    try { inst.process.kill(); } catch {}
  }
  instances.clear();
}

// ── Mouse/Touch Event Encoding ────────────────────────────────────────────

/**
 * Encode mouse events as ANSI escape sequences.
 * Supports click, scroll, wheel events using X10/SGR encoding.
 * 
 * Mouse protocol modes (must be enabled by app):
 * - X10: \x1b[M Cb Cx Cy (basic, 0-223 coords)
 * - SGR: \x1b[< Cb ; Cx ; Cy M/m (extended, any coords, release detection)
 */
function encodeMouseEvent(msg: { event: string; button?: number; x?: number; y?: number; dx?: number; dy?: number }): string | null {
  const { event, button = 0, x = 0, y = 0, dx, dy } = msg;
  
  // SGR extended mouse encoding (most compatible with modern terminals)
  // Format: \x1b[< Cb ; Cx ; Cy M (press) or m (release)
  
  let cb = 0; // button code
  
  switch (event) {
    case "click":
      // button: 0=left, 1=middle, 2=right, 3=release
      cb = button; // 0-3
      return `\x1b[<${cb};${x};${y}M`;
      
    case "release":
      cb = button; // same as click but with 'm' suffix
      return `\x1b[<${cb};${x};${y}m`;
      
    case "scroll":
    case "wheel":
      // Scroll/wheel: button 4=scroll up, 5=scroll down
      // dx/dy indicate direction: dy < 0 = up, dy > 0 = down
      if (dy !== undefined) {
        cb = dy < 0 ? 4 : 5;
      } else if (dx !== undefined) {
        // Horizontal scroll: 6=left, 7=right (less common)
        cb = dx < 0 ? 6 : 7;
      } else {
        cb = 4; // default scroll up
      }
      return `\x1b[<${cb};${x};${y}M`;
      
    case "drag":
      // Drag: button + 32 (motion indicator)
      cb = (button ?? 0) + 32;
      return `\x1b[<${cb};${x};${y}M`;
      
    case "move":
      // Mouse move without button (requires mouse tracking mode 1003)
      cb = 32; // motion with no button
      return `\x1b[<${cb};${x};${y}M`;
      
    default:
      return null;
  }
}

/**
 * Encode touch events as ANSI sequences.
 * Touch events are mapped to mouse-like sequences since terminals
 * don't have native touch support.
 */
function encodeTouchEvent(msg: { event: string; x?: number; y?: number; dx?: number; dy?: number; scale?: number }): string | null {
  const { event, x = 0, y = 0, dx, dy, scale } = msg;
  
  switch (event) {
    case "tap":
      // Single tap → left click
      return `\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`;
      
    case "doubletap":
      // Double tap → double click (button code + 2 for double)
      // Note: requires app to support double-click detection
      return `\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`;
      
    case "longpress":
      // Long press → right click
      return `\x1b[<2;${x};${y}M\x1b[<2;${x};${y}m`;
      
    case "swipe":
      // Swipe → scroll in the same direction as finger movement
      // Swipe up (dy < 0) → scroll up (button 4), swipe down (dy > 0) → scroll down (button 5)
      if (dx !== undefined && Math.abs(dx) > Math.abs(dy ?? 0)) {
        // Horizontal swipe: swipe left (dx < 0) → scroll left (button 6), swipe right (dx > 0) → scroll right (button 7)
        const scrollButton = dx > 0 ? 7 : 6;
        return `\x1b[<${scrollButton};${x};${y}M`;
      } else if (dy !== undefined) {
        // Vertical swipe: swipe up (dy < 0) → scroll up (button 4), swipe down (dy > 0) → scroll down (button 5)
        const scrollButton = dy > 0 ? 5 : 4;
        return `\x1b[<${scrollButton};${x};${y}M`;
      }
      return null;
      
    case "pinch":
      // Pinch gesture → Ctrl+scroll (zoom)
      // scale > 1 = zoom in, scale < 1 = zoom out
      if (scale !== undefined) {
        const scrollButton = scale > 1 ? 4 : 5;
        // Send Ctrl modifier + scroll
        const cb = scrollButton + 16; // Ctrl modifier in SGR
        return `\x1b[<${cb};${x};${y}M`;
      }
      return null;
      
    default:
      return null;
  }
}

// Auto-cleanup on exit
process.on("exit", ptyCleanup);
process.on("SIGINT", () => { ptyCleanup(); process.exit(1); });
process.on("SIGTERM", () => { ptyCleanup(); process.exit(1); });

// ── CLI entry point ───────────────────────────────────────────────────────
// Run directly: tsx pty.ts <command> [args...] [-- <pty-args>]
//
// Examples:
//   tsx src/services/pty.ts top
//   tsx src/services/pty.ts htop
//   tsx src/services/pty.ts ls -la
//   tsx src/services/pty.ts python -- -c "print('hello')"

// Normalize Windows paths (backslashes → forward slashes) for comparison
function normalizeUrlPath(url: string): string {
  return url.replace(/\\/g, "/").replace(/^file:\/+/, "file://");
}

const isMain = (() => {
  // Skip CLI when running in test mode (vitest sets NODE_ENV=test or VITE_TEST)
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return false;
  // Always run CLI when executed directly - vite bundles everything into one file
  // so import.meta.url and process.argv[1] will always match for the bundled output
  return true;
})()

if (isMain) {
  (async () => {
    const args = process.argv.slice(2);
    if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
      console.log(`Usage: tsx pty.ts [command] [args...] [-- <options>]

PTY Service Manager — spawn, manage, and interact with TUI applications.

Server mode:
  --serve                    Start PTY service manager (HTTP + WebSocket)
  --port <n>                 Server port (default: 3000)
  --host <addr>              Bind address (default: 127.0.0.1)

Client commands (requires running server):
  --start <cmd> [args...]    Spawn a new TUI application
  --list                     List all running applications
  --kill <id>                Kill an application by ID (sends SIGTERM)
  --connect [id]             Connect to an app interactively (default: first)

Direct mode (no server):
  <command> [args...]        Run command directly in PTY

PTY options (after --):
  --cols <n>                 Terminal width (default: 400)
  --rows <n>                 Terminal height (default: 40)
  --cwd <dir>                Working directory
  --term <name>              Terminal type (default: xterm-256color)
  --wait <ms>                Wait before snapshot (default: 1000)
  --color                    Preserve ANSI color codes
  --interactive              Interactive passthrough (default)
  --snapshot                 Print snapshot and exit

HTTP API (--serve mode):
  GET  /apps                 List all running apps
  POST /start                Spawn new app { "command": "...", "args": [] }
  POST /kill                 Kill app { "id": "..." }
  GET  /app/:id/snapshot     Get app snapshot
  POST /app/:id/send         Send keystrokes { "text": "..." }
  POST /app/:id/resize       Resize app { "cols": N, "rows": N }
  GET  /app/:id/status       Get app status
  GET  /health               Health check
  WS   /app/:id              WebSocket for real-time I/O

WebSocket messages (client → server):
  { "type": "input", "text": "..." }           Send keystrokes
  { "type": "resize", "cols": N, "rows": N }   Resize terminal
  { "type": "mouse", "event": "...", ... }     Mouse event
  { "type": "touch", "event": "...", ... }     Touch gesture

Mouse events:
  { "type": "mouse", "event": "click", "button": 0, "x": 10, "y": 5 }
  { "type": "mouse", "event": "release", "button": 0, "x": 10, "y": 5 }
  { "type": "mouse", "event": "scroll", "x": 10, "y": 5, "dy": -1 }
  { "type": "mouse", "event": "wheel", "x": 10, "y": 5, "dy": 1 }
  { "type": "mouse", "event": "drag", "button": 0, "x": 10, "y": 5 }
  button: 0=left, 1=middle, 2=right

Touch gestures:
  { "type": "touch", "event": "tap", "x": 10, "y": 5 }
  { "type": "touch", "event": "doubletap", "x": 10, "y": 5 }
  { "type": "touch", "event": "longpress", "x": 10, "y": 5 }
  { "type": "touch", "event": "swipe", "x": 10, "y": 5, "dx": 50, "dy": 0 }
  { "type": "touch", "event": "pinch", "x": 10, "y": 5, "scale": 1.5 }

Examples:
  pnpm dev -- --serve --port 3000           # start service manager
  pnpm dev -- --start htop                  # spawn htop
  pnpm dev -- --list                        # list running apps
  pnpm dev -- --kill abc123                 # kill app by ID
  pnpm dev -- --connect abc123              # connect to specific app
  pnpm dev -- --connect                     # connect to first app
  pnpm dev htop                             # run htop directly (no server)`);
      process.exit(0);
    }

    // Split args at -- : left = command+args, right = pty options
    const PTY_FLAGS = new Set(["--cols", "--rows", "--cwd", "--term", "--wait", "--color", "--interactive", "--snapshot", "--serve", "--connect", "--port", "--host", "--start", "--list", "--kill", "--help", "-h"]);

    let cmdArgs: string[];
    let ptyOpts: string[];

    const explicitSplit = args.indexOf("--");
    if (explicitSplit !== -1) {
      cmdArgs = args.slice(0, explicitSplit);
      ptyOpts = [];
      const valueFlags = new Set(["--cols", "--rows", "--cwd", "--term", "--wait", "--port", "--host", "--start", "--kill"]);
      for (let i = explicitSplit + 1; i < args.length; i++) {
        const arg = args[i];
        if (PTY_FLAGS.has(arg)) {
          ptyOpts.push(arg);
          // If this flag takes a value, grab it too
          if (valueFlags.has(arg) && i + 1 < args.length) {
            ptyOpts.push(args[++i]);
          }
        } else {
          // Not a pty flag — goes to command
          cmdArgs.push(arg);
        }
      }
    } else {
      // No explicit separator — find the first pty flag and split there
      let firstPtyIdx = -1;
      for (let i = 0; i < args.length; i++) {
        if (PTY_FLAGS.has(args[i])) {
          firstPtyIdx = i;
          break;
        }
      }
      if (firstPtyIdx === -1) {
        cmdArgs = args;
        ptyOpts = [];
      } else if (firstPtyIdx === 0) {
        cmdArgs = [];
        ptyOpts = args;
      } else {
        cmdArgs = args.slice(0, firstPtyIdx);
        ptyOpts = args.slice(firstPtyIdx);
      }
    }

    const command = cmdArgs[0];
    const cmdRest = cmdArgs.slice(1);

    // Parse pty options
    let cols: number | undefined;
    let rows: number | undefined;
    let cwd = process.cwd();
    let term = "xterm-256color";
    let waitMs = 1000;
    let color = false;
    let interactive = false;
    let snapshot = false;
    let serve = false;
    let connect = false;
    let port = 3000;

    // Helper to parse int with bounds checking
    const parseBoundedInt = (val: string, min: number, max: number, def: number): number => {
      const parsed = parseInt(val, 10);
      if (Number.isNaN(parsed)) return def;
      return Math.min(Math.max(parsed, min), max);
    };
    let host = "127.0.0.1";
    let start: string | undefined;
    let list = false;
    let kill: string | undefined;

    // Check for help flags early (before parsing options)
    const showHelp = ptyOpts.includes("--help") || ptyOpts.includes("-h");

    for (let i = 0; i < ptyOpts.length; i++) {
      switch (ptyOpts[i]) {
        case "--cols": cols = parseBoundedInt(ptyOpts[++i], 1, MAX_DIMENSION, DEFAULT_COLS); break;
        case "--rows": rows = parseBoundedInt(ptyOpts[++i], 1, MAX_DIMENSION, DEFAULT_ROWS); break;
        case "--cwd": cwd = ptyOpts[++i]; break;
        case "--term": term = ptyOpts[++i]; break;
        case "--wait": waitMs = parseBoundedInt(ptyOpts[++i], 0, 60000, 1000); break;
        case "--color": color = true; break;
        case "--interactive": interactive = true; break;
        case "--snapshot": snapshot = true; break;
        case "--serve": serve = true; break;
        case "--connect": connect = true; break;
        case "--port": port = parseBoundedInt(ptyOpts[++i], 1, 65535, 3000); break;
        case "--host": host = ptyOpts[++i]; break;
        case "--start": start = ptyOpts[++i]; break;
        case "--list": list = true; break;
        case "--kill": kill = ptyOpts[++i]; break;
        case "--help": case "-h": break; // handled by showHelp check
      }
    }

    // Show help if requested (works whether --help is at start or after --)
    if (showHelp) {
      console.log(`Usage: tsx pty.ts [command] [args...] [-- <options>]

PTY Service Manager — spawn, manage, and interact with TUI applications.

Server mode:
  --serve                    Start PTY service manager (HTTP + WebSocket)
  --port <n>                 Server port (default: 3000)
  --host <addr>              Bind address (default: 127.0.0.1)

Client commands (requires running server):
  --start <cmd> [args...]    Spawn a new TUI application
  --list                     List all running applications
  --kill <id>                Kill an application by ID (sends SIGTERM)
  --connect [id]             Connect to an app interactively (default: first)

Direct mode (no server):
  <command> [args...]        Run command directly in PTY

PTY options (after --):
  --cols <n>                 Terminal width (default: 400)
  --rows <n>                 Terminal height (default: 40)
  --cwd <dir>                Working directory
  --term <name>              Terminal type (default: xterm-256color)
  --wait <ms>                Wait before snapshot (default: 1000)
  --color                    Preserve ANSI color codes
  --interactive              Interactive passthrough (default)
  --snapshot                 Print snapshot and exit

HTTP API (--serve mode):
  GET  /apps                 List all running apps
  POST /start                Spawn new app { "command": "...", "args": [] }
  POST /kill                 Kill app { "id": "..." }
  GET  /app/:id/snapshot     Get app snapshot
  POST /app/:id/send         Send keystrokes { "text": "..." }
  POST /app/:id/resize       Resize app { "cols": N, "rows": N }
  GET  /app/:id/status       Get app status
  GET  /health               Health check
  WS   /app/:id              WebSocket for real-time I/O

WebSocket messages (client → server):
  { "type": "input", "text": "..." }           Send keystrokes
  { "type": "resize", "cols": N, "rows": N }   Resize terminal
  { "type": "mouse", "event": "...", ... }     Mouse event
  { "type": "touch", "event": "...", ... }     Touch gesture

Mouse events:
  { "type": "mouse", "event": "click", "button": 0, "x": 10, "y": 5 }
  { "type": "mouse", "event": "release", "button": 0, "x": 10, "y": 5 }
  { "type": "mouse", "event": "scroll", "x": 10, "y": 5, "dy": -1 }
  { "type": "mouse", "event": "wheel", "x": 10, "y": 5, "dy": 1 }
  { "type": "mouse", "event": "drag", "button": 0, "x": 10, "y": 5 }
  button: 0=left, 1=middle, 2=right

Touch gestures:
  { "type": "touch", "event": "tap", "x": 10, "y": 5 }
  { "type": "touch", "event": "doubletap", "x": 10, "y": 5 }
  { "type": "touch", "event": "longpress", "x": 10, "y": 5 }
  { "type": "touch", "event": "swipe", "x": 10, "y": 5, "dx": 50, "dy": 0 }
  { "type": "touch", "event": "pinch", "x": 10, "y": 5, "scale": 1.5 }

Examples:
  pnpm dev -- --serve --port 3000           # start service manager
  pnpm dev -- --start htop                  # spawn htop
  pnpm dev -- --list                        # list running apps
  pnpm dev -- --kill abc123                 # kill app by ID
  pnpm dev -- --connect abc123              # connect to specific app
  pnpm dev -- --connect                     # connect to first app
  pnpm dev htop                             # run htop directly (no server)`);
      process.exit(0);
    }

    // Resolve cols/rows from TTY if not specified
    const defaultCols = 400;
    const defaultRows = 40;
    const resolvedCols = cols ?? (process.stdout.isTTY ? process.stdout.columns : undefined) ?? defaultCols;
    const resolvedRows = rows ?? (process.stdout.isTTY ? process.stdout.rows : undefined) ?? defaultRows;

    // Determine mode
    if (connect) {
      interactive = false;
      snapshot = false;
      serve = false;
    } else if (serve) {
      interactive = false;
      snapshot = false;
    } else if (snapshot) {
      interactive = false;
    } else {
      // Default: interactive passthrough
      interactive = true;
    }

    // ── Client commands (require running server) ─────────────────────────────
    if (start || list || kill || connect) {
      const baseUrl = `http://${host}:${port}`;
      
      // Helper for HTTP requests
      const httpGet = async (path: string) => {
        const res = await fetch(`${baseUrl}${path}`);
        return res.json();
      };
      const httpPost = async (path: string, body: object) => {
        const res = await fetch(`${baseUrl}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        return res.json();
      };

      // --list: List all running apps
      if (list) {
        try {
          const result = await httpGet("/apps") as { apps: Array<{ id: string; name: string; pid: number; cols: number; rows: number; createdAt: number }> };
          if (result.apps.length === 0) {
            console.log("No running applications.");
          } else {
            console.log("Running applications:");
            for (const app of result.apps) {
              const age = Math.round((Date.now() - app.createdAt) / 1000);
              console.log(`  ${app.id.slice(0, 8)}  ${app.name.padEnd(20)}  pid:${app.pid}  ${app.cols}x${app.rows}  ${age}s`);
            }
          }
        } catch (err: any) {
          console.error(`Failed to connect to server: ${err.message}`);
          process.exit(1);
        }
        return;
      }

      // --start: Spawn a new app
      if (start) {
        try {
          const result = await httpPost("/start", { command: start, args: cmdRest, cols, rows, cwd, term }) as { id: string; pid: number } | { error: string };
          if ("error" in result) {
            console.error(`Error: ${result.error}`);
            process.exit(1);
          }
          console.log(`Started app: ${result.id.slice(0, 8)} (pid: ${result.pid})`);
          console.log(`Connect: pnpm dev -- --connect ${result.id.slice(0, 8)} --port ${port}`);
        } catch (err: any) {
          console.error(`Failed to start app: ${err.message}`);
          process.exit(1);
        }
        return;
      }

      // --kill: Kill an app
      if (kill) {
        try {
          const result = await httpPost("/kill", { id: kill }) as { ok: boolean } | { error: string };
          if ("error" in result) {
            console.error(`Error: ${result.error}`);
            process.exit(1);
          }
          console.log(`Killed app: ${kill}`);
        } catch (err: any) {
          console.error(`Failed to kill app: ${err.message}`);
          process.exit(1);
        }
        return;
      }

      // --connect: Interactive connection to an app
      if (connect) {
        const resolvedCols = cols ?? (process.stdout.isTTY ? process.stdout.columns : undefined);
        const resolvedRows = rows ?? (process.stdout.isTTY ? process.stdout.rows : undefined);

        // Determine which app to connect to
        let appId = command; // command arg after --connect becomes the app ID
        if (!appId) {
          // Get first available app
          try {
            const result = await httpGet("/apps") as { apps: Array<{ id: string }> };
            if (result.apps.length === 0) {
              console.error("No running applications. Use --start to spawn one.");
              process.exit(1);
            }
            appId = result.apps[0].id;
            console.error(`Connecting to app: ${appId.slice(0, 8)}`);
          } catch (err: any) {
            console.error(`Failed to connect to server: ${err.message}`);
            process.exit(1);
          }
        }

        // Set up stdin first
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        process.stdin.resume();

        const ws = new WsClient(`ws://${host}:${port}/app/${appId}`);

        // Track terminal mode for arrow key translation
        let applicationCursorKeys = false;

        // Translate arrow keys based on current mode
        const translateArrowKeys = (text: string): string => {
          if (applicationCursorKeys) {
            // App expects application mode: ESC [ A/B/C/D → ESC O A/B/C/D
            return text
              .replace(/\x1b\[A/g, "\x1bOA")  // up
              .replace(/\x1b\[B/g, "\x1bOB")  // down
              .replace(/\x1b\[C/g, "\x1bOC")  // right
              .replace(/\x1b\[D/g, "\x1bOD"); // left
          }
          return text;
        };

        // Stdin → WebSocket (set up early, before connection)
        process.stdin.on("data", (data) => {
          const key = data.toString();
          if (key === "\x03") {
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
            ws.close();
            process.exit(0);
            return;
          }
          if (ws.readyState === WsClient.OPEN) {
            ws.send(JSON.stringify({ type: "input", text: translateArrowKeys(key) }));
          }
        });

        ws.on("open", () => {
          // Tell server our terminal dimensions
          if (resolvedCols && resolvedRows) {
            ws.send(JSON.stringify({ type: "resize", cols: resolvedCols, rows: resolvedRows }));
          }
          process.stderr.write(`Connected to app ${appId!.slice(0, 8)} at ws://${host}:${port}\n`);
          process.stderr.write(`Mode: remote interactive (Ctrl+C to disconnect)\n\n`);
        });

        ws.on("message", (data) => {
          let msg: { type?: string; text?: string; exitCode?: number; applicationCursorKeys?: boolean; message?: string };
          try {
            msg = JSON.parse(data.toString());
          } catch {
            process.stderr.write("Received malformed message from server\n");
            return;
          }
          if (msg.type === "output" && msg.text) {
            process.stdout.write(msg.text);
          } else if (msg.type === "exit") {
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
            process.stderr.write(`\n\nRemote process exited with code ${msg.exitCode}\n`);
            process.exit(0);
          } else if (msg.type === "mode") {
            // Server notifies of terminal mode change
            applicationCursorKeys = msg.applicationCursorKeys ?? false;
          } else if (msg.type === "ready") {
            // Server acknowledges connection
          } else if (msg.type === "error" && msg.message) {
            // Server sent error (e.g., app not found)
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
            process.stderr.write(`Error: ${msg.message}\n`);
            process.exit(1);
          }
        });

        ws.on("close", () => {
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          process.stderr.write("\nDisconnected from PTY server\n");
          process.exit(0);
        });

        ws.on("error", (err) => {
          process.stderr.write(`Connection error: ${err.message}\n`);
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          process.exit(1);
        });

        // Handle resize → send to server
        if (process.stdout.isTTY) {
          process.stdout.on("resize", () => {
            if (ws.readyState === WsClient.OPEN) {
              ws.send(JSON.stringify({
                type: "resize",
                cols: process.stdout.columns,
                rows: process.stdout.rows,
              }));
            }
          });
        }

        return;
      }
    }

    // ── Serve mode (multi-app service manager) ───────────────────────────
    if (serve) {
      const { createServer } = await import("http");

      // If a command was provided, spawn it as the initial app
      if (command) {
        console.log(`Initial app: ${command} ${cmdRest.join(" ")}`);
      }
      console.log(`Service manager starting on http://${host}:${port}`);
      console.log();

      const server = createServer(async (req, res) => {
        const url = new URL(req.url!, `http://${host}:${port}`);
        const pathname = url.pathname;

        // CORS headers
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

        // Helper to read request body
        const readBody = (): Promise<string> => new Promise((resolve) => {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", () => resolve(body));
        });

        // Helper to find app by ID (supports short IDs)
        const findApp = (id: string): PtyInstance | undefined => {
          // Try exact match first
          let app = instances.get(id);
          if (app) return app;
          // Try short ID match (first 8 chars)
          for (const [fullId, inst] of instances) {
            if (fullId.startsWith(id)) return inst;
          }
          return undefined;
        };

        try {
          // GET /apps - list all running apps
          if (req.method === "GET" && pathname === "/apps") {
            const apps = ptyList().map(inst => ({
              id: inst.id,
              name: inst.name,
              pid: inst.process.pid,
              cols: inst.cols,
              rows: inst.rows,
              cwd: inst.cwd,
              createdAt: inst.createdAt,
              clients: inst.clients.size,
            }));
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ apps }));
          }

          // POST /start - spawn a new app
          if (req.method === "POST" && pathname === "/start") {
            const body = await readBody();
            let parsed: { command?: string; args?: string[]; cols?: number; rows?: number; cwd?: string; term?: string };
            try {
              parsed = JSON.parse(body);
            } catch {
              res.writeHead(400, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({ error: "invalid JSON" }));
            }
            const { command: cmd, args = [], cols: c, rows: r, cwd: wd, term: t } = parsed;
            if (!cmd) {
              res.writeHead(400, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({ error: "command is required" }));
            }
            try {
              const inst = ptySpawn({
                command: cmd,
                args,
                cols: c ?? DEFAULT_COLS,
                rows: r ?? DEFAULT_ROWS,
                cwd: wd ?? process.cwd(),
                term: t ?? "xterm-256color",
              });
              console.log(`Started: ${cmd} (id: ${inst.id.slice(0, 8)}, pid: ${inst.process.pid})`);
              res.writeHead(200, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({ id: inst.id, pid: inst.process.pid }));
            } catch (err: any) {
              res.writeHead(400, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({ error: err.message }));
            }
          }

          // POST /kill - kill an app
          if (req.method === "POST" && pathname === "/kill") {
            const body = await readBody();
            let parsedKill: { id?: string };
            try {
              parsedKill = JSON.parse(body);
            } catch {
              res.writeHead(400, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({ error: "invalid JSON" }));
            }
            const { id } = parsedKill;
            if (!id) {
              res.writeHead(400, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({ error: "id is required" }));
            }
            const app = findApp(id);
            if (!app) {
              res.writeHead(404, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({ error: "app not found" }));
            }
            console.log(`Killed: ${app.name} (id: ${app.id.slice(0, 8)})`);
            ptyKill(app);
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: true }));
          }

          // GET /health
          if (req.method === "GET" && pathname === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ status: "ok", apps: instances.size }));
          }

          // App-specific endpoints: /app/:id/...
          const appMatch = pathname.match(/^\/app\/([^/]+)(\/.*)?$/);
          if (appMatch) {
            const appId = appMatch[1];
            const subPath = appMatch[2] || "/";
            const app = findApp(appId);
            
            if (!app) {
              res.writeHead(404, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({ error: "app not found" }));
            }

            // GET /app/:id/snapshot
            if (req.method === "GET" && subPath === "/snapshot") {
              const color = url.searchParams.get("color") === "true";
              const snap = ptySnapshot(app, 20, !color);
              res.writeHead(200, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({
                visibleText: snap.visibleText,
                visibleLines: snap.visibleLines,
                cols: app.cols,
                rows: app.rows,
                pid: app.process.pid,
              }));
            }

            // GET /app/:id/status
            if (req.method === "GET" && subPath === "/status") {
              res.writeHead(200, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({
                id: app.id,
                name: app.name,
                pid: app.process.pid,
                cols: app.cols,
                rows: app.rows,
                cwd: app.cwd,
                createdAt: app.createdAt,
                clients: app.clients.size,
              }));
            }

            // POST /app/:id/send
            if (req.method === "POST" && subPath === "/send") {
              const body = await readBody();
              let parsedSend: { text?: string };
              try {
                parsedSend = JSON.parse(body);
              } catch {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ error: "invalid JSON" }));
              }
              const { text } = parsedSend;
              if (!text) {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ error: "text is required" }));
              }
              ptySend(app, text);
              res.writeHead(200, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({ ok: true }));
            }

            // POST /app/:id/resize
            if (req.method === "POST" && subPath === "/resize") {
              const body = await readBody();
              let parsedResize: { cols?: number; rows?: number };
              try {
                parsedResize = JSON.parse(body);
              } catch {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ error: "invalid JSON" }));
              }
              const { cols: c, rows: r } = parsedResize;
              // Validate bounds
              const validCols = c ? Math.min(Math.max(1, c), MAX_DIMENSION) : undefined;
              const validRows = r ? Math.min(Math.max(1, r), MAX_DIMENSION) : undefined;
              if (validCols === undefined || validRows === undefined) {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ error: "cols and rows must be valid numbers" }));
              }
              ptyResize(app, validCols, validRows);
              res.writeHead(200, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({ ok: true, cols: c, rows: r }));
            }

            res.writeHead(404, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "unknown app endpoint" }));
          }

          // 404
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
        } catch (err) {
          console.error("HTTP handler error:", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        }
      });

      // Spawn initial app if command provided
      if (command) {
        try {
          const inst = ptySpawn({ command, args: cmdRest, cols: resolvedCols, rows: resolvedRows, cwd, term });
          ptySetDefault(inst);
          console.log(`Started: ${command} (id: ${inst.id.slice(0, 8)}, pid: ${inst.process.pid})`);
        } catch (err: any) {
          console.error(err.message);
          process.exit(1);
        }
      }

      server.listen(port, host, () => {
        console.log(`PTY service manager listening on http://${host}:${port}`);
        console.log(`Endpoints:`);
        console.log(`  GET  /apps              — list all running apps`);
        console.log(`  POST /start             — spawn new app { "command": "..." }`);
        console.log(`  POST /kill              — kill app { "id": "..." }`);
        console.log(`  GET  /app/:id/snapshot  — get app snapshot`);
        console.log(`  POST /app/:id/send      — send keystrokes`);
        console.log(`  POST /app/:id/resize    — resize app`);
        console.log(`  GET  /app/:id/status    — get app status`);
        console.log(`  GET  /health            — health check`);
        console.log(`  WS   ws://${host}:${port}/app/:id  — WebSocket for real-time I/O`);
        console.log(`\nCtrl+C to stop`);
      });

      // ── WebSocket server for per-app real-time I/O ─────────────────────
      const wss = new WebSocketServer({ server });

      wss.on("connection", (ws, req) => {
        // Parse app ID from URL: /app/:id
        const urlPath = req.url?.split("?")[0] || "/";
        const appMatch = urlPath.match(/^\/app\/([^/]+)$/);
        
        if (!appMatch) {
          ws.close();
          return;
        }

        const appId = appMatch[1];
        // Find app by ID (supports short IDs)
        let app: PtyInstance | undefined;
        for (const [fullId, inst] of instances) {
          if (fullId === appId || fullId.startsWith(appId)) {
            app = inst;
            break;
          }
        }

        if (!app) {
          ws.send(JSON.stringify({ type: "error", message: "app not found" }));
          ws.close();
          return;
        }

        app.clients.add(ws);
        console.log(`Client connected to ${app.name} (${app.clients.size} clients)`);

        // Send current terminal mode to client
        ws.send(JSON.stringify({ 
          type: "mode", 
          applicationCursorKeys: app.applicationCursorKeys 
        }));

        // Buffer output until client sends resize
        let initialized = false;
        let pending: string[] = [];

        // Auto-initialize after timeout to prevent unbounded buffering
        const initTimeout = setTimeout(() => {
          if (!initialized) {
            initialized = true;
            for (const chunk of pending) {
              ws.send(JSON.stringify({ type: "output", text: chunk }));
            }
            pending = [];
          }
        }, 5000);

        // Send output to this client
        const outputHandler = (data: string) => {
          if (initialized) {
            ws.send(JSON.stringify({ type: "output", text: data }));
          } else if (pending.length < MAX_PENDING_OUTPUT) {
            pending.push(data);
          }
        };

        // Listen for PTY output
        const onData = app.process.onData(outputHandler);

        ws.on("message", (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === "input" && msg.text) {
              ptySend(app!, msg.text);
            } else if (msg.type === "resize" && msg.cols && msg.rows) {
              ptyResize(app!, msg.cols, msg.rows);
              // Send visible snapshot at the new size
              const snap = ptySnapshot(app!, msg.rows, false);
              ws.send(JSON.stringify({ type: "output", text: snap.visibleText }));
              // Flush buffered output
              for (const chunk of pending) {
                ws.send(JSON.stringify({ type: "output", text: chunk }));
              }
              pending = [];
              initialized = true;
            } else if (msg.type === "mouse") {
              // Mouse event: { type: "mouse", event: "click|scroll|wheel", button, x, y, dx, dy }
              const mouseSeq = encodeMouseEvent(msg);
              if (mouseSeq) ptySend(app!, mouseSeq);
            } else if (msg.type === "touch") {
              // Touch event: { type: "touch", event: "tap|swipe|pinch", x, y, dx, dy, scale }
              const touchSeq = encodeTouchEvent(msg);
              if (touchSeq) ptySend(app!, touchSeq);
            }
          } catch (err) {
            console.error("WebSocket message parse error:", err);
          }
        });

        ws.on("close", () => {
          clearTimeout(initTimeout);
          app!.clients.delete(ws);
          onData.dispose(); // Remove listener
          console.log(`Client disconnected from ${app!.name} (${app!.clients.size} remaining)`);
        });
      });

      process.on("SIGINT", () => {
        console.log("\nShutting down...");
        ptyCleanup();
        wss.close();
        server.close();
        process.exit(0);
      });
      process.on("SIGTERM", () => {
        ptyCleanup();
        wss.close();
        server.close();
        process.exit(0);
      });

      return;
    }

    // ── Direct mode: spawn command for interactive/snapshot ──────────────
    if (!command) {
      console.error("Error: no command specified");
      console.error("Use --serve to start service manager, or provide a command to run");
      process.exit(1);
    }

    console.log(`Spawning: ${command} ${cmdRest.join(" ")}`);
    console.log(`  Terminal: ${resolvedCols}x${resolvedRows}, cwd: ${cwd}, term: ${term}`);
    if (snapshot) console.log(`  Mode: snapshot (wait ${waitMs}ms)`);
    else console.log(`  Mode: interactive (Ctrl+C to exit)`);
    console.log();

    let instance: ReturnType<typeof ptySpawn>;
    try {
      instance = ptySpawn({ command, args: cmdRest, cols: resolvedCols, rows: resolvedRows, cwd, term });
    } catch (err: any) {
      console.error(err.message);
      process.exit(1);
    }

    // ── Interactive passthrough ────────────────────────────────────────
    if (interactive) {
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.resume();

      // PTY output → stdout
      instance.process.onData((data) => process.stdout.write(data));

      // Stdin → PTY input
      process.stdin.on("data", (data) => {
        const key = data.toString();
        if (key === "\x03") {
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          ptyKill(instance);
          process.exit(0);
          return;
        }
        ptySend(instance, key);
      });

      // Handle resize — relay from current terminal to PTY
      if (process.stdout.isTTY) {
        process.stdout.on("resize", () => {
          try {
            ptyResize(instance, process.stdout.columns || resolvedCols, process.stdout.rows || resolvedRows);
          } catch {}
        });
      }

      instance.process.onExit(({ exitCode }) => {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        console.log(`\n\nProcess exited with code ${exitCode}`);
        process.exit(exitCode ?? 0);
      });
      return;
    }

    // ── Snapshot mode ──────────────────────────────────────────────────
    await new Promise((r) => setTimeout(r, waitMs));

    const snap = ptySnapshot(instance, 20, !color);

    console.log("=== VISIBLE SCREEN ===");
    console.log(snap.visibleText);
    console.log("=== SCROLLBACK ===");
    console.log(snap.scrollbackLines.join("\n"));
    console.log("=== END ===");
    console.log(`Buffer: ${snap.bufLength} lines, scroll: ${snap.baseY}`);

    ptyKill(instance);
    process.exit(0);
  })();
}
