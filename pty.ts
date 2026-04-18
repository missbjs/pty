#!/usr/bin/env node
// PTY Utility Service — a mini OS for TUI applications
// Spawn any process in a PTY, send keystrokes, read full buffer, take snapshots.
import * as pty from "node-pty";
import xtermHeadless from "@xterm/headless";
import stripAnsi from "strip-ansi";
import { randomUUID } from "crypto";

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

// ── Service ────────────────────────────────────────────────────────────────

const instances = new Map<string, PtyInstance>();

/** Spawn a new process in a PTY and return the instance */
export function ptySpawn(opts: PtySpawnOptions): PtyInstance {
  const id = randomUUID();

  const cols = opts.cols ?? 200; // wide default to avoid line wrapping
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

  // Feed all PTY output into xterm buffer
  ptyProcess.onData((data) => {
    vt.write(data);
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

  let outputAccum = "";
  ptyProcess.onData((data) => {
    outputAccum += data;
    vt.write(data);
  });

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
export function ptySnapshot(instance: PtyInstance, footerRows: number = 20): BufferSnapshot {
  const buf = instance.terminal.buffer.active;

  // Read FULL buffer (scrollback + visible)
  const fullLines: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    fullLines.push(line ? stripAnsi(line.translateToString(true)) : "");
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
//   tsx src/services/pty.ts qodercli -- --model auto -w /path
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
  --cols <n>             Terminal width (default: auto from TTY, fallback 200)
  --rows <n>             Terminal height (default: auto from TTY, fallback 40)
  --cwd <dir>            Working directory (default: current)
  --term <name>          Terminal type (default: xterm-256color)
  --wait <ms>            Wait time before first snapshot (default: 1000)
  --interactive          Relay TUI to current terminal (default when not --serve)
  --snapshot             Print buffer snapshot once and exit
  --serve                Start HTTP server to accept upstream requests
  --port <n>             Server port for --serve (default: 3000)
  --host <addr>          Bind address for --serve (default: 127.0.0.1)

Modes (mutually exclusive):
  (none)                 Interactive passthrough to current terminal
  --interactive          Same as above, explicit
  --snapshot             Single snapshot and exit
  --serve                HTTP API server for upstream consumers

HTTP API (--serve mode):
  GET  /snapshot          Get current screen snapshot
  GET  /snapshot/visible  Get visible area only
  GET  /snapshot/full     Get full buffer with scrollback
  POST /send              Send keystrokes to PTY { "text": "..." }
  POST /resize            Resize PTY { "cols": 120, "rows": 30 }
  GET  /status            Get PTY process status
  GET  /health            Health check

Examples:
  pnpm pty top
  pnpm pty top -- --interactive
  pnpm pty qodercli -- --serve --port 3001
  pnpm pty htop -- --serve --host 0.0.0.0 --port 8080
  pnpm pty vim file.txt -- --cols 120 --rows 30 --snapshot`);
      process.exit(0);
    }

    // Known pty-specific flags
    const PTY_FLAGS = new Set(["--cols", "--rows", "--cwd", "--term", "--wait", "--interactive", "--snapshot", "--serve", "--port", "--host"]);

    // Split args at -- : left = command+args, right = pty options
    let cmdArgs: string[];
    let ptyOpts: string[];

    const explicitSplit = args.indexOf("--");
    if (explicitSplit !== -1) {
      cmdArgs = args.slice(0, explicitSplit);
      ptyOpts = args.slice(explicitSplit + 1);
    } else {
      // No explicit separator — find the first pty flag and split there
      let firstPtyIdx = -1;
      for (let i = 1; i < args.length; i++) {
        if (PTY_FLAGS.has(args[i])) {
          firstPtyIdx = i;
          break;
        }
      }
      if (firstPtyIdx === -1) {
        cmdArgs = args;
        ptyOpts = [];
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
    let interactive = false;
    let snapshot = false;
    let serve = false;
    let port = 3000;
    let host = "127.0.0.1";

    for (let i = 0; i < ptyOpts.length; i++) {
      switch (ptyOpts[i]) {
        case "--cols": cols = parseInt(ptyOpts[++i], 10); break;
        case "--rows": rows = parseInt(ptyOpts[++i], 10); break;
        case "--cwd": cwd = ptyOpts[++i]; break;
        case "--term": term = ptyOpts[++i]; break;
        case "--wait": waitMs = parseInt(ptyOpts[++i], 10); break;
        case "--interactive": interactive = true; break;
        case "--snapshot": snapshot = true; break;
        case "--serve": serve = true; break;
        case "--port": port = parseInt(ptyOpts[++i], 10); break;
        case "--host": host = ptyOpts[++i]; break;
      }
    }

    // Resolve cols/rows from TTY if not specified
    const defaultCols = 200;
    const defaultRows = 40;
    const resolvedCols = cols ?? (process.stdout.isTTY ? process.stdout.columns : undefined) ?? defaultCols;
    const resolvedRows = rows ?? (process.stdout.isTTY ? process.stdout.rows : undefined) ?? defaultRows;

    // Determine mode
    if (serve) {
      interactive = false;
      snapshot = false;
    } else if (snapshot) {
      interactive = false;
    } else {
      // Default: interactive passthrough
      interactive = true;
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
            const snap = ptySnapshot(instance);
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
            const snap = ptySnapshot(instance);
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({
              visibleText: snap.visibleText,
              visibleLines: snap.visibleLines,
            }));
          }

          // GET /snapshot/full
          if (req.method === "GET" && pathname === "/snapshot/full") {
            const snap = ptySnapshot(instance);
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({
              fullText: snap.fullText,
              fullLines: snap.fullLines,
              scrollbackLines: snap.scrollbackLines,
              visibleText: snap.visibleText,
              footerText: snap.footerText,
              cols: instance.cols,
              rows: instance.rows,
              baseY: snap.baseY,
              bufLength: snap.bufLength,
            }));
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
        console.log(`  GET  /snapshot/visible  — visible area`);
        console.log(`  GET  /snapshot/full     — full buffer + scrollback`);
        console.log(`  POST /send              — send keystrokes { "text": "..." }`);
        console.log(`  POST /resize            — resize PTY { "cols": N, "rows": N }`);
        console.log(`  GET  /status            — process status`);
        console.log(`  GET  /health            — health check`);
        console.log(`\nCtrl+C to stop`);
      });

      process.on("SIGINT", () => {
        console.log("\nShutting down...");
        ptyKill(instance);
        server.close();
        process.exit(0);
      });
      process.on("SIGTERM", () => {
        ptyKill(instance);
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

    const snap = ptySnapshot(instance);

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
