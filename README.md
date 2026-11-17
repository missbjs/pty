# pty — PTY Service Manager

Spawn TUI apps in pseudo-terminals (node-pty), keep a headless xterm screen for each, and drive them from a
CLI, an HTTP API or a WebSocket: start with args/env/cwd, send keys and pastes, wait for text or idle,
take plain-text or colour snapshots, read exit codes, kill the whole process tree. Works on Windows
(ConPTY), macOS and Linux. Typical use: a test harness for interactive terminal programs.

> **Security first.** The HTTP/WebSocket API is *remote command execution by design*. It binds to
> `127.0.0.1` by default and refuses browser cross-origin requests. Do not expose it to a network
> without `--token` (see [Security](#security)).

## Install

```bash
# global command `pty` (Windows, macOS, Linux; Node >= 20)
pnpm i -g https://github.com/missbjs/pty
pty --version
pty --help
```

* node-pty ships **prebuilt binaries for Windows (x64/arm64) and macOS**. pnpm >= 10 prints
  `Ignored build scripts: node-pty` — on those platforms this is harmless, nothing needs building.
  On **Linux** node-pty is compiled from source: run `pnpm approve-builds -g` and select `node-pty`
  (needs `python3`, `make`, `g++`), or install with `npm i -g https://github.com/missbjs/pty`.
* `dist/` is committed, so installing from GitHub does not need a build step.
* If `pty` still resolves to an old shim, check `where pty` (Windows) / `which -a pty`: a stale
  `%APPDATA%\npm\pty.cmd` from an earlier `npm link` shadows pnpm's global bin directory. Delete it.

From a clone (development):

```bash
pnpm install
pnpm dev --serve --port 3000          # = tsx pty.ts --serve --port 3000   (`pnpm dev -- ...` also works)
pnpm build                            # dist/pty.js + dist/pty.d.ts (commit dist/ with your change)
pnpm test                             # builds, then vitest (~1 min)
```

Everything below uses the global command `pty`; replace it with `pnpm dev` inside a clone.

## Quick start

```bash
pty --serve --port 3100 &                         # 1. start the service manager (loopback only)
pty --port 3100 --start node                      # 2. spawn an app (a node REPL here) -> prints its id
#   Started app: 3b1a8fd4 (pid: 12345)
pty --port 3100 --wait-for 3b1a8fd4 --text ">"    # 3. wait until the prompt is on screen
pty --port 3100 --send 3b1a8fd4 --text "6*7" --keys Enter
pty --port 3100 --wait-for 3b1a8fd4 --text "42"   # 4. blocks until "42" shows up (exit code 0) or times out (2)
pty --port 3100 --screen 3b1a8fd4                 # 5. print the screen
pty --port 3100 --kill 3b1a8fd4                   # 6. kill it (whole process tree)
```

`PTY_PORT`, `PTY_HOST` and `PTY_TOKEN` environment variables provide defaults for `--port`, `--host`
and `--token`, so a harness can `set PTY_PORT=3100` once. Ids may be shortened to any unique prefix.

## Security

* Default bind is **127.0.0.1**. `--host 0.0.0.0` (or any non-loopback address) prints a loud warning:
  anyone who can reach the port can run arbitrary commands as you.
* **`--token <secret>`** (or `PTY_TOKEN`) makes every request except `GET /health` require the token:
  `Authorization: Bearer <secret>`, `X-Pty-Token: <secret>`, or `?token=<secret>` (also for WebSockets).
  Wrong/missing token -> `401`. Use it whenever the server is not strictly local, and prefer the env
  var over the flag (flags show up in process listings).
* Without a token, requests that look like a browser attack are refused with `403`: a cross-origin
  `Origin` header (CSRF; no wildcard CORS is sent) and, on loopback binds, a `Host` header that is not
  `localhost` or an IP literal (DNS rebinding). Plain `curl`/`fetch`/scripts are unaffected. With a
  token, CORS is opened (`*`) so browser UIs can talk to it — the token is the protection.
* There is no TLS. Put a TLS-terminating proxy or an SSH tunnel in front for remote use.

## CLI reference

`pty [command [args...]] [-- <options>]`. Options can also precede the command; a bare `--` separates
the command's own args from pty options.

| Flag | Default | Description |
|------|---------|-------------|
| `--serve` | | Start the service manager (HTTP + WebSocket). A leading command (`pty sleep 60 -- --serve`) is spawned as an initial app |
| `--port <n>` | `3000` / `$PTY_PORT` | Server port (for client commands: the server to talk to) |
| `--host <addr>` | `127.0.0.1` / `$PTY_HOST` | Bind address / server address. Non-loopback => warning |
| `--token <s>` | `$PTY_TOKEN` | Require / send the token |
| `--start <cmd> [args...]` | | Spawn an app on the server. Args follow the command up to the next pty flag; a bare `--` forces the rest to be args |
| `--cwd <dir>` | client's cwd | Working directory of the app |
| `--env K=V` | | Environment variable for the app (repeatable). Inherits the server's environment otherwise |
| `--cols <n>` / `--rows <n>` | `400` / `40` | Terminal size |
| `--term <name>` | `xterm-256color` | `TERM` for the app (`COLORTERM=truecolor` is always set) |
| `--list [--all]` | | Running apps (`--all`: also the last 20 exited ones) |
| `--status <id>` | | Status JSON incl. `running`, `exitCode` |
| `--screen <id> [--color] [--full]` | | Print the screen as plain text (`--color`: ANSI colours, `--full`: plus scrollback). `--tail N` = last N non-blank lines, `--grep RE [--ignore-case]` = only matching lines (grep, then tail). `--expect TEXT` = exit **3** and print nothing unless the screen contains TEXT |
| `--send <id> --text T \| --paste P \| --paste-file F \| --keys K1,K2` | | Send input (see [Input](#input)); `--delay <ms>` between parts (default 30). `--newline-as M-Enter\|S-Enter\|C-j\|lf\|literal` types a multi-line paste line by line (see below). `--require TEXT` = exit **3** and send nothing unless the screen contains TEXT. Prints `Sent.` and (stderr) `offset=N` |
| `--wait-for <id> --text T \| --regex R \| --gone T \| --idle <ms>` | | Block until a condition holds. `--timeout <ms>` (default 30000), `--scope full`. Prints the screen; **exit code 0 matched, 2 timeout/exited**. `--new-only` / `--after <offset>`: only output produced after now / after that stream offset counts; `--min-new-bytes N` additionally requires N new chars before `--idle` can fire |
| `--kill <id>` | | Kill the app and its process tree; prints `killed: true` and the raw exit code |
| `--connect [id]` | | Interactive attach over WebSocket (Ctrl+C detaches) |
| `--json` | | Raw JSON output for client commands (`--start --json` prints the full id) |
| `--snapshot [--wait ms] [--color]` | | Direct mode: run a command, print one snapshot, exit |
| `--version`, `--help` | | |

Direct mode without a server: `pty node` (interactive passthrough, Ctrl+C quits),
`pty node -- --snapshot --wait 1500`.

## Driving an app: a harness recipe

```bash
export PTY_PORT=3100                                   # PowerShell: $env:PTY_PORT = "3100"
pty --serve &                                          # one server for the whole run

# start any command with args, env and cwd. Use bash -lc "..." for shell one-liners / wrapper scripts.
ID=$(pty --start bash -lc "exec ./claudes.sh" --cwd C:/work/proj --env ANTHROPIC_BASE_URL=http://127.0.0.1:11380 \
        --cols 400 --rows 40 --json | python -c "import sys,json;print(json.load(sys.stdin)['id'])")

pty --wait-for $ID --idle 1500 --timeout 60000         # let the TUI settle after start-up
pty --send $ID --text "list the files" ; pty --send $ID --keys Enter   # type, then submit
pty --send $ID --keys Escape                           # Escape / C-c / Up / Down / Tab / S-Tab / F5 ...
pty --send $ID --paste "line one
line two"                                              # multi-line paste
pty --wait-for $ID --text "Done" --timeout 120000      # wait for a distinctive string
pty --wait-for $ID --idle 3000 --timeout 120000        # or: until the screen was quiet for 3s
pty --screen $ID                                       # plain text, trailing blank rows trimmed
pty --screen $ID --color                               # with ANSI colours (truecolor/palette/bold/inverse)
pty --screen $ID --full                                # whole buffer incl. scrollback
pty --status $ID                                       # running? exitCode?
pty --kill $ID                                         # tree kill
```

Notes that save debugging time:

* **By default `wait` matches against the screen as it is now**, so text left over from an earlier turn matches
  immediately. To wait for *new* output use offsets: every app has a monotonically increasing stream **offset**
  (characters of PTY output so far) shown by `--status`, printed by `--send` (value *before* the send) and
  `--wait-for` (value at return). `--wait-for ID --text Done --after $OFFSET` (or `--new-only`) only looks at
  output produced after that point (ANSI stripped; the last ~2M chars are kept). Typical turn:
  `OFF=$(pty --send $ID --text hi --keys Enter --json | python -c "import sys,json;print(json.load(sys.stdin)['offset'])")`
  then `pty --wait-for $ID --text "answer" --after $OFF --timeout 60000`, then
  `pty --wait-for $ID --idle 3000 --min-new-bytes 50 --after $OFF` (quiet for 3 s *and* something new was printed).
  A TUI that redraws an old string re-emits it, which counts as new output; pick strings the new turn alone produces.
  Screen lines have trailing spaces trimmed, so wait for `>` rather than `> `.
* **Guards against typing into the wrong terminal**: `--send ID --text "/model" --keys Enter --require "esc to interrupt"`
  sends nothing (exit 3, HTTP 412) unless the current screen contains the text; `--screen ID --expect "..."`
  does the same check for reads.
* **Keep long sessions small**: `--screen ID --full --tail 60` (last 60 non-blank lines of screen+scrollback),
  `--screen ID --full --grep "error|warn" --ignore-case --tail 20`. Filtering is done server-side.
* Send **text and Enter separately** (`--text X` then `--keys Enter`, or one call with both:
  `{"text":"X","keys":["Enter"]}` — they are written `delayMs` apart). Many TUIs treat a chunk like `X\r`
  as a paste, and an ESC byte directly followed by another byte reads as Alt+key, which is why keys are
  never batched.
* **Multi-line text into a prompt box**: plain `--paste` sends CR-separated text wrapped in bracketed-paste
  markers when the app enabled them — **but Windows ConPTY strips the `ESC[200~`/`ESC[201~` markers**, so there
  the app gets the lines CR-joined in one burst (a bare CR may submit). The robust way is to *type* the lines:
  `pty --send $ID --paste "line 1
line 2
line 3" --newline-as M-Enter --delay 40` writes each line as text with `M-Enter` (Alt+Enter, `ESC CR` — a
  newline-without-submit in Claude Code and most line editors) between them, then `--keys Enter` submits.
  `S-Enter` sends CSI-u `ESC[13;2u`, `C-j` a LF, `lf` a raw LF, `literal` the text unchanged. Empty lines are kept.
  Same over HTTP: `{"paste": "a\nb", "newlineAs": "M-Enter"}`.
* Exit codes: a normal exit gives the program's code. An app ended by `--kill` / `/kill` has **`killed: true`**
  and `exitStatus: "killed"` (`"exited"` for a natural exit, `"running"` while alive); its raw `exitCode` is the
  platform's: on Windows `-1073741510` (`0xC000013A`, STATUS_CONTROL_C_EXIT) — expected, not an error — on POSIX
  the signal is in `signal`. Test `killed` / `exitStatus`, not the number. Exited apps stay readable (final
  screen, `exitCode`) for the last 20 apps.
* Ctrl-C (`C-c`) is delivered to the app as byte `0x03`; it only interrupts if the app reads it
  (raw-mode TUIs do; for others use `--kill`).
* Windows has no `htop`/`vim`; use `node`, `python -q`, `powershell -NoLogo`, `cmd`, `bash -lc "..."` (Git Bash).
  `.ps1`/`.sh` files are not executables — run them via `powershell -File x.ps1` / `bash x.sh`.
  Bare command names are resolved through `PATH` (`.exe`, `.com`, `.cmd`, `.bat`).

## HTTP API

All bodies/responses are JSON unless noted. Errors are `{ "error": "..." }` with `400` (bad input),
`401` (token), `403` (browser/DNS-rebinding guard), `404` (unknown app/route), `409` (app has exited),
`413` (body > 16 MB). `:id` may be a unique prefix. With a token every call except `/health` needs it.

### `GET /health`
```json
{ "status": "ok", "apps": 2, "version": "1.2.0", "auth": false }
```

### `POST /start`
```json
{ "command": "bash", "args": ["-lc", "exec ./claudes.sh"], "cwd": "C:/work/proj",
  "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:11380", "UNWANTED": null },
  "cols": 400, "rows": 40, "term": "xterm-256color" }
```
Only `command` is required. `env` is merged over the server's environment (`null` unsets).
`command` is run directly (no shell), found via `PATH`; args are passed verbatim (spaces/quotes are safe).
```json
{ "id": "3b1a8fd4-....", "pid": 12345, "cols": 400, "rows": 40, "cwd": "C:\\work\\proj" }
```
`400` with a clear message for a missing command, bad `cwd`, or malformed `args`/`env`.

### `GET /apps[?all=true]`
```json
{ "apps": [ { "id": "...", "name": "bash", "command": "bash", "args": ["-lc", "..."], "pid": 12345,
  "cols": 400, "rows": 40, "cwd": "...", "createdAt": 1794874000000, "clients": 0,
  "running": true, "exited": false, "exitCode": null, "signal": null, "exitedAt": null,
  "exitStatus": "running", "killed": false,
  "outputBytes": 20413, "offset": 20413, "lastOutputAt": 1794874012345 } ] }
```
`all=true` also lists the last 20 exited apps (`exited: true`, `exitCode`).

### `GET /app/:id/status`
Same object as one entry of `/apps`. Works for exited apps.

### `GET /app/:id/snapshot[?color=true][&full=true][&format=text][&tail=N][&grep=RE][&ignoreCase=true][&expect=TEXT]`
```json
{ "visibleText": "line1\nline2\n...", "visibleLines": ["line1", "line2", "..."],
  "cols": 400, "rows": 40, "pid": 12345, "cursor": { "x": 2, "y": 5 },
  "running": true, "exited": false, "exitCode": null, "signal": null,
  "outputBytes": 20413, "offset": 20413, "killed": false, "idleMs": 120 }
```
`color=true`: lines carry ANSI SGR codes rebuilt from the cell attributes (bold/dim/italic/underline/inverse,
palette and 24-bit colours; blank trailing cells trimmed). `full=true` adds `fullText` (scrollback + screen,
10 000 lines of scrollback kept) and `scrollbackLineCount`. `format=text` returns just the screen as
`text/plain` with trailing blank rows trimmed (`curl .../snapshot?format=text`). `tail`/`grep`/`ignoreCase` filter
(trailing blanks dropped, then lines whose text matches the regex, then the last N); the JSON then also has
`lines` and `text`. `expect=TEXT` answers `412` (`{"error": ..., "visibleText": ...}`) if the visible screen lacks it.
Works for exited apps.

### `GET /app/:id/wait?text=&regex=&gone=&idle=&timeout=&scope=&color=&screen=&after=&new=&minNewBytes=`
Returns when **any** given condition holds: `text` (substring on screen), `regex` (JS RegExp source),
`gone` (substring no longer on screen), `idle` (ms without PTY output; default 500 when no other condition
is given), or when the app exits / `timeout` ms (default 30000, max 600000) elapse. `scope=full` includes
scrollback. `screen=false` omits the screen from the reply; `color=true` makes it ANSI. `after=N` (stream offset) or
`new=true` (= offset at call time) restricts `text`/`regex` to output produced after that point; `minNewBytes=B`
makes `idle` also require B new characters since then.
```json
{ "matched": true, "reason": "text", "elapsedMs": 1840, "exited": false, "exitCode": null,
  "offset": 20413, "visibleText": "..." }
```
`reason` is `text | regex | gone | idle | exit | timeout | cancelled`; `matched` is false for the last three.
A text/regex condition is also checked against the final screen of an exited app. Polls every 50 ms;
dropping the HTTP connection cancels the wait.

### `POST /app/:id/send`
```json
{ "text": "hello", "keys": ["Enter"], "delayMs": 30 }
{ "paste": "line one\nline two", "bracketed": true }
{ "paste": "line one\nline two", "newlineAs": "M-Enter" }
{ "text": "/model", "keys": ["Enter"], "require": "esc to interrupt" }
{ "keys": ["Escape", "C-c", "Up", "S-Tab", "M-Enter", "F5", "PageDown"] }
```
Order: `text`, then `paste`, then each of `keys`, `delayMs` apart (default 30, max 5000). Unknown key names
are a `400` and nothing is sent. `409` if the app has exited. `require` (visible screen must contain it) failing is a
`412` with nothing sent. `newlineAs` types the paste line by line (see above). Response `{ "ok": true, "offset": N }`
where `offset` is the stream offset *before* the send (use it as `after`).

<a id="input"></a>**Key names** (case-insensitive): `Enter`, `Tab`, `Escape`/`Esc`, `Space`, `Backspace`,
`Delete`, `Insert`, `Up` `Down` `Left` `Right` (honour the app's application-cursor-keys mode), `Home`, `End`,
`PageUp`, `PageDown`, `F1`..`F12`, any single character, with modifiers `C-`/`Ctrl-` (control char),
`M-`/`Alt-` (ESC prefix), `S-`/`Shift-` (e.g. `C-c`, `Ctrl+d`, `M-x`, `S-Tab`, `C-Left`). `text` is raw: it
may contain escape sequences and is written exactly as given. `paste` converts `\n`/`\r\n` to CR and adds
`ESC[200~ ... ESC[201~` if the app enabled bracketed paste (`bracketed: false/true` overrides).

### `POST /app/:id/resize`
```json
{ "cols": 120, "rows": 30 }
```
-> `{ "ok": true, "cols": 120, "rows": 30 }` (clamped to 1..10000). `409` if exited.

### `POST /kill` and `POST /app/:id/kill`
Body `{ "id": "3b1a8fd4" }` (the second form has no body). Kills the app and its whole process tree, waits
(up to 3 s) until it is gone: `{ "ok": true, "exited": true, "exitCode": -1073741510, "killed": true }`. Already-exited app: `404`
`{ "error": "app already exited", "exitCode": 0 }`.

## WebSocket `ws://host:port/app/:id[?token=...]`

Client -> server:

```json
{"type": "input", "text": "q"}
{"type": "resize", "cols": 120, "rows": 30}
{"type": "mouse", "event": "click", "button": 0, "x": 10, "y": 5}
{"type": "mouse", "event": "scroll", "x": 10, "y": 5, "dy": -1}
{"type": "touch", "event": "tap", "x": 10, "y": 5}
{"type": "touch", "event": "swipe", "x": 10, "y": 5, "dy": 50}
```

Server -> client: `{"type":"output","text":"..."}`, `{"type":"exit","exitCode":0,"id":"..."}`,
`{"type":"error","message":"..."}`, `{"type":"mode","applicationCursorKeys":true}`.
A client must send `resize` first (output is buffered for up to 5 s until it does; the reply is the current
screen). All clients of one app share the PTY and see the same output; any can type. Mouse uses SGR encoding
(`ESC[<Cb;Cx;CyM`); touch events map to mouse sequences (`tap` = click, `longpress` = right click,
`swipe` = scroll, `pinch` = ctrl+scroll). Wheel buttons follow SGR: 64 up, 65 down, 66 left, 67 right (+16 with Ctrl).

## Windows notes

* Uses ConPTY via node-pty (needs Windows 10 1809+). ConPTY re-encodes keyboard input: `ESC O A` arrives as
  `ESC [ A`, and bracketed-paste markers are consumed (see above).
* `kill` closes the pseudo-console, which terminates the whole tree; if anything survives 1.5 s it is
  escalated to `taskkill /T /F`.
* Signals do not exist: `ptySignal()` degrades to a kill; send Ctrl-C as the `C-c` key.
* `cwd` must exist (a clear error is returned instead of node-pty's "error code 267").
* Quote shell one-liners for the *shell you type in*; inside `pty` the args array is passed verbatim, e.g.
  `pty --start bash -lc "echo 'a b' && read x"` hands bash exactly two args after `-lc`.

## Programmatic API

```typescript
import {
  ptySpawn, ptySnapshot, ptyScreenText, ptyInput, ptyWait, ptyWaitExit, ptyKill,
  ptyList, ptyGetAny, createPtyServer, keyToSequence,
} from "pty";

const app = ptySpawn({ command: "node", args: ["-i"], cwd: process.cwd(), env: { FOO: "1" }, cols: 120, rows: 30 });
await ptyWait(app, { text: ">", timeoutMs: 5000 });
await ptyInput(app, { text: "1+1", keys: ["Enter"] });          // text / paste / named keys
await ptyWait(app, { text: "2" });                              // or { regex }, { gone }, { idleMs }
console.log(ptySnapshot(app).visibleText);                      // ptySnapshot(app, 20, false) = ANSI colours
ptyKill(app);                                                   // tree kill
await ptyWaitExit(app);
console.log(app.exited, app.exitCode, ptyGetAny(app.id)?.exitCode);

const svc = createPtyServer({ port: 3100, token: "secret" });   // the HTTP+WS server as a library
await svc.listen();
```

`ptyGet/ptyList` = running apps only; `ptyGetAny/ptyFinished` also cover the last 20 exited apps.

## Architecture

Each app = one node-pty process + one `@xterm/headless` terminal that parses its output into a screen buffer
(10 000 lines of scrollback). Snapshots read that buffer; the server routes `/app/:id/*` and WebSocket
clients to instances. Apps are isolated; several can run at once. Single source file `pty.ts`, bundled to
`dist/pty.js` by Vite.

## Testing

```bash
pnpm test        # builds dist/ then runs vitest
```

* `pty.harness.test.ts` — harness features (keys, paste, wait, exit status, colour snapshot, tree kill,
  auth/CSRF guards, CLI). Only needs `node`; ports 3160-3169.
* `pty.test.ts` — core API and server/WebSocket scenarios; some use Unix tools (`bash`, `sleep`, `cat`; on
  Windows Git Bash provides them); port 3190. Tests needing `htop`/`vim`/`nano` skip themselves if missing.
* `test-multi-client.js` — standalone multi-client script (needs a running server).

## Comparison

| Feature | pty | ttyd | tmux |
|---------|-----|------|------|
| Multi-app manager | yes | no | yes |
| HTTP API (send / snapshot / wait) | yes | no | no |
| WebSocket | yes | yes | no |
| Structured + colour snapshots | yes | no | no |
| Embeddable library | yes | no | no |
