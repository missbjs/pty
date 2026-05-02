# Multi-Client Multi-App Test Spec

## Overview
Test the PTY service manager's ability to handle multiple apps with multiple clients,
including real-time relay, cross-client synchronization, and proper cleanup.

## Test Scenarios

### 1. Single App, Multiple Clients (Broadcast Test)
**Setup:**
- Server: `pnpm exec tsx pty.ts --serve --port 3000`
- App: Start one `htop` instance
- Clients: Connect 3 WebSocket clients to the same app

**Steps:**
1. Start server
2. Start htop via `--start htop`
3. Get app ID via `--list`
4. Connect client A via WebSocket to `/app/{id}`
5. Connect client B via WebSocket to `/app/{id}`
6. Connect client C via WebSocket to `/app/{id}`
7. Client A sends keystroke "q" (quit htop)
8. All clients should receive the same output updates
9. App exits, all clients receive `exit` message

**Expected:**
- All clients see identical output in real-time
- When client A types, all clients see the result
- When app exits, all clients get `exit` message
- Server logs show client connect/disconnect events

---

### 2. Multiple Apps, Single Client (App Switching)
**Setup:**
- Server: `pnpm exec tsx pty.ts --serve --port 3000`
- Apps: Start `htop`, `top`, `btop`
- Client: Single WebSocket client

**Steps:**
1. Start server
2. Start 3 different apps
3. Connect to app 1, capture snapshot
4. Disconnect, connect to app 2, capture snapshot
5. Disconnect, connect to app 3, capture snapshot
6. Verify each snapshot shows different app content

**Expected:**
- Client can connect to any app by ID
- Each app maintains independent state
- Switching apps doesn't affect other running apps

---

### 3. Multiple Apps, Multiple Clients (Full Matrix)
**Setup:**
- Server: `pnpm exec tsx pty.ts --serve --port 3000`
- Apps: 2 apps (htop, top)
- Clients: 4 clients (2 per app)

**Steps:**
1. Start server
2. Start htop (app A) and top (app B)
3. Connect client 1 and 2 to app A
4. Connect client 3 and 4 to app B
5. Client 1 sends keystroke to app A
6. Verify: clients 1,2 see update; clients 3,4 do NOT see it
7. Client 3 sends keystroke to app B
8. Verify: clients 3,4 see update; clients 1,2 do NOT see it
9. Kill app A via `--kill`
10. Verify: clients 1,2 receive exit; clients 3,4 still connected to app B

**Expected:**
- Output is isolated per app
- Clients only see output from their connected app
- Killing one app only affects clients connected to that app

---

### 4. Client Kill Propagation
**Setup:**
- Server: `pnpm exec tsx pty.ts --serve --port 3000`
- App: Single `htop` instance
- Clients: 3 clients connected

**Steps:**
1. Start server and htop
2. Connect 3 clients
3. Client A sends Ctrl+C (`\x03`)
4. Verify: All clients see the effect (htop exits or shows update)
5. Or: Use `--kill` from CLI
6. Verify: All clients receive `exit` message

**Expected:**
- Ctrl+C from one client affects all clients (same PTY)
- `--kill` command triggers exit messages to all connected clients
- Server cleans up app after all clients disconnect

---

### 5. Client Disconnect Cleanup
**Setup:**
- Server: `pnpm exec tsx pty.ts --serve --port 3000`
- App: Single `htop` instance
- Clients: 3 clients

**Steps:**
1. Start server and htop
2. Connect 3 clients
3. Client A disconnects (close WebSocket)
4. Verify: Server logs show "Client disconnected (2 remaining)"
5. Client B disconnects
6. Verify: Server logs show "Client disconnected (1 remaining)"
7. Client C disconnects
8. Verify: Server logs show "Client disconnected (0 remaining)"
9. App should still be running (not killed when clients disconnect)

**Expected:**
- App survives client disconnects
- Server properly tracks client count
- No memory leaks or orphaned connections

---

### 6. App Restart After Kill
**Setup:**
- Server: `pnpm exec tsx pty.ts --serve --port 3000`

**Steps:**
1. Start htop (app ID: A)
2. Connect client to app A
3. Kill app A via `--kill`
4. Verify: Client receives exit message
5. Start new htop (app ID: B)
6. Connect client to app B
7. Verify: New app works normally

**Expected:**
- Can start new apps after killing old ones
- New app gets new ID
- No state pollution from killed app

---

### 7. Short ID Resolution
**Setup:**
- Server: `pnpm exec tsx pty.ts --serve --port 3000`

**Steps:**
1. Start htop, get full ID (e.g., `a1b2c3d4-e5f6-...`)
2. Test operations with:
   - Full ID: `a1b2c3d4-e5f6-7890-abcd-ef1234567890`
   - Short ID (8 chars): `a1b2c3d4`
   - Short ID (4 chars): `a1b2`
3. Each should work for: `--kill`, `--connect`, `/app/:id/snapshot`

**Expected:**
- Short IDs work for all operations
- Ambiguous short IDs (if multiple apps share prefix) match first

---

### 8. Concurrent Start Requests
**Setup:**
- Server: `pnpm exec tsx pty.ts --serve --port 3000`

**Steps:**
1. Send 5 concurrent `/start` requests via HTTP
2. Verify: All 5 apps start successfully
3. Verify: Each has unique ID
4. Verify: `--list` shows all 5

**Expected:**
- No race conditions
- All apps start successfully
- Each app has unique ID and independent PTY

---

### 9. WebSocket Reconnect
**Setup:**
- Server: `pnpm exec tsx pty.ts --serve --port 3000`
- App: htop running

**Steps:**
1. Connect client, send resize
2. Disconnect client
3. Reconnect same client to same app
4. Send resize again
5. Verify: Client receives current snapshot

**Expected:**
- Reconnection works
- Client sees current state of app
- No duplicate output or missed output

---

### 10. Large Output Stress Test
**Setup:**
- Server: `pnpm exec tsx pty.ts --serve --port 3000`
- App: Command that generates lots of output (e.g., `find /`)

**Steps:**
1. Start app: `find / 2>/dev/null`
2. Connect 3 clients
3. Let output stream for 5 seconds
4. Verify: All clients receive output
5. Kill app
6. Verify: All clients receive exit

**Expected:**
- Server handles high-volume output
- All clients stay in sync
- No buffer overflows or crashes

---

## Implementation Notes

### WebSocket Message Protocol

**Client → Server:**
```json
{"type": "input", "text": "q"}           // Send keystroke
{"type": "resize", "cols": 120, "rows": 30}  // Resize terminal
```

**Server → Client:**
```json
{"type": "output", "text": "..."}        // PTY output
{"type": "exit", "exitCode": 0, "id": "..."}  // App exited
{"type": "error", "message": "..."}      // Error
```

### HTTP Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/apps` | List all apps |
| POST | `/start` | Start new app |
| POST | `/kill` | Kill app by ID |
| GET | `/app/:id/snapshot` | Get app snapshot |
| GET | `/app/:id/status` | Get app status |
| POST | `/app/:id/send` | Send keystrokes |
| POST | `/app/:id/resize` | Resize app |
| WS | `/app/:id` | WebSocket connection |

---

## Running Tests

```bash
# Start server
pnpm exec tsx pty.ts --serve --port 3000 &

# Run test scenarios manually or via test script
node test-multi-client.js

# Cleanup
pkill -f "tsx pty.ts"
```
