---
name: tui-to-api
description: Wrap a TUI CLI tool (e.g. qodercli) as an OpenAI-compatible HTTP API on PRoot/Linux. Covers architecture, PTY interaction, spawnSync vs spawn gotchas, screen parsing, SSE streaming, and test patterns. Use when building, debugging, or extending API wrappers around interactive CLI tools.
---

# TUI → HTTP API Wrapper

Pattern learned from wrapping `qodercli` (an interactive TUI agent) as an OpenAI-compatible REST API using Hono + Node.js on PRoot-Distro.

---

## Architecture

```
Client (OpenAI SDK)
  │  POST /v1/chat/completions
  ▼
Hono API Server (:3000)
  │  spawnSync("qodercli", args, { input: prompt })
  ▼
qodercli subprocess  ←→  LLM provider
  │  stdout: JSONL (stream-json format)
  ▼
Parse JSONL → SSE chunks → Client
```

Two modes:
- **subprocess mode** (`spawnSync`): safe on PRoot, used here
- **PTY serve mode**: persistent PTY process exposed over HTTP (`/snapshot`, `/send`) — for full TUI interaction including screen parsing

---

## PRoot / libuv Crash — The Critical Constraint

**Symptom:** `uv__io_poll: Assertion errno == EINTR failed` — process crashes.

**Cause:** PRoot-Distro's kernel returns unexpected errno from `epoll_wait`. libuv's event loop assertion fails whenever fd watchers are registered (pipes, file watchers, child process exit monitors).

**Rules:**
- ✅ `spawnSync` — creates isolated `uv_loop_t`, never touches main event loop's epoll. **Safe.**
- ❌ `spawn` (async) — registers fd watchers → crashes
- ❌ `tsx watch` — uses inotify (fd watcher) → crashes. Use `tsx` without `--watch`
- ❌ `setInterval` — keeps epoll spinning; crashes on long-running ops (e.g. WebSearch). Use `setImmediate` chaining instead.
- ❌ `child_process.exec` / `execFile` — async, same problem as spawn

**SSE streaming with spawnSync pattern:**
```typescript
export function streamQoderCli(options, onChunk, onError, onEnd): void {
  setImmediate(() => {
    try {
      // spawnSync runs to completion — collect all output first
      const { stdout, stderr, status } = spawnSync("qodercli", args, {
        input: options.prompt,
        encoding: "utf-8",
        timeout: 120000,
        maxBuffer: 50 * 1024 * 1024,
      });

      // Parse JSONL, build chunk array
      const chunks: Array<() => void> = [];
      for (const line of stdout.split("\n")) { /* ... */ }

      // Emit via setImmediate chaining — safe, flushes SSE between each
      const emit = (i: number) => {
        if (i < chunks.length) {
          chunks[i]();
          setImmediate(() => emit(i + 1));
        } else {
          onEnd(result);
        }
      };
      emit(0);
    } catch (err) { onError(err); }
  });
}
```

---

## qodercli stream-json Output Format

Always use `-f stream-json` (not `-f json`) — it includes intermediate `assistant` messages with reasoning tokens.

```
qodercli -p - -q --model <model> -f stream-json -w <workdir>
# stdin: prompt text
```

**JSONL line types:**
| type | content | notes |
|------|---------|-------|
| `system` | metadata | session init |
| `assistant` | `reasoning`, `text`, `function`, `finish` | emitted **twice** — deduplicate with Set |
| `result` | final `text` | use for non-streaming answer |

**Deduplication is required** — qodercli emits each assistant message twice in stream-json:
```typescript
const emittedReasoning = new Set<string>();
const emittedProgress  = new Set<string>();

if (c.type === "reasoning" && c.thinking && !emittedReasoning.has(c.thinking)) {
  emittedReasoning.add(c.thinking);
  // emit
}
if (c.type === "function" && c.finished) {
  const key = c.id ?? label;
  if (!emittedProgress.has(key)) {
    emittedProgress.add(key);
    // emit
  }
}
```

**Reasoning content shape:**
```json
{
  "type": "reasoning",
  "thinking": "The user wants...",
  "signature": "",
  "ReasoningItem": { "id": "...", "encrypted_content": "..." }
}
```
Only `thinking` field matters. Reasoning only appears for complex queries — simple ones skip it.

---

## PTY Screen Interaction (PTY Serve Mode)

For full TUI interaction, run qodercli as a persistent PTY serve:
```bash
tsx ~/pty/pty.ts qodercli -- --model lite -w <workspace> --cols 120 --rows 40 --serve --port 3002
```

### PTY Endpoints
| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Liveness check |
| `GET /status` | Returns `{"pid": N}` — use to kill by PID |
| `POST /send` | Send keystrokes to TUI |
| `GET /snapshot` | Current visible screen (text + ANSI) |
| `GET /snapshot/full` | Full buffer with conversation array |

### Kill by Port (Never by Name)
```bash
# Get PID
curl -s http://127.0.0.1:3002/status   # {"pid": 12345}
kill 12345

# Or via /proc (when lsof unavailable — PRoot)
ls /proc/ | while read pid; do
  exe=$(readlink /proc/$pid/exe 2>/dev/null)
  case "$exe" in */node*) echo "PID=$pid $(cat /proc/$pid/cmdline | tr '\0' ' ' | head -c 80)";; esac
done
```
**Never:** `pkill tsx`, `pkill node`, `killall qodercli` — kills unrelated processes.

### Ctrl+R — Expand Mode
- Toggles collapsed (`╭╮╰╯` borders) ↔ expanded (no borders) view
- **Does NOT change buffer content** — purely visual
- Expand mode adds: `─── Press ctrl+r to exit expand mode ───`
- Screen parser must handle both modes

### Slash Commands Available
Discovered via PTY: `/agents`, `/bashes`, `/clear`, `/commands`, `/compact`, `/config`, `/export`, `/help`, `/login`, `/logout`, `/mcp`, `/memory`, `/model`, `/quest-on`, `/quest-off`, `/quit`/`/exit`, `/release-notes`, `/resume`, `/setup-github`, `/skills`, `/status`, `/upgrade`, `/usage`, `/vim`

Useful for API endpoints: `/compact` (context compression), `/export` (session export), `/resume` (session continuation).

---

## OpenAI Compatibility — What Maps and What Doesn't

### What maps well
| OpenAI concept | qodercli equivalent |
|----------------|---------------------|
| `messages[]` | Concatenated prompt string via `buildPromptFromMessages()` |
| `session_id` (extension) | `-r <uuid>` flag to resume session |
| `model` | `--model <lite\|efficient\|performance\|ultimate\|...>` |
| `stream: true` | `-f stream-json` + SSE |
| `reasoning_content` | `c.type === "reasoning"` from assistant messages |
| `delta.progress` | `c.type === "function"` tool calls |

### What doesn't map
- **`tools`/`tool_choice`** — qodercli is autonomous, handles tools internally. No client-controlled tool loop. Don't implement.
- **`temperature`, `top_p`, `max_tokens`, `stop`** — not forwarded to qodercli (no CLI flags). Either forward if supported, or return 400 rather than silently ignoring.
- **`n > 1`** — single response only
- **Assistants API** — not worth implementing. Sessions + chat completions IS the Assistants API, just simpler.
- **Embeddings, Moderations, Batch** — unrelated to qodercli's capabilities

### Model mapping pattern
```typescript
const OPENAI_TO_QODER: Record<string, string> = {
  "qoder-lite": "lite",
  "gpt-3.5-turbo": "lite",
  "gpt-4": "performance",
  "gpt-4o": "performance",
  "o1": "ultimate",
  // ...
};
export const modelMap = {
  openaiToQoder(name: string): string {
    return OPENAI_TO_QODER[name] ?? "lite";
  }
};
```

---

## Testing Pattern

### Unit tests (fast, no server needed)
Use Hono's `app.request()` — in-process, no network:
```typescript
const app = new Hono();
app.route("/v1/models", modelsRoutes);
const res = await app.request("/v1/models", { headers: authHeaders() });
```

### Integration tests (require live server)
Separate vitest config — excluded from default `pnpm test`:
```typescript
// vitest.integration.config.ts
export default defineConfig({
  test: {
    include: ["test/chat-api.test.ts", "test/pseudo.test.ts"],
    testTimeout: 180000,
  }
});
```
```json
// package.json
"test": "vitest run",
"test:integration": "vitest run --config vitest.integration.config.ts"
```

**Why separate:** integration tests make real qodercli calls (10–30s each). 15 tests = 5+ minutes. Default `pnpm test` must be fast.

### Handle server crashes in integration tests
PRoot server crashes unpredictably. Wrap all fetch calls:
```typescript
async function safeRequest(fn: () => Promise<Response>): Promise<Response | null> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ECONNRESET") || msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
      apiAvailable = false;  // skip remaining tests
      return null;
    }
    throw err;
  }
}
// Usage: const res = await safeRequest(() => fetch(...)); if (!res) return;
```

### Streaming hang fix
`reader.read()` hangs forever if server crashes mid-stream. Always use AbortController:
```typescript
async function* streamRequest(url, body, timeoutMs = 120000) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(url, { body, signal: abort.signal });
    const reader = res.body?.getReader();
    try {
      while (!abort.signal.aborted) {
        const { done, value } = await Promise.race([
          reader.read(),
          new Promise<never>((_, rej) =>
            abort.signal.addEventListener("abort", () => rej(new Error("timeout")), { once: true })
          )
        ]);
        if (done) break;
        // process value...
      }
    } finally { reader?.cancel().catch(() => {}); }
  } finally { clearTimeout(timer); }
}
```

### PTY debugging via MCP
```typescript
// Spawn qodercli in PTY to inspect TUI behavior
mcp__pty-debug__spawn_session({ command: "qodercli", args: ["--model", "lite", "-w", "/tmp/ws"], cols: 120, rows: 40 })
mcp__pty-debug__send_input({ sessionId, specialKey: "ctrl+r" })   // expand mode
mcp__pty-debug__send_input({ sessionId, input: "/help" })          // slash commands
mcp__pty-debug__send_input({ sessionId, specialKey: "tab" })       // cycle help tabs
mcp__pty-debug__get_snapshot({ sessionId, format: "text" })        // read screen
```
Use `specialKey` for control sequences (ctrl+r, ctrl+c, enter, tab, escape).
Use `input` for printable text — control chars as literal `\uXXXX` get typed literally, not sent as control codes.

---

## Debugging Checklist

| Symptom | Cause | Fix |
|---------|-------|-----|
| `uv__io_poll assertion failed` | Using async spawn/exec or tsx watch | Switch to `spawnSync`, remove `--watch` |
| Empty `reasoning_content` | Using `-f json` (no assistant messages) | Always use `-f stream-json` |
| Duplicate stream chunks | qodercli emits assistant msg twice | Deduplicate with `Set<string>` |
| Model always "lite" | Model not forwarded to buildArgs | Add `model` to `QoderCliOptions`, map via `modelMap` |
| `pnpm test` hangs | Integration tests making live API calls | Exclude from vitest config; put in separate integration config |
| Server crash mid-stream | PRoot libuv epoll crash | safeRequest wrapper + AbortController on reader |
| Port in use after kill | Old server survived kill by name | Kill by PID from `/status` endpoint or `/proc` scan |
| Slash command typed literally | Sent `\u0012` via `input:` field | Use `specialKey: "ctrl+r"` in pty-debug MCP |
