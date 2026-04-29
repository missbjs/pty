#!/usr/bin/env node
// PTY Utility Service — a mini OS for TUI applications
// Spawn any process in a PTY, send keystrokes, read full buffer, take snapshots.
import * as pty from "node-pty";
import xtermHeadless from "@xterm/headless";
import stripAnsi from "strip-ansi";
import { randomUUID } from "crypto";
import { WebSocketServer, WebSocket as WsClient } from "ws";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Terminal = (xtermHeadless as any).Terminal;

// ── Types ──────────────────────────────────────────────────────────────────

export interface PtyInstance {
  id: string;
  process: pty.IPty;
  terminal: any; // xterm headless terminal
  cols: number;
  rows: number;
  createdAt: number;
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

/** Spawn a new process in a PTY and return the instance */
export function ptySpawn(opts: PtySpawnOptions): PtyInstance {
  const id = randomUUID();

  const cols = opts.cols ?? 400; // wide default to avoid line wrapping
  const rows = opts.rows ?? 40;
  const term = opts.term ?? "xterm-256color";

  let ptyProcess: pty.IPty;
  try {
    ptyProcess = pty.spawn(opts.command, opts.args ?? [], {
      name: term,
      cols,
      rows,
      cwd: opts.cwd ?? process.cwd(),
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
    process: ptyProcess,
    terminal: vt,
    cols,
    rows,
    createdAt: Date.now(),
  };

  instances.set(id, instance);

  ptyProcess.onExit(({ exitCode }) => {
    setTimeout(() => instances.delete(id), 5000);
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
  instances.delete(instance.id);
}

/** Get a PTY instance by ID */
export function ptyGet(id: string): PtyInstance | undefined {
  return instances.get(id);
}

/** List all active PTY instances */
export function ptyList(): PtyInstance[] {
  return [...instances.values()];
}

/** Cleanup all PTY instances */
export function ptyCleanup(): void {
  for (const [, inst] of instances) {
    try { inst.process.kill(); } catch {}
  }
  instances.clear();
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

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const args = process.argv.slice(2);
    if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
      console.log(`Usage: tsx pty.ts <command> [args...] [-- <pty-options>]

Spawn a TUI app in a PTY and interact with it.

Commands:
  <command> [args...]    Command to run (everything before --)

PTY options (after --):
  --cols <n>             Terminal width (default: auto from TTY, fallback 400)
  --rows <n>             Terminal height (default: auto from TTY, fallback 40)
  --cwd <dir>            Working directory (default: current)
  --term <name>          Terminal type (default: xterm-256color)
  --wait <ms>            Wait time before first snapshot (default: 1000)
  --color                Preserve ANSI color codes in snapshot output
  --interactive          Relay TUI to current terminal (default when not --serve)
  --snapshot             Print buffer snapshot once and exit
  --serve                Start HTTP + WebSocket server
  --connect              Connect to an existing PTY server (no command needed)
  --port <n>             Server port for --serve / --connect (default: 3000)
  --host <addr>          Bind address for --serve (default: 127.0.0.1)

Modes (mutually exclusive):
  (none)                 Interactive passthrough to current terminal
  --interactive          Same as above, explicit
  --snapshot             Single snapshot and exit
  --serve                HTTP API + WebSocket server (spawn app + broadcast)
  --connect              WebSocket client to existing --serve instance

HTTP API (--serve mode):
  GET  /snapshot          Get current screen snapshot
  GET  /snapshot?color=true  Snapshot with ANSI color codes
  GET  /snapshot/visible  Get visible area only
  GET  /snapshot/visible?color=true  Visible area with ANSI color codes
  GET  /snapshot/full     Get full buffer with scrollback
  GET  /snapshot/full?color=true  Full buffer with ANSI color codes
  POST /send              Send keystrokes to PTY { "text": "..." }
  POST /resize            Resize PTY { "cols": 120, "rows": 30 }
  GET  /status            Get PTY process status
  GET  /health            Health check

Examples:
  pnpm dev top
  pnpm dev top -- --interactive
  pnpm dev htop -- --serve --host 0.0.0.0 --port 8080
  pnpm dev vim file.txt -- --cols 120 --rows 30 --snapshot
  pnpm dev top -- --serve --port 3000       # spawn top + serve
  pnpm dev -- --connect --port 3000         # connect to existing server`);
      process.exit(0);
    }

    // Split args at -- : left = command+args, right = pty options
    const PTY_FLAGS = new Set(["--cols", "--rows", "--cwd", "--term", "--wait", "--color", "--interactive", "--snapshot", "--serve", "--connect", "--port", "--host"]);

    let cmdArgs: string[];
    let ptyOpts: string[];

    const explicitSplit = args.indexOf("--");
    if (explicitSplit !== -1) {
      cmdArgs = args.slice(0, explicitSplit);
      ptyOpts = [];
      const valueFlags = new Set(["--cols", "--rows", "--cwd", "--term", "--wait", "--port", "--host"]);
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
    let host = "127.0.0.1";

    for (let i = 0; i < ptyOpts.length; i++) {
      switch (ptyOpts[i]) {
        case "--cols": cols = parseInt(ptyOpts[++i], 10); break;
        case "--rows": rows = parseInt(ptyOpts[++i], 10); break;
        case "--cwd": cwd = ptyOpts[++i]; break;
        case "--term": term = ptyOpts[++i]; break;
        case "--wait": waitMs = parseInt(ptyOpts[++i], 10); break;
        case "--color": color = true; break;
        case "--interactive": interactive = true; break;
        case "--snapshot": snapshot = true; break;
        case "--serve": serve = true; break;
        case "--connect": connect = true; break;
        case "--port": port = parseInt(ptyOpts[++i], 10); break;
        case "--host": host = ptyOpts[++i]; break;
      }
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

    // ── Connect mode (WebSocket client) ────────────────────────────────
    if (connect) {
      const resolvedCols = cols ?? (process.stdout.isTTY ? process.stdout.columns : undefined);
      const resolvedRows = rows ?? (process.stdout.isTTY ? process.stdout.rows : undefined);

      // Set up stdin first
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.resume();

      const ws = new WsClient(`ws://${host}:${port}`);

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
          ws.send(JSON.stringify({ type: "input", text: key }));
        }
      });

      ws.on("open", () => {
        // Tell server our terminal dimensions
        if (resolvedCols && resolvedRows) {
          ws.send(JSON.stringify({ type: "resize", cols: resolvedCols, rows: resolvedRows }));
        }
        process.stderr.write(`Connected to PTY server at ws://${host}:${port}\n`);
        process.stderr.write(`Mode: remote interactive (Ctrl+C to disconnect)\n\n`);
      });

      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "output") {
          process.stdout.write(msg.text);
        } else if (msg.type === "exit") {
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          process.stderr.write(`\n\nRemote process exited with code ${msg.exitCode}\n`);
          process.exit(0);
        } else if (msg.type === "ready") {
          // Server acknowledges connection
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

    console.log(`Spawning: ${command} ${cmdRest.join(" ")}`);
    console.log(`  Terminal: ${resolvedCols}x${resolvedRows}, cwd: ${cwd}, term: ${term}`);
    if (serve) console.log(`  Mode: serve on http://${host}:${port}`);
    else if (snapshot) console.log(`  Mode: snapshot (wait ${waitMs}ms)`);
    else console.log(`  Mode: interactive (Ctrl+C to exit)`);
    console.log();

    let instance: ReturnType<typeof ptySpawn>;
    try {
      instance = ptySpawn({ command, args: cmdRest, cols: resolvedCols, rows: resolvedRows, cwd, term });
    } catch (err: any) {
      console.error(err.message);
      process.exit(1);
    }

    // ── Serve mode ─────────────────────────────────────────────────────
    if (serve) {
      const { createServer } = await import("http");

      const server = createServer(async (req, res) => {
        const url = new URL(req.url!, `http://${host}:${port}`);
        const pathname = url.pathname;

        // CORS headers
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

        try {
          // GET /snapshot — visible area
          if (req.method === "GET" && pathname === "/snapshot") {
            const color = url.searchParams.get("color") === "true";
            const snap = ptySnapshot(instance, 20, !color);
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({
              visibleText: snap.visibleText,
              visibleLines: snap.visibleLines,
              cols: instance.cols,
              rows: instance.rows,
              pid: instance.process.pid,
            }));
          }

          // GET /snapshot/visible
          if (req.method === "GET" && pathname === "/snapshot/visible") {
            const color = url.searchParams.get("color") === "true";
            const snap = ptySnapshot(instance, 20, !color);
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({
              visibleText: snap.visibleText,
              visibleLines: snap.visibleLines,
            }));
          }

          // GET /snapshot/full
          if (req.method === "GET" && pathname === "/snapshot/full") {
            const withColor = url.searchParams.get("color") === "true";
            const snap = ptySnapshot(instance, 20, true);
            const payload: Record<string, unknown> = {
              fullText: snap.fullText,
              fullLines: snap.fullLines,
              visibleLines: snap.visibleLines,
              scrollbackLines: snap.scrollbackLines,
              visibleText: snap.visibleText,
              footerText: snap.footerText,
              cols: instance.cols,
              rows: instance.rows,
              baseY: snap.baseY,
              bufLength: snap.bufLength,
            };
            if (withColor) {
              const colorSnap = ptySnapshot(instance, 20, false);
              payload.fullLinesColor = colorSnap.fullLines;
              payload.visibleLinesColor = colorSnap.visibleLines;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify(payload));
          }

          // POST /send
          if (req.method === "POST" && pathname === "/send") {
            let body = "";
            req.on("data", (chunk) => (body += chunk));
            req.on("end", () => {
              try {
                const { text } = JSON.parse(body);
                if (!text) throw new Error("text is required");
                ptySend(instance, text);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
              } catch (err: any) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: err.message }));
              }
            });
            return;
          }

          // POST /resize
          if (req.method === "POST" && pathname === "/resize") {
            let body = "";
            req.on("data", (chunk) => (body += chunk));
            req.on("end", () => {
              try {
                const { cols: c, rows: r } = JSON.parse(body);
                if (!c || !r) throw new Error("cols and rows are required");
                ptyResize(instance, c, r);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, cols: c, rows: r }));
              } catch (err: any) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: err.message }));
              }
            });
            return;
          }

          // GET /status
          if (req.method === "GET" && pathname === "/status") {
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({
              pid: instance.process.pid,
              cols: instance.cols,
              rows: instance.rows,
              cwd: instance.cols > 0 ? cwd : undefined,
              createdAt: instance.createdAt,
              running: true,
            }));
          }

          // GET /health
          if (req.method === "GET" && pathname === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ status: "ok", pid: instance.process.pid }));
          }

          // 404
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
        } catch {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        }
      });

      // Handle process exit
      instance.process.onExit(({ exitCode }) => {
        console.log(`\nPTY process exited with code ${exitCode}`);
        server.close();
        process.exit(exitCode ?? 0);
      });

      server.listen(port, host, () => {
        console.log(`PTY server listening on http://${host}:${port}`);
        console.log(`Endpoints:`);
        console.log(`  GET  /snapshot          — visible screen`);
        console.log(`  GET  /snapshot?color=true — visible screen with ANSI color`);
        console.log(`  GET  /snapshot/visible  — visible area`);
        console.log(`  GET  /snapshot/visible?color=true — visible area with ANSI color`);
        console.log(`  GET  /snapshot/full     — full buffer + scrollback`);
        console.log(`  GET  /snapshot/full?color=true — full buffer with ANSI color`);
        console.log(`  POST /send              — send keystrokes { "text": "..." }`);
        console.log(`  POST /resize            — resize PTY { "cols": N, "rows": N }`);
        console.log(`  GET  /status            — process status`);
        console.log(`  GET  /health            — health check`);
        console.log(`  WS   ws://${host}:${port}           — WebSocket for real-time I/O`);
        console.log(`\nCtrl+C to stop`);
      });

      // ── WebSocket server for real-time multi-client ──────────────────
      const wss = new WebSocketServer({ server });
      const clients = new Set<WsClient>();

      // Broadcast PTY output to all connected clients
      instance.process.onData((data) => {
        const payload = JSON.stringify({ type: "output", text: data });
        for (const client of clients) {
          if (client.readyState === WsClient.OPEN) {
            // Check if this client has been initialized (sent resize)
            // Access the pending buffer from the connection handler
            if ((client as any)._ptyInitialized) {
              client.send(payload);
            } else {
              // Buffer the output until resize arrives
              if (!(client as any)._ptyPending) (client as any)._ptyPending = [];
              (client as any)._ptyPending.push(data);
            }
          }
        }
      });

      wss.on("connection", (ws) => {
        clients.add(ws);
        console.log(`Client connected (${clients.size} total)`);

        // Buffer realtime output until client sends its dimensions
        ws.on("message", (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === "input" && msg.text) {
              ptySend(instance, msg.text);
            } else if (msg.type === "resize" && msg.cols && msg.rows) {
              // Resize PTY to client dimensions (affects all clients)
              ptyResize(instance, msg.cols, msg.rows);
              // Send visible snapshot at the new size (preserve colors)
              const snap = ptySnapshot(instance, msg.rows, false);
              ws.send(JSON.stringify({ type: "output", text: snap.visibleText }));
              // Flush any buffered realtime output
              const pending = (ws as any)._ptyPending;
              if (pending && pending.length > 0) {
                for (const chunk of pending) {
                  ws.send(JSON.stringify({ type: "output", text: chunk }));
                }
              }
              (ws as any)._ptyInitialized = true;
            }
          } catch {}
        });

        ws.on("close", () => {
          clients.delete(ws);
          console.log(`Client disconnected (${clients.size} remaining)`);
        });
      });

      process.on("SIGINT", () => {
        console.log("\nShutting down...");
        ptyKill(instance);
        wss.close();
        server.close();
        process.exit(0);
      });
      process.on("SIGTERM", () => {
        ptyKill(instance);
        wss.close();
        server.close();
        process.exit(0);
      });

      return;
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
