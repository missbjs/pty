#!/usr/bin/env node
// PTY Utility Service — a mini OS for TUI applications
// Spawn any process in a PTY, send keystrokes, read full buffer, take snapshots.
import * as pty from "node-pty";
import xtermHeadless from "@xterm/headless";
import stripAnsi from "strip-ansi";
import { randomUUID, timingSafeEqual, createHash } from "crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { WebSocketServer, WebSocket as WsClient } from "ws";
import { existsSync, statSync, realpathSync } from "node:fs";
import { fileURLToPath } from "url";
import { spawnSync } from "node:child_process";
import pkg from "./package.json";

const VERSION: string = (pkg as { version: string }).version;

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
  /** true once the child process has exited (instance then lives in the "finished" registry) */
  exited: boolean;
  /** exit code of the child (null while running; negative/odd values are Windows NTSTATUS codes) */
  exitCode: number | null;
  /** signal number if the child was killed by one (POSIX), else null */
  signal: number | null;
  exitedAt: number | null;
  /** epoch ms of the last byte of PTY output (used by wait-for-idle) */
  lastOutputAt: number;
  /** total bytes of PTY output seen */
  outputBytes: number;
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
  /** Cursor column (0-based, relative to the visible area) */
  cursorX: number;
  /** Cursor row (0-based, relative to the visible area) */
  cursorY: number;
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

/** SGR parameter list (without ESC[ ... m) describing one xterm cell's style. */
function cellSgr(cell: any): string {
  const codes: (number | string)[] = [];
  if (cell.isBold()) codes.push(1);
  if (cell.isDim()) codes.push(2);
  if (cell.isItalic()) codes.push(3);
  if (cell.isUnderline()) codes.push(4);
  if (cell.isBlink()) codes.push(5);
  if (cell.isInverse()) codes.push(7);
  if (cell.isInvisible()) codes.push(8);
  if (cell.isStrikethrough()) codes.push(9);
  if (!cell.isFgDefault()) {
    const c = cell.getFgColor();
    if (cell.isFgRGB()) codes.push(`38;2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}`);
    else codes.push(`38;5;${c}`);
  }
  if (!cell.isBgDefault()) {
    const c = cell.getBgColor();
    if (cell.isBgRGB()) codes.push(`48;2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}`);
    else codes.push(`48;5;${c}`);
  }
  return codes.join(";");
}

/**
 * Convert an xterm.js line to a string with ANSI escape codes reconstructed
 * from cell attributes (bold/dim/italic/underline/inverse, 256-palette and
 * 24-bit RGB colors). Trailing blank, unstyled cells are trimmed (like the
 * plain-text snapshot), and wide-character continuation cells are skipped.
 */
function lineToAnsiString(line: any): string {
  // Find the last cell that has visible content or a visible style
  let end = 0;
  for (let col = line.length - 1; col >= 0; col--) {
    const cell = line.getCell(col);
    if (!cell) continue;
    const chars = cell.getChars();
    if ((chars !== "" && chars !== " ") || !cell.isBgDefault() || cell.isInverse() || cell.isUnderline()) {
      end = col + 1;
      break;
    }
  }

  let result = "";
  let lastSgr = "";
  for (let col = 0; col < end; col++) {
    const cell = line.getCell(col);
    if (!cell || cell.getWidth() === 0) continue; // 2nd half of a wide char
    const sgr = cellSgr(cell);
    if (sgr !== lastSgr) {
      result += sgr === "" ? "[0m" : `[0;${sgr}m`;
      lastSgr = sgr;
    }
    result += cell.getChars() || " ";
  }
  if (lastSgr !== "") result += "[0m";
  return result;
}

// ── Service ────────────────────────────────────────────────────────────────

const instances = new Map<string, PtyInstance>();
let defaultInstance: PtyInstance | null = null; // for backward compat with single-app mode

/** Finished (exited) instances, kept so exit status + final screen stay readable. */
const finished = new Map<string, PtyInstance>();
const MAX_FINISHED = 20;

/**
 * Resolve a bare command name to a full path (Windows: honours PATH + PATHEXT,
 * so `node`, `python`, `bash` work without an extension). Names that already
 * contain a path separator are returned unchanged; unresolvable names are
 * returned unchanged so node-pty reports the error.
 */
export function resolveCommand(cmd: string): string {
  if (cmd.includes("/") || cmd.includes("\\")) return cmd;
  const win = process.platform === "win32";
  const sep = win ? ";" : ":";
  const pathDirs = (process.env.PATH || process.env.Path || "").split(sep).map((d) => d.replace(/^"|"$/g, ""));
  let candidates: string[];
  if (win) {
    // Only extensions CreateProcess can run directly (.cmd/.bat go through cmd.exe implicitly)
    const pathext = [".exe", ".com", ".cmd", ".bat"];
    const hasExt = pathext.some((e) => cmd.toLowerCase().endsWith(e));
    candidates = hasExt ? [cmd] : pathext.map((e) => cmd + e);
  } else {
    candidates = [cmd];
  }
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const name of candidates) {
      const full = win ? dir + "\\" + name : dir + "/" + name;
      try {
        if (existsSync(full) && statSync(full).isFile()) return full;
      } catch { /* ignore */ }
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

  // node-pty reports a bad cwd as an opaque "error code 267" on Windows — check first
  try {
    if (!statSync(cwd).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`Failed to spawn "${opts.command}": cwd does not exist or is not a directory: ${cwd}`);
  }

  // Child env = our env + COLORTERM/TERM + caller overrides (an undefined/null value unsets the variable)
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, COLORTERM: "truecolor", TERM: term, ...(opts.env ?? {}) })) {
    if (v !== undefined && v !== null) childEnv[k] = String(v);
  }

  let ptyProcess: pty.IPty;
  try {
    ptyProcess = pty.spawn(resolvedCommand, opts.args ?? [], {
      name: term,
      cols,
      rows,
      cwd,
      env: childEnv,
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
    instance.lastOutputAt = Date.now();
    instance.outputBytes += data.length;
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
    exited: false,
    exitCode: null,
    signal: null,
    exitedAt: null,
    lastOutputAt: Date.now(),
    outputBytes: 0,
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

  ptyProcess.onExit(({ exitCode, signal }) => {
    instance.exited = true;
    instance.exitCode = exitCode;
    instance.signal = signal ?? null;
    instance.exitedAt = Date.now();
    // Notify connected clients
    for (const client of instance.clients) {
      if (client.readyState === WsClient.OPEN) {
        client.send(JSON.stringify({ type: "exit", exitCode, id }));
        client.close();
      }
    }
    instance.clients.clear();
    instances.delete(id);
    // Keep the dead instance (final screen + exit status) for a while
    finished.set(id, instance);
    while (finished.size > MAX_FINISHED) {
      const oldest = finished.keys().next().value as string;
      try { finished.get(oldest)?.terminal.dispose(); } catch { /* ignore */ }
      finished.delete(oldest);
    }

    if (exitCode !== 0 && outputAccum.trim().length < 500) {
      const clean = outputAccum.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").trim();
      if (clean.includes("No such file") || clean.includes("not found") || clean.includes("execvp")) {
        console.error(`Error: command "${opts.command}" not found`);
      }
    }
  });

  return instance;
}

/** Read buffer lines [start, end) as plain text or ANSI-reconstructed text. */
function readLines(instance: PtyInstance, start: number, end: number, stripAnsiCodes: boolean): string[] {
  const buf = instance.terminal.buffer.active;
  const out: string[] = [];
  for (let i = start; i < end && i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) {
      out.push("");
    } else if (stripAnsiCodes) {
      out.push(stripAnsi(line.translateToString(true)));
    } else {
      // Reconstruct ANSI codes from xterm cell attributes
      out.push(lineToAnsiString(line));
    }
  }
  return out;
}

/** Text of the visible screen (cheap: reads only the viewport) or of the full buffer incl. scrollback. */
export function ptyScreenText(instance: PtyInstance, scope: "visible" | "full" = "visible", stripAnsiCodes: boolean = true): string {
  const buf = instance.terminal.buffer.active;
  const start = scope === "full" ? 0 : buf.baseY;
  return readLines(instance, start, buf.length, stripAnsiCodes).join("\n");
}

/** Get a snapshot of the full buffer */
export function ptySnapshot(instance: PtyInstance, footerRows: number = 20, stripAnsiCodes: boolean = true): BufferSnapshot {
  const buf = instance.terminal.buffer.active;

  // Read FULL buffer (scrollback + visible)
  const fullLines = readLines(instance, 0, buf.length, stripAnsiCodes);

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
    cursorX: buf.cursorX,
    cursorY: buf.cursorY,
  };
}

/** Send keystrokes to the PTY */
export function ptySend(instance: PtyInstance, text: string): void {
  // Note: Arrow key translation is handled by WebSocket clients based on mode
  // HTTP /send endpoint clients should send correct sequences for the app
  instance.process.write(text);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Named keys ─────────────────────────────────────────────────────────────

/** key name -> [final-or-number, kind]; "csi" = ESC [ 1;m X (ESC O X in app-cursor mode), "ss3" = ESC O X, "tilde" = ESC [ n ~ */
const NAMED_KEYS: Record<string, [string, "csi" | "ss3" | "tilde"]> = {
  up: ["A", "csi"], down: ["B", "csi"], right: ["C", "csi"], left: ["D", "csi"],
  home: ["H", "csi"], end: ["F", "csi"],
  insert: ["2", "tilde"], delete: ["3", "tilde"], pageup: ["5", "tilde"], pagedown: ["6", "tilde"],
  f1: ["P", "ss3"], f2: ["Q", "ss3"], f3: ["R", "ss3"], f4: ["S", "ss3"],
  f5: ["15", "tilde"], f6: ["17", "tilde"], f7: ["18", "tilde"], f8: ["19", "tilde"],
  f9: ["20", "tilde"], f10: ["21", "tilde"], f11: ["23", "tilde"], f12: ["24", "tilde"],
};
const KEY_ALIASES: Record<string, string> = {
  del: "delete", ins: "insert", pgup: "pageup", pgdn: "pagedown", pgdown: "pagedown", "page-up": "pageup", "page-down": "pagedown",
  arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right",
};
const SIMPLE_KEYS: Record<string, string> = {
  enter: "\r", return: "\r", cr: "\r", lf: "\n", newline: "\n", tab: "\t", escape: "\x1b", esc: "\x1b",
  space: " ", backspace: "\x7f", bspace: "\x7f", bs: "\x7f",
};

/**
 * Translate a key name to the byte sequence a terminal would send.
 * Names (case-insensitive): Enter, Tab, Escape/Esc, Space, Backspace, Delete, Insert, Up/Down/Left/Right,
 * Home, End, PageUp, PageDown, F1..F12, with optional modifiers `C-`/`Ctrl-`, `M-`/`Alt-`, `S-`/`Shift-`
 * (e.g. `C-c`, `Ctrl+d`, `Alt-x`, `S-Tab`, `C-Left`). A single character is sent literally.
 * Arrow/Home/End honour the app's application-cursor-keys mode (DECCKM).
 * Throws on an unknown name.
 */
export function keyToSequence(name: string, applicationCursorKeys: boolean = false): string {
  const m = /^((?:(?:c|ctrl|control|m|a|alt|meta|s|shift)[-+])*)(.+)$/i.exec(name);
  if (!m) throw new Error(`unknown key "${name}"`);
  const mods = m[1].toLowerCase().split(/[-+]/).filter(Boolean);
  const base = m[2];
  const ctrl = mods.some((x) => x === "c" || x === "ctrl" || x === "control");
  const alt = mods.some((x) => x === "m" || x === "a" || x === "alt" || x === "meta");
  const shift = mods.some((x) => x === "s" || x === "shift");
  const lower = KEY_ALIASES[base.toLowerCase()] ?? base.toLowerCase();

  const mod = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
  const named = NAMED_KEYS[lower];
  if (named) {
    const [code, kind] = named;
    if (kind === "tilde") return mod > 1 ? `\x1b[${code};${mod}~` : `\x1b[${code}~`;
    if (mod > 1) return `\x1b[1;${mod}${code}`;
    if (kind === "ss3") return `\x1bO${code}`;
    return applicationCursorKeys ? `\x1bO${code}` : `\x1b[${code}`;
  }
  if (lower === "tab" && shift && !ctrl && !alt) return "\x1b[Z";
  let seq: string;
  if (SIMPLE_KEYS[lower] !== undefined) {
    seq = ctrl && lower === "space" ? "\x00" : SIMPLE_KEYS[lower];
  } else if ([...base].length === 1) {
    seq = shift ? base.toUpperCase() : base;
    if (ctrl) {
      const c = base.toLowerCase();
      if (c >= "a" && c <= "z") seq = String.fromCharCode(c.charCodeAt(0) - 96);
      else if (c === "@" || c === " ") seq = "\x00";
      else if (c === "[") seq = "\x1b";
      else if (c === "\\") seq = "\x1c";
      else if (c === "]") seq = "\x1d";
      else if (c === "^") seq = "\x1e";
      else if (c === "_" || c === "-") seq = "\x1f";
      else if (c === "?") seq = "\x7f";
      else throw new Error(`unknown key "${name}"`);
    }
  } else {
    throw new Error(`unknown key "${name}"`);
  }
  return alt ? "\x1b" + seq : seq;
}

export interface PtyInputOptions {
  /** Raw text written first, exactly as given */
  text?: string;
  /** Multi-line text sent as a paste (bracketed-paste markers when the app enabled mode 2004) */
  paste?: string;
  /** Force (true) or suppress (false) bracketed-paste markers; default: follow the app's mode */
  bracketed?: boolean;
  /** Named keys, sent one at a time after text/paste */
  keys?: string[];
  /** Pause between text, paste and each key (ms, default 30, max 5000). ESC immediately followed by another byte reads as Alt+<byte>, so keys are never batched. */
  delayMs?: number;
}

/** Wrap text as a paste: CRLF/LF become CR (what real terminals send), plus bracketed-paste markers if enabled. */
export function pasteSequence(instance: PtyInstance, text: string, bracketed?: boolean): string {
  const body = text.replace(/\r\n|\n/g, "\r");
  const on = bracketed ?? !!instance.terminal?.modes?.bracketedPasteMode;
  return on ? `\x1b[200~${body}\x1b[201~` : body;
}

/**
 * Send text / a paste / named keys to the app, in that order, pausing `delayMs` between parts.
 * Validates every key name before sending anything (throws on an unknown key).
 */
export async function ptyInput(instance: PtyInstance, opts: PtyInputOptions): Promise<void> {
  const delay = Math.min(Math.max(opts.delayMs ?? 30, 0), 5000);
  const dcck = () => !!instance.terminal?.modes?.applicationCursorKeysMode || instance.applicationCursorKeys;
  for (const k of opts.keys ?? []) keyToSequence(k, dcck()); // validate up-front
  let first = true;
  const part = async (data: string) => {
    if (!first && delay > 0) await sleep(delay);
    first = false;
    if (instance.exited) throw new Error("app has exited");
    ptySend(instance, data);
  };
  if (opts.text) await part(opts.text);
  if (opts.paste) await part(pasteSequence(instance, opts.paste, opts.bracketed));
  for (const k of opts.keys ?? []) await part(keyToSequence(k, dcck()));
}

// ── Waiting ──────────────────────────────────────────────────────────────

export interface PtyWaitOptions {
  /** Resolve when the screen contains this substring */
  text?: string;
  /** Resolve when the screen matches this regular expression */
  regex?: string | RegExp;
  /** Resolve when the screen no longer contains this substring */
  gone?: string;
  /** Resolve when there was no PTY output for this many ms (default 500 if no other condition is given) */
  idleMs?: number;
  /** Give up after this many ms (default 30000, max 600000) */
  timeoutMs?: number;
  /** "visible" (default) = the current screen only; "full" = screen + scrollback */
  scope?: "visible" | "full";
  /** Poll interval ms (default 50) */
  pollMs?: number;
  /** Abort early (e.g. HTTP client went away) */
  isCancelled?: () => boolean;
}

export interface PtyWaitResult {
  matched: boolean;
  reason: "text" | "regex" | "gone" | "idle" | "exit" | "timeout" | "cancelled";
  elapsedMs: number;
  exited: boolean;
  exitCode: number | null;
}

/**
 * Wait until ANY of the given conditions holds (checked in order: text, regex, gone, idle),
 * the app exits (reason "exit", matched=false) or the timeout elapses (reason "timeout").
 * Conditions are evaluated on the CURRENT screen, so use distinctive strings (or `gone`/idle)
 * rather than text that is already on screen.
 */
export async function ptyWait(instance: PtyInstance, opts: PtyWaitOptions = {}): Promise<PtyWaitResult> {
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 30000, 0), 600000);
  const pollMs = Math.max(opts.pollMs ?? 50, 10);
  const scope = opts.scope ?? "visible";
  const re = opts.regex === undefined ? undefined : opts.regex instanceof RegExp ? opts.regex : new RegExp(opts.regex);
  const hasScreenCond = opts.text !== undefined || re !== undefined || opts.gone !== undefined;
  const idleMs = opts.idleMs ?? (hasScreenCond ? undefined : 500);
  const t0 = Date.now();
  const res = (matched: boolean, reason: PtyWaitResult["reason"]): PtyWaitResult => ({
    matched, reason, elapsedMs: Date.now() - t0, exited: instance.exited, exitCode: instance.exitCode,
  });
  for (;;) {
    if (hasScreenCond) {
      const screen = ptyScreenText(instance, scope, true);
      if (opts.text !== undefined && screen.includes(opts.text)) return res(true, "text");
      if (re && re.test(screen)) return res(true, "regex");
      if (opts.gone !== undefined && !screen.includes(opts.gone)) return res(true, "gone");
    }
    if (idleMs !== undefined && Date.now() - instance.lastOutputAt >= idleMs) return res(true, "idle");
    if (instance.exited) return res(false, "exit");
    if (opts.isCancelled?.()) return res(false, "cancelled");
    if (Date.now() - t0 >= timeoutMs) return res(false, "timeout");
    await sleep(pollMs);
  }
}

/** Resolve once the instance has exited (or after timeoutMs). Returns true if it exited. */
export async function ptyWaitExit(instance: PtyInstance, timeoutMs: number = 3000): Promise<boolean> {
  const t0 = Date.now();
  while (!instance.exited && Date.now() - t0 < timeoutMs) await sleep(20);
  return instance.exited;
}

/**
 * Send a signal to the PTY process. Windows has no POSIX signals (node-pty throws "Signals not
 * supported on windows" asynchronously), so there ANY signal terminates the app like ptyKill();
 * to send Ctrl-C use ptySend(instance, "") / the "C-c" key instead.
 */
export function ptySignal(instance: PtyInstance, signal: string): void {
  if (instance.exited) return;
  if (process.platform === "win32") return ptyKill(instance);
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

/** Hard-kill a process and all of its descendants (taskkill /T /F on Windows, process group on POSIX). */
function killTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      try { process.kill(-pid, "SIGKILL"); } catch { process.kill(pid, "SIGKILL"); }
    }
  } catch { /* already gone */ }
}

/**
 * Kill the PTY process and its whole process tree. node-pty's own kill() closes the pseudoconsole
 * (which takes the tree down on Windows); if the app is still alive 1.5s later it is escalated to
 * a hard tree kill. No-op if the app already exited.
 */
export function ptyKill(instance: PtyInstance): void {
  if (instance.exited) return;
  try { instance.process.kill(); } catch {}
  const t = setTimeout(() => { if (!instance.exited) killTree(instance.process.pid); }, 1500);
  t.unref?.();
  // Don't clear clients here - let onExit handler notify them first
  // instances.delete will happen in onExit handler after notification
}

/** Get a running PTY instance by ID */
export function ptyGet(id: string): PtyInstance | undefined {
  return instances.get(id);
}

/** Get a running OR recently finished instance (finished ones keep their final screen and exit code) */
export function ptyGetAny(id: string): PtyInstance | undefined {
  return instances.get(id) ?? finished.get(id);
}

/** Recently finished instances (last 20), oldest first */
export function ptyFinished(): PtyInstance[] {
  return [...finished.values()];
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
    if (!inst.exited) { try { inst.process.kill(); } catch {} }
  }
  instances.clear();
  finished.clear();
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

// ── HTTP + WebSocket server ────────────────────────────────────────────────

export interface PtyServerOptions {
  /** Bind address (default 127.0.0.1). Anything other than loopback exposes remote command execution — set a token! */
  host?: string;
  port: number;
  /** If set, every request except GET /health must carry it (Authorization: Bearer <t>, X-Pty-Token: <t>, or ?token=<t>) */
  token?: string;
  /** Logger (default console.log) */
  log?: (msg: string) => void;
}

export interface PtyServer {
  server: Server;
  wss: WebSocketServer;
  listen(): Promise<void>;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** True for 127.0.0.0/8, ::1 and "localhost" */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\./.test(h);
}

function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function truthy(v: string | null): boolean {
  return v === "true" || v === "1" || v === "yes";
}

/** Hostname part of a Host header value ("localhost:3000" -> "localhost", "[::1]:3000" -> "::1") */
function hostnameOf(hostHeader: string): string {
  const m = /^\[([^\]]+)\](?::\d+)?$/.exec(hostHeader);
  if (m) return m[1];
  return hostHeader.replace(/:\d+$/, "");
}

/**
 * Create (but do not start) the PTY HTTP+WebSocket service.
 *
 * Security model: the API is remote command execution by design. Without a token it is only safe
 * on loopback, and requests are additionally refused when they look like a browser attack:
 * a cross-origin `Origin` header (CSRF) or a non-IP/non-localhost `Host` header (DNS rebinding).
 * With a token, every route except GET /health requires it and CORS is opened for browser UIs.
 */
export function createPtyServer(opts: PtyServerOptions): PtyServer {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port;
  const token = opts.token ? opts.token : undefined;
  const log = opts.log ?? ((m: string) => console.log(m));
  const loopbackBound = isLoopbackHost(host);

  /** Returns an error message if the request must be refused before routing, else null */
  const guard = (req: IncomingMessage, url: URL, isHealth: boolean): { status: number; error: string } | null => {
    if (token) {
      if (isHealth) return null;
      const auth = req.headers["authorization"];
      const provided =
        (typeof auth === "string" && /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, "") : undefined) ??
        (typeof req.headers["x-pty-token"] === "string" ? (req.headers["x-pty-token"] as string) : undefined) ??
        url.searchParams.get("token") ?? undefined;
      if (!tokenMatches(provided, token)) return { status: 401, error: "unauthorized: missing or invalid token" };
      return null;
    }
    // No token: only same-origin / non-browser callers, and (on loopback) only IP-literal or localhost Host headers
    const origin = req.headers["origin"];
    if (typeof origin === "string" && origin !== "null") {
      let originHost = "";
      try { originHost = new URL(origin).host; } catch { /* malformed */ }
      if (originHost !== req.headers["host"]) {
        return { status: 403, error: "cross-origin request refused (start the server with --token / PTY_TOKEN to allow browser clients)" };
      }
    } else if (origin === "null") {
      return { status: 403, error: "opaque-origin request refused" };
    }
    if (loopbackBound) {
      const h = hostnameOf(String(req.headers["host"] ?? ""));
      const ipLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":");
      if (!(h === "localhost" || ipLiteral)) return { status: 403, error: "invalid Host header (DNS-rebinding protection)" };
    }
    return null;
  };

  // Find app by ID (exact, then unique-ish prefix = short IDs); running apps win over finished ones
  const findApp = (id: string, includeFinished = false): PtyInstance | undefined => {
    let app = instances.get(id);
    if (app) return app;
    for (const [fullId, inst] of instances) if (fullId.startsWith(id)) return inst;
    if (!includeFinished) return undefined;
    app = finished.get(id);
    if (app) return app;
    for (const [fullId, inst] of finished) if (fullId.startsWith(id)) return inst;
    return undefined;
  };

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

  const appSummary = (inst: PtyInstance) => ({
    id: inst.id,
    name: inst.name,
    command: inst.command,
    args: inst.args,
    pid: inst.process.pid,
    cols: inst.cols,
    rows: inst.rows,
    cwd: inst.cwd,
    createdAt: inst.createdAt,
    clients: inst.clients.size,
    running: !inst.exited,
    exited: inst.exited,
    exitCode: inst.exitCode,
    signal: inst.signal,
    exitedAt: inst.exitedAt,
    outputBytes: inst.outputBytes,
    lastOutputAt: inst.lastOutputAt,
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    const isHealth = req.method === "GET" && pathname === "/health";

    if (token) {
      // Browser UIs may talk to a token-protected server from anywhere
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Pty-Token");
      if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    }
    const refused = guard(req, url, isHealth);
    if (refused) return send(res, refused.status, { error: refused.error });
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

    const parseJson = async (): Promise<Record<string, any> | null> => {
      let body: string;
      try { body = await readBody(req); } catch { send(res, 413, { error: "body too large" }); return null; }
      try {
        const v = JSON.parse(body === "" ? "{}" : body);
        if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
        return v;
      } catch {
        send(res, 400, { error: "invalid JSON" });
        return null;
      }
    };

    try {
      // GET /apps - list running apps (?all=true also lists recently finished ones)
      if (req.method === "GET" && pathname === "/apps") {
        const all = truthy(url.searchParams.get("all"));
        const apps = [...ptyList(), ...(all ? ptyFinished() : [])].map(appSummary);
        return send(res, 200, { apps });
      }

      // POST /start - spawn a new app
      if (req.method === "POST" && pathname === "/start") {
        const parsed = await parseJson();
        if (!parsed) return;
        const { command: cmd, args = [], cols: c, rows: r, cwd: wd, term: t, env } = parsed;
        if (!cmd || typeof cmd !== "string") return send(res, 400, { error: "command is required" });
        if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) return send(res, 400, { error: "args must be an array of strings" });
        if (wd !== undefined && typeof wd !== "string") return send(res, 400, { error: "cwd must be a string" });
        if (env !== undefined && (env === null || typeof env !== "object" || Array.isArray(env) ||
            Object.values(env).some((v) => v !== null && typeof v !== "string"))) {
          return send(res, 400, { error: "env must be an object of string values (null unsets a variable)" });
        }
        const dim = (v: unknown, def: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(Math.floor(v), 1), MAX_DIMENSION) : def);
        try {
          const inst = ptySpawn({
            command: cmd,
            args,
            cols: dim(c, DEFAULT_COLS),
            rows: dim(r, DEFAULT_ROWS),
            cwd: wd ?? process.cwd(),
            term: typeof t === "string" ? t : "xterm-256color",
            env: env as Record<string, string | undefined> | undefined,
          });
          log(`Started: ${cmd} (id: ${inst.id.slice(0, 8)}, pid: ${inst.process.pid})`);
          return send(res, 200, { id: inst.id, pid: inst.process.pid, cols: inst.cols, rows: inst.rows, cwd: inst.cwd });
        } catch (err: any) {
          return send(res, 400, { error: err.message });
        }
      }

      // POST /kill - kill an app (and its process tree); responds once it is gone (max ~3s)
      if (req.method === "POST" && pathname === "/kill") {
        const parsedKill = await parseJson();
        if (!parsedKill) return;
        const { id } = parsedKill;
        if (!id || typeof id !== "string") return send(res, 400, { error: "id is required" });
        const app = findApp(id);
        if (!app) {
          const done = findApp(id, true);
          return send(res, 404, done ? { error: "app already exited", exited: true, exitCode: done.exitCode } : { error: "app not found" });
        }
        log(`Killed: ${app.name} (id: ${app.id.slice(0, 8)})`);
        ptyKill(app);
        await ptyWaitExit(app, 3000);
        return send(res, 200, { ok: true, exited: app.exited, exitCode: app.exitCode });
      }

      // GET /health (never needs the token)
      if (isHealth) {
        return send(res, 200, { status: "ok", apps: instances.size, version: VERSION, auth: !!token });
      }

      // App-specific endpoints: /app/:id/...
      const appMatch = pathname.match(/^\/app\/([^/]+)(\/.*)?$/);
      if (appMatch) {
        const appId = decodeURIComponent(appMatch[1]);
        const subPath = appMatch[2] || "/";
        // Recently finished apps stay addressable: read-only calls return the final screen + exit code,
        // mutating calls answer 409 "app has exited"
        const app = findApp(appId, true);

        if (!app) return send(res, 404, { error: "app not found" });

        // GET /app/:id/snapshot[?color=true][&full=true][&format=text]
        if (req.method === "GET" && subPath === "/snapshot") {
          const color = truthy(url.searchParams.get("color"));
          const full = truthy(url.searchParams.get("full"));
          const snap = ptySnapshot(app, 20, !color);
          if (url.searchParams.get("format") === "text") {
            const text = (full ? snap.fullText : snap.visibleText).replace(/(\r?\n)+$/, "");
            res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
            return res.end(text + "\n");
          }
          return send(res, 200, {
            visibleText: snap.visibleText,
            visibleLines: snap.visibleLines,
            ...(full ? { fullText: snap.fullText, scrollbackLineCount: snap.scrollbackLines.length } : {}),
            cols: app.cols,
            rows: app.rows,
            pid: app.process.pid,
            cursor: { x: snap.cursorX, y: snap.cursorY },
            running: !app.exited,
            exited: app.exited,
            exitCode: app.exitCode,
            signal: app.signal,
            outputBytes: app.outputBytes,
            idleMs: Date.now() - app.lastOutputAt,
          });
        }

        // GET /app/:id/status
        if (req.method === "GET" && subPath === "/status") {
          return send(res, 200, appSummary(app));
        }

        // GET /app/:id/wait?text=&regex=&gone=&idle=&timeout=&scope=visible|full&color=&screen=false
        if (req.method === "GET" && subPath === "/wait") {
          const q = url.searchParams;
          const numQ = (k: string): number | undefined => {
            const v = q.get(k);
            if (v === null || v === "") return undefined;
            const n = Number(v);
            return Number.isFinite(n) ? n : NaN;
          };
          const idleMs = numQ("idle");
          const timeoutMs = numQ("timeout");
          if (Number.isNaN(idleMs) || Number.isNaN(timeoutMs)) return send(res, 400, { error: "idle and timeout must be numbers (ms)" });
          const scope = q.get("scope") === "full" ? "full" : "visible";
          let regex: RegExp | undefined;
          if (q.get("regex")) {
            try { regex = new RegExp(q.get("regex")!); } catch { return send(res, 400, { error: "invalid regex" }); }
          }
          let cancelled = false;
          res.on("close", () => { cancelled = true; });
          const result = await ptyWait(app, {
            text: q.get("text") ?? undefined,
            regex,
            gone: q.get("gone") ?? undefined,
            idleMs,
            timeoutMs,
            scope,
            isCancelled: () => cancelled,
          });
          if (cancelled) return;
          const wantScreen = q.get("screen") !== "false";
          return send(res, 200, {
            ...result,
            ...(wantScreen ? { visibleText: ptyScreenText(app, scope, !truthy(q.get("color"))) } : {}),
          });
        }

        // POST /app/:id/send  { text?, paste?, keys?, bracketed?, delayMs? }
        if (req.method === "POST" && subPath === "/send") {
          const parsedSend = await parseJson();
          if (!parsedSend) return;
          const { text, paste, keys, bracketed, delayMs } = parsedSend;
          if (!text && !paste && !(Array.isArray(keys) && keys.length)) {
            return send(res, 400, { error: "text is required (or paste / keys)" });
          }
          if ((text !== undefined && typeof text !== "string") || (paste !== undefined && typeof paste !== "string") ||
              (keys !== undefined && (!Array.isArray(keys) || keys.some((k) => typeof k !== "string")))) {
            return send(res, 400, { error: "text and paste must be strings, keys an array of strings" });
          }
          if (app.exited) return send(res, 409, { error: "app has exited", exitCode: app.exitCode });
          try {
            await ptyInput(app, {
              text, paste, keys,
              bracketed: typeof bracketed === "boolean" ? bracketed : undefined,
              delayMs: typeof delayMs === "number" ? delayMs : undefined,
            });
          } catch (err: any) {
            return send(res, /unknown key/.test(err.message) ? 400 : 409, { error: err.message });
          }
          return send(res, 200, { ok: true });
        }

        // POST /app/:id/kill  (same as POST /kill {id})
        if (req.method === "POST" && subPath === "/kill") {
          if (app.exited) return send(res, 404, { error: "app already exited", exited: true, exitCode: app.exitCode });
          log(`Killed: ${app.name} (id: ${app.id.slice(0, 8)})`);
          ptyKill(app);
          await ptyWaitExit(app, 3000);
          return send(res, 200, { ok: true, exited: app.exited, exitCode: app.exitCode });
        }

        // POST /app/:id/resize
        if (req.method === "POST" && subPath === "/resize") {
          const parsedResize = await parseJson();
          if (!parsedResize) return;
          const { cols: c, rows: r } = parsedResize;
          if (typeof c !== "number" || typeof r !== "number" || !Number.isFinite(c) || !Number.isFinite(r) || c < 1 || r < 1) {
            return send(res, 400, { error: "cols and rows must be valid numbers" });
          }
          if (app.exited) return send(res, 409, { error: "app has exited", exitCode: app.exitCode });
          const validCols = Math.min(Math.floor(c), MAX_DIMENSION);
          const validRows = Math.min(Math.floor(r), MAX_DIMENSION);
          ptyResize(app, validCols, validRows);
          return send(res, 200, { ok: true, cols: validCols, rows: validRows });
        }

        return send(res, 404, { error: "unknown app endpoint" });
      }

      return send(res, 404, { error: "not found" });
    } catch (err) {
      console.error("HTTP handler error:", err);
      if (!res.headersSent) send(res, 500, { error: "internal error" });
    }
  });

  // ── WebSocket server for per-app real-time I/O ─────────────────────
  const wss = new WebSocketServer({
    server,
    verifyClient: (info: { req: IncomingMessage }, cb: (ok: boolean, code?: number, message?: string) => void) => {
      const wsUrl = new URL(info.req.url ?? "/", "http://localhost");
      const refused = guard(info.req, wsUrl, false);
      if (refused) cb(false, refused.status, refused.error);
      else cb(true);
    },
  });

  wss.on("connection", (ws, req) => {
    // Parse app ID from URL: /app/:id
    const urlPath = req.url?.split("?")[0] || "/";
    const appMatch = urlPath.match(/^\/app\/([^/]+)$/);

    if (!appMatch) {
      ws.close();
      return;
    }

    const app = findApp(decodeURIComponent(appMatch[1]));

    if (!app) {
      ws.send(JSON.stringify({ type: "error", message: "app not found" }));
      ws.close();
      return;
    }

    app.clients.add(ws);
    log(`Client connected to ${app.name} (${app.clients.size} clients)`);

    // Send current terminal mode to client
    ws.send(JSON.stringify({
      type: "mode",
      applicationCursorKeys: app.applicationCursorKeys,
    }));

    // Buffer output until client sends resize
    let initialized = false;
    let pending: string[] = [];

    // Auto-initialize after timeout to prevent unbounded buffering
    const initTimeout = setTimeout(() => {
      if (!initialized) {
        initialized = true;
        for (const chunk of pending) {
          if (ws.readyState === WsClient.OPEN) ws.send(JSON.stringify({ type: "output", text: chunk }));
        }
        pending = [];
      }
    }, 5000);

    // Send output to this client
    const outputHandler = (data: string) => {
      if (initialized) {
        if (ws.readyState === WsClient.OPEN) ws.send(JSON.stringify({ type: "output", text: data }));
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
          ptySend(app, msg.text);
        } else if (msg.type === "resize" && msg.cols && msg.rows) {
          ptyResize(app, msg.cols, msg.rows);
          // Send visible snapshot at the new size
          const snap = ptySnapshot(app, msg.rows, false);
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
          if (mouseSeq) ptySend(app, mouseSeq);
        } else if (msg.type === "touch") {
          // Touch event: { type: "touch", event: "tap|swipe|pinch", x, y, dx, dy, scale }
          const touchSeq = encodeTouchEvent(msg);
          if (touchSeq) ptySend(app, touchSeq);
        }
      } catch (err) {
        console.error("WebSocket message parse error:", err);
      }
    });

    ws.on("close", () => {
      clearTimeout(initTimeout);
      app.clients.delete(ws);
      onData.dispose(); // Remove listener
      log(`Client disconnected from ${app.name} (${app.clients.size} remaining)`);
    });
  });

  return {
    server,
    wss,
    listen: () => new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => { server.off("error", reject); resolve(); });
    }),
    close: () => new Promise<void>((resolve) => {
      for (const c of wss.clients) { try { c.terminate(); } catch { /* ignore */ } }
      wss.close();
      server.close(() => resolve());
      (server as any).closeAllConnections?.();
    }),
  };
}

// Auto-cleanup on exit
process.on("exit", ptyCleanup);
process.on("SIGINT", () => { ptyCleanup(); process.exit(1); });
process.on("SIGTERM", () => { ptyCleanup(); process.exit(1); });

// ── CLI ──────────────────────────────────────────────────────────────────
// pty <command> [args...]            run directly in this terminal
// pty --serve [--port N]             start the service manager
// pty --start <cmd> [args...]        ... then drive it from another shell (see --help)

/** Flags the CLI understands (everything else is part of the command being run) */
const PTY_FLAGS = new Set([
  "--cols", "--rows", "--cwd", "--term", "--wait", "--color", "--interactive", "--snapshot",
  "--serve", "--connect", "--port", "--host", "--start", "--list", "--kill", "--help", "-h",
  "--env", "--token", "--json", "--all",
  "--screen", "--status", "--send", "--wait-for",
  "--text", "--paste", "--paste-file", "--keys", "--delay", "--regex", "--gone", "--idle", "--timeout", "--scope", "--full",
]);
/** Flags that existed before the client commands were added: the only ones that split `pty <command> <args> --flag` (no `--`) */
const LEGACY_FLAGS = new Set([
  "--cols", "--rows", "--cwd", "--term", "--wait", "--color", "--interactive", "--snapshot",
  "--serve", "--connect", "--port", "--host", "--start", "--list", "--kill", "--help", "-h",
]);
/** Flags that consume the next token */
const VALUE_FLAGS = new Set([
  "--cols", "--rows", "--cwd", "--term", "--wait", "--port", "--host", "--start", "--kill", "--env", "--token",
  "--screen", "--status", "--send", "--wait-for",
  "--text", "--paste", "--paste-file", "--keys", "--delay", "--regex", "--gone", "--idle", "--timeout", "--scope",
]);

export interface SplitArgs {
  /** Command (+ args) to run directly / as the initial app of --serve */
  cmdArgs: string[];
  /** Recognised flags and their values, in order */
  ptyOpts: string[];
  /** Arguments of the command named by --start (everything after it up to the next pty flag, or after a bare `--`) */
  startArgs: string[];
}

/**
 * Split argv into command / pty options.
 *  - `pty htop`                            -> command htop
 *  - `pty bash -lc "x" -- --serve`         -> args before `--` are the command, after it are pty flags
 *  - `pty --start node -e "1+1" --port 3100` -> --start takes the next token as the command; following
 *     tokens are its arguments until a pty flag. A bare `--` forces everything after it to be arguments
 *     (needed only when an argument collides with a pty flag name):
 *     `pty --port 3100 --start mytool -- --port 8080`  (mytool gets `--port 8080`)
 */
export function splitCliArgs(args: string[]): SplitArgs {
  const startIdx = args.indexOf("--start");
  if (startIdx !== -1) {
    const ptyOpts: string[] = [];
    const startArgs: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (i < startIdx) {
        if (a === "--") continue; // `pnpm dev -- --start ...` style lone separator
        ptyOpts.push(a);
        if (VALUE_FLAGS.has(a) && i + 1 < args.length) ptyOpts.push(args[++i]);
      } else if (i === startIdx) {
        ptyOpts.push("--start");
        if (i + 1 < args.length) ptyOpts.push(args[++i]);
        // everything after the command is its argument list until the next pty flag / bare `--`
        for (i = i + 1; i < args.length; i++) {
          const t = args[i];
          if (t === "--") { startArgs.push(...args.slice(i + 1)); i = args.length; break; }
          if (PTY_FLAGS.has(t)) {
            ptyOpts.push(t);
            if (VALUE_FLAGS.has(t) && i + 1 < args.length) ptyOpts.push(args[++i]);
          } else {
            startArgs.push(t);
          }
        }
      }
    }
    return { cmdArgs: [], ptyOpts, startArgs };
  }

  const explicitSplit = args.indexOf("--");
  if (explicitSplit !== -1) {
    const cmdArgs = args.slice(0, explicitSplit);
    const ptyOpts: string[] = [];
    for (let i = explicitSplit + 1; i < args.length; i++) {
      const arg = args[i];
      if (PTY_FLAGS.has(arg)) {
        ptyOpts.push(arg);
        if (VALUE_FLAGS.has(arg) && i + 1 < args.length) ptyOpts.push(args[++i]);
      } else {
        cmdArgs.push(arg); // Not a pty flag — goes to the command
      }
    }
    return { cmdArgs, ptyOpts, startArgs: [] };
  }

  // No explicit separator — find the first pty flag and split there. When the first token is a command
  // (not a flag) only the historic flags split, so `pty mytool --json` still passes --json to mytool.
  const known = args[0].startsWith("-") ? PTY_FLAGS : LEGACY_FLAGS;
  const firstPtyIdx = args.findIndex((a) => known.has(a));
  if (firstPtyIdx === -1) return { cmdArgs: args, ptyOpts: [], startArgs: [] };
  return { cmdArgs: args.slice(0, firstPtyIdx), ptyOpts: args.slice(firstPtyIdx), startArgs: [] };
}

const HELP_TEXT = `pty ${VERSION} — PTY Service Manager: spawn, drive and snapshot TUI apps in pseudo-terminals.

Usage: pty [command [args...]] [-- <options>]      (from a clone: pnpm dev <same args>)

Server:
  --serve                    Start the service manager (HTTP + WebSocket)
  --port <n>                 Port (default 3000, or $PTY_PORT)
  --host <addr>              Bind address (default 127.0.0.1, or $PTY_HOST).
                             WARNING: anything but loopback exposes remote command execution.
  --token <secret>           Require this token on every request except GET /health
                             (default $PTY_TOKEN). Strongly recommended with a non-loopback --host.

Client commands (talk to a running server; same --port/--host/--token):
  --start <cmd> [args...]    Spawn an app; prints its id.  Options: --cwd --env K=V (repeatable)
                             --cols --rows --term.  A bare "--" forces the rest to be cmd args.
  --list [--all]             List running apps (--all: also recently exited ones)
  --status <id>              Show status incl. exit code
  --screen <id>              Print the screen as plain text (--color: ANSI, --full: with scrollback)
  --send <id>                Send input: --text "raw" | --paste "multi\\nline" | --paste-file f | --keys Enter,Escape,C-c,Up
                             (--delay <ms> between parts, default 30)
  --wait-for <id>            Block until --text "s" | --regex "re" | --gone "s" | --idle <ms> or --timeout <ms>
                             (default 30000). Exit code 0 = matched, 2 = timeout/exited. Prints the screen.
  --kill <id>                Kill the app and its whole process tree
  --connect [id]             Interactive attach (Ctrl+C detaches)
  --json                     Print raw JSON responses instead of text
  ids may be shortened to any unique prefix (the first 8 chars are printed).

Direct mode (no server):
  pty <command> [args...]    Run in this terminal (interactive; Ctrl+C quits)
  pty <command> -- --snapshot [--wait <ms>] [--color]   Print one screen snapshot and exit
  --cols <n> --rows <n> --cwd <dir> --term <name> --env K=V

Other: --version, --help

HTTP API (see README): GET /health /apps /app/:id/snapshot|status|wait, POST /start /kill /app/:id/send|resize|kill,
WS /app/:id.   Examples:
  pty --serve --port 3100 &
  pty --port 3100 --start bash -lc "echo hi; exec bash" --cwd C:/work --env FOO=bar
  pty --port 3100 --send a1b2c3d4 --text "ls" --keys Enter
  pty --port 3100 --wait-for a1b2c3d4 --text "$" --timeout 5000
  pty --port 3100 --screen a1b2c3d4
  pty --port 3100 --kill a1b2c3d4`;

/** Parse "K=V" strings into an env object; throws on a malformed entry */
export function parseEnvPairs(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const i = p.indexOf("=");
    if (i < 1) throw new Error(`--env expects KEY=VALUE, got "${p}"`);
    out[p.slice(0, i)] = p.slice(i + 1);
  }
  return out;
}

/**
 * True when this file is the program being executed (node dist/pty.js, the `pty` bin shim, tsx pty.ts),
 * false when it is imported as a library — including under vitest, and including child servers spawned
 * from a test (they inherit NODE_ENV=test, so the env must NOT be used for this decision).
 */
const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  let self: string;
  try { self = realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
  for (const candidate of [argv1, argv1 + ".js"]) {
    try { if (realpathSync(candidate) === self) return true; } catch { /* try next */ }
  }
  return false;
})()

if (isMain) {
  (async () => {
    const args = process.argv.slice(2);
    if (args[0] === "--" && args.length > 1) args.shift(); // `pnpm dev -- --serve` passes the separator through
    if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
      console.log(HELP_TEXT);
      process.exit(0);
    }
    if (args[0] === "--version" || args[0] === "-v") {
      console.log(VERSION);
      process.exit(0);
    }

    const { cmdArgs, ptyOpts, startArgs } = splitCliArgs(args);
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
    let host = process.env.PTY_HOST || "127.0.0.1";
    let start: string | undefined;
    let list = false;
    let kill: string | undefined;
    let json = false;
    let all = false;
    let full = false;
    let token: string | undefined = process.env.PTY_TOKEN || undefined;
    const envPairs: string[] = [];
    let screenId: string | undefined, statusId: string | undefined, sendId: string | undefined, waitForId: string | undefined;
    let sendText: string | undefined, sendPaste: string | undefined, sendKeys: string[] | undefined, sendDelay: number | undefined;
    let waitRegex: string | undefined, waitGone: string | undefined, waitIdle: number | undefined, waitTimeout: number | undefined;
    let scope: string | undefined;

    // Helper to parse int with bounds checking
    const parseBoundedInt = (val: string, min: number, max: number, def: number): number => {
      const parsed = parseInt(val, 10);
      if (Number.isNaN(parsed)) return def;
      return Math.min(Math.max(parsed, min), max);
    };
    let port = parseBoundedInt(process.env.PTY_PORT ?? "", 1, 65535, 3000);

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
        case "--env": envPairs.push(ptyOpts[++i] ?? ""); break;
        case "--token": token = ptyOpts[++i]; break;
        case "--json": json = true; break;
        case "--all": all = true; break;
        case "--full": full = true; break;
        case "--screen": screenId = ptyOpts[++i]; break;
        case "--status": statusId = ptyOpts[++i]; break;
        case "--send": sendId = ptyOpts[++i]; break;
        case "--wait-for": waitForId = ptyOpts[++i]; break;
        case "--text": sendText = ptyOpts[++i]; break;
        case "--paste": sendPaste = ptyOpts[++i]; break;
        case "--paste-file": {
          const f = ptyOpts[++i];
          try { sendPaste = (await import("node:fs")).readFileSync(f, "utf8"); } catch (e: any) { console.error(`Cannot read --paste-file ${f}: ${e.message}`); process.exit(1); }
          break;
        }
        case "--keys": sendKeys = (ptyOpts[++i] ?? "").split(",").map((k) => k.trim()).filter(Boolean); break;
        case "--delay": sendDelay = parseBoundedInt(ptyOpts[++i], 0, 5000, 30); break;
        case "--regex": waitRegex = ptyOpts[++i]; break;
        case "--gone": waitGone = ptyOpts[++i]; break;
        case "--idle": waitIdle = parseBoundedInt(ptyOpts[++i], 0, 600000, 500); break;
        case "--timeout": waitTimeout = parseBoundedInt(ptyOpts[++i], 0, 600000, 30000); break;
        case "--scope": scope = ptyOpts[++i]; break;
        case "--help": case "-h": break; // handled by showHelp check
      }
    }

    // Show help if requested (works whether --help is at start or after --)
    if (showHelp) {
      console.log(HELP_TEXT);
      process.exit(0);
    }

    let env: Record<string, string>;
    try {
      env = parseEnvPairs(envPairs);
    } catch (e: any) {
      console.error(e.message);
      process.exit(1);
    }

    // Resolve cols/rows from TTY if not specified
    const resolvedCols = cols ?? (process.stdout.isTTY ? process.stdout.columns : undefined) ?? DEFAULT_COLS;
    const resolvedRows = rows ?? (process.stdout.isTTY ? process.stdout.rows : undefined) ?? DEFAULT_ROWS;

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
    const isClient = start || list || kill || connect || screenId || statusId || sendId || waitForId;
    if (isClient) {
      const baseUrl = `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      const fail = (msg: string, code = 1): never => { console.error(msg); process.exit(code); };

      // JSON request helper: returns {status, body}; friendly error when the server is unreachable
      const call = async (method: "GET" | "POST", path: string, body?: object): Promise<{ status: number; body: any }> => {
        let res: Response;
        try {
          res = await fetch(`${baseUrl}${path}`, {
            method,
            headers: body ? { ...headers, "Content-Type": "application/json" } : headers,
            body: body ? JSON.stringify(body) : undefined,
          });
        } catch (err: any) {
          return fail(`Cannot reach a PTY server at ${baseUrl} (${err.cause?.code ?? err.message}).\n` +
            `Start one with:  pty --serve --port ${port}   (or pass --port/--host; PTY_PORT/PTY_HOST are honoured)`);
        }
        const text = await res.text();
        let parsed: any;
        try { parsed = JSON.parse(text); } catch { parsed = { error: text.slice(0, 200) }; }
        if (res.status === 401) fail("Unauthorized: pass --token <secret> (or set PTY_TOKEN) matching the server's token");
        return { status: res.status, body: parsed };
      };
      const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));

      if (list) {
        const { body } = await call("GET", `/apps${all ? "?all=true" : ""}`);
        if (json) return out(body);
        if (!body.apps?.length) return console.log("No running applications.");
        console.log(all ? "Applications:" : "Running applications:");
        for (const app of body.apps) {
          const age = Math.round((Date.now() - app.createdAt) / 1000);
          const state = app.exited ? `  exited(${app.exitCode})` : "";
          console.log(`  ${app.id.slice(0, 8)}  ${String(app.name).padEnd(20)}  pid:${app.pid}  ${app.cols}x${app.rows}  ${age}s${state}`);
        }
        return;
      }

      if (start) {
        const { status, body } = await call("POST", "/start", {
          command: start, args: startArgs, cols, rows, cwd, term, ...(Object.keys(env).length ? { env } : {}),
        });
        if (status !== 200) fail(`Error: ${body.error}`);
        if (json) return out(body);
        console.log(`Started app: ${body.id.slice(0, 8)} (pid: ${body.pid})`);
        console.log(`Screen: pty --port ${port} --screen ${body.id.slice(0, 8)}    Attach: pty --port ${port} --connect ${body.id.slice(0, 8)}`);
        return;
      }

      if (kill) {
        const { status, body } = await call("POST", "/kill", { id: kill });
        if (status !== 200) fail(`Error: ${body.error}`);
        if (json) return out(body);
        console.log(`Killed app: ${kill}${body.exitCode !== null && body.exitCode !== undefined ? ` (exit code ${body.exitCode})` : ""}`);
        return;
      }

      if (statusId) {
        const { status, body } = await call("GET", `/app/${encodeURIComponent(statusId)}/status`);
        if (status !== 200) fail(`Error: ${body.error}`);
        return out(body);
      }

      if (screenId) {
        const q = `color=${color}&full=${full}&format=${json ? "json" : "text"}`;
        if (json) {
          const { status, body } = await call("GET", `/app/${encodeURIComponent(screenId)}/snapshot?${q}`);
          if (status !== 200) fail(`Error: ${body.error}`);
          return out(body);
        }
        const res = await fetch(`${baseUrl}/app/${encodeURIComponent(screenId)}/snapshot?${q}`, { headers }).catch((e) => fail(`Cannot reach a PTY server at ${baseUrl}: ${e.message}`));
        if (res.status !== 200) fail(`Error: ${((await res.json().catch(() => ({ error: res.statusText }))) as { error?: string }).error}`);
        process.stdout.write(await res.text());
        return;
      }

      if (sendId) {
        if (sendText === undefined && sendPaste === undefined && !sendKeys?.length) fail("--send needs --text, --paste, --paste-file or --keys");
        const { status, body } = await call("POST", `/app/${encodeURIComponent(sendId)}/send`, {
          text: sendText, paste: sendPaste, keys: sendKeys, delayMs: sendDelay,
        });
        if (status !== 200) fail(`Error: ${body.error}`);
        if (json) out(body); else console.log("Sent.");
        return;
      }

      if (waitForId) {
        const p = new URLSearchParams();
        if (sendText !== undefined) p.set("text", sendText);
        if (waitRegex !== undefined) p.set("regex", waitRegex);
        if (waitGone !== undefined) p.set("gone", waitGone);
        if (waitIdle !== undefined) p.set("idle", String(waitIdle));
        if (waitTimeout !== undefined) p.set("timeout", String(waitTimeout));
        if (scope) p.set("scope", scope);
        if (color) p.set("color", "true");
        const { status, body } = await call("GET", `/app/${encodeURIComponent(waitForId)}/wait?${p}`);
        if (status !== 200) fail(`Error: ${body.error}`);
        if (json) out(body);
        else {
          console.error(`wait: ${body.matched ? "matched" : "NOT matched"} (${body.reason}) after ${body.elapsedMs}ms${body.exited ? `, app exited with code ${body.exitCode}` : ""}`);
          console.log(String(body.visibleText ?? "").replace(/(\r?\n)+$/, ""));
        }
        process.exit(body.matched ? 0 : 2);
      }

      // --connect: Interactive connection to an app
      if (connect) {
        // Determine which app to connect to
        let appId = command; // command arg after --connect becomes the app ID
        if (!appId) {
          // Get first available app
          const { body } = await call("GET", "/apps");
          if (!body.apps?.length) fail("No running applications. Use --start to spawn one.");
          appId = body.apps[0].id as string;
          console.error(`Connecting to app: ${appId.slice(0, 8)}`);
        }

        // Set up stdin first
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        process.stdin.resume();

        const ws = new WsClient(`ws://${host}:${port}/app/${appId}${token ? `?token=${encodeURIComponent(token)}` : ""}`);

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
          const cc = cols ?? (process.stdout.isTTY ? process.stdout.columns : undefined);
          const rr = rows ?? (process.stdout.isTTY ? process.stdout.rows : undefined);
          if (cc && rr) {
            ws.send(JSON.stringify({ type: "resize", cols: cc, rows: rr }));
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
      const svc = createPtyServer({ host, port, token });

      // If a command was provided, spawn it as the initial app
      if (command) {
        console.log(`Initial app: ${command} ${cmdRest.join(" ")}`);
      }
      console.log(`PTY service manager ${VERSION} starting on http://${host}:${port}`);
      console.log();

      // Spawn initial app if command provided
      if (command) {
        try {
          const inst = ptySpawn({ command, args: cmdRest, cols: resolvedCols, rows: resolvedRows, cwd, term, env });
          ptySetDefault(inst);
          console.log(`Started: ${command} (id: ${inst.id.slice(0, 8)}, pid: ${inst.process.pid})`);
        } catch (err: any) {
          console.error(err.message);
          process.exit(1);
        }
      }

      try {
        await svc.listen();
      } catch (err: any) {
        console.error(err.code === "EADDRINUSE"
          ? `Error: port ${port} on ${host} is already in use. Pick another with --port.`
          : `Error: cannot listen on ${host}:${port}: ${err.message}`);
        ptyCleanup();
        process.exit(1);
      }

      console.log(`PTY service manager listening on http://${host}:${port}`);
      if (!isLoopbackHost(host)) {
        console.warn(`\n!!! WARNING: listening on ${host} — this API lets ANY client that can reach it run arbitrary commands`);
        console.warn(`!!! as your user. ${token ? "Requests are protected by the token you set; use a firewall/TLS proxy too." : "NO TOKEN IS SET. Restart with --token <secret> (or PTY_TOKEN) or bind to 127.0.0.1."}\n`);
      } else if (token) {
        console.log("Auth: token required (Authorization: Bearer <token> | X-Pty-Token | ?token=)");
      }
      console.log(`Endpoints:`);
      console.log(`  GET  /health                         — liveness (no auth)`);
      console.log(`  GET  /apps[?all=true]                — list running (and finished) apps`);
      console.log(`  POST /start                          — spawn { "command", "args", "cwd", "env", "cols", "rows" }`);
      console.log(`  POST /kill  | /app/:id/kill          — kill app + process tree`);
      console.log(`  GET  /app/:id/snapshot[?color=true&full=true&format=text]`);
      console.log(`  GET  /app/:id/wait?text=|regex=|gone=|idle=&timeout=`);
      console.log(`  POST /app/:id/send                   — { "text" | "paste" | "keys": [...] }`);
      console.log(`  POST /app/:id/resize                 — { "cols", "rows" }`);
      console.log(`  GET  /app/:id/status                 — status + exit code`);
      console.log(`  WS   ws://${host}:${port}/app/:id    — real-time I/O`);
      console.log(`\nCtrl+C to stop`);

      const shutdown = () => {
        console.log("\nShutting down...");
        ptyCleanup();
        svc.close().finally(() => process.exit(0));
        setTimeout(() => process.exit(0), 1000).unref();
      };
      process.removeAllListeners("SIGINT");
      process.removeAllListeners("SIGTERM");
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      return;
    }

    // ── Direct mode: spawn command for interactive/snapshot ──────────────
    if (!command) {
      console.error("Error: no command specified");
      console.error("Use --serve to start service manager, or provide a command to run (pty --help)");
      process.exit(1);
    }

    console.log(`Spawning: ${command} ${cmdRest.join(" ")}`);
    console.log(`  Terminal: ${resolvedCols}x${resolvedRows}, cwd: ${cwd}, term: ${term}`);
    if (snapshot) console.log(`  Mode: snapshot (wait ${waitMs}ms)`);
    else console.log(`  Mode: interactive (Ctrl+C to exit)`);
    console.log();

    let instance: ReturnType<typeof ptySpawn>;
    try {
      instance = ptySpawn({ command, args: cmdRest, cols: resolvedCols, rows: resolvedRows, cwd, term, env });
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
