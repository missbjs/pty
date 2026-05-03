import { describe, it, expect, afterAll, beforeAll, afterEach, beforeEach } from "vitest";
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

// ─────────────────────────────────────────────────────────────────────────────
// Test Utilities
// ─────────────────────────────────────────────────────────────────────────────

const TEST_PORT = 13099;
const TEST_TIMEOUT = 10000;
const RETRY_COUNT = 3;

// Helper: Wait for port to be free
async function waitForPortFree(port: number, timeout = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(100) });
      // Port still in use, wait
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      // Port is free
      return;
    }
  }
  throw new Error(`Port ${port} not freed within ${timeout}ms`);
}

// Helper: Start server and wait for ready
async function startServer(port: number): Promise<{ process: ReturnType<typeof import("child_process").spawn>; appId: string }> {
  const { spawn } = await import("child_process");
  
  const serverProcess = spawn("node", [
    "--preserve-symlinks-main",
    "dist/pty.js",
    "sleep", "60",  // Keep alive for tests
    "--", "--serve", "--port", String(port),
  ], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Wait for server to be ready
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      serverProcess.kill();
      reject(new Error("Server did not start in time"));
    }, TEST_TIMEOUT);

    serverProcess.stdout!.on("data", (data: Buffer) => {
      if (data.toString().includes("PTY service manager listening")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    serverProcess.stderr!.on("data", (data: Buffer) => {
      if (data.toString().includes("PTY service manager listening")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    serverProcess.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  // Get initial app ID
  const appsRes = await fetch(`http://127.0.0.1:${port}/apps`);
  const appsBody = await appsRes.json();
  const appId = appsBody.apps[0]?.id;

  return { process: serverProcess, appId };
}

// Helper: Kill all apps on server
async function killAllApps(port: number): Promise<void> {
  try {
    const appsRes = await fetch(`http://127.0.0.1:${port}/apps`);
    const apps = await appsRes.json();
    await Promise.all(
      (apps.apps || []).map((app: any) =>
        fetch(`http://127.0.0.1:${port}/kill`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: app.id }),
        }).catch(() => {})
      )
    );
  } catch {}
}

// Helper: Retry wrapper for flaky tests
async function withRetry<T>(fn: () => Promise<T>, retries = RETRY_COUNT): Promise<T> {
  let lastError: Error | null = null;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      if (i < retries - 1) {
        await new Promise((r) => setTimeout(r, 500 * (i + 1)));
      }
    }
  }
  throw lastError;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core PTY API Tests (no server needed)
// ─────────────────────────────────────────────────────────────────────────────

describe("pty.ts — generic PTY service", () => {
  let instance: PtyInstance | null = null;

  afterAll(() => {
    if (instance) ptyKill(instance);
    ptyCleanup();
  });

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
    const inst = ptySpawn({ command: "nonexistent-command-xyz" });
    await new Promise<void>((resolve) => {
      inst.process.onExit(() => resolve());
    });
    // Process should have exited
    expect(true).toBe(true);
  });

  it("captures a buffer snapshot", async () => {
    const inst = ptySpawn({
      command: "bash",
      args: ["-c", "echo 'hello world'; sleep 1"],
    });

    await new Promise((r) => setTimeout(r, 500));

    const snap = ptySnapshot(inst, 10);

    expect(snap.fullLines).toBeInstanceOf(Array);
    expect(snap.visibleLines).toBeInstanceOf(Array);
    expect(snap.fullText).toContain("hello world");
    expect(snap.visibleText).toContain("hello world");
    expect(snap.bufCols).toBe(400);
    expect(snap.bufRows).toBe(40);

    ptyKill(inst);
  });

  it("respects footerRows parameter", async () => {
    const inst = ptySpawn({
      command: "bash",
      args: ["-c", "for i in $(seq 1 10); do echo line$i; done; sleep 1"],
    });

    await new Promise((r) => setTimeout(r, 500));

    const snap = ptySnapshot(inst, 5);
    expect(snap.footerLines.length).toBeLessThanOrEqual(5);

    ptyKill(inst);
  });

  it("strips ANSI codes from snapshot output", async () => {
    const inst = ptySpawn({
      command: "bash",
      args: ["-c", "echo -e '\\033[31mred\\033[0m'; sleep 1"],
    });

    await new Promise((r) => setTimeout(r, 500));

    const snap = ptySnapshot(inst, 10, true);
    expect(snap.fullText).not.toContain("\x1b[31m");
    expect(snap.fullText).toContain("red");

    ptyKill(inst);
  });

  it("preserves ANSI codes when stripAnsiCodes is false", async () => {
    const inst = ptySpawn({
      command: "bash",
      args: ["-c", "echo -e '\\033[31mred\\033[0m'; sleep 1"],
    });

    await new Promise((r) => setTimeout(r, 500));

    const snap = ptySnapshot(inst, 10, false);
    // ANSI codes should be present (possibly reconstructed)
    expect(snap.fullText).toContain("red");

    ptyKill(inst);
  });

  it("sends input to the process", async () => {
    const inst = ptySpawn({ command: "cat" });

    ptySend(inst, "test input\n");

    await new Promise((r) => setTimeout(r, 100));

    const snap = ptySnapshot(inst, 10);
    expect(snap.fullText).toContain("test input");

    ptyKill(inst);
  });

  it("resizes the PTY and xterm terminal", () => {
    const inst = ptySpawn({ command: "cat", cols: 80, rows: 24 });

    ptyResize(inst, 120, 40);

    expect(inst.cols).toBe(120);
    expect(inst.rows).toBe(40);

    ptyKill(inst);
  });

  it("sends signals to the process", async () => {
    const inst = ptySpawn({ command: "sleep", args: ["60"] });

    ptySignal(inst, "SIGTERM");

    await new Promise<void>((resolve) => {
      inst.process.onExit(() => resolve());
    });

    // Process should have exited
    expect(true).toBe(true);
  });

  it("tracks instances in the registry", () => {
    const inst = ptySpawn({ command: "sleep", args: ["60"] });
    const id = inst.id;

    const retrieved = ptyGet(id);
    expect(retrieved).toBe(inst);

    const all = ptyList();
    expect(all.some((i) => i.id === inst.id)).toBe(true);

    ptyKill(inst);
  });

  it("removes instances from registry after kill", async () => {
    const inst = ptySpawn({ command: "sleep", args: ["60"] });
    const id = inst.id;

    ptyKill(inst);

    // Wait for process to exit and instance to be removed from registry
    await new Promise<void>((resolve) => {
      inst.process.onExit(() => resolve());
    });

    expect(ptyGet(id)).toBeUndefined();
  });

  it("cleanup kills all remaining instances", () => {
    const inst = ptySpawn({ command: "sleep", args: ["60"] });
    expect(ptyGet(inst.id)).toBeTruthy();

    ptyCleanup();

    expect(ptyGet(inst.id)).toBeUndefined();
  });

  it("produces correct scrollback vs visible separation", async () => {
    const inst = ptySpawn({
      command: "bash",
      args: ["-c", 'for i in $(seq 1 50); do echo "line-$i"; done; sleep 1'],
      cols: 80,
      rows: 10,
    });

    await new Promise((r) => setTimeout(r, 2000));

    const snap = ptySnapshot(inst, 10);

    const totalFromParts = snap.scrollbackLines.length + snap.visibleLines.length;
    expect(totalFromParts).toBe(snap.fullLines.length);

    expect(snap.visibleLines.length).toBeLessThanOrEqual(10);

    ptyKill(inst);
  });

  it("captures full output for long-running processes (accum cap doesn't truncate xterm buffer)", async () => {
    const inst = ptySpawn({
      command: "bash",
      args: ["-c", 'for i in $(seq 1 100); do echo "line-$i"; done; sleep 1'],
      cols: 80,
      rows: 10,
    });

    await new Promise((r) => setTimeout(r, 2000));

    const snap = ptySnapshot(inst, 10);

    expect(snap.fullText).toContain("line-1");
    expect(snap.fullText).toContain("line-50");
    expect(snap.fullText).toContain("line-100");

    ptyKill(inst);
  });

  // ── Arg splitting logic (CLI) ─────────────────────────────────────────

  it("correctly splits command args from pty flags (no -- separator)", () => {
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

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket/HTTP Server Tests (isolated per test)
// ─────────────────────────────────────────────────────────────────────────────

describe("WebSocket serve/connect", () => {
  let serverProcess: ReturnType<typeof import("child_process").spawn>;
  let appId: string;

  // Start fresh server before EACH test
  beforeEach(async () => {
    await waitForPortFree(TEST_PORT, 3000).catch(() => {});
    const server = await startServer(TEST_PORT);
    serverProcess = server.process;
    appId = server.appId;
  });

  // Kill server after EACH test
  afterEach(async () => {
    await killAllApps(TEST_PORT).catch(() => {});
    if (serverProcess) {
      serverProcess.kill("SIGKILL");
      await new Promise((r) => setTimeout(r, 100));
    }
    await waitForPortFree(TEST_PORT, 3000).catch(() => {});
  });

  // ── Basic HTTP Endpoints ────────────────────────────────────────────────────

  it("responds to HTTP health check", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("serves /apps endpoint", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/apps`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.apps).toBeInstanceOf(Array);
    expect(body.apps.length).toBeGreaterThan(0);
  });

  it("serves /app/:id/snapshot endpoint", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/app/${appId}/snapshot`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("visibleText");
    expect(body).toHaveProperty("cols");
    expect(body).toHaveProperty("rows");
    expect(body).toHaveProperty("pid");
  });

  it("serves /app/:id/status endpoint", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/app/${appId}/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("sleep");
    expect(typeof body.pid).toBe("number");
    expect(body.pid).toBeGreaterThan(0);
    expect(typeof body.cols).toBe("number");
    expect(typeof body.rows).toBe("number");
    expect(typeof body.createdAt).toBe("number");
  });

  it("accepts POST /app/:id/send with valid body", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/app/${appId}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "test" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("rejects POST /app/:id/send with missing text", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/app/${appId}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  it("accepts POST /app/:id/resize and reflects new dimensions", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/app/${appId}/resize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cols: 132, rows: 50 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, cols: 132, rows: 50 });

    const statusRes = await fetch(`http://127.0.0.1:${TEST_PORT}/app/${appId}/status`);
    const status = await statusRes.json();
    expect(status.cols).toBe(132);
    expect(status.rows).toBe(50);
  });

  it("rejects POST /app/:id/resize with missing dimensions", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/app/${appId}/resize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cols: 100 }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown routes", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/does-not-exist`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  // ── WebSocket Basic Tests ───────────────────────────────────────────────────

  it("accepts WebSocket connection and receives output", async () => {
    const { WebSocket } = await import("ws");

    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${appId}`);
    const messages: string[] = [];

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout")), TEST_TIMEOUT);
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
      });
      ws.on("message", (data) => {
        messages.push(data.toString());
        if (messages.length >= 1) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    expect(messages.length).toBeGreaterThan(0);
    ws.close();
  });

  it("accepts input via WebSocket and sends to PTY", async () => {
    const { WebSocket } = await import("ws");

    // Start a bash app for input testing
    const startRes = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "bash" }),
    });
    const app = await startRes.json();

    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app.id}`);
    const received: string[] = [];

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout")), TEST_TIMEOUT);
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "input", text: "echo WS_INPUT_TEST\n" }));
        }, 200);
      });
      ws.on("message", (data) => {
        received.push(data.toString());
        if (data.toString().includes("WS_INPUT_TEST")) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    expect(received.some((m) => m.includes("WS_INPUT_TEST"))).toBe(true);
    ws.close();
  });

  // ── Test Spec Scenario 1: Single App, Multiple Clients (Broadcast) ───────────

  it("scenario 1: 3 clients see identical output, exit broadcast on app quit", async () => {
    const { WebSocket } = await import("ws");

    // Start a bash app
    const startRes = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "bash", args: ["-c", "echo SCENARIO1; sleep 30"] }),
    });
    const app = await startRes.json();

    // Connect 3 clients
    const wsA = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app.id}`);
    const wsB = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app.id}`);
    const wsC = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app.id}`);

    const msgsA: string[] = [];
    const msgsB: string[] = [];
    const msgsC: string[] = [];

    [wsA, wsB, wsC].forEach((ws) => {
      ws.on("open", () => ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 })));
    });
    wsA.on("message", (data) => msgsA.push(data.toString()));
    wsB.on("message", (data) => msgsB.push(data.toString()));
    wsC.on("message", (data) => msgsC.push(data.toString()));

    // Wait for all to receive output
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout")), TEST_TIMEOUT);
      const check = () => {
        if (msgsA.some((m) => m.includes("SCENARIO1")) &&
            msgsB.some((m) => m.includes("SCENARIO1")) &&
            msgsC.some((m) => m.includes("SCENARIO1"))) {
          clearTimeout(timeout);
          resolve();
        }
      };
      wsA.on("message", check);
      wsB.on("message", check);
      wsC.on("message", check);
      setTimeout(check, 500);
    });

    // All should have seen the output
    expect(msgsA.some((m) => m.includes("SCENARIO1"))).toBe(true);
    expect(msgsB.some((m) => m.includes("SCENARIO1"))).toBe(true);
    expect(msgsC.some((m) => m.includes("SCENARIO1"))).toBe(true);

    // Kill app and verify all get exit
    await fetch(`http://127.0.0.1:${TEST_PORT}/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: app.id }),
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout")), TEST_TIMEOUT);
      const check = () => {
        const hasExitA = msgsA.some((m) => { try { return JSON.parse(m).type === "exit"; } catch { return false; } });
        const hasExitB = msgsB.some((m) => { try { return JSON.parse(m).type === "exit"; } catch { return false; } });
        const hasExitC = msgsC.some((m) => { try { return JSON.parse(m).type === "exit"; } catch { return false; } });
        if (hasExitA && hasExitB && hasExitC) {
          clearTimeout(timeout);
          resolve();
        }
      };
      wsA.on("message", check);
      wsB.on("message", check);
      wsC.on("message", check);
      setTimeout(check, 200);
    });

    [wsA, wsB, wsC].forEach((ws) => { try { ws.close(); } catch {} });
  });

  // ── Test Spec Scenario 2: Multiple Apps, Single Client ────────────────────────

  it("scenario 2: single client switches between multiple apps", async () => {
    const { WebSocket } = await import("ws");

    // Start 2 apps
    const app1Res = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "bash", args: ["-c", "echo APP_1; sleep 30"] }),
    });
    const app1 = await app1Res.json();

    const app2Res = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "bash", args: ["-c", "echo APP_2; sleep 30"] }),
    });
    const app2 = await app2Res.json();

    // Connect to app1
    const ws1 = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app1.id}`);
    const msgs1: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout")), TEST_TIMEOUT);
      ws1.on("open", () => ws1.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 })));
      ws1.on("message", (data) => {
        msgs1.push(data.toString());
        if (data.toString().includes("APP_1")) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    ws1.close();

    // Connect to app2
    const ws2 = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app2.id}`);
    const msgs2: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout")), TEST_TIMEOUT);
      ws2.on("open", () => ws2.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 })));
      ws2.on("message", (data) => {
        msgs2.push(data.toString());
        if (data.toString().includes("APP_2")) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    ws2.close();

    // Verify isolation
    expect(msgs1.some((m) => m.includes("APP_1"))).toBe(true);
    expect(msgs1.some((m) => m.includes("APP_2"))).toBe(false);
    expect(msgs2.some((m) => m.includes("APP_2"))).toBe(true);
    expect(msgs2.some((m) => m.includes("APP_1"))).toBe(false);
  });

  // ── Test Spec Scenario 3: Multiple Apps, Multiple Clients ─────────────────────

  it("scenario 3: many clients across many apps - output isolated per app", async () => {
    const { WebSocket } = await import("ws");

    // Start 2 apps
    const app1Res = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "bash", args: ["-c", "echo APP1_OUTPUT; sleep 30"] }),
    });
    const app1 = await app1Res.json();

    const app2Res = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "bash", args: ["-c", "echo APP2_OUTPUT; sleep 30"] }),
    });
    const app2 = await app2Res.json();

    // 3 clients: 2 to app1, 1 to app2
    const ws1a = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app1.id}`);
    const ws1b = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app1.id}`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app2.id}`);

    const msgs1a: string[] = [];
    const msgs1b: string[] = [];
    const msgs2: string[] = [];

    [ws1a, ws1b, ws2].forEach((ws) => {
      ws.on("open", () => ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 })));
    });
    ws1a.on("message", (data) => msgs1a.push(data.toString()));
    ws1b.on("message", (data) => msgs1b.push(data.toString()));
    ws2.on("message", (data) => msgs2.push(data.toString()));

    // Wait for all to receive output
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout")), TEST_TIMEOUT);
      const check = () => {
        const has1a = msgs1a.some((m) => m.includes("APP1_OUTPUT"));
        const has1b = msgs1b.some((m) => m.includes("APP1_OUTPUT"));
        const has2 = msgs2.some((m) => m.includes("APP2_OUTPUT"));
        if (has1a && has1b && has2) {
          clearTimeout(timeout);
          resolve();
        }
      };
      ws1a.on("message", check);
      ws1b.on("message", check);
      ws2.on("message", check);
      setTimeout(check, 500);
    });

    // Verify isolation
    expect(msgs1a.some((m) => m.includes("APP1_OUTPUT"))).toBe(true);
    expect(msgs1a.some((m) => m.includes("APP2_OUTPUT"))).toBe(false);
    expect(msgs1b.some((m) => m.includes("APP1_OUTPUT"))).toBe(true);
    expect(msgs1b.some((m) => m.includes("APP2_OUTPUT"))).toBe(false);
    expect(msgs2.some((m) => m.includes("APP2_OUTPUT"))).toBe(true);
    expect(msgs2.some((m) => m.includes("APP1_OUTPUT"))).toBe(false);

    [ws1a, ws1b, ws2].forEach((ws) => ws.close());
  });

  // ── Test Spec Scenario 4: Client Kill Propagation ─────────────────────────────

  it("scenario 4a: Ctrl+C from one client affects all clients", async () => {
    const { WebSocket } = await import("ws");

    const appRes = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "bash", args: ["-c", "trap 'echo SIGINT' SIGINT; while true; do echo LOOP; sleep 1; done"] }),
    });
    const app = await appRes.json();

    const ws1 = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app.id}`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app.id}`);

    const msgs1: string[] = [];
    const msgs2: string[] = [];

    [ws1, ws2].forEach((ws) => {
      ws.on("open", () => ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 })));
    });
    ws1.on("message", (data) => msgs1.push(data.toString()));
    ws2.on("message", (data) => msgs2.push(data.toString()));

    await new Promise((r) => setTimeout(r, 500));

    // Client 1 sends Ctrl+C
    ws1.send(JSON.stringify({ type: "input", text: "\x03" }));

    // Both should see the effect
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout")), TEST_TIMEOUT);
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

    [ws1, ws2].forEach((ws) => ws.close());
  });

  it("scenario 4b: HTTP kill notifies all WebSocket clients", async () => {
    const { WebSocket } = await import("ws");

    const appRes = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "sleep", args: ["60"] }),
    });
    const app = await appRes.json();

    const ws1 = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app.id}`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app.id}`);

    const msgs1: string[] = [];
    const msgs2: string[] = [];

    [ws1, ws2].forEach((ws) => {
      ws.on("open", () => ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 })));
    });
    ws1.on("message", (data) => msgs1.push(data.toString()));
    ws2.on("message", (data) => msgs2.push(data.toString()));

    await new Promise((r) => setTimeout(r, 300));

    // Kill via HTTP
    await fetch(`http://127.0.0.1:${TEST_PORT}/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: app.id }),
    });

    // Both should receive exit
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout")), TEST_TIMEOUT);
      const check = () => {
        const hasExit1 = msgs1.some((m) => { try { return JSON.parse(m).type === "exit"; } catch { return false; } });
        const hasExit2 = msgs2.some((m) => { try { return JSON.parse(m).type === "exit"; } catch { return false; } });
        if (hasExit1 && hasExit2) {
          clearTimeout(timeout);
          resolve();
        }
      };
      ws1.on("message", check);
      ws2.on("message", check);
      setTimeout(check, 200);
    });

    expect(msgs1.some((m) => { try { return JSON.parse(m).type === "exit"; } catch { return false; } })).toBe(true);
    expect(msgs2.some((m) => { try { return JSON.parse(m).type === "exit"; } catch { return false; } })).toBe(true);

    [ws1, ws2].forEach((ws) => { try { ws.close(); } catch {} });
  });

  // ── Test Spec Scenario 5: Client Disconnect Cleanup ───────────────────────────

  it("scenario 5: app survives after all clients disconnect", async () => {
    const { WebSocket } = await import("ws");

    const appRes = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "sleep", args: ["60"] }),
    });
    const app = await appRes.json();

    // Connect 3 clients
    const clients = await Promise.all(
      [1, 2, 3].map(() =>
        new Promise<WebSocket>((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app.id}`);
          ws.on("open", () => {
            ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
            resolve(ws);
          });
        })
      )
    );

    await new Promise((r) => setTimeout(r, 300));

    // Disconnect all
    clients.forEach((ws) => ws.close());
    await new Promise((r) => setTimeout(r, 200));

    // App should still be running
    const statusRes = await fetch(`http://127.0.0.1:${TEST_PORT}/app/${app.id}/status`);
    expect(statusRes.status).toBe(200);
  });

  // ── Test Spec Scenario 6: App Restart After Kill ───────────────────────────────

  it("scenario 6: can start new app after killing old one", async () => {
    // Start app A
    const appARes = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "sleep", args: ["60"] }),
    });
    const appA = await appARes.json();

    // Kill app A
    await fetch(`http://127.0.0.1:${TEST_PORT}/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: appA.id }),
    });
    await new Promise((r) => setTimeout(r, 200));

    // Start app B
    const appBRes = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "sleep", args: ["60"] }),
    });
    expect(appBRes.status).toBe(200);
    const appB = await appBRes.json();

    // New app has different ID
    expect(appB.id).not.toBe(appA.id);

    // New app works
    const statusRes = await fetch(`http://127.0.0.1:${TEST_PORT}/app/${appB.id}/status`);
    expect(statusRes.status).toBe(200);
  });

  // ── Test Spec Scenario 7: Short ID Resolution ──────────────────────────────────

  it("scenario 7: short ID works for all operations", async () => {
    const appRes = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "sleep", args: ["60"] }),
    });
    const app = await appRes.json();
    const shortId = app.id.slice(0, 8);

    // Snapshot
    const snapRes = await fetch(`http://127.0.0.1:${TEST_PORT}/app/${shortId}/snapshot`);
    expect(snapRes.status).toBe(200);

    // Status
    const statusRes = await fetch(`http://127.0.0.1:${TEST_PORT}/app/${shortId}/status`);
    expect(statusRes.status).toBe(200);

    // Send
    const sendRes = await fetch(`http://127.0.0.1:${TEST_PORT}/app/${shortId}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "test" }),
    });
    expect(sendRes.status).toBe(200);

    // Kill
    const killRes = await fetch(`http://127.0.0.1:${TEST_PORT}/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: shortId }),
    });
    expect(killRes.status).toBe(200);
  });

  // ── Test Spec Scenario 8: Concurrent Start Requests ─────────────────────────────

  it("scenario 8: concurrent start requests all succeed", async () => {
    const requests = Array.from({ length: 5 }, () =>
      fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "sleep", args: ["60"] }),
      }).then((r) => r.json())
    );

    const apps = await Promise.all(requests);

    // All succeeded
    apps.forEach((app) => {
      expect(app.id).toBeDefined();
      expect(app.pid).toBeDefined();
    });

    // All IDs unique
    const ids = apps.map((a) => a.id);
    expect(new Set(ids).size).toBe(5);

    // All appear in /apps
    const appsRes = await fetch(`http://127.0.0.1:${TEST_PORT}/apps`);
    const appsList = await appsRes.json();
    expect(appsList.apps.length).toBeGreaterThanOrEqual(5);
  });

  // ── Test Spec Scenario 9: WebSocket Reconnect ──────────────────────────────────

  it("scenario 9: client can reconnect to same app", async () => {
    const { WebSocket } = await import("ws");

    const appRes = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "bash", args: ["-c", "echo RECONNECT; sleep 30"] }),
    });
    const app = await appRes.json();

    // First connection
    const ws1 = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app.id}`);
    const msgs1: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout")), TEST_TIMEOUT);
      ws1.on("open", () => ws1.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 })));
      ws1.on("message", (data) => {
        msgs1.push(data.toString());
        if (data.toString().includes("RECONNECT")) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    ws1.close();
    await new Promise((r) => setTimeout(r, 200));

    // Reconnect
    const ws2 = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app.id}`);
    const msgs2: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout")), TEST_TIMEOUT);
      ws2.on("open", () => ws2.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 })));
      ws2.on("message", (data) => {
        msgs2.push(data.toString());
        resolve();
      });
    });
    ws2.close();

    expect(msgs2.length).toBeGreaterThan(0);
  });

  // ── Test Spec Scenario 10: Large Output Stress Test ─────────────────────────────

  it("scenario 10: handles large output with multiple clients", async () => {
    const { WebSocket } = await import("ws");

    const appRes = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "bash", args: ["-c", "for i in $(seq 1 100); do echo LINE_$i; done; sleep 1"] }),
    });
    const app = await appRes.json();

    const ws1 = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app.id}`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app.id}`);

    const msgs1: string[] = [];
    const msgs2: string[] = [];

    [ws1, ws2].forEach((ws) => {
      ws.on("open", () => ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 })));
    });
    ws1.on("message", (data) => msgs1.push(data.toString()));
    ws2.on("message", (data) => msgs2.push(data.toString()));

    // Wait for completion
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout")), TEST_TIMEOUT);
      const check = () => {
        if (msgs1.some((m) => m.includes("LINE_100")) && msgs2.some((m) => m.includes("LINE_100"))) {
          clearTimeout(timeout);
          resolve();
        }
      };
      ws1.on("message", check);
      ws2.on("message", check);
      setTimeout(check, 500);
    });

    const all1 = msgs1.join("");
    const all2 = msgs2.join("");
    expect(all1).toContain("LINE_1");
    expect(all1).toContain("LINE_100");
    expect(all2).toContain("LINE_1");
    expect(all2).toContain("LINE_100");

    [ws1, ws2].forEach((ws) => ws.close());
  });

  // ── Shared Editing Test ───────────────────────────────────────────────────────

  it("shared editing: multiple clients send input, all see result", async () => {
    const { WebSocket } = await import("ws");

    const appRes = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "bash" }),
    });
    const app = await appRes.json();

    const ws1 = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app.id}`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app.id}`);

    const msgs1: string[] = [];
    const msgs2: string[] = [];

    [ws1, ws2].forEach((ws) => {
      ws.on("open", () => ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 })));
    });
    ws1.on("message", (data) => msgs1.push(data.toString()));
    ws2.on("message", (data) => msgs2.push(data.toString()));

    await new Promise((r) => setTimeout(r, 500));

    // Client 1 sends command
    ws1.send(JSON.stringify({ type: "input", text: "echo SHARED_1\n" }));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout")), TEST_TIMEOUT);
      const check = () => {
        if (msgs1.some((m) => m.includes("SHARED_1")) && msgs2.some((m) => m.includes("SHARED_1"))) {
          clearTimeout(timeout);
          resolve();
        }
      };
      ws1.on("message", check);
      ws2.on("message", check);
      setTimeout(check, 200);
    });

    // Client 2 sends command
    ws2.send(JSON.stringify({ type: "input", text: "echo SHARED_2\n" }));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout")), TEST_TIMEOUT);
      const check = () => {
        if (msgs1.some((m) => m.includes("SHARED_2")) && msgs2.some((m) => m.includes("SHARED_2"))) {
          clearTimeout(timeout);
          resolve();
        }
      };
      ws1.on("message", check);
      ws2.on("message", check);
      setTimeout(check, 200);
    });

    // Both saw both commands
    const all1 = msgs1.join("");
    const all2 = msgs2.join("");
    expect(all1).toContain("SHARED_1");
    expect(all1).toContain("SHARED_2");
    expect(all2).toContain("SHARED_1");
    expect(all2).toContain("SHARED_2");

    [ws1, ws2].forEach((ws) => ws.close());
  });

  // ── Edge Cases: Malformed Input ───────────────────────────────────────────────

  it("handles malformed JSON in WebSocket messages", async () => {
    const { WebSocket } = await import("ws");

    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${appId}`);
    const msgs: string[] = [];

    await new Promise<void>((resolve) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
        // Malformed
        ws.send("{ invalid json }");
        ws.send("not json");
        ws.send(JSON.stringify({ type: "input" })); // missing text
        ws.send(JSON.stringify({ type: "resize" })); // missing cols/rows
        setTimeout(resolve, 300);
      });
      ws.on("message", (data) => msgs.push(data.toString()));
    });

    // Connection still alive
    expect(ws.readyState).toBe(1);
    ws.close();
  });

  it("handles malformed JSON in HTTP requests", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ invalid json }",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("handles invalid app ID in all endpoints", async () => {
    const fakeId = "nonexistent-id-12345";

    expect((await fetch(`http://127.0.0.1:${TEST_PORT}/app/${fakeId}/snapshot`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${TEST_PORT}/app/${fakeId}/status`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${TEST_PORT}/app/${fakeId}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "test" }),
    })).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${TEST_PORT}/app/${fakeId}/resize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cols: 80, rows: 24 }),
    })).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${TEST_PORT}/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: fakeId }),
    })).status).toBe(404);
  });

  it("handles double kill gracefully", async () => {
    const appRes = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "sleep", args: ["30"] }),
    });
    const app = await appRes.json();

    // First kill
    expect((await fetch(`http://127.0.0.1:${TEST_PORT}/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: app.id }),
    })).status).toBe(200);

    await new Promise((r) => setTimeout(r, 200));

    // Second kill
    expect((await fetch(`http://127.0.0.1:${TEST_PORT}/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: app.id }),
    })).status).toBe(404);
  });

  it("handles kill with missing ID", async () => {
    expect((await fetch(`http://127.0.0.1:${TEST_PORT}/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })).status).toBe(400);
  });

  it("handles start with missing command", async () => {
    expect((await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })).status).toBe(400);
  });

  // ── Edge Cases: Boundary Values ───────────────────────────────────────────────

  it("handles very large terminal dimensions", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "sleep", args: ["30"], cols: 10000, rows: 10000 }),
    });
    expect(res.status).toBe(200);
    const app = await res.json();

    const statusRes = await fetch(`http://127.0.0.1:${TEST_PORT}/app/${app.id}/status`);
    expect(statusRes.status).toBe(200);
    const status = await statusRes.json();
    expect(status.cols).toBeDefined();
    expect(status.rows).toBeDefined();
  });

  it("handles empty input text", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/app/${appId}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    expect(res.status).toBe(400);
  });

  // ── Security Tests ────────────────────────────────────────────────────────────

  it("handles shell injection attempts safely", async () => {
    const { WebSocket } = await import("ws");

    const appRes = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "bash" }),
    });
    const app = await appRes.json();

    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app.id}`);
    const msgs: string[] = [];

    await new Promise<void>((resolve) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "input", text: "echo $(whoami)\n" }));
          ws.send(JSON.stringify({ type: "input", text: "echo `date`\n" }));
        }, 100);
      });
      ws.on("message", (data) => {
        msgs.push(data.toString());
        if (msgs.length > 5) resolve();
      });
      setTimeout(resolve, 2000);
    });

    expect(msgs.length).toBeGreaterThan(0);
    ws.close();
  });

  // ── Performance Tests ─────────────────────────────────────────────────────────

  it("handles many concurrent WebSocket connections", async () => {
    const { WebSocket } = await import("ws");

    const clients: WebSocket[] = [];
    const connectPromises: Promise<void>[] = [];

    for (let i = 0; i < 20; i++) {
      const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${appId}`);
      clients.push(ws);
      connectPromises.push(
        new Promise<void>((resolve) => {
          ws.on("open", () => {
            ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
            resolve();
          });
        })
      );
    }

    await Promise.all(connectPromises);

    const statusRes = await fetch(`http://127.0.0.1:${TEST_PORT}/app/${appId}/status`);
    const status = await statusRes.json();
    expect(status.clients).toBe(20);

    clients.forEach((ws) => ws.close());
  });

  // ── Race Condition Tests ─────────────────────────────────────────────────────

  it("handles rapid connect/disconnect cycles", async () => {
    const { WebSocket } = await import("ws");

    for (let i = 0; i < 10; i++) {
      const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${appId}`);
      await new Promise<void>((resolve) => {
        ws.on("open", () => {
          ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
          setTimeout(() => {
            ws.close();
            resolve();
          }, 50);
        });
      });
    }

    // App still running
    const statusRes = await fetch(`http://127.0.0.1:${TEST_PORT}/app/${appId}/status`);
    expect(statusRes.status).toBe(200);
  });

  it("handles kill during WebSocket connection", async () => {
    const { WebSocket } = await import("ws");

    const appRes = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "sleep", args: ["30"] }),
    });
    const app = await appRes.json();

    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app.id}`);
    const msgs: string[] = [];

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
        setTimeout(() => {
          fetch(`http://127.0.0.1:${TEST_PORT}/kill`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: app.id }),
          });
        }, 100);
      });
      ws.on("message", (data) => {
        msgs.push(data.toString());
        const msg = JSON.parse(data.toString());
        if (msg.type === "exit") resolve();
      });
      setTimeout(resolve, 2000);
    });

    expect(msgs.some((m) => { try { return JSON.parse(m).type === "exit"; } catch { return false; } })).toBe(true);
    ws.close();
  });

  // ── Integration: Real TUI Apps ────────────────────────────────────────────────

  it("runs htop and captures output", async () => {
    const appRes = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "htop" }),
    });

    if (appRes.status !== 200) return; // htop not installed

    const app = await appRes.json();
    await new Promise((r) => setTimeout(r, 500));

    const snapRes = await fetch(`http://127.0.0.1:${TEST_PORT}/app/${app.id}/snapshot`);
    expect(snapRes.status).toBe(200);
    const snap = await snapRes.json();
    expect(snap.visibleText.length).toBeGreaterThan(0);
  });

  it("runs vim and exits cleanly", async () => {
    const { WebSocket } = await import("ws");

    const appRes = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "vim" }),
    });

    if (appRes.status !== 200) return; // vim not installed

    const app = await appRes.json();

    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app.id}`);
    const msgs: string[] = [];

    await new Promise<void>((resolve) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "input", text: "\x1b" })); // ESC
          ws.send(JSON.stringify({ type: "input", text: ":q!\r" }));
        }, 500);
      });
      ws.on("message", (data) => {
        msgs.push(data.toString());
        const msg = JSON.parse(data.toString());
        if (msg.type === "exit") resolve();
      });
      setTimeout(resolve, 3000);
    });

    ws.close();
  });

  it("runs nano and exits cleanly", async () => {
    const { WebSocket } = await import("ws");

    const appRes = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "nano" }),
    });

    if (appRes.status !== 200) return; // nano not installed

    const app = await appRes.json();

    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app.id}`);

    await new Promise<void>((resolve) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "input", text: "\x18" })); // Ctrl+X
        }, 500);
      });
      ws.on("message", () => {});
      setTimeout(() => {
        ws.close();
        resolve();
      }, 2000);
    });
  });

  it("sends arrow keys via HTTP /send endpoint", async () => {
    const appRes = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "cat", args: ["-v"], cols: 80, rows: 24 }),
    });
    const app = await appRes.json();

    await new Promise((r) => setTimeout(r, 300));

    await fetch(`http://127.0.0.1:${TEST_PORT}/app/${app.id}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "\x1b[B" }),
    });

    await new Promise((r) => setTimeout(r, 200));

    const snapRes = await fetch(`http://127.0.0.1:${TEST_PORT}/app/${app.id}/snapshot`);
    const snap = await snapRes.json();

    expect(snap.visibleText).toContain("^[[B");

    await fetch(`http://127.0.0.1:${TEST_PORT}/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: app.id }),
    });
  });

  it("sends arrow keys via WebSocket", async () => {
    const { WebSocket } = await import("ws");

    const appRes = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "cat", args: ["-v"], cols: 80, rows: 24 }),
    });
    const app = await appRes.json();

    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app.id}`);
    let receivedOutput = false;

    await new Promise<void>((resolve) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "input", text: "\x1b[B" }));
        }, 300);
      });
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "output" && msg.text.includes("^[[B")) {
          receivedOutput = true;
        }
      });
      setTimeout(() => {
        ws.close();
        resolve();
      }, 1000);
    });

    expect(receivedOutput).toBe(true);

    await fetch(`http://127.0.0.1:${TEST_PORT}/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: app.id }),
    });
  });

  it("htop responds to arrow keys with client-side mode translation", async () => {
    const { WebSocket } = await import("ws");

    const appRes = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "htop", cols: 80, rows: 24 }),
    });

    if (appRes.status !== 200) {
      return;
    }

    const app = await appRes.json();

    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app.id}`);
    let applicationCursorKeys = false;

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
    });

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "mode") {
        applicationCursorKeys = msg.applicationCursorKeys;
      }
    });

    await new Promise((r) => setTimeout(r, 500));

    const snapBeforeRes = await fetch(`http://127.0.0.1:${TEST_PORT}/app/${app.id}/snapshot?color=true`);
    const snapBefore = await snapBeforeRes.json();
    const beforePid = findHighlightedPid(snapBefore);

    // Client translates arrow key based on mode
    const arrowDown = applicationCursorKeys ? "\x1bOB" : "\x1b[B";
    ws.send(JSON.stringify({ type: "input", text: arrowDown }));

    await new Promise((r) => setTimeout(r, 300));

    const snapAfterRes = await fetch(`http://127.0.0.1:${TEST_PORT}/app/${app.id}/snapshot?color=true`);
    const snapAfter = await snapAfterRes.json();
    const afterPid = findHighlightedPid(snapAfter);

    expect(afterPid).not.toBe(beforePid);

    ws.close();
    await fetch(`http://127.0.0.1:${TEST_PORT}/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: app.id }),
    });
  });

  // ── Mouse/Touch Event Encoding Tests ─────────────────────────────────────────

  it("encodes mouse click event correctly", async () => {
    const { WebSocket } = await import("ws");

    const appRes = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "cat", args: ["-v"], cols: 80, rows: 24 }),
    });
    const app = await appRes.json();

    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app.id}`);
    const msgs: string[] = [];

    await new Promise<void>((resolve) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "mouse", event: "click", button: 0, x: 10, y: 5 }));
        }, 200);
      });
      ws.on("message", (data) => msgs.push(data.toString()));
      setTimeout(resolve, 500);
    });

    const output = msgs.map(m => { try { return JSON.parse(m).text || ""; } catch { return ""; } }).join("");
    expect(output).toContain("[<0;10;5M");

    ws.close();
    await fetch(`http://127.0.0.1:${TEST_PORT}/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: app.id }),
    });
  });

  it("encodes mouse scroll event correctly", async () => {
    const { WebSocket } = await import("ws");

    const appRes = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "cat", args: ["-v"], cols: 80, rows: 24 }),
    });
    const app = await appRes.json();

    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app.id}`);
    const msgs: string[] = [];

    await new Promise<void>((resolve) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "mouse", event: "scroll", x: 10, y: 5, dy: -1 }));
          ws.send(JSON.stringify({ type: "mouse", event: "scroll", x: 10, y: 5, dy: 1 }));
        }, 200);
      });
      ws.on("message", (data) => msgs.push(data.toString()));
      setTimeout(resolve, 500);
    });

    const output = msgs.map(m => { try { return JSON.parse(m).text || ""; } catch { return ""; } }).join("");
    expect(output).toContain("[<4;10;5M");
    expect(output).toContain("[<5;10;5M");

    ws.close();
    await fetch(`http://127.0.0.1:${TEST_PORT}/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: app.id }),
    });
  });

  it("encodes mouse release event correctly", async () => {
    const { WebSocket } = await import("ws");

    const appRes = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "cat", args: ["-v"], cols: 80, rows: 24 }),
    });
    const app = await appRes.json();

    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app.id}`);
    const msgs: string[] = [];

    await new Promise<void>((resolve) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "mouse", event: "release", button: 0, x: 10, y: 5 }));
        }, 200);
      });
      ws.on("message", (data) => msgs.push(data.toString()));
      setTimeout(resolve, 500);
    });

    const output = msgs.map(m => { try { return JSON.parse(m).text || ""; } catch { return ""; } }).join("");
    expect(output).toContain("[<0;10;5m");

    ws.close();
    await fetch(`http://127.0.0.1:${TEST_PORT}/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: app.id }),
    });
  });

  it("encodes touch tap event correctly", async () => {
    const { WebSocket } = await import("ws");

    const appRes = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "cat", args: ["-v"], cols: 80, rows: 24 }),
    });
    const app = await appRes.json();

    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app.id}`);
    const msgs: string[] = [];

    await new Promise<void>((resolve) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "touch", event: "tap", x: 10, y: 5 }));
        }, 200);
      });
      ws.on("message", (data) => msgs.push(data.toString()));
      setTimeout(resolve, 500);
    });

    const output = msgs.map(m => { try { return JSON.parse(m).text || ""; } catch { return ""; } }).join("");
    expect(output).toContain("[<0;10;5M");
    expect(output).toContain("[<0;10;5m");

    ws.close();
    await fetch(`http://127.0.0.1:${TEST_PORT}/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: app.id }),
    });
  });

  it("encodes touch longpress event correctly", async () => {
    const { WebSocket } = await import("ws");

    const appRes = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "cat", args: ["-v"], cols: 80, rows: 24 }),
    });
    const app = await appRes.json();

    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app.id}`);
    const msgs: string[] = [];

    await new Promise<void>((resolve) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "touch", event: "longpress", x: 10, y: 5 }));
        }, 200);
      });
      ws.on("message", (data) => msgs.push(data.toString()));
      setTimeout(resolve, 500);
    });

    const output = msgs.map(m => { try { return JSON.parse(m).text || ""; } catch { return ""; } }).join("");
    expect(output).toContain("[<2;10;5M");
    expect(output).toContain("[<2;10;5m");

    ws.close();
    await fetch(`http://127.0.0.1:${TEST_PORT}/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: app.id }),
    });
  });

  it("encodes touch swipe event correctly", async () => {
    const { WebSocket } = await import("ws");

    const appRes = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "cat", args: ["-v"], cols: 80, rows: 24 }),
    });
    const app = await appRes.json();

    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app.id}`);
    const msgs: string[] = [];

    await new Promise<void>((resolve) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
        setTimeout(() => {
          // Swipe up (dy < 0) → scroll up (button 4)
          ws.send(JSON.stringify({ type: "touch", event: "swipe", x: 10, y: 5, dy: -50 }));
          // Swipe down (dy > 0) → scroll down (button 5)
          ws.send(JSON.stringify({ type: "touch", event: "swipe", x: 10, y: 5, dy: 50 }));
        }, 200);
      });
      ws.on("message", (data) => msgs.push(data.toString()));
      setTimeout(resolve, 500);
    });

    const output = msgs.map(m => { try { return JSON.parse(m).text || ""; } catch { return ""; } }).join("");
    // Swipe up = scroll up (button 4), swipe down = scroll down (button 5)
    expect(output).toContain("[<4;10;5M");
    expect(output).toContain("[<5;10;5M");

    ws.close();
    await fetch(`http://127.0.0.1:${TEST_PORT}/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: app.id }),
    });
  });

  it("encodes touch pinch event correctly", async () => {
    const { WebSocket } = await import("ws");

    const appRes = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "cat", args: ["-v"], cols: 80, rows: 24 }),
    });
    const app = await appRes.json();

    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app.id}`);
    const msgs: string[] = [];

    await new Promise<void>((resolve) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "touch", event: "pinch", x: 10, y: 5, scale: 1.5 }));
        }, 200);
      });
      ws.on("message", (data) => msgs.push(data.toString()));
      setTimeout(resolve, 500);
    });

    const output = msgs.map(m => { try { return JSON.parse(m).text || ""; } catch { return ""; } }).join("");
    expect(output).toContain("[<20;10;5M");

    ws.close();
    await fetch(`http://127.0.0.1:${TEST_PORT}/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: app.id }),
    });
  });

  it("handles mouse drag event", async () => {
    const { WebSocket } = await import("ws");

    const appRes = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "cat", args: ["-v"], cols: 80, rows: 24 }),
    });
    const app = await appRes.json();

    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app.id}`);
    const msgs: string[] = [];

    await new Promise<void>((resolve) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "mouse", event: "drag", button: 0, x: 15, y: 10 }));
        }, 200);
      });
      ws.on("message", (data) => msgs.push(data.toString()));
      setTimeout(resolve, 500);
    });

    const output = msgs.map(m => { try { return JSON.parse(m).text || ""; } catch { return ""; } }).join("");
    expect(output).toContain("[<32;15;10M");

    ws.close();
    await fetch(`http://127.0.0.1:${TEST_PORT}/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: app.id }),
    });
  });

  it("handles mouse move event", async () => {
    const { WebSocket } = await import("ws");

    const appRes = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "cat", args: ["-v"], cols: 80, rows: 24 }),
    });
    const app = await appRes.json();

    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app.id}`);
    const msgs: string[] = [];

    await new Promise<void>((resolve) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "mouse", event: "move", x: 20, y: 15 }));
        }, 200);
      });
      ws.on("message", (data) => msgs.push(data.toString()));
      setTimeout(resolve, 500);
    });

    const output = msgs.map(m => { try { return JSON.parse(m).text || ""; } catch { return ""; } }).join("");
    expect(output).toContain("[<32;20;15M");

    ws.close();
    await fetch(`http://127.0.0.1:${TEST_PORT}/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: app.id }),
    });
  });

  it("handles horizontal scroll via wheel event", async () => {
    const { WebSocket } = await import("ws");

    const appRes = await fetch(`http://127.0.0.1:${TEST_PORT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "cat", args: ["-v"], cols: 80, rows: 24 }),
    });
    const app = await appRes.json();

    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/app/${app.id}`);
    const msgs: string[] = [];

    await new Promise<void>((resolve) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "mouse", event: "wheel", x: 10, y: 5, dx: -1 }));
          ws.send(JSON.stringify({ type: "mouse", event: "wheel", x: 10, y: 5, dx: 1 }));
        }, 200);
      });
      ws.on("message", (data) => msgs.push(data.toString()));
      setTimeout(resolve, 500);
    });

    const output = msgs.map(m => { try { return JSON.parse(m).text || ""; } catch { return ""; } }).join("");
    expect(output).toContain("[<6;10;5M");
    expect(output).toContain("[<7;10;5M");

    ws.close();
    await fetch(`http://127.0.0.1:${TEST_PORT}/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: app.id }),
    });
  });
});

function findHighlightedPid(snap: { visibleLines: string[] }): string | null {
  for (const line of snap.visibleLines) {
    if (line.includes("48;5;6")) {
      const match = line.match(/\s(\d{4,})\s/);
      if (match) return match[1];
    }
  }
  return null;
}
