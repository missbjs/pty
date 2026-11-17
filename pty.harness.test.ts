// Tests for the test-harness features: env/cwd/args, named keys + paste, wait, exit status,
// colour snapshots, process-tree kill, token auth / browser-attack guards, and the CLI client.
// Only needs `node` (cross-platform) — no bash/htop/vim. Servers use ports 3160-3169.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { execFile } from "node:child_process";
import { WebSocket as WsClient } from "ws";
import {
  ptySpawn, ptySnapshot, ptyKill, ptyCleanup, ptyGet, ptyGetAny, ptyList, ptyWait, ptyWaitExit, ptyInput,
  ptyScreenText, keyToSequence, pasteSequence, resolveCommand, splitCliArgs, parseEnvPairs, isLoopbackHost,
  createPtyServer, type PtyInstance, type PtyServer,
} from "./pty.js";

const NODE = process.execPath;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let dir: string;

/** poll until fn() is truthy */
async function until<T>(fn: () => T | Promise<T>, timeoutMs = 8000, what = "condition"): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(40);
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pty-harness-"));
  // prints a marker, then the hex of every raw stdin chunk on its own line; arg "bp" enables bracketed paste
  writeFileSync(join(dir, "keyecho.cjs"), `
    process.stdin.setRawMode(true); process.stdin.resume();
    if (process.argv[2] === 'bp') process.stdout.write('\\x1b[?2004h');
    process.stdout.write('READY\\n');
    process.stdin.on('data', d => process.stdout.write('GOT:' + d.toString('hex') + '\\n'));
  `);
  writeFileSync(join(dir, "info.cjs"), `
    console.log('ARGV=' + JSON.stringify(process.argv.slice(2)));
    console.log('CWD=' + process.cwd());
    console.log('FOO=' + process.env.FOO + ' BAR=' + process.env.BAR + ' TERM=' + process.env.TERM);
    setInterval(() => {}, 1000);
  `);
  // spawns a grandchild that touches a heartbeat file every 100ms
  writeFileSync(join(dir, "heartbeat.cjs"), `
    require('fs').writeFileSync(process.argv[2], String(Date.now()));
    setInterval(() => require('fs').writeFileSync(process.argv[2], String(Date.now())), 100);
  `);
  writeFileSync(join(dir, "parent.cjs"), `
    require('child_process').spawn(process.execPath, [${JSON.stringify(join(dir, "heartbeat.cjs"))}, process.argv[2]], { stdio: 'ignore' });
    console.log('PARENT_READY');
    setInterval(() => {}, 1000);
  `);
});

afterAll(() => {
  ptyCleanup();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* grandchild may still hold a file briefly */ }
});

// ─────────────────────────────────────────────────────────────────────────────
describe("key names and paste sequences", () => {
  it("maps basic keys", () => {
    expect(keyToSequence("Enter")).toBe("\r");
    expect(keyToSequence("enter")).toBe("\r");
    expect(keyToSequence("Escape")).toBe("\x1b");
    expect(keyToSequence("Esc")).toBe("\x1b");
    expect(keyToSequence("Tab")).toBe("\t");
    expect(keyToSequence("S-Tab")).toBe("\x1b[Z");
    expect(keyToSequence("Backspace")).toBe("\x7f");
    expect(keyToSequence("Space")).toBe(" ");
    expect(keyToSequence("a")).toBe("a");
    expect(keyToSequence("Delete")).toBe("\x1b[3~");
    expect(keyToSequence("PageUp")).toBe("\x1b[5~");
    expect(keyToSequence("F1")).toBe("\x1bOP");
    expect(keyToSequence("F5")).toBe("\x1b[15~");
    expect(keyToSequence("F12")).toBe("\x1b[24~");
  });

  it("maps ctrl / alt / modified keys", () => {
    expect(keyToSequence("C-c")).toBe("\x03");
    expect(keyToSequence("Ctrl-d")).toBe("\x04");
    expect(keyToSequence("ctrl+z")).toBe("\x1a");
    expect(keyToSequence("C-[")).toBe("\x1b");
    expect(keyToSequence("C-Space")).toBe("\x00");
    expect(keyToSequence("M-x")).toBe("\x1bx");
    expect(keyToSequence("Alt-Enter")).toBe("\x1b\r");
    expect(keyToSequence("C-Left")).toBe("\x1b[1;5D");
    expect(keyToSequence("S-Up")).toBe("\x1b[1;2A");
    expect(keyToSequence("C-Delete")).toBe("\x1b[3;5~");
  });

  it("arrows follow application-cursor-keys mode", () => {
    expect(keyToSequence("Up")).toBe("\x1b[A");
    expect(keyToSequence("Up", true)).toBe("\x1bOA");
    expect(keyToSequence("Down", true)).toBe("\x1bOB");
    expect(keyToSequence("Home", true)).toBe("\x1bOH");
    expect(keyToSequence("Left")).toBe("\x1b[D");
  });

  it("rejects unknown keys", () => {
    expect(() => keyToSequence("Frobnicate")).toThrow(/unknown key/);
    expect(() => keyToSequence("C-1")).toThrow(/unknown key/);
  });

  it("pasteSequence normalises newlines to CR and honours bracketed mode", () => {
    const fake = (bp: boolean) => ({ terminal: { modes: { bracketedPasteMode: bp } } }) as unknown as PtyInstance;
    expect(pasteSequence(fake(true), "a\nb\r\nc")).toBe("\x1b[200~a\rb\rc\x1b[201~");
    expect(pasteSequence(fake(false), "a\nb")).toBe("a\rb");
    expect(pasteSequence(fake(false), "a\nb", true)).toBe("\x1b[200~a\rb\x1b[201~");
    expect(pasteSequence(fake(true), "a", false)).toBe("a");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("spawn: args, env, cwd, exit status", () => {
  const live: PtyInstance[] = [];
  afterEach(() => { for (const i of live.splice(0)) ptyKill(i); });
  const spawn = (o: Parameters<typeof ptySpawn>[0]) => { const i = ptySpawn(o); live.push(i); return i; };

  it("passes args with spaces/quotes, env and cwd", async () => {
    const inst = spawn({
      command: "node",
      args: [join(dir, "info.cjs"), "two words", 'q"uote', "--port", "1"],
      cwd: dir,
      env: { FOO: "bar baz", BAR: undefined },
    });
    await ptyWait(inst, { text: "FOO=" });
    const screen = ptyScreenText(inst);
    expect(screen).toContain('ARGV=["two words","q\\"uote","--port","1"]');
    expect(screen.replace(/\\/g, "/").toLowerCase()).toContain(`CWD=${dir}`.replace(/\\/g, "/").toLowerCase());
    expect(screen).toContain("FOO=bar baz BAR=undefined TERM=xterm-256color");
  });

  it("resolves bare commands via PATH", () => {
    const r = resolveCommand("node");
    expect(r.toLowerCase()).toMatch(/node(\.exe)?$/);
    expect(resolveCommand("definitely-not-a-command-xyz")).toBe("definitely-not-a-command-xyz");
  });

  it("gives a clear error for a missing cwd and a missing command", () => {
    expect(() => ptySpawn({ command: "node", cwd: join(dir, "nope") })).toThrow(/cwd does not exist/);
    expect(() => ptySpawn({ command: "definitely-not-a-command-xyz" })).toThrow(/Failed to spawn/);
  });

  it("records exit code and keeps the final screen after exit", async () => {
    const inst = spawn({ command: "node", args: ["-e", "console.log('BYE_SCREEN'); process.exit(7)"] });
    expect(await ptyWaitExit(inst, 8000)).toBe(true);
    expect(inst.exited).toBe(true);
    expect(inst.exitCode).toBe(7);
    expect(ptyGet(inst.id)).toBeUndefined(); // not running any more
    expect(ptyGetAny(inst.id)).toBe(inst); // ...but still readable
    expect(ptySnapshot(inst).visibleText).toContain("BYE_SCREEN");
    ptyKill(inst); // no-op on a dead app, must not throw
  });

  it("two apps at once stay isolated", async () => {
    const a = spawn({ command: "node", args: ["-e", "console.log('ONLY_A'); setInterval(()=>{},1000)"] });
    const b = spawn({ command: "node", args: ["-e", "console.log('ONLY_B'); setInterval(()=>{},1000)"] });
    await ptyWait(a, { text: "ONLY_A" });
    await ptyWait(b, { text: "ONLY_B" });
    expect(ptyScreenText(a)).not.toContain("ONLY_B");
    expect(ptyScreenText(b)).not.toContain("ONLY_A");
    expect(ptyList().map((i) => i.id)).toEqual(expect.arrayContaining([a.id, b.id]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("ptyWait", () => {
  const live: PtyInstance[] = [];
  afterEach(() => { for (const i of live.splice(0)) ptyKill(i); });
  const spawn = (o: Parameters<typeof ptySpawn>[0]) => { const i = ptySpawn(o); live.push(i); return i; };

  it("returns when text appears, with elapsed time", async () => {
    const inst = spawn({ command: "node", args: ["-e", "setTimeout(()=>console.log('LATE_TEXT'),600); setInterval(()=>{},1000)"] });
    const r = await ptyWait(inst, { text: "LATE_TEXT", timeoutMs: 8000 });
    expect(r).toMatchObject({ matched: true, reason: "text", exited: false });
    expect(r.elapsedMs).toBeGreaterThan(300);
  });

  it("matches a regex", async () => {
    const inst = spawn({ command: "node", args: ["-e", "console.log('build 42 ok'); setInterval(()=>{},1000)"] });
    const r = await ptyWait(inst, { regex: /build \d+ ok/, timeoutMs: 8000 });
    expect(r).toMatchObject({ matched: true, reason: "regex" });
  });

  it("times out when nothing matches", async () => {
    const inst = spawn({ command: "node", args: ["-e", "setInterval(()=>{},1000)"] });
    const r = await ptyWait(inst, { text: "NEVER_PRINTED", timeoutMs: 400 });
    expect(r).toMatchObject({ matched: false, reason: "timeout" });
    expect(r.elapsedMs).toBeGreaterThanOrEqual(390);
  });

  it("waits for idle (no output)", async () => {
    const inst = spawn({ command: "node", args: ["-e", "let n=0; const t=setInterval(()=>{console.log('tick'+(++n)); if(n==8){clearInterval(t); setInterval(()=>{},1000)}},100)"] });
    const r = await ptyWait(inst, { idleMs: 500, timeoutMs: 10000 });
    expect(r).toMatchObject({ matched: true, reason: "idle" });
    expect(ptyScreenText(inst)).toContain("tick8");
  });

  it("waits for text to disappear (spinner gone)", async () => {
    const inst = spawn({ command: "node", args: ["-e", "process.stdout.write('BUSY...'); setTimeout(()=>process.stdout.write('\\r\\x1b[2KDONE'),500); setInterval(()=>{},1000)"] });
    await ptyWait(inst, { text: "BUSY..." });
    const r = await ptyWait(inst, { gone: "BUSY...", timeoutMs: 8000 });
    expect(r).toMatchObject({ matched: true, reason: "gone" });
  });

  it("ends with reason exit and the exit code when the app dies", async () => {
    const inst = spawn({ command: "node", args: ["-e", "setTimeout(()=>process.exit(3),300)"] });
    const r = await ptyWait(inst, { text: "NEVER", timeoutMs: 8000 });
    expect(r).toMatchObject({ matched: false, reason: "exit", exited: true, exitCode: 3 });
  });

  it("can still match the final screen of an exited app", async () => {
    const inst = spawn({ command: "node", args: ["-e", "console.log('FINAL_WORDS')"] });
    await ptyWaitExit(inst, 8000);
    const r = await ptyWait(inst, { text: "FINAL_WORDS" });
    expect(r).toMatchObject({ matched: true, reason: "text", exited: true, exitCode: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("sending keys and pastes", () => {
  const live: PtyInstance[] = [];
  afterEach(() => { for (const i of live.splice(0)) ptyKill(i); });
  const spawn = (o: Parameters<typeof ptySpawn>[0]) => { const i = ptySpawn(o); live.push(i); return i; };
  const got = (inst: PtyInstance) => ptyScreenText(inst).split("\n").filter((l) => l.startsWith("GOT:")).map((l) => l.slice(4));

  it("delivers text then Enter/Escape/Ctrl-C as separate, correct chunks", async () => {
    const inst = spawn({ command: "node", args: [join(dir, "keyecho.cjs")] });
    await ptyWait(inst, { text: "READY" });
    await ptyInput(inst, { text: "hi", keys: ["Enter", "Escape", "Up", "C-b", "Tab"], delayMs: 60 });
    await ptyWait(inst, { idleMs: 300 });
    const hex = got(inst).join("");
    expect(hex).toContain("6869"); // "hi"
    expect(hex).toContain("0d"); // Enter
    expect(hex).toContain("1b"); // Escape (and Up)
    expect(hex).toContain("02"); // Ctrl-B
    expect(hex).toContain("09"); // Tab
    // Escape must not have been glued to the following key (that would read as Alt-<key>)
    expect(got(inst).some((c) => c === "1b")).toBe(true);
  });

  it("sends a multi-line paste with bracketed-paste markers when the app enabled the mode", async () => {
    const inst = spawn({ command: "node", args: [join(dir, "keyecho.cjs"), "bp"] });
    await ptyWait(inst, { text: "READY" });
    await sleep(200); // let xterm process ?2004h
    expect(inst.terminal.modes.bracketedPasteMode).toBe(true);
    await ptyInput(inst, { paste: "line1\nline2\nline3" });
    await ptyWait(inst, { idleMs: 300 });
    const hex = got(inst).join("");
    // Windows ConPTY consumes the \x1b[200~ / \x1b[201~ markers on the input side; POSIX ptys pass them through
    const expected = process.platform === "win32" ? "line1\rline2\rline3" : "\x1b[200~line1\rline2\rline3\x1b[201~";
    expect(hex).toBe(Buffer.from(expected).toString("hex"));
  });

  it("sends a paste without markers when the app did not enable bracketed paste", async () => {
    const inst = spawn({ command: "node", args: [join(dir, "keyecho.cjs")] });
    await ptyWait(inst, { text: "READY" });
    await ptyInput(inst, { paste: "a\nb" });
    await ptyWait(inst, { idleMs: 300 });
    expect(got(inst).join("")).toBe(Buffer.from("a\rb").toString("hex"));
  });

  it("rejects unknown key names before sending anything", async () => {
    const inst = spawn({ command: "node", args: [join(dir, "keyecho.cjs")] });
    await ptyWait(inst, { text: "READY" });
    await expect(ptyInput(inst, { text: "x", keys: ["Enter", "Nope"] })).rejects.toThrow(/unknown key/);
    await sleep(200);
    expect(got(inst)).toEqual([]); // not even "x" was sent
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("snapshots", () => {
  const live: PtyInstance[] = [];
  afterEach(() => { for (const i of live.splice(0)) ptyKill(i); });
  const spawn = (o: Parameters<typeof ptySpawn>[0]) => { const i = ptySpawn(o); live.push(i); return i; };

  it("colour snapshot reconstructs truecolor, palette, bold and inverse; plain snapshot has none", async () => {
    const script = "process.stdout.write('\\x1b[1;38;2;255;10;20mTRUE\\x1b[0m \\x1b[38;5;196mPAL\\x1b[0m \\x1b[7mINV\\x1b[0m \\x1b[48;2;1;2;3mBG\\x1b[0m END\\n'); setInterval(()=>{},1000)";
    const inst = spawn({ command: "node", args: ["-e", script], cols: 80, rows: 10 });
    await ptyWait(inst, { text: "END" });
    await sleep(100);
    const color = ptySnapshot(inst, 20, false).visibleText;
    expect(color).toContain("38;2;255;10;20");
    expect(color).toMatch(/\x1b\[0;1;38;2;255;10;20mTRUE/);
    expect(color).toContain("38;5;196");
    expect(color).toContain(";7mINV");
    expect(color).toContain("48;2;1;2;3");
    // trailing blank cells are trimmed: a 80-col line is not padded with spaces
    const line = color.split("\n").find((l) => l.includes("TRUE"))!;
    expect(line.replace(/\x1b\[[0-9;]*m/g, "").length).toBeLessThan(30);
    const plain = ptySnapshot(inst, 20, true).visibleText;
    expect(plain).not.toContain("\x1b");
    expect(plain).toContain("TRUE PAL INV BG END");
  });

  it("wide characters are not double-spaced in the colour snapshot", async () => {
    const inst = spawn({ command: "node", args: ["-e", "console.log('\\x1b[31m日本語\\x1b[0m|'); setInterval(()=>{},1000)"], cols: 40, rows: 5 });
    await ptyWait(inst, { text: "|" });
    const color = ptySnapshot(inst, 20, false).visibleText.replace(/\x1b\[[0-9;]*m/g, "");
    expect(color).toContain("日本語|");
  });

  it("snapshot exposes cursor position and scrollback", async () => {
    const inst = spawn({ command: "node", args: ["-e", "for(let i=1;i<=30;i++)console.log('row'+i); setInterval(()=>{},1000)"], cols: 40, rows: 10 });
    await ptyWait(inst, { text: "row30" });
    const snap = ptySnapshot(inst);
    expect(snap.visibleLines.length).toBe(10);
    expect(snap.fullText).toContain("row1\n");
    expect(snap.visibleText).not.toContain("row1\n");
    expect(snap.scrollbackLines.length).toBeGreaterThan(15);
    expect(typeof snap.cursorX).toBe("number");
    expect(ptyScreenText(inst, "full")).toContain("row1\n");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("kill takes down the whole process tree", () => {
  it("kills grandchildren (heartbeat stops)", async () => {
    const hb = join(dir, "hb.txt");
    const inst = ptySpawn({ command: "node", args: [join(dir, "parent.cjs"), hb] });
    await ptyWait(inst, { text: "PARENT_READY" });
    await until(() => existsSync(hb), 8000, "heartbeat file");
    const age = () => Date.now() - Number(readFileSync(hb, "utf8") || 0);
    await until(() => age() < 400, 3000, "fresh heartbeat");
    ptyKill(inst);
    expect(await ptyWaitExit(inst, 8000)).toBe(true);
    await sleep(2000); // allow the 1.5s escalation to hard-kill stragglers
    expect(age()).toBeGreaterThan(1200);
  }, 30000);
});

// ─────────────────────────────────────────────────────────────────────────────
describe("CLI argument splitting", () => {
  it("--start takes the command and its args up to the next pty flag", () => {
    expect(splitCliArgs(["--start", "node", "-e", "console.log(1)", "--port", "3100"])).toEqual({
      cmdArgs: [],
      ptyOpts: ["--start", "node", "--port", "3100"],
      startArgs: ["-e", "console.log(1)"],
    });
  });
  it("--start: flags before it and a lone leading -- (pnpm dev -- ...) are fine", () => {
    const r = splitCliArgs(["--", "--port", "3100", "--start", "bash", "-lc", "echo hi there", "--cwd", "C:/x", "--env", "A=1"]);
    expect(r.ptyOpts).toEqual(["--port", "3100", "--start", "bash", "--cwd", "C:/x", "--env", "A=1"]);
    expect(r.startArgs).toEqual(["-lc", "echo hi there"]);
  });
  it("--start: a bare -- forces the rest to be command args", () => {
    const r = splitCliArgs(["--port", "3100", "--start", "tool", "--", "--port", "8080"]);
    expect(r.ptyOpts).toEqual(["--port", "3100", "--start", "tool"]);
    expect(r.startArgs).toEqual(["--port", "8080"]);
  });
  it("keeps the historic forms", () => {
    expect(splitCliArgs(["sleep", "60", "--", "--serve", "--port", "3100"])).toEqual({ cmdArgs: ["sleep", "60"], ptyOpts: ["--serve", "--port", "3100"], startArgs: [] });
    expect(splitCliArgs(["ls", "-la", "/tmp"])).toEqual({ cmdArgs: ["ls", "-la", "/tmp"], ptyOpts: [], startArgs: [] });
    expect(splitCliArgs(["vim", "f.txt", "--snapshot", "--wait", "500"])).toEqual({ cmdArgs: ["vim", "f.txt"], ptyOpts: ["--snapshot", "--wait", "500"], startArgs: [] });
    expect(splitCliArgs(["--serve", "--port", "3100"])).toEqual({ cmdArgs: [], ptyOpts: ["--serve", "--port", "3100"], startArgs: [] });
  });
  it("a command's own --json/--text style flags are not swallowed (only historic flags split)", () => {
    expect(splitCliArgs(["mytool", "--json", "--text", "x"]).cmdArgs).toEqual(["mytool", "--json", "--text", "x"]);
  });
  it("parseEnvPairs", () => {
    expect(parseEnvPairs(["A=1", "B=x=y", "C="])).toEqual({ A: "1", B: "x=y", C: "" });
    expect(() => parseEnvPairs(["nope"])).toThrow(/KEY=VALUE/);
    expect(() => parseEnvPairs(["=x"])).toThrow(/KEY=VALUE/);
  });
  it("isLoopbackHost", () => {
    for (const h of ["127.0.0.1", "localhost", "::1", "[::1]", "127.1.2.3"]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["0.0.0.0", "192.168.1.5", "::", "example.com"]) expect(isLoopbackHost(h)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("HTTP API (in-process server, no token)", () => {
  const PORT = 3160;
  const base = `http://127.0.0.1:${PORT}`;
  let svc: PtyServer;
  beforeAll(async () => { svc = createPtyServer({ port: PORT, log: () => {} }); await svc.listen(); });
  afterAll(async () => { ptyCleanup(); await svc.close(); });

  const post = async (path: string, body: unknown, init: RequestInit = {}) => {
    const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), ...init });
    return { status: res.status, body: await res.json() as any };
  };
  const get = async (path: string) => {
    const res = await fetch(base + path);
    return { status: res.status, body: await res.json() as any };
  };

  it("/health reports version and auth state", async () => {
    const r = await get("/health");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "ok", auth: false });
    expect(r.body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("/start with args+env+cwd, snapshot (json/text), wait, send keys, status, kill", async () => {
    const start = await post("/start", { command: "node", args: [join(dir, "info.cjs"), "a b"], cwd: dir, env: { FOO: "from-http" }, cols: 100, rows: 20 });
    expect(start.status).toBe(200);
    const { id } = start.body;
    expect(start.body).toMatchObject({ cols: 100, rows: 20 });

    const w = await get(`/app/${id}/wait?text=${encodeURIComponent("FOO=from-http")}&timeout=8000`);
    expect(w.body).toMatchObject({ matched: true, reason: "text" });
    expect(w.body.visibleText).toContain('ARGV=["a b"]');

    const snap = await get(`/app/${id.slice(0, 8)}/snapshot`);
    expect(snap.body.visibleText).toContain("FOO=from-http");
    expect(snap.body).toMatchObject({ cols: 100, rows: 20, running: true, exited: false, exitCode: null });
    expect(snap.body.cursor).toEqual({ x: expect.any(Number), y: expect.any(Number) });

    const text = await fetch(`${base}/app/${id}/snapshot?format=text`);
    expect(text.headers.get("content-type")).toContain("text/plain");
    const body = await text.text();
    expect(body).toContain("FOO=from-http");
    expect(body.endsWith("\n")).toBe(true);
    expect(body).not.toMatch(/\n\n$/); // trailing blank rows trimmed

    const apps = await get("/apps");
    expect(apps.body.apps.find((a: any) => a.id === id)).toMatchObject({ running: true, exited: false });

    const kill = await post("/kill", { id });
    expect(kill.status).toBe(200);
    expect(kill.body).toMatchObject({ ok: true, exited: true });

    // after exit: still readable, with exit info; mutating calls say 409; /kill again is 404
    const status = await get(`/app/${id}/status`);
    expect(status.body).toMatchObject({ running: false, exited: true });
    expect(typeof status.body.exitCode).toBe("number");
    expect((await get(`/app/${id}/snapshot`)).body.visibleText).toContain("FOO=from-http");
    expect((await post(`/app/${id}/send`, { text: "x" })).status).toBe(409);
    expect((await post(`/app/${id}/resize`, { cols: 80, rows: 24 })).status).toBe(409);
    expect((await post("/kill", { id })).status).toBe(404);
    expect((await get("/apps")).body.apps.some((a: any) => a.id === id)).toBe(false);
    expect((await get("/apps?all=true")).body.apps.find((a: any) => a.id === id)).toMatchObject({ exited: true });
  }, 30000);

  it("/send accepts text, keys and paste; bad keys are a 400", async () => {
    const { body: { id } } = await post("/start", { command: "node", args: [join(dir, "keyecho.cjs"), "bp"] });
    await get(`/app/${id}/wait?text=READY&timeout=8000`);
    await sleep(200);
    expect((await post(`/app/${id}/send`, { text: "ab", keys: ["Enter", "Escape"], delayMs: 60 })).status).toBe(200);
    expect((await post(`/app/${id}/send`, { paste: "x\ny" })).status).toBe(200);
    expect((await post(`/app/${id}/send`, { keys: ["Bogus"] })).status).toBe(400);
    expect((await post(`/app/${id}/send`, { keys: "Enter" })).status).toBe(400);
    expect((await post(`/app/${id}/send`, {})).status).toBe(400);
    await get(`/app/${id}/wait?idle=300`);
    const screen = (await get(`/app/${id}/snapshot`)).body.visibleText as string;
    const hex = screen.split("\n").filter((l) => l.startsWith("GOT:")).map((l) => l.slice(4)).join("");
    expect(hex).toContain("6162"); // ab
    expect(hex).toContain(Buffer.from(process.platform === "win32" ? "x\ry" : "\x1b[200~x\ry\x1b[201~").toString("hex"));
    await post("/kill", { id });
  }, 30000);

  it("/wait validates input and times out cleanly", async () => {
    const { body: { id } } = await post("/start", { command: "node", args: ["-e", "setInterval(()=>{},1000)"] });
    expect((await get(`/app/${id}/wait?timeout=abc`)).status).toBe(400);
    expect((await get(`/app/${id}/wait?regex=${encodeURIComponent("(")}`)).status).toBe(400);
    const r = await get(`/app/${id}/wait?text=NOPE&timeout=300&screen=false`);
    expect(r.body).toMatchObject({ matched: false, reason: "timeout" });
    expect(r.body.visibleText).toBeUndefined();
    await post("/kill", { id });
  }, 20000);

  it("/snapshot?color=true returns ANSI", async () => {
    const { body: { id } } = await post("/start", { command: "node", args: ["-e", "console.log('\\x1b[1;31mRED\\x1b[0m'); setInterval(()=>{},1000)"] });
    await get(`/app/${id}/wait?text=RED&timeout=8000`);
    const r = await get(`/app/${id}/snapshot?color=true`);
    expect(r.body.visibleText).toMatch(/\x1b\[0;1;38;5;1mRED/);
    const full = await get(`/app/${id}/snapshot?full=true`);
    expect(full.body.fullText).toContain("RED");
    await post("/kill", { id });
  }, 20000);

  it("/start validation", async () => {
    expect((await post("/start", { command: "node", args: "x" })).status).toBe(400);
    expect((await post("/start", { command: "node", args: [1] })).status).toBe(400);
    expect((await post("/start", { command: "node", env: { A: 1 } })).status).toBe(400);
    expect((await post("/start", { command: "node", env: [] })).status).toBe(400);
    const bad = await post("/start", { command: "node", cwd: join(dir, "missing") });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/cwd does not exist/);
    const nf = await post("/start", { command: "no-such-command-xyz" });
    expect(nf.status).toBe(400);
  });

  it("several apps at once; killing one leaves the others", async () => {
    const ids: string[] = [];
    for (let n = 0; n < 4; n++) {
      const r = await post("/start", { command: "node", args: ["-e", `console.log('APP_${n}'); setInterval(()=>{},1000)`] });
      ids.push(r.body.id);
    }
    for (let n = 0; n < 4; n++) {
      const w = await get(`/app/${ids[n]}/wait?text=APP_${n}&timeout=8000`);
      expect(w.body.matched).toBe(true);
      expect(w.body.visibleText).not.toContain(`APP_${(n + 1) % 4}`);
    }
    await post("/kill", { id: ids[1] });
    const apps = (await get("/apps")).body.apps.map((a: any) => a.id);
    expect(apps).toEqual(expect.arrayContaining([ids[0], ids[2], ids[3]]));
    expect(apps).not.toContain(ids[1]);
    for (const id of [ids[0], ids[2], ids[3]]) await post("/kill", { id });
  }, 40000);

  it("refuses cross-origin (browser CSRF) requests and rebinding Host headers", async () => {
    const withHeaders = (headers: Record<string, string>, path = "/apps") => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: PORT, path, headers }, (res) => {
        let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode!, body: b }));
      });
      req.on("error", reject); req.end();
    });
    expect((await withHeaders({ Origin: "https://evil.example" })).status).toBe(403);
    expect((await withHeaders({ Origin: "null" })).status).toBe(403);
    expect((await withHeaders({ Origin: `http://127.0.0.1:${PORT}` })).status).toBe(200); // same origin
    expect((await withHeaders({ Host: "evil.example:3160" })).status).toBe(403);
    expect((await withHeaders({ Host: `localhost:${PORT}` })).status).toBe(200);
    // no CORS wildcard without a token
    const res = await fetch(base + "/apps");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    // POST from a form-ish cross-origin page is refused too
    const evil = await fetch(base + "/start", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "text/plain" }, body: JSON.stringify({ command: "node" }) });
    expect(evil.status).toBe(403);
  });

  it("WebSocket: streams output, accepts input, rejects cross-origin", async () => {
    const { body: { id } } = await post("/start", { command: "node", args: [join(dir, "keyecho.cjs")] });
    await get(`/app/${id}/wait?text=READY&timeout=8000`);
    const ws = new WsClient(`ws://127.0.0.1:${PORT}/app/${id}`);
    const msgs: any[] = [];
    ws.on("message", (d) => msgs.push(JSON.parse(d.toString())));
    await new Promise<void>((r, j) => { ws.on("open", () => r()); ws.on("error", j); });
    ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 20 }));
    ws.send(JSON.stringify({ type: "input", text: "zz" }));
    await until(() => msgs.some((m) => m.type === "output" && String(m.text).includes("GOT:7a7a")), 8000, "ws echo");
    ws.close();
    const evil = new WsClient(`ws://127.0.0.1:${PORT}/app/${id}`, { headers: { Origin: "https://evil.example" } });
    const status = await new Promise<number>((r) => { evil.on("unexpected-response", (_q, res) => r(res.statusCode!)); evil.on("open", () => r(101)); evil.on("error", () => {}); });
    expect(status).toBe(403);
    await post("/kill", { id });
  }, 30000);
});

// ─────────────────────────────────────────────────────────────────────────────
describe("HTTP API with a token", () => {
  const PORT = 3161;
  const base = `http://127.0.0.1:${PORT}`;
  const TOKEN = "s3cret-test-token";
  let svc: PtyServer;
  beforeAll(async () => { svc = createPtyServer({ port: PORT, token: TOKEN, log: () => {} }); await svc.listen(); });
  afterAll(async () => { ptyCleanup(); await svc.close(); });

  it("rejects missing/wrong tokens with 401 but leaves /health open", async () => {
    expect((await fetch(base + "/health")).status).toBe(200);
    expect(((await (await fetch(base + "/health")).json()) as any).auth).toBe(true);
    expect((await fetch(base + "/apps")).status).toBe(401);
    expect((await fetch(base + "/apps", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(base + "/apps?token=wrong")).status).toBe(401);
    expect((await fetch(base + "/start", { method: "POST", body: JSON.stringify({ command: "node" }) })).status).toBe(401);
  });

  it("accepts Bearer, X-Pty-Token and ?token=", async () => {
    expect((await fetch(base + "/apps", { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    expect((await fetch(base + "/apps", { headers: { "X-Pty-Token": TOKEN } })).status).toBe(200);
    expect((await fetch(`${base}/apps?token=${TOKEN}`)).status).toBe(200);
  });

  it("opens CORS for browser UIs (token is the protection) and answers preflight", async () => {
    const pre = await fetch(base + "/start", { method: "OPTIONS", headers: { Origin: "https://ui.example" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("Authorization");
    const r = await fetch(base + "/apps", { headers: { Authorization: `Bearer ${TOKEN}`, Origin: "https://ui.example" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("WebSocket needs the token too", async () => {
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const started = await fetch(base + "/start", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ command: "node", args: ["-e", "setInterval(()=>{},1000)"] }) });
    const { id } = await started.json() as any;
    const noTok = new WsClient(`ws://127.0.0.1:${PORT}/app/${id}`);
    const code = await new Promise<number>((r) => { noTok.on("unexpected-response", (_q, res) => r(res.statusCode!)); noTok.on("open", () => r(101)); noTok.on("error", () => {}); });
    expect(code).toBe(401);
    const ok = new WsClient(`ws://127.0.0.1:${PORT}/app/${id}?token=${TOKEN}`);
    await new Promise<void>((r, j) => { ok.on("open", () => r()); ok.on("error", j); });
    ok.close();
    await fetch(base + "/kill", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
  }, 20000);
});

// ─────────────────────────────────────────────────────────────────────────────
describe("CLI (built dist/pty.js as a subprocess)", () => {
  const PORT = 3162;
  let svc: ReturnType<typeof import("node:child_process").spawn> | undefined;
  const cli = (args: string[], env: Record<string, string> = {}) => new Promise<{ code: number; out: string; err: string }>((resolve) => {
    execFile(NODE, ["dist/pty.js", ...args], { timeout: 30000, env: { ...process.env, ...env, NODE_ENV: "test" } }, (e, out, err) => {
      resolve({ code: e ? ((e as any).code ?? 1) : 0, out: String(out), err: String(err) });
    });
  });

  beforeAll(async () => {
    const { spawn } = await import("node:child_process");
    svc = spawn(NODE, ["dist/pty.js", "--serve", "--port", String(PORT)], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "test" } });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("server did not start")), 15000);
      svc!.stdout!.on("data", (d: Buffer) => { if (d.toString().includes("listening on")) { clearTimeout(t); resolve(); } });
      svc!.on("error", reject);
    });
  }, 20000);
  afterAll(async () => {
    if (svc) {
      svc.kill();
      await sleep(300);
    }
  });

  it("--version and --help", async () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const v = await cli(["--version"]);
    expect(v.out.trim()).toBe(pkg.version);
    const h = await cli(["--help"]);
    expect(h.out).toContain("pty --serve");
    expect(h.out).toContain("--wait-for");
    expect(h.out).toContain("Usage: pty");
  });

  it("full flow: --start with args/env/cwd, --wait-for, --send keys, --screen, --kill", async () => {
    const start = await cli(["--port", String(PORT), "--start", "node", join(dir, "info.cjs"), "has space", "--cwd", dir, "--env", "FOO=cli-env", "--json"]);
    expect(start.code).toBe(0);
    const { id } = JSON.parse(start.out);
    const w = await cli(["--port", String(PORT), "--wait-for", id.slice(0, 8), "--text", "FOO=cli-env", "--timeout", "8000"]);
    expect(w.code).toBe(0);
    expect(w.out).toContain('ARGV=["has space"]');
    const miss = await cli(["--port", String(PORT), "--wait-for", id.slice(0, 8), "--text", "NOT_THERE", "--timeout", "300"]);
    expect(miss.code).toBe(2);
    const screen = await cli(["--port", String(PORT), "--screen", id.slice(0, 8)]);
    expect(screen.out).toContain("FOO=cli-env");
    const list = await cli(["--port", String(PORT), "--list"]);
    expect(list.out).toContain(id.slice(0, 8));
    const k = await cli(["--port", String(PORT), "--kill", id.slice(0, 8)]);
    expect(k.code).toBe(0);
    const status = await cli(["--port", String(PORT), "--status", id.slice(0, 8)]);
    expect(JSON.parse(status.out)).toMatchObject({ running: false, exited: true });
  }, 60000);

  it("--send with --keys and --paste reaches the app", async () => {
    const start = await cli(["--port", String(PORT), "--start", "node", join(dir, "keyecho.cjs"), "bp", "--json"]);
    const { id } = JSON.parse(start.out);
    await cli(["--port", String(PORT), "--wait-for", id, "--text", "READY", "--timeout", "8000"]);
    await sleep(200);
    expect((await cli(["--port", String(PORT), "--send", id, "--text", "q", "--keys", "Enter,C-c"])).code).toBe(0);
    expect((await cli(["--port", String(PORT), "--send", id, "--paste", "m1\nm2"])).code).toBe(0);
    const w = await cli(["--port", String(PORT), "--wait-for", id, "--idle", "300"]);
    const hex = w.out.split("\n").filter((l) => l.startsWith("GOT:")).map((l) => l.slice(4)).join("");
    expect(hex).toContain("71"); // q
    expect(hex).toContain("03"); // ctrl-c delivered as a byte (raw mode)
    expect(hex).toContain(Buffer.from(process.platform === "win32" ? "m1\rm2" : "\x1b[200~m1\rm2\x1b[201~").toString("hex"));
    await cli(["--port", String(PORT), "--kill", id]);
  }, 60000);

  it("tells the user how to start a server when none is reachable", async () => {
    const r = await cli(["--port", "3169", "--list"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/Cannot reach a PTY server/);
    expect(r.err).toContain("pty --serve --port 3169");
  });

  it("honours PTY_PORT and a token (--token / PTY_TOKEN)", async () => {
    const TP = 3163;
    const { spawn } = await import("node:child_process");
    const secured = spawn(NODE, ["dist/pty.js", "--serve", "--port", String(TP)], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "test", PTY_TOKEN: "tok123" } });
    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("secured server did not start")), 15000);
        secured.stdout!.on("data", (d: Buffer) => { if (d.toString().includes("listening on")) { clearTimeout(t); resolve(); } });
      });
      const noTok = await cli(["--port", String(TP), "--list"]);
      expect(noTok.code).not.toBe(0);
      expect(noTok.err).toMatch(/Unauthorized/);
      const viaEnv = await cli(["--list"], { PTY_PORT: String(TP), PTY_TOKEN: "tok123" });
      expect(viaEnv.code).toBe(0);
      const viaFlag = await cli(["--port", String(TP), "--token", "tok123", "--list"]);
      expect(viaFlag.code).toBe(0);
    } finally {
      secured.kill();
    }
  }, 40000);

  it("warns loudly when bound to a non-loopback address without a token", async () => {
    const { spawn } = await import("node:child_process");
    const p = spawn(NODE, ["dist/pty.js", "--serve", "--port", "3164", "--host", "0.0.0.0"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "test", PTY_TOKEN: "" } });
    let all = "";
    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("did not start: " + all)), 15000);
        const on = (d: Buffer) => { all += d.toString(); if (all.includes("NO TOKEN IS SET")) { clearTimeout(t); resolve(); } };
        p.stdout!.on("data", on); p.stderr!.on("data", on);
      });
      expect(all).toMatch(/WARNING: listening on 0\.0\.0\.0/);
    } finally {
      p.kill();
    }
  }, 30000);

  it("reports a busy port instead of crashing with a stack trace", async () => {
    const r = await cli(["--serve", "--port", String(PORT)]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/already in use/);
  }, 30000);
});
