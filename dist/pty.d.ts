#!/usr/bin/env node
import * as pty from "node-pty";
import { type Server } from "http";
import { WebSocketServer, WebSocket as WsClient } from "ws";
export interface PtyInstance {
    id: string;
    name: string;
    command: string;
    args: string[];
    process: pty.IPty;
    terminal: any;
    cols: number;
    rows: number;
    cwd: string;
    createdAt: number;
    clients: Set<WsClient>;
    applicationCursorKeys: boolean;
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
    baseY: number;
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
/**
 * Resolve a bare command name to a full path (Windows: honours PATH + PATHEXT,
 * so `node`, `python`, `bash` work without an extension). Names that already
 * contain a path separator are returned unchanged; unresolvable names are
 * returned unchanged so node-pty reports the error.
 */
export declare function resolveCommand(cmd: string): string;
/** Spawn a new process in a PTY and return the instance */
export declare function ptySpawn(opts: PtySpawnOptions): PtyInstance;
/** Text of the visible screen (cheap: reads only the viewport) or of the full buffer incl. scrollback. */
export declare function ptyScreenText(instance: PtyInstance, scope?: "visible" | "full", stripAnsiCodes?: boolean): string;
/** Get a snapshot of the full buffer */
export declare function ptySnapshot(instance: PtyInstance, footerRows?: number, stripAnsiCodes?: boolean): BufferSnapshot;
/** Send keystrokes to the PTY */
export declare function ptySend(instance: PtyInstance, text: string): void;
/**
 * Translate a key name to the byte sequence a terminal would send.
 * Names (case-insensitive): Enter, Tab, Escape/Esc, Space, Backspace, Delete, Insert, Up/Down/Left/Right,
 * Home, End, PageUp, PageDown, F1..F12, with optional modifiers `C-`/`Ctrl-`, `M-`/`Alt-`, `S-`/`Shift-`
 * (e.g. `C-c`, `Ctrl+d`, `Alt-x`, `S-Tab`, `C-Left`). A single character is sent literally.
 * Arrow/Home/End honour the app's application-cursor-keys mode (DECCKM).
 * Throws on an unknown name.
 */
export declare function keyToSequence(name: string, applicationCursorKeys?: boolean): string;
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
export declare function pasteSequence(instance: PtyInstance, text: string, bracketed?: boolean): string;
/**
 * Send text / a paste / named keys to the app, in that order, pausing `delayMs` between parts.
 * Validates every key name before sending anything (throws on an unknown key).
 */
export declare function ptyInput(instance: PtyInstance, opts: PtyInputOptions): Promise<void>;
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
export declare function ptyWait(instance: PtyInstance, opts?: PtyWaitOptions): Promise<PtyWaitResult>;
/** Resolve once the instance has exited (or after timeoutMs). Returns true if it exited. */
export declare function ptyWaitExit(instance: PtyInstance, timeoutMs?: number): Promise<boolean>;
/**
 * Send a signal to the PTY process. Windows has no POSIX signals (node-pty throws "Signals not
 * supported on windows" asynchronously), so there ANY signal terminates the app like ptyKill();
 * to send Ctrl-C use ptySend(instance, "") / the "C-c" key instead.
 */
export declare function ptySignal(instance: PtyInstance, signal: string): void;
/** Resize the PTY */
export declare function ptyResize(instance: PtyInstance, cols: number, rows: number): void;
/**
 * Kill the PTY process and its whole process tree. node-pty's own kill() closes the pseudoconsole
 * (which takes the tree down on Windows); if the app is still alive 1.5s later it is escalated to
 * a hard tree kill. No-op if the app already exited.
 */
export declare function ptyKill(instance: PtyInstance): void;
/** Get a running PTY instance by ID */
export declare function ptyGet(id: string): PtyInstance | undefined;
/** Get a running OR recently finished instance (finished ones keep their final screen and exit code) */
export declare function ptyGetAny(id: string): PtyInstance | undefined;
/** Recently finished instances (last 20), oldest first */
export declare function ptyFinished(): PtyInstance[];
/** List all active PTY instances */
export declare function ptyList(): PtyInstance[];
/** Get the first/default instance */
export declare function ptyDefault(): PtyInstance | undefined;
/** Set the default instance */
export declare function ptySetDefault(instance: PtyInstance | null): void;
/** Cleanup all PTY instances */
export declare function ptyCleanup(): void;
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
/** True for 127.0.0.0/8, ::1 and "localhost" */
export declare function isLoopbackHost(host: string): boolean;
/**
 * Create (but do not start) the PTY HTTP+WebSocket service.
 *
 * Security model: the API is remote command execution by design. Without a token it is only safe
 * on loopback, and requests are additionally refused when they look like a browser attack:
 * a cross-origin `Origin` header (CSRF) or a non-IP/non-localhost `Host` header (DNS rebinding).
 * With a token, every route except GET /health requires it and CORS is opened for browser UIs.
 */
export declare function createPtyServer(opts: PtyServerOptions): PtyServer;
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
export declare function splitCliArgs(args: string[]): SplitArgs;
/** Parse "K=V" strings into an env object; throws on a malformed entry */
export declare function parseEnvPairs(pairs: string[]): Record<string, string>;
