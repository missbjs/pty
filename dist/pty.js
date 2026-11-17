#!/usr/bin/env node
import * as pty from "node-pty";
import xtermHeadless from "@xterm/headless";
import stripAnsi from "strip-ansi";
import { randomUUID, createHash, timingSafeEqual } from "crypto";
import { createServer } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { realpathSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "url";
import { spawnSync } from "node:child_process";
const version = "1.2.0";
const pkg = {
  version
};
const VERSION = pkg.version;
const Terminal = xtermHeadless.Terminal;
const DEFAULT_COLS = 400;
const DEFAULT_ROWS = 40;
const MAX_PENDING_OUTPUT = 1e3;
const MAX_DIMENSION = 1e4;
const TAIL_CAP = 2e6;
function cellSgr(cell) {
  const codes = [];
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
    if (cell.isFgRGB()) codes.push(`38;2;${c >> 16 & 255};${c >> 8 & 255};${c & 255}`);
    else codes.push(`38;5;${c}`);
  }
  if (!cell.isBgDefault()) {
    const c = cell.getBgColor();
    if (cell.isBgRGB()) codes.push(`48;2;${c >> 16 & 255};${c >> 8 & 255};${c & 255}`);
    else codes.push(`48;5;${c}`);
  }
  return codes.join(";");
}
function lineToAnsiString(line) {
  let end = 0;
  for (let col = line.length - 1; col >= 0; col--) {
    const cell = line.getCell(col);
    if (!cell) continue;
    const chars = cell.getChars();
    if (chars !== "" && chars !== " " || !cell.isBgDefault() || cell.isInverse() || cell.isUnderline()) {
      end = col + 1;
      break;
    }
  }
  let result = "";
  let lastSgr = "";
  for (let col = 0; col < end; col++) {
    const cell = line.getCell(col);
    if (!cell || cell.getWidth() === 0) continue;
    const sgr = cellSgr(cell);
    if (sgr !== lastSgr) {
      result += sgr === "" ? "\x1B[0m" : `\x1B[0;${sgr}m`;
      lastSgr = sgr;
    }
    result += cell.getChars() || " ";
  }
  if (lastSgr !== "") result += "\x1B[0m";
  return result;
}
const instances = /* @__PURE__ */ new Map();
let defaultInstance = null;
const finished = /* @__PURE__ */ new Map();
const MAX_FINISHED = 20;
function resolveCommand(cmd) {
  if (cmd.includes("/") || cmd.includes("\\")) return cmd;
  const win = process.platform === "win32";
  const sep = win ? ";" : ":";
  const pathDirs = (process.env.PATH || process.env.Path || "").split(sep).map((d) => d.replace(/^"|"$/g, ""));
  let candidates;
  if (win) {
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
      } catch {
      }
    }
  }
  return cmd;
}
function ptySpawn(opts) {
  const id = randomUUID();
  const cols = opts.cols ?? DEFAULT_COLS;
  const rows = opts.rows ?? DEFAULT_ROWS;
  const term = opts.term ?? "xterm-256color";
  const cwd = opts.cwd ?? process.cwd();
  const resolvedCommand = resolveCommand(opts.command);
  try {
    if (!statSync(cwd).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`Failed to spawn "${opts.command}": cwd does not exist or is not a directory: ${cwd}`);
  }
  const childEnv = {};
  for (const [k, v] of Object.entries({ ...process.env, COLORTERM: "truecolor", TERM: term, ...opts.env ?? {} })) {
    if (v !== void 0 && v !== null) childEnv[k] = String(v);
  }
  let ptyProcess;
  try {
    ptyProcess = pty.spawn(resolvedCommand, opts.args ?? [], {
      name: term,
      cols,
      rows,
      cwd,
      env: childEnv
    });
  } catch (err) {
    throw new Error(`Failed to spawn "${opts.command}": ${err.message}`);
  }
  const vt = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 1e4 });
  const ACCUM_CAP = 2048;
  let outputAccum = "";
  ptyProcess.onData((data) => {
    instance.lastOutputAt = Date.now();
    instance.outputBytes += data.length;
    instance.tail += data;
    if (instance.tail.length > TAIL_CAP * 1.5) {
      const drop = instance.tail.length - TAIL_CAP;
      instance.tail = instance.tail.slice(drop);
      instance.tailStart += drop;
    }
    if (outputAccum.length < ACCUM_CAP) {
      outputAccum += data;
      if (outputAccum.length > ACCUM_CAP) outputAccum = outputAccum.slice(0, ACCUM_CAP);
    }
    vt.write(data);
    if (data.includes("\x1B[6n") || data.endsWith("\x1B[")) {
      setTimeout(() => ptyProcess.write("\x1B[1;1R"), 50);
    }
  });
  const instance = {
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
    clients: /* @__PURE__ */ new Set(),
    applicationCursorKeys: false,
    exited: false,
    exitCode: null,
    signal: null,
    exitedAt: null,
    lastOutputAt: Date.now(),
    outputBytes: 0,
    killed: false,
    tail: "",
    tailStart: 0
  };
  const trackModes = (data) => {
    if (data.includes("\x1B[?1h") && !instance.applicationCursorKeys) {
      instance.applicationCursorKeys = true;
      for (const client of instance.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: "mode", applicationCursorKeys: true }));
        }
      }
    }
    if (data.includes("\x1B[?1l") && instance.applicationCursorKeys) {
      instance.applicationCursorKeys = false;
      for (const client of instance.clients) {
        if (client.readyState === WebSocket.OPEN) {
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
    for (const client of instance.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "exit", exitCode, id }));
        client.close();
      }
    }
    instance.clients.clear();
    instances.delete(id);
    finished.set(id, instance);
    while (finished.size > MAX_FINISHED) {
      const oldest = finished.keys().next().value;
      try {
        finished.get(oldest)?.terminal.dispose();
      } catch {
      }
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
function readLines(instance, start, end, stripAnsiCodes) {
  const buf = instance.terminal.buffer.active;
  const out = [];
  for (let i = start; i < end && i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) {
      out.push("");
    } else if (stripAnsiCodes) {
      out.push(stripAnsi(line.translateToString(true)));
    } else {
      out.push(lineToAnsiString(line));
    }
  }
  return out;
}
function ptyScreenText(instance, scope = "visible", stripAnsiCodes = true) {
  const buf = instance.terminal.buffer.active;
  const start = scope === "full" ? 0 : buf.baseY;
  return readLines(instance, start, buf.length, stripAnsiCodes).join("\n");
}
function ptyFilterLines(lines, opts = {}) {
  let out = lines.slice();
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  if (opts.grep) {
    const re = new RegExp(opts.grep, opts.ignoreCase ? "i" : "");
    out = out.filter((l) => re.test(l.replace(/\x1b\[[0-9;]*m/g, "")));
  }
  if (opts.tail !== void 0 && opts.tail >= 0) out = opts.tail === 0 ? [] : out.slice(-opts.tail);
  return out;
}
function ptySnapshot(instance, footerRows = 20, stripAnsiCodes = true) {
  const buf = instance.terminal.buffer.active;
  const fullLines = readLines(instance, 0, buf.length, stripAnsiCodes);
  const visibleLines = fullLines.slice(-instance.rows);
  const scrollbackLines = fullLines.slice(0, -instance.rows);
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
    cursorY: buf.cursorY
  };
}
function ptySend(instance, text) {
  instance.process.write(text);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NAMED_KEYS = {
  up: ["A", "csi"],
  down: ["B", "csi"],
  right: ["C", "csi"],
  left: ["D", "csi"],
  home: ["H", "csi"],
  end: ["F", "csi"],
  insert: ["2", "tilde"],
  delete: ["3", "tilde"],
  pageup: ["5", "tilde"],
  pagedown: ["6", "tilde"],
  f1: ["P", "ss3"],
  f2: ["Q", "ss3"],
  f3: ["R", "ss3"],
  f4: ["S", "ss3"],
  f5: ["15", "tilde"],
  f6: ["17", "tilde"],
  f7: ["18", "tilde"],
  f8: ["19", "tilde"],
  f9: ["20", "tilde"],
  f10: ["21", "tilde"],
  f11: ["23", "tilde"],
  f12: ["24", "tilde"]
};
const KEY_ALIASES = {
  del: "delete",
  ins: "insert",
  pgup: "pageup",
  pgdn: "pagedown",
  pgdown: "pagedown",
  "page-up": "pageup",
  "page-down": "pagedown",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right"
};
const SIMPLE_KEYS = {
  enter: "\r",
  return: "\r",
  cr: "\r",
  lf: "\n",
  newline: "\n",
  tab: "	",
  escape: "\x1B",
  esc: "\x1B",
  space: " ",
  backspace: "",
  bspace: "",
  bs: ""
};
function keyToSequence(name, applicationCursorKeys = false) {
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
    if (kind === "tilde") return mod > 1 ? `\x1B[${code};${mod}~` : `\x1B[${code}~`;
    if (mod > 1) return `\x1B[1;${mod}${code}`;
    if (kind === "ss3") return `\x1BO${code}`;
    return applicationCursorKeys ? `\x1BO${code}` : `\x1B[${code}`;
  }
  if (lower === "tab" && shift && !ctrl && !alt) return "\x1B[Z";
  if ((lower === "enter" || lower === "return") && shift && !ctrl && !alt) return "\x1B[13;2u";
  let seq;
  if (SIMPLE_KEYS[lower] !== void 0) {
    seq = ctrl && lower === "space" ? "\0" : SIMPLE_KEYS[lower];
  } else if ([...base].length === 1) {
    seq = shift ? base.toUpperCase() : base;
    if (ctrl) {
      const c = base.toLowerCase();
      if (c >= "a" && c <= "z") seq = String.fromCharCode(c.charCodeAt(0) - 96);
      else if (c === "@" || c === " ") seq = "\0";
      else if (c === "[") seq = "\x1B";
      else if (c === "\\") seq = "";
      else if (c === "]") seq = "";
      else if (c === "^") seq = "";
      else if (c === "_" || c === "-") seq = "";
      else if (c === "?") seq = "";
      else throw new Error(`unknown key "${name}"`);
    }
  } else {
    throw new Error(`unknown key "${name}"`);
  }
  return alt ? "\x1B" + seq : seq;
}
class PtyPreconditionError extends Error {
}
function pasteSequence(instance, text, bracketed) {
  const body = text.replace(/\r\n|\n/g, "\r");
  const on = bracketed ?? !!instance.terminal?.modes?.bracketedPasteMode;
  return on ? `\x1B[200~${body}\x1B[201~` : body;
}
async function ptyInput(instance, opts) {
  const delay = Math.min(Math.max(opts.delayMs ?? 30, 0), 5e3);
  if (opts.require !== void 0 && !ptyScreenText(instance, "visible", true).includes(opts.require)) {
    throw new PtyPreconditionError(`screen does not contain required text ${JSON.stringify(opts.require)}; nothing was sent`);
  }
  const dcck = () => !!instance.terminal?.modes?.applicationCursorKeysMode || instance.applicationCursorKeys;
  for (const k of opts.keys ?? []) keyToSequence(k, dcck());
  if (opts.newlineAs && opts.newlineAs !== "cr" && opts.newlineAs !== "lf" && opts.newlineAs !== "literal") keyToSequence(opts.newlineAs, dcck());
  let first = true;
  const part = async (data) => {
    if (!first && delay > 0) await sleep(delay);
    first = false;
    if (instance.exited) throw new Error("app has exited");
    ptySend(instance, data);
  };
  if (opts.text) await part(opts.text);
  if (opts.paste) {
    const nl = opts.newlineAs;
    if (nl === void 0 || nl === "cr") {
      await part(pasteSequence(instance, opts.paste, opts.bracketed));
    } else if (nl === "literal") {
      await part(opts.paste);
    } else {
      const sep = nl === "lf" ? "\n" : keyToSequence(nl, dcck());
      const lines = opts.paste.split(/\r\n|\n|\r/);
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) await part(sep);
        if (lines[i]) await part(lines[i]);
      }
    }
  }
  for (const k of opts.keys ?? []) await part(keyToSequence(k, dcck()));
}
function ptyOutputSince(instance, offset) {
  const from = Math.max(offset - instance.tailStart, 0);
  return stripAnsi(instance.tail.slice(from)).replace(/\r/g, "");
}
async function ptyWait(instance, opts = {}) {
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 3e4, 0), 6e5);
  const pollMs = Math.max(opts.pollMs ?? 50, 10);
  const scope = opts.scope ?? "visible";
  const re = opts.regex === void 0 ? void 0 : opts.regex instanceof RegExp ? opts.regex : new RegExp(opts.regex);
  const hasScreenCond = opts.text !== void 0 || re !== void 0 || opts.gone !== void 0;
  const idleMs = opts.idleMs ?? (hasScreenCond ? void 0 : 500);
  const t0 = Date.now();
  const startOffset = instance.outputBytes;
  const base = opts.after ?? (opts.newOnly ? startOffset : void 0);
  const minNew = opts.minNewBytes ?? 0;
  const res = (matched, reason) => ({
    matched,
    reason,
    elapsedMs: Date.now() - t0,
    exited: instance.exited,
    exitCode: instance.exitCode,
    offset: instance.outputBytes
  });
  for (; ; ) {
    if (hasScreenCond) {
      const screen = ptyScreenText(instance, scope, true);
      const searched = base !== void 0 ? ptyOutputSince(instance, base) : screen;
      if (opts.text !== void 0 && searched.includes(opts.text)) return res(true, "text");
      if (re && re.test(searched)) return res(true, "regex");
      if (opts.gone !== void 0 && !screen.includes(opts.gone)) return res(true, "gone");
    }
    if (idleMs !== void 0 && Date.now() - instance.lastOutputAt >= idleMs && instance.outputBytes - (base ?? startOffset) >= minNew) return res(true, "idle");
    if (instance.exited) return res(false, "exit");
    if (opts.isCancelled?.()) return res(false, "cancelled");
    if (Date.now() - t0 >= timeoutMs) return res(false, "timeout");
    await sleep(pollMs);
  }
}
async function ptyWaitExit(instance, timeoutMs = 3e3) {
  const t0 = Date.now();
  while (!instance.exited && Date.now() - t0 < timeoutMs) await sleep(20);
  return instance.exited;
}
function ptySignal(instance, signal) {
  if (instance.exited) return;
  if (process.platform === "win32") return ptyKill(instance);
  try {
    instance.process.kill(signal);
  } catch {
  }
}
function ptyResize(instance, cols, rows) {
  instance.process.resize(cols, rows);
  instance.terminal.resize(cols, rows);
  instance.cols = cols;
  instance.rows = rows;
}
function killTree(pid) {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch {
  }
}
function ptyKill(instance) {
  if (instance.exited) return;
  instance.killed = true;
  try {
    instance.process.kill();
  } catch {
  }
  const t = setTimeout(() => {
    if (!instance.exited) killTree(instance.process.pid);
  }, 1500);
  t.unref?.();
}
function ptyGet(id) {
  return instances.get(id);
}
function ptyGetAny(id) {
  return instances.get(id) ?? finished.get(id);
}
function ptyFinished() {
  return [...finished.values()];
}
function ptyList() {
  return [...instances.values()];
}
function ptyDefault() {
  return defaultInstance ?? instances.values().next().value;
}
function ptySetDefault(instance) {
  defaultInstance = instance;
}
function ptyCleanup() {
  for (const [, inst] of instances) {
    if (!inst.exited) {
      try {
        inst.process.kill();
      } catch {
      }
    }
  }
  instances.clear();
  finished.clear();
}
function encodeMouseEvent(msg) {
  const { event, button = 0, x = 0, y = 0, dx, dy } = msg;
  let cb = 0;
  switch (event) {
    case "click":
      cb = button;
      return `\x1B[<${cb};${x};${y}M`;
    case "release":
      cb = button;
      return `\x1B[<${cb};${x};${y}m`;
    case "scroll":
    case "wheel":
      if (dy !== void 0) {
        cb = dy < 0 ? 64 : 65;
      } else if (dx !== void 0) {
        cb = dx < 0 ? 66 : 67;
      } else {
        cb = 64;
      }
      return `\x1B[<${cb};${x};${y}M`;
    case "drag":
      cb = (button ?? 0) + 32;
      return `\x1B[<${cb};${x};${y}M`;
    case "move":
      cb = 32;
      return `\x1B[<${cb};${x};${y}M`;
    default:
      return null;
  }
}
function encodeTouchEvent(msg) {
  const { event, x = 0, y = 0, dx, dy, scale } = msg;
  switch (event) {
    case "tap":
      return `\x1B[<0;${x};${y}M\x1B[<0;${x};${y}m`;
    case "doubletap":
      return `\x1B[<0;${x};${y}M\x1B[<0;${x};${y}m\x1B[<0;${x};${y}M\x1B[<0;${x};${y}m`;
    case "longpress":
      return `\x1B[<2;${x};${y}M\x1B[<2;${x};${y}m`;
    case "swipe":
      if (dx !== void 0 && Math.abs(dx) > Math.abs(dy ?? 0)) {
        const scrollButton = dx > 0 ? 67 : 66;
        return `\x1B[<${scrollButton};${x};${y}M`;
      } else if (dy !== void 0) {
        const scrollButton = dy > 0 ? 65 : 64;
        return `\x1B[<${scrollButton};${x};${y}M`;
      }
      return null;
    case "pinch":
      if (scale !== void 0) {
        const scrollButton = scale > 1 ? 64 : 65;
        const cb = scrollButton + 16;
        return `\x1B[<${cb};${x};${y}M`;
      }
      return null;
    default:
      return null;
  }
}
const MAX_BODY_BYTES = 16 * 1024 * 1024;
function isLoopbackHost(host) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\./.test(h);
}
function tokenMatches(provided, expected) {
  if (!provided) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
function truthy(v) {
  return v === "true" || v === "1" || v === "yes";
}
function hostnameOf(hostHeader) {
  const m = /^\[([^\]]+)\](?::\d+)?$/.exec(hostHeader);
  if (m) return m[1];
  return hostHeader.replace(/:\d+$/, "");
}
function createPtyServer(opts) {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port;
  const token = opts.token ? opts.token : void 0;
  const log = opts.log ?? ((m) => console.log(m));
  const loopbackBound = isLoopbackHost(host);
  const guard = (req, url, isHealth) => {
    if (token) {
      if (isHealth) return null;
      const auth = req.headers["authorization"];
      const provided = (typeof auth === "string" && /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, "") : void 0) ?? (typeof req.headers["x-pty-token"] === "string" ? req.headers["x-pty-token"] : void 0) ?? url.searchParams.get("token") ?? void 0;
      if (!tokenMatches(provided, token)) return { status: 401, error: "unauthorized: missing or invalid token" };
      return null;
    }
    const origin = req.headers["origin"];
    if (typeof origin === "string" && origin !== "null") {
      let originHost = "";
      try {
        originHost = new URL(origin).host;
      } catch {
      }
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
  const findApp = (id, includeFinished = false) => {
    let app = instances.get(id);
    if (app) return app;
    for (const [fullId, inst] of instances) if (fullId.startsWith(id)) return inst;
    if (!includeFinished) return void 0;
    app = finished.get(id);
    if (app) return app;
    for (const [fullId, inst] of finished) if (fullId.startsWith(id)) return inst;
    return void 0;
  };
  const send = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
  const appSummary = (inst) => ({
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
    /** "running" | "exited" | "killed" (killed = ended by /kill; on Windows its exitCode is the Ctrl-C status -1073741510) */
    exitStatus: !inst.exited ? "running" : inst.killed ? "killed" : "exited",
    killed: inst.killed,
    outputBytes: inst.outputBytes,
    /** stream offset: pass to wait?after=N to only look at output produced after now */
    offset: inst.outputBytes,
    lastOutputAt: inst.lastOutputAt
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    const isHealth = req.method === "GET" && pathname === "/health";
    if (token) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Pty-Token");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
      }
    }
    const refused = guard(req, url, isHealth);
    if (refused) return send(res, refused.status, { error: refused.error });
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    const parseJson = async () => {
      let body;
      try {
        body = await readBody(req);
      } catch {
        send(res, 413, { error: "body too large" });
        return null;
      }
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
      if (req.method === "GET" && pathname === "/apps") {
        const all = truthy(url.searchParams.get("all"));
        const apps = [...ptyList(), ...all ? ptyFinished() : []].map(appSummary);
        return send(res, 200, { apps });
      }
      if (req.method === "POST" && pathname === "/start") {
        const parsed = await parseJson();
        if (!parsed) return;
        const { command: cmd, args = [], cols: c, rows: r, cwd: wd, term: t, env } = parsed;
        if (!cmd || typeof cmd !== "string") return send(res, 400, { error: "command is required" });
        if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) return send(res, 400, { error: "args must be an array of strings" });
        if (wd !== void 0 && typeof wd !== "string") return send(res, 400, { error: "cwd must be a string" });
        if (env !== void 0 && (env === null || typeof env !== "object" || Array.isArray(env) || Object.values(env).some((v) => v !== null && typeof v !== "string"))) {
          return send(res, 400, { error: "env must be an object of string values (null unsets a variable)" });
        }
        const dim = (v, def) => typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(Math.floor(v), 1), MAX_DIMENSION) : def;
        try {
          const inst = ptySpawn({
            command: cmd,
            args,
            cols: dim(c, DEFAULT_COLS),
            rows: dim(r, DEFAULT_ROWS),
            cwd: wd ?? process.cwd(),
            term: typeof t === "string" ? t : "xterm-256color",
            env
          });
          log(`Started: ${cmd} (id: ${inst.id.slice(0, 8)}, pid: ${inst.process.pid})`);
          return send(res, 200, { id: inst.id, pid: inst.process.pid, cols: inst.cols, rows: inst.rows, cwd: inst.cwd });
        } catch (err) {
          return send(res, 400, { error: err.message });
        }
      }
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
        await ptyWaitExit(app, 3e3);
        return send(res, 200, { ok: true, exited: app.exited, exitCode: app.exitCode, killed: app.killed });
      }
      if (isHealth) {
        return send(res, 200, { status: "ok", apps: instances.size, version: VERSION, auth: !!token });
      }
      const appMatch = pathname.match(/^\/app\/([^/]+)(\/.*)?$/);
      if (appMatch) {
        const appId = decodeURIComponent(appMatch[1]);
        const subPath = appMatch[2] || "/";
        const app = findApp(appId, true);
        if (!app) return send(res, 404, { error: "app not found" });
        if (req.method === "GET" && subPath === "/snapshot") {
          const color = truthy(url.searchParams.get("color"));
          const full = truthy(url.searchParams.get("full"));
          const expectText = url.searchParams.get("expect");
          if (expectText !== null && !ptyScreenText(app, "visible", true).includes(expectText)) {
            return send(res, 412, { error: `screen does not contain expected text ${JSON.stringify(expectText)}`, visibleText: ptyScreenText(app, "visible", true) });
          }
          const snap = ptySnapshot(app, 20, !color);
          const tailQ = url.searchParams.get("tail");
          const grepQ = url.searchParams.get("grep");
          const filtered = tailQ !== null || grepQ !== null;
          let filteredLines = [];
          if (filtered) {
            const tailN = tailQ === null ? void 0 : Number(tailQ);
            if (tailN !== void 0 && (!Number.isInteger(tailN) || tailN < 0)) return send(res, 400, { error: "tail must be a non-negative integer" });
            try {
              filteredLines = ptyFilterLines(full ? snap.fullLines : snap.visibleLines, { grep: grepQ ?? void 0, ignoreCase: truthy(url.searchParams.get("ignoreCase")), tail: tailN });
            } catch {
              return send(res, 400, { error: "invalid grep regex" });
            }
          }
          if (url.searchParams.get("format") === "text") {
            const text = (filtered ? filteredLines.join("\n") : full ? snap.fullText : snap.visibleText).replace(/(\r?\n)+$/, "");
            res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
            return res.end(text === "" ? "" : text + "\n");
          }
          return send(res, 200, {
            ...filtered ? { lines: filteredLines, text: filteredLines.join("\n") } : {},
            offset: app.outputBytes,
            killed: app.killed,
            visibleText: snap.visibleText,
            visibleLines: snap.visibleLines,
            ...full ? { fullText: snap.fullText, scrollbackLineCount: snap.scrollbackLines.length } : {},
            cols: app.cols,
            rows: app.rows,
            pid: app.process.pid,
            cursor: { x: snap.cursorX, y: snap.cursorY },
            running: !app.exited,
            exited: app.exited,
            exitCode: app.exitCode,
            signal: app.signal,
            outputBytes: app.outputBytes,
            idleMs: Date.now() - app.lastOutputAt
          });
        }
        if (req.method === "GET" && subPath === "/status") {
          return send(res, 200, appSummary(app));
        }
        if (req.method === "GET" && subPath === "/wait") {
          const q = url.searchParams;
          const numQ = (k) => {
            const v = q.get(k);
            if (v === null || v === "") return void 0;
            const n = Number(v);
            return Number.isFinite(n) ? n : NaN;
          };
          const idleMs = numQ("idle");
          const timeoutMs = numQ("timeout");
          const afterN = numQ("after");
          const minNew = numQ("minNewBytes");
          if ([idleMs, timeoutMs, afterN, minNew].some((v) => v !== void 0 && Number.isNaN(v))) {
            return send(res, 400, { error: "idle, timeout, after and minNewBytes must be numbers" });
          }
          const scope = q.get("scope") === "full" ? "full" : "visible";
          let regex;
          if (q.get("regex")) {
            try {
              regex = new RegExp(q.get("regex"));
            } catch {
              return send(res, 400, { error: "invalid regex" });
            }
          }
          let cancelled = false;
          res.on("close", () => {
            cancelled = true;
          });
          const result = await ptyWait(app, {
            text: q.get("text") ?? void 0,
            regex,
            gone: q.get("gone") ?? void 0,
            idleMs,
            timeoutMs,
            scope,
            after: afterN,
            newOnly: truthy(q.get("new")),
            minNewBytes: minNew,
            isCancelled: () => cancelled
          });
          if (cancelled) return;
          const wantScreen = q.get("screen") !== "false";
          return send(res, 200, {
            ...result,
            ...wantScreen ? { visibleText: ptyScreenText(app, scope, !truthy(q.get("color"))) } : {}
          });
        }
        if (req.method === "POST" && subPath === "/send") {
          const parsedSend = await parseJson();
          if (!parsedSend) return;
          const { text, paste, keys, bracketed, delayMs, newlineAs, require: requireText } = parsedSend;
          if (!text && !paste && !(Array.isArray(keys) && keys.length)) {
            return send(res, 400, { error: "text is required (or paste / keys)" });
          }
          if (text !== void 0 && typeof text !== "string" || paste !== void 0 && typeof paste !== "string" || keys !== void 0 && (!Array.isArray(keys) || keys.some((k) => typeof k !== "string"))) {
            return send(res, 400, { error: "text and paste must be strings, keys an array of strings" });
          }
          if (newlineAs !== void 0 && typeof newlineAs !== "string" || requireText !== void 0 && typeof requireText !== "string") {
            return send(res, 400, { error: "newlineAs and require must be strings" });
          }
          if (app.exited) return send(res, 409, { error: "app has exited", exitCode: app.exitCode });
          const offsetBefore = app.outputBytes;
          try {
            await ptyInput(app, {
              text,
              paste,
              keys,
              newlineAs,
              require: requireText,
              bracketed: typeof bracketed === "boolean" ? bracketed : void 0,
              delayMs: typeof delayMs === "number" ? delayMs : void 0
            });
          } catch (err) {
            if (err instanceof PtyPreconditionError) return send(res, 412, { error: err.message });
            return send(res, /unknown key/.test(err.message) ? 400 : 409, { error: err.message });
          }
          return send(res, 200, { ok: true, offset: offsetBefore });
        }
        if (req.method === "POST" && subPath === "/kill") {
          if (app.exited) return send(res, 404, { error: "app already exited", exited: true, exitCode: app.exitCode });
          log(`Killed: ${app.name} (id: ${app.id.slice(0, 8)})`);
          ptyKill(app);
          await ptyWaitExit(app, 3e3);
          return send(res, 200, { ok: true, exited: app.exited, exitCode: app.exitCode, killed: app.killed });
        }
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
  const wss = new WebSocketServer({
    server,
    verifyClient: (info, cb) => {
      const wsUrl = new URL(info.req.url ?? "/", "http://localhost");
      const refused = guard(info.req, wsUrl, false);
      if (refused) cb(false, refused.status, refused.error);
      else cb(true);
    }
  });
  wss.on("connection", (ws, req) => {
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
    ws.send(JSON.stringify({
      type: "mode",
      applicationCursorKeys: app.applicationCursorKeys
    }));
    let initialized = false;
    let pending = [];
    const initTimeout = setTimeout(() => {
      if (!initialized) {
        initialized = true;
        for (const chunk of pending) {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "output", text: chunk }));
        }
        pending = [];
      }
    }, 5e3);
    const outputHandler = (data) => {
      if (initialized) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "output", text: data }));
      } else if (pending.length < MAX_PENDING_OUTPUT) {
        pending.push(data);
      }
    };
    const onData = app.process.onData(outputHandler);
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "input" && msg.text) {
          ptySend(app, msg.text);
        } else if (msg.type === "resize" && msg.cols && msg.rows) {
          ptyResize(app, msg.cols, msg.rows);
          const snap = ptySnapshot(app, msg.rows, false);
          ws.send(JSON.stringify({ type: "output", text: snap.visibleText }));
          for (const chunk of pending) {
            ws.send(JSON.stringify({ type: "output", text: chunk }));
          }
          pending = [];
          initialized = true;
        } else if (msg.type === "mouse") {
          const mouseSeq = encodeMouseEvent(msg);
          if (mouseSeq) ptySend(app, mouseSeq);
        } else if (msg.type === "touch") {
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
      onData.dispose();
      log(`Client disconnected from ${app.name} (${app.clients.size} remaining)`);
    });
  });
  return {
    server,
    wss,
    listen: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    }),
    close: () => new Promise((resolve) => {
      for (const c of wss.clients) {
        try {
          c.terminate();
        } catch {
        }
      }
      wss.close();
      server.close(() => resolve());
      server.closeAllConnections?.();
    })
  };
}
process.on("exit", ptyCleanup);
process.on("SIGINT", () => {
  ptyCleanup();
  process.exit(1);
});
process.on("SIGTERM", () => {
  ptyCleanup();
  process.exit(1);
});
const PTY_FLAGS = /* @__PURE__ */ new Set([
  "--cols",
  "--rows",
  "--cwd",
  "--term",
  "--wait",
  "--color",
  "--interactive",
  "--snapshot",
  "--serve",
  "--connect",
  "--port",
  "--host",
  "--start",
  "--list",
  "--kill",
  "--help",
  "-h",
  "--env",
  "--token",
  "--json",
  "--all",
  "--screen",
  "--status",
  "--send",
  "--wait-for",
  "--text",
  "--paste",
  "--paste-file",
  "--keys",
  "--delay",
  "--regex",
  "--gone",
  "--idle",
  "--timeout",
  "--scope",
  "--full",
  "--newline-as",
  "--after",
  "--min-new-bytes",
  "--expect",
  "--require",
  "--tail",
  "--grep",
  "--new-only",
  "--ignore-case"
]);
const LEGACY_FLAGS = /* @__PURE__ */ new Set([
  "--cols",
  "--rows",
  "--cwd",
  "--term",
  "--wait",
  "--color",
  "--interactive",
  "--snapshot",
  "--serve",
  "--connect",
  "--port",
  "--host",
  "--start",
  "--list",
  "--kill",
  "--help",
  "-h"
]);
const VALUE_FLAGS = /* @__PURE__ */ new Set([
  "--cols",
  "--rows",
  "--cwd",
  "--term",
  "--wait",
  "--port",
  "--host",
  "--start",
  "--kill",
  "--env",
  "--token",
  "--screen",
  "--status",
  "--send",
  "--wait-for",
  "--text",
  "--paste",
  "--paste-file",
  "--keys",
  "--delay",
  "--regex",
  "--gone",
  "--idle",
  "--timeout",
  "--scope",
  "--newline-as",
  "--after",
  "--min-new-bytes",
  "--expect",
  "--require",
  "--tail",
  "--grep"
]);
function splitCliArgs(args) {
  const startIdx = args.indexOf("--start");
  if (startIdx !== -1) {
    const ptyOpts = [];
    const startArgs = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (i < startIdx) {
        if (a === "--") continue;
        ptyOpts.push(a);
        if (VALUE_FLAGS.has(a) && i + 1 < args.length) ptyOpts.push(args[++i]);
      } else if (i === startIdx) {
        ptyOpts.push("--start");
        if (i + 1 < args.length) ptyOpts.push(args[++i]);
        for (i = i + 1; i < args.length; i++) {
          const t = args[i];
          if (t === "--") {
            startArgs.push(...args.slice(i + 1));
            i = args.length;
            break;
          }
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
    const ptyOpts = [];
    for (let i = explicitSplit + 1; i < args.length; i++) {
      const arg = args[i];
      if (PTY_FLAGS.has(arg)) {
        ptyOpts.push(arg);
        if (VALUE_FLAGS.has(arg) && i + 1 < args.length) ptyOpts.push(args[++i]);
      } else {
        cmdArgs.push(arg);
      }
    }
    return { cmdArgs, ptyOpts, startArgs: [] };
  }
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
                             --tail <n>  last n non-blank lines;  --grep <re> [--ignore-case]  only matching lines
                             --expect <text>  exit 3 (prints nothing) unless the screen contains <text>
  --send <id>                Send input: --text "raw" | --paste "multi\\nline" | --paste-file f | --keys Enter,Escape,C-c,Up
                             (--delay <ms> between parts, default 30)
                             --newline-as M-Enter|S-Enter|C-j|lf|literal  type a multi-line --paste line by line with that
                               key between lines (robust for prompt boxes; default: CR-joined / bracketed paste)
                             --require <text>  refuse (exit 3, nothing sent) unless the screen contains <text>
  --wait-for <id>            Block until --text "s" | --regex "re" | --gone "s" | --idle <ms> or --timeout <ms>
                             (default 30000). Exit code 0 = matched, 2 = timeout/exited. Prints the screen.
                             --new-only | --after <offset>  only count output produced after now / after that stream
                               offset (printed by --send, --wait-for, --status as offset=N); --min-new-bytes <n> for --idle
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
function parseEnvPairs(pairs) {
  const out = {};
  for (const p of pairs) {
    const i = p.indexOf("=");
    if (i < 1) throw new Error(`--env expects KEY=VALUE, got "${p}"`);
    out[p.slice(0, i)] = p.slice(i + 1);
  }
  return out;
}
const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  let self;
  try {
    self = realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
  for (const candidate of [argv1, argv1 + ".js"]) {
    try {
      if (realpathSync(candidate) === self) return true;
    } catch {
    }
  }
  return false;
})();
if (isMain) {
  (async () => {
    const args = process.argv.slice(2);
    if (args[0] === "--" && args.length > 1) args.shift();
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
    let cols;
    let rows;
    let cwd = process.cwd();
    let term = "xterm-256color";
    let waitMs = 1e3;
    let color = false;
    let interactive = false;
    let snapshot = false;
    let serve = false;
    let connect = false;
    let host = process.env.PTY_HOST || "127.0.0.1";
    let start;
    let list = false;
    let kill;
    let json = false;
    let all = false;
    let full = false;
    let token = process.env.PTY_TOKEN || void 0;
    const envPairs = [];
    let screenId, statusId, sendId, waitForId;
    let sendText, sendPaste, sendKeys, sendDelay;
    let waitRegex, waitGone, waitIdle, waitTimeout;
    let scope;
    let newlineAs, after, minNewBytes;
    let expectText, requireText, tailN, grepRe;
    let newOnly = false, ignoreCase = false;
    const parseBoundedInt = (val, min, max, def) => {
      const parsed = parseInt(val, 10);
      if (Number.isNaN(parsed)) return def;
      return Math.min(Math.max(parsed, min), max);
    };
    let port = parseBoundedInt(process.env.PTY_PORT ?? "", 1, 65535, 3e3);
    const showHelp = ptyOpts.includes("--help") || ptyOpts.includes("-h");
    for (let i = 0; i < ptyOpts.length; i++) {
      switch (ptyOpts[i]) {
        case "--cols":
          cols = parseBoundedInt(ptyOpts[++i], 1, MAX_DIMENSION, DEFAULT_COLS);
          break;
        case "--rows":
          rows = parseBoundedInt(ptyOpts[++i], 1, MAX_DIMENSION, DEFAULT_ROWS);
          break;
        case "--cwd":
          cwd = ptyOpts[++i];
          break;
        case "--term":
          term = ptyOpts[++i];
          break;
        case "--wait":
          waitMs = parseBoundedInt(ptyOpts[++i], 0, 6e4, 1e3);
          break;
        case "--color":
          color = true;
          break;
        case "--interactive":
          interactive = true;
          break;
        case "--snapshot":
          snapshot = true;
          break;
        case "--serve":
          serve = true;
          break;
        case "--connect":
          connect = true;
          break;
        case "--port":
          port = parseBoundedInt(ptyOpts[++i], 1, 65535, 3e3);
          break;
        case "--host":
          host = ptyOpts[++i];
          break;
        case "--start":
          start = ptyOpts[++i];
          break;
        case "--list":
          list = true;
          break;
        case "--kill":
          kill = ptyOpts[++i];
          break;
        case "--env":
          envPairs.push(ptyOpts[++i] ?? "");
          break;
        case "--token":
          token = ptyOpts[++i];
          break;
        case "--json":
          json = true;
          break;
        case "--all":
          all = true;
          break;
        case "--full":
          full = true;
          break;
        case "--screen":
          screenId = ptyOpts[++i];
          break;
        case "--status":
          statusId = ptyOpts[++i];
          break;
        case "--send":
          sendId = ptyOpts[++i];
          break;
        case "--wait-for":
          waitForId = ptyOpts[++i];
          break;
        case "--text":
          sendText = ptyOpts[++i];
          break;
        case "--paste":
          sendPaste = ptyOpts[++i];
          break;
        case "--paste-file": {
          const f = ptyOpts[++i];
          try {
            sendPaste = (await import("node:fs")).readFileSync(f, "utf8");
          } catch (e) {
            console.error(`Cannot read --paste-file ${f}: ${e.message}`);
            process.exit(1);
          }
          break;
        }
        case "--keys":
          sendKeys = (ptyOpts[++i] ?? "").split(",").map((k) => k.trim()).filter(Boolean);
          break;
        case "--delay":
          sendDelay = parseBoundedInt(ptyOpts[++i], 0, 5e3, 30);
          break;
        case "--regex":
          waitRegex = ptyOpts[++i];
          break;
        case "--gone":
          waitGone = ptyOpts[++i];
          break;
        case "--idle":
          waitIdle = parseBoundedInt(ptyOpts[++i], 0, 6e5, 500);
          break;
        case "--timeout":
          waitTimeout = parseBoundedInt(ptyOpts[++i], 0, 6e5, 3e4);
          break;
        case "--scope":
          scope = ptyOpts[++i];
          break;
        case "--newline-as":
          newlineAs = ptyOpts[++i];
          break;
        case "--after":
          after = parseBoundedInt(ptyOpts[++i], 0, Number.MAX_SAFE_INTEGER, 0);
          break;
        case "--min-new-bytes":
          minNewBytes = parseBoundedInt(ptyOpts[++i], 0, Number.MAX_SAFE_INTEGER, 0);
          break;
        case "--expect":
          expectText = ptyOpts[++i];
          break;
        case "--require":
          requireText = ptyOpts[++i];
          break;
        case "--tail":
          tailN = parseBoundedInt(ptyOpts[++i], 0, 1e6, 50);
          break;
        case "--grep":
          grepRe = ptyOpts[++i];
          break;
        case "--new-only":
          newOnly = true;
          break;
        case "--ignore-case":
          ignoreCase = true;
          break;
      }
    }
    if (showHelp) {
      console.log(HELP_TEXT);
      process.exit(0);
    }
    let env;
    try {
      env = parseEnvPairs(envPairs);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
    const resolvedCols = cols ?? (process.stdout.isTTY ? process.stdout.columns : void 0) ?? DEFAULT_COLS;
    const resolvedRows = rows ?? (process.stdout.isTTY ? process.stdout.rows : void 0) ?? DEFAULT_ROWS;
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
      interactive = true;
    }
    const isClient = start || list || kill || connect || screenId || statusId || sendId || waitForId;
    if (isClient) {
      const baseUrl = `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const fail = (msg, code = 1) => {
        console.error(msg);
        process.exit(code);
      };
      const call = async (method, path, body) => {
        let res;
        try {
          res = await fetch(`${baseUrl}${path}`, {
            method,
            headers: body ? { ...headers, "Content-Type": "application/json" } : headers,
            body: body ? JSON.stringify(body) : void 0
          });
        } catch (err) {
          return fail(`Cannot reach a PTY server at ${baseUrl} (${err.cause?.code ?? err.message}).
Start one with:  pty --serve --port ${port}   (or pass --port/--host; PTY_PORT/PTY_HOST are honoured)`);
        }
        const text = await res.text();
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { error: text.slice(0, 200) };
        }
        if (res.status === 401) fail("Unauthorized: pass --token <secret> (or set PTY_TOKEN) matching the server's token");
        return { status: res.status, body: parsed };
      };
      const out = (v) => console.log(JSON.stringify(v, null, 2));
      if (list) {
        const { body } = await call("GET", `/apps${all ? "?all=true" : ""}`);
        if (json) return out(body);
        if (!body.apps?.length) return console.log("No running applications.");
        console.log(all ? "Applications:" : "Running applications:");
        for (const app of body.apps) {
          const age = Math.round((Date.now() - app.createdAt) / 1e3);
          const state = app.exited ? `  exited(${app.exitCode})` : "";
          console.log(`  ${app.id.slice(0, 8)}  ${String(app.name).padEnd(20)}  pid:${app.pid}  ${app.cols}x${app.rows}  ${age}s${state}`);
        }
        return;
      }
      if (start) {
        const { status, body } = await call("POST", "/start", {
          command: start,
          args: startArgs,
          cols,
          rows,
          cwd,
          term,
          ...Object.keys(env).length ? { env } : {}
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
        console.log(`Killed app: ${kill}${body.exitCode !== null && body.exitCode !== void 0 ? ` (killed: ${body.killed === true}, raw exit code ${body.exitCode})` : ""}`);
        return;
      }
      if (statusId) {
        const { status, body } = await call("GET", `/app/${encodeURIComponent(statusId)}/status`);
        if (status !== 200) fail(`Error: ${body.error}`);
        return out(body);
      }
      if (screenId) {
        let q = `color=${color}&full=${full}&format=${json ? "json" : "text"}`;
        if (expectText !== void 0) q += `&expect=${encodeURIComponent(expectText)}`;
        if (tailN !== void 0) q += `&tail=${tailN}`;
        if (grepRe !== void 0) q += `&grep=${encodeURIComponent(grepRe)}`;
        if (ignoreCase) q += "&ignoreCase=true";
        if (json) {
          const { status, body } = await call("GET", `/app/${encodeURIComponent(screenId)}/snapshot?${q}`);
          if (status !== 200) fail(`Error: ${body.error}`, status === 412 ? 3 : 1);
          return out(body);
        }
        const res = await fetch(`${baseUrl}/app/${encodeURIComponent(screenId)}/snapshot?${q}`, { headers }).catch((e) => fail(`Cannot reach a PTY server at ${baseUrl}: ${e.message}`));
        if (res.status !== 200) fail(`Error: ${(await res.json().catch(() => ({ error: res.statusText }))).error}`, res.status === 412 ? 3 : 1);
        process.stdout.write(await res.text());
        return;
      }
      if (sendId) {
        if (sendText === void 0 && sendPaste === void 0 && !sendKeys?.length) fail("--send needs --text, --paste, --paste-file or --keys");
        const { status, body } = await call("POST", `/app/${encodeURIComponent(sendId)}/send`, {
          text: sendText,
          paste: sendPaste,
          keys: sendKeys,
          delayMs: sendDelay,
          newlineAs,
          require: requireText
        });
        if (status !== 200) fail(`Error: ${body.error}`, status === 412 ? 3 : 1);
        if (json) out(body);
        else {
          console.log("Sent.");
          console.error(`offset=${body.offset}`);
        }
        return;
      }
      if (waitForId) {
        const p = new URLSearchParams();
        if (sendText !== void 0) p.set("text", sendText);
        if (waitRegex !== void 0) p.set("regex", waitRegex);
        if (waitGone !== void 0) p.set("gone", waitGone);
        if (waitIdle !== void 0) p.set("idle", String(waitIdle));
        if (waitTimeout !== void 0) p.set("timeout", String(waitTimeout));
        if (scope) p.set("scope", scope);
        if (color) p.set("color", "true");
        if (after !== void 0) p.set("after", String(after));
        if (newOnly) p.set("new", "true");
        if (minNewBytes !== void 0) p.set("minNewBytes", String(minNewBytes));
        const { status, body } = await call("GET", `/app/${encodeURIComponent(waitForId)}/wait?${p}`);
        if (status !== 200) fail(`Error: ${body.error}`);
        if (json) out(body);
        else {
          console.error(`wait: ${body.matched ? "matched" : "NOT matched"} (${body.reason}) after ${body.elapsedMs}ms${body.exited ? `, app exited with code ${body.exitCode}` : ""}, offset=${body.offset}`);
          console.log(String(body.visibleText ?? "").replace(/(\r?\n)+$/, ""));
        }
        process.exit(body.matched ? 0 : 2);
      }
      if (connect) {
        let appId = command;
        if (!appId) {
          const { body } = await call("GET", "/apps");
          if (!body.apps?.length) fail("No running applications. Use --start to spawn one.");
          appId = body.apps[0].id;
          console.error(`Connecting to app: ${appId.slice(0, 8)}`);
        }
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        process.stdin.resume();
        const ws = new WebSocket(`ws://${host}:${port}/app/${appId}${token ? `?token=${encodeURIComponent(token)}` : ""}`);
        let applicationCursorKeys = false;
        const translateArrowKeys = (text) => {
          if (applicationCursorKeys) {
            return text.replace(/\x1b\[A/g, "\x1BOA").replace(/\x1b\[B/g, "\x1BOB").replace(/\x1b\[C/g, "\x1BOC").replace(/\x1b\[D/g, "\x1BOD");
          }
          return text;
        };
        process.stdin.on("data", (data) => {
          const key = data.toString();
          if (key === "") {
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
            ws.close();
            process.exit(0);
            return;
          }
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "input", text: translateArrowKeys(key) }));
          }
        });
        ws.on("open", () => {
          const cc = cols ?? (process.stdout.isTTY ? process.stdout.columns : void 0);
          const rr = rows ?? (process.stdout.isTTY ? process.stdout.rows : void 0);
          if (cc && rr) {
            ws.send(JSON.stringify({ type: "resize", cols: cc, rows: rr }));
          }
          process.stderr.write(`Connected to app ${appId.slice(0, 8)} at ws://${host}:${port}
`);
          process.stderr.write(`Mode: remote interactive (Ctrl+C to disconnect)

`);
        });
        ws.on("message", (data) => {
          let msg;
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
            process.stderr.write(`

Remote process exited with code ${msg.exitCode}
`);
            process.exit(0);
          } else if (msg.type === "mode") {
            applicationCursorKeys = msg.applicationCursorKeys ?? false;
          } else if (msg.type === "ready") ;
          else if (msg.type === "error" && msg.message) {
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
            process.stderr.write(`Error: ${msg.message}
`);
            process.exit(1);
          }
        });
        ws.on("close", () => {
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          process.stderr.write("\nDisconnected from PTY server\n");
          process.exit(0);
        });
        ws.on("error", (err) => {
          process.stderr.write(`Connection error: ${err.message}
`);
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          process.exit(1);
        });
        if (process.stdout.isTTY) {
          process.stdout.on("resize", () => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: "resize",
                cols: process.stdout.columns,
                rows: process.stdout.rows
              }));
            }
          });
        }
        return;
      }
    }
    if (serve) {
      const svc = createPtyServer({ host, port, token });
      if (command) {
        console.log(`Initial app: ${command} ${cmdRest.join(" ")}`);
      }
      console.log(`PTY service manager ${VERSION} starting on http://${host}:${port}`);
      console.log();
      if (command) {
        try {
          const inst = ptySpawn({ command, args: cmdRest, cols: resolvedCols, rows: resolvedRows, cwd, term, env });
          ptySetDefault(inst);
          console.log(`Started: ${command} (id: ${inst.id.slice(0, 8)}, pid: ${inst.process.pid})`);
        } catch (err) {
          console.error(err.message);
          process.exit(1);
        }
      }
      try {
        await svc.listen();
      } catch (err) {
        console.error(err.code === "EADDRINUSE" ? `Error: port ${port} on ${host} is already in use. Pick another with --port.` : `Error: cannot listen on ${host}:${port}: ${err.message}`);
        ptyCleanup();
        process.exit(1);
      }
      console.log(`PTY service manager listening on http://${host}:${port}`);
      if (!isLoopbackHost(host)) {
        console.warn(`
!!! WARNING: listening on ${host} — this API lets ANY client that can reach it run arbitrary commands`);
        console.warn(`!!! as your user. ${token ? "Requests are protected by the token you set; use a firewall/TLS proxy too." : "NO TOKEN IS SET. Restart with --token <secret> (or PTY_TOKEN) or bind to 127.0.0.1."}
`);
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
      console.log(`
Ctrl+C to stop`);
      const shutdown = () => {
        console.log("\nShutting down...");
        ptyCleanup();
        svc.close().finally(() => process.exit(0));
        setTimeout(() => process.exit(0), 1e3).unref();
      };
      process.removeAllListeners("SIGINT");
      process.removeAllListeners("SIGTERM");
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return;
    }
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
    let instance;
    try {
      instance = ptySpawn({ command, args: cmdRest, cols: resolvedCols, rows: resolvedRows, cwd, term, env });
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    if (interactive) {
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.resume();
      instance.process.onData((data) => process.stdout.write(data));
      process.stdin.on("data", (data) => {
        const key = data.toString();
        if (key === "") {
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          ptyKill(instance);
          process.exit(0);
          return;
        }
        ptySend(instance, key);
      });
      if (process.stdout.isTTY) {
        process.stdout.on("resize", () => {
          try {
            ptyResize(instance, process.stdout.columns || resolvedCols, process.stdout.rows || resolvedRows);
          } catch {
          }
        });
      }
      instance.process.onExit(({ exitCode }) => {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        console.log(`

Process exited with code ${exitCode}`);
        process.exit(exitCode ?? 0);
      });
      return;
    }
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
export {
  PtyPreconditionError,
  createPtyServer,
  isLoopbackHost,
  keyToSequence,
  parseEnvPairs,
  pasteSequence,
  ptyCleanup,
  ptyDefault,
  ptyFilterLines,
  ptyFinished,
  ptyGet,
  ptyGetAny,
  ptyInput,
  ptyKill,
  ptyList,
  ptyOutputSince,
  ptyResize,
  ptyScreenText,
  ptySend,
  ptySetDefault,
  ptySignal,
  ptySnapshot,
  ptySpawn,
  ptyWait,
  ptyWaitExit,
  resolveCommand,
  splitCliArgs
};
