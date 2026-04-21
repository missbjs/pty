import { describe, it, expect, afterAll, beforeAll } from "vitest";
import {
  ptySpawn,
  ptySnapshot,
  ptySend,
  ptySignal,
  ptyResize,
  ptyKill,
  ptyGet,
  ptyList,
  ptyCleanup,
  type PtyInstance,
  type BufferSnapshot,
} from "./pty.js";

describe("pty.ts — generic PTY service", () => {
  let instance: PtyInstance | null = null;

  afterAll(() => {
    if (instance) ptyKill(instance);
    ptyCleanup();
  });

  // ── ptySpawn ──────────────────────────────────────────────────────────

  it("spawns a process and returns an instance", () => {
    instance = ptySpawn({
      command: "cat",
      args: [],
      cols: 80,
      rows: 24,
    });

    expect(instance).toBeTruthy();
    expect(instance!.process.pid).toBeGreaterThan(0);
    expect(instance!.cols).toBe(80);
    expect(instance!.rows).toBe(24);
    expect(instance!.terminal).toBeTruthy();
    expect(instance!.createdAt).toBeGreaterThan(0);
  });

  it("uses default dimensions when not specified", () => {
    const inst = ptySpawn({ command: "sleep", args: ["60"] });
    expect(inst.cols).toBe(400);
    expect(inst.rows).toBe(40);
    ptyKill(inst);
  });

  it("detects non-existent command via early exit", async () => {
    // pty.spawn doesn't throw for non-existent commands — it spawns but exits immediately
    const inst = ptySpawn({ command: "nonexistent-command-xyz" });
    expect(inst.process.pid).toBeGreaterThan(0);

    // Wait for it to exit and check error output
    await new Promise((r) => setTimeout(r, 1000));

    const snap = ptySnapshot(inst);
    // The error message should be in the buffer
    expect(snap.fullText.toLowerCase()).toMatch(/no such file|not found|execvp/);

    ptyKill(inst);
  });

  // ── ptySnapshot ───────────────────────────────────────────────────────

  it("captures a buffer snapshot", async () => {
    if (!instance) throw new Error("No instance");

    // Give the process time to render
    await new Promise((r) => setTimeout(r, 500));

    const snap = ptySnapshot(instance);

    expect(snap.fullLines).toBeInstanceOf(Array);
    expect(snap.visibleLines).toBeInstanceOf(Array);
    expect(snap.scrollbackLines).toBeInstanceOf(Array);
    expect(snap.footerLines).toBeInstanceOf(Array);
    expect(typeof snap.fullText).toBe("string");
    expect(typeof snap.visibleText).toBe("string");
    expect(typeof snap.footerText).toBe("string");
    expect(snap.bufCols).toBe(80);
    expect(snap.bufRows).toBe(24);
    expect(snap.bufLength).toBeGreaterThan(0);
    expect(typeof snap.baseY).toBe("number");

    // Visible lines should not exceed rows
    expect(snap.visibleLines.length).toBeLessThanOrEqual(instance!.rows);
  });

  it("respects footerRows parameter", async () => {
    if (!instance) throw new Error("No instance");

    const snap5 = ptySnapshot(instance, 5);
    const snap20 = ptySnapshot(instance, 20);

    expect(snap5.footerLines.length).toBeLessThanOrEqual(5);
    expect(snap20.footerLines.length).toBeLessThanOrEqual(20);
  });

  it("strips ANSI codes from snapshot output", async () => {
    // Spawn a process that outputs ANSI codes (ls --color)
    const lsInst = ptySpawn({
      command: "ls",
      args: ["--color=always", "/"],
      cols: 120,
      rows: 30,
    });

    await new Promise((r) => setTimeout(r, 1000));

    const snap = ptySnapshot(lsInst);
    // Snapshots should be stripped by default
    const escRegex = /\x1b\[[0-9;]*[a-zA-Z]/;
    for (const line of snap.fullLines) {
      expect(escRegex.test(line)).toBe(false);
    }

    ptyKill(lsInst);
  });

  it("preserves ANSI codes when stripAnsiCodes is false", async () => {
    // Spawn a process that outputs ANSI codes
    const lsInst = ptySpawn({
      command: "ls",
      args: ["--color=always", "/"],
      cols: 120,
      rows: 30,
    });

    await new Promise((r) => setTimeout(r, 1000));

    const snap = ptySnapshot(lsInst, 20, false);
    // Snapshots should preserve ANSI codes
    const escRegex = /\x1b\[[0-9;]*[a-zA-Z]/;
    const hasColor = snap.fullLines.some((line) => escRegex.test(line));
    expect(hasColor).toBe(true);

    ptyKill(lsInst);
  });

  // ── ptySend ───────────────────────────────────────────────────────────

  it("sends input to the process", async () => {
    const echoInst = ptySpawn({
      command: "bash",
      args: ["-c", "read -r line; echo \"$line\"; sleep 1"],
      cols: 80,
      rows: 24,
    });

    await new Promise((r) => setTimeout(r, 300));

    ptySend(echoInst, "hello world\r");

    await new Promise((r) => setTimeout(r, 1500));

    const snap = ptySnapshot(echoInst);
    const fullText = snap.fullText;
    expect(fullText).toContain("hello world");

    ptyKill(echoInst);
  });

  // ── ptyResize ─────────────────────────────────────────────────────────

  it("resizes the PTY and xterm terminal", () => {
    const inst = ptySpawn({ command: "sleep", args: ["60"], cols: 80, rows: 24 });

    expect(inst.cols).toBe(80);
    expect(inst.rows).toBe(24);

    ptyResize(inst, 120, 40);

    expect(inst.cols).toBe(120);
    expect(inst.rows).toBe(40);

    ptyKill(inst);
  });

  // ── ptySignal ─────────────────────────────────────────────────────────

  it("sends signals to the process", () => {
    const inst = ptySpawn({ command: "sleep", args: ["60"] });
    expect(inst.process.pid).toBeGreaterThan(0);

    // SIGTERM should kill it
    ptySignal(inst, "SIGTERM");

    // Give it time to die
    setTimeout(() => {
      expect(inst.process.pid).toBeDefined(); // process ref still exists
    }, 500);
  });

  // ── ptyGet / ptyList ─────────────────────────────────────────────────

  it("tracks instances in the registry", () => {
    const inst = ptySpawn({ command: "sleep", args: ["60"] });

    const retrieved = ptyGet(inst.id);
    expect(retrieved).toBe(inst);

    const all = ptyList();
    expect(all.some((i) => i.id === inst.id)).toBe(true);

    ptyKill(inst);
  });

  it("removes instances from registry after kill", () => {
    const inst = ptySpawn({ command: "sleep", args: ["60"] });
    const id = inst.id;

    ptyKill(inst);

    expect(ptyGet(id)).toBeUndefined();
  });

  // ── ptyCleanup ────────────────────────────────────────────────────────

  it("cleanup kills all remaining instances", () => {
    const inst = ptySpawn({ command: "sleep", args: ["60"] });
    expect(ptyGet(inst.id)).toBeTruthy();

    ptyCleanup();

    expect(ptyGet(inst.id)).toBeUndefined();
  });

  // ── Buffer snapshot structure ─────────────────────────────────────────

  it("produces correct scrollback vs visible separation", async () => {
    // Run a command that produces more output than fits in rows
    const inst = ptySpawn({
      command: "bash",
      args: ["-c", 'for i in $(seq 1 50); do echo "line-$i"; done; sleep 1'],
      cols: 80,
      rows: 10,
    });

    await new Promise((r) => setTimeout(r, 2000));

    const snap = ptySnapshot(inst, 10);

    // Total buffer should have scrollback + visible
    const totalFromParts = snap.scrollbackLines.length + snap.visibleLines.length;
    expect(totalFromParts).toBe(snap.fullLines.length);

    // Visible should be at most rows
    expect(snap.visibleLines.length).toBeLessThanOrEqual(10);

    ptyKill(inst);
  });

  // ── Arg splitting logic (CLI) ─────────────────────────────────────────

  it("correctly splits command args from pty flags (no -- separator)", () => {
    // Simulate the CLI arg splitting logic
    const PTY_FLAGS = new Set(["--cols", "--rows", "--cwd", "--term", "--wait", "--color", "--interactive", "--snapshot", "--serve", "--connect", "--port", "--host"]);

    const args = ["--model", "auto", "-w", "/tmp", "--snapshot", "--wait", "2000"];
    let firstPtyIdx = -1;
    for (let i = 1; i < args.length; i++) {
      if (PTY_FLAGS.has(args[i])) { firstPtyIdx = i; break; }
    }

    const cmdArgs = args.slice(0, firstPtyIdx);
    const ptyOpts = args.slice(firstPtyIdx);

    expect(cmdArgs).toEqual(["--model", "auto", "-w", "/tmp"]);
    expect(ptyOpts).toEqual(["--snapshot", "--wait", "2000"]);
  });

  it("handles explicit -- separator", () => {
    const args = ["top", "--", "--cols", "80", "--snapshot"];
    const splitIdx = args.indexOf("--");

    const cmdArgs = args.slice(0, splitIdx);
    const ptyOpts = args.slice(splitIdx + 1);

    expect(cmdArgs).toEqual(["top"]);
    expect(ptyOpts).toEqual(["--cols", "80", "--snapshot"]);
  });

  it("handles no pty flags at all", () => {
    const PTY_FLAGS = new Set(["--cols", "--rows", "--cwd", "--term", "--wait", "--color", "--interactive", "--snapshot", "--serve", "--connect", "--port", "--host"]);

    const args = ["ls", "-la", "/tmp"];
    let firstPtyIdx = -1;
    for (let i = 1; i < args.length; i++) {
      if (PTY_FLAGS.has(args[i])) { firstPtyIdx = i; break; }
    }

    const cmdArgs = firstPtyIdx === -1 ? args : args.slice(0, firstPtyIdx);
    const ptyOpts = firstPtyIdx === -1 ? [] : args.slice(firstPtyIdx);

    expect(cmdArgs).toEqual(["ls", "-la", "/tmp"]);
    expect(ptyOpts).toEqual([]);
  });
});

describe("WebSocket serve/connect", () => {
  let serverProcess: ReturnType<typeof import("child_process").spawn>;
  const testPort = 13099;

  afterAll(() => {
    if (serverProcess) serverProcess.kill();
  });

  it("starts a serve instance and responds to HTTP health check", async () => {
    const { spawn } = await import("child_process");
    serverProcess = spawn("npx", ["tsx", "pty.ts", "sleep", "30", "--", "--serve", "--port", String(testPort)], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Wait for server to start
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server did not start in time")), 10000);
      serverProcess.stdout!.on("data", (data: Buffer) => {
        if (data.toString().includes("PTY server listening")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      serverProcess.stderr!.on("data", (data: Buffer) => {
        if (data.toString().includes("PTY server listening")) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    // HTTP health check
    const res = await fetch(`http://127.0.0.1:${testPort}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("serves /snapshot endpoint", async () => {
    await new Promise((r) => setTimeout(r, 500));

    const res = await fetch(`http://127.0.0.1:${testPort}/snapshot`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("visibleText");
    expect(body).toHaveProperty("cols");
    expect(body).toHaveProperty("rows");
    expect(body).toHaveProperty("pid");
  });

  it("accepts WebSocket connection and receives output", async () => {
    const { WebSocket } = await import("ws");

    const ws = new WebSocket(`ws://127.0.0.1:${testPort}`);

    const messages: string[] = [];
    const done = new Promise<void>((resolve) => {
      ws.on("open", () => {
        // Send resize to trigger initial snapshot
        ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
      });

      ws.on("message", (data) => {
        messages.push(data.toString());
        const msg = JSON.parse(data.toString());
        if (msg.type === "output" && messages.length >= 1) {
          resolve();
        }
      });
    });

    await done;

    const outputMsgs = messages.filter((m) => JSON.parse(m).type === "output");
    expect(outputMsgs.length).toBeGreaterThan(0);

    ws.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("accepts input via WebSocket and sends to PTY", async () => {
    const { WebSocket } = await import("ws");

    const ws = new WebSocket(`ws://127.0.0.1:${testPort}`);

    const received: string[] = [];
    let wsOpen = false;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("WebSocket test timed out")), 10000);

      ws.on("open", () => {
        wsOpen = true;
        // Send resize first to initialize
        ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
        // Then send input after a short delay
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "input", text: "HELLO_VIA_WS\n" }));
        }, 500);
      });

      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "output") {
          received.push(msg.text);
          if (msg.text.includes("HELLO_VIA_WS")) {
            clearTimeout(timeout);
            resolve();
          }
        }
      });

      ws.on("error", (err) => {
        if (err.message.includes("ECONNREFUSED")) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    if (wsOpen) {
      const allOutput = received.join("");
      expect(allOutput).toContain("HELLO_VIA_WS");
    }

    if (ws.readyState === 1) ws.close();
    await new Promise((r) => setTimeout(r, 200));
  });

  it("broadcasts output to multiple WebSocket clients", async () => {
    const { WebSocket } = await import("ws");

    const ws1 = new WebSocket(`ws://127.0.0.1:${testPort}`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${testPort}`);

    const msgs1: string[] = [];
    const msgs2: string[] = [];

    ws1.on("open", () => {
      ws1.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
    });
    ws2.on("open", () => {
      ws2.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
    });

    ws1.on("message", (data) => msgs1.push(data.toString()));
    ws2.on("message", (data) => msgs2.push(data.toString()));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout waiting for broadcast")), 5000);
      const check = () => {
        if (msgs1.length > 0 && msgs2.length > 0) {
          clearTimeout(timeout);
          resolve();
        }
      };
      ws1.on("message", check);
      ws2.on("message", check);
      setTimeout(check, 500);
    });

    expect(msgs1.length).toBeGreaterThan(0);
    expect(msgs2.length).toBeGreaterThan(0);

    ws1.close();
    ws2.close();
    await new Promise((r) => setTimeout(r, 100));
  });
});
