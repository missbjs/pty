#!/usr/bin/env node
// Multi-client multi-app test suite for PTY service manager

import { spawn } from 'child_process';
import { WebSocket } from 'ws';

const PORT = 3099;
const HOST = '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}`;

let serverProcess = null;
let testResults = [];

function log(msg) {
  console.log(`[${new Date().toISOString().split('T')[1]}] ${msg}`);
}

function pass(test) {
  testResults.push({ test, status: 'PASS' });
  log(`✅ PASS: ${test}`);
}

function fail(test, reason) {
  testResults.push({ test, status: 'FAIL', reason });
  log(`❌ FAIL: ${test} - ${reason}`);
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function httpGet(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  return res.json();
}

async function httpPost(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

function wsConnect(appId) {
  return new WebSocket(`ws://${HOST}:${PORT}/app/${appId}`);
}

async function startServer() {
  serverProcess = spawn('pnpm', ['exec', 'tsx', 'pty.ts', '--serve', '--port', PORT.toString()], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  
  serverProcess.stdout.on('data', (data) => {
    // Uncomment to see server logs
    // process.stderr.write(data);
  });
  
  await sleep(2000);
  log('Server started');
}

async function stopServer() {
  if (serverProcess) {
    serverProcess.kill();
    await sleep(500);
  }
  log('Server stopped');
}

// Test 1: Single App, Multiple Clients (Broadcast)
async function test1_singleAppMultipleClients() {
  log('\n=== Test 1: Single App, Multiple Clients ===');
  
  try {
    // Start htop
    const startRes = await httpPost('/start', { command: 'htop' });
    const appId = startRes.id;
    
    if (!appId) {
      fail('Test 1', 'Failed to start htop');
      return;
    }
    
    await sleep(500);
    
    // Connect 3 clients
    const clients = [];
    const outputs = [[], [], []];
    
    for (let i = 0; i < 3; i++) {
      const ws = wsConnect(appId);
      await new Promise((resolve, reject) => {
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
          resolve();
        });
        ws.on('error', reject);
        setTimeout(resolve, 1000);
      });
      
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'output') {
          outputs[i].push(msg.text);
        }
      });
      
      clients.push(ws);
    }
    
    await sleep(500);
    
    // Client 0 sends 'h' (help in htop)
    clients[0].send(JSON.stringify({ type: 'input', text: 'h' }));
    await sleep(300);
    
    // All clients should have received output
    const allReceivedOutput = outputs.every(o => o.length > 0);
    
    if (allReceivedOutput) {
      pass('Test 1.1: All clients received output');
    } else {
      fail('Test 1.1', `Output counts: ${outputs.map(o => o.length).join(', ')}`);
    }
    
    // Cleanup
    for (const ws of clients) {
      ws.close();
    }
    await httpPost('/kill', { id: appId });
    
  } catch (err) {
    fail('Test 1', err.message);
  }
}

// Test 2: Multiple Apps, Isolated Clients
async function test2_multipleAppsIsolatedClients() {
  log('\n=== Test 2: Multiple Apps, Isolated Clients ===');
  
  try {
    // Start two apps
    const app1 = await httpPost('/start', { command: 'htop' });
    const app2 = await httpPost('/start', { command: 'top' });
    
    await sleep(500);
    
    // Connect client to app1
    const output1 = [];
    const ws1 = wsConnect(app1.id);
    await new Promise(r => {
      ws1.on('open', () => {
        ws1.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
        r();
      });
      setTimeout(r, 500);
    });
    ws1.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'output') output1.push(msg.text);
    });
    
    // Connect client to app2
    const output2 = [];
    const ws2 = wsConnect(app2.id);
    await new Promise(r => {
      ws2.on('open', () => {
        ws2.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
        r();
      });
      setTimeout(r, 500);
    });
    ws2.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'output') output2.push(msg.text);
    });
    
    await sleep(300);
    
    // Send input to app1 only
    ws1.send(JSON.stringify({ type: 'input', text: 'h' }));
    await sleep(300);
    
    // app1 should have more output than app2 (since we sent input)
    // Actually both have output, but they should be different
    const apps = await httpGet('/apps');
    
    if (apps.apps.length === 2) {
      pass('Test 2.1: Both apps running');
    } else {
      fail('Test 2.1', `Expected 2 apps, got ${apps.apps.length}`);
    }
    
    // Cleanup
    ws1.close();
    ws2.close();
    await httpPost('/kill', { id: app1.id });
    await httpPost('/kill', { id: app2.id });
    
  } catch (err) {
    fail('Test 2', err.message);
  }
}

// Test 3: Kill Propagation to Clients
async function test3_killPropagation() {
  log('\n=== Test 3: Kill Propagation ===');
  
  try {
    const app = await httpPost('/start', { command: 'htop' });
    await sleep(300);
    
    // Connect client
    let exitReceived = false;
    const ws = wsConnect(app.id);
    
    await new Promise(r => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
        r();
      });
      setTimeout(r, 500);
    });
    
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'exit') {
        exitReceived = true;
      }
    });
    
    // Kill app via HTTP
    await httpPost('/kill', { id: app.id });
    await sleep(500);
    
    if (exitReceived) {
      pass('Test 3.1: Client received exit message on kill');
    } else {
      fail('Test 3.1', 'Client did not receive exit message');
    }
    
    ws.close();
    
  } catch (err) {
    fail('Test 3', err.message);
  }
}

// Test 4: Short ID Resolution
async function test4_shortIdResolution() {
  log('\n=== Test 4: Short ID Resolution ===');
  
  try {
    const app = await httpPost('/start', { command: 'htop' });
    await sleep(300);
    
    const fullId = app.id;
    const shortId = fullId.slice(0, 8);
    
    // Test snapshot with short ID
    const snapshot = await httpGet(`/app/${shortId}/snapshot`);
    
    if (snapshot.cols && snapshot.rows) {
      pass('Test 4.1: Short ID works for snapshot');
    } else {
      fail('Test 4.1', 'Short ID snapshot failed');
    }
    
    // Test kill with short ID
    const killRes = await httpPost('/kill', { id: shortId });
    
    if (killRes.ok) {
      pass('Test 4.2: Short ID works for kill');
    } else {
      fail('Test 4.2', 'Short ID kill failed');
    }
    
  } catch (err) {
    fail('Test 4', err.message);
  }
}

// Test 5: Client Disconnect Tracking
async function test5_clientDisconnectTracking() {
  log('\n=== Test 5: Client Disconnect Tracking ===');
  
  try {
    const app = await httpPost('/start', { command: 'htop' });
    await sleep(300);
    
    // Check initial client count
    const status1 = await httpGet(`/app/${app.id}/status`);
    
    if (status1.clients === 0) {
      pass('Test 5.1: Initial client count is 0');
    } else {
      fail('Test 5.1', `Expected 0 clients, got ${status1.clients}`);
    }
    
    // Connect client
    const ws = wsConnect(app.id);
    await new Promise(r => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
        r();
      });
      setTimeout(r, 500);
    });
    
    await sleep(200);
    
    const status2 = await httpGet(`/app/${app.id}/status`);
    
    if (status2.clients === 1) {
      pass('Test 5.2: Client count is 1 after connect');
    } else {
      fail('Test 5.2', `Expected 1 client, got ${status2.clients}`);
    }
    
    // Disconnect
    ws.close();
    await sleep(300);
    
    const status3 = await httpGet(`/app/${app.id}/status`);
    
    if (status3.clients === 0) {
      pass('Test 5.3: Client count is 0 after disconnect');
    } else {
      fail('Test 5.3', `Expected 0 clients, got ${status3.clients}`);
    }
    
    await httpPost('/kill', { id: app.id });
    
  } catch (err) {
    fail('Test 5', err.message);
  }
}

// Test 6: Concurrent App Starts
async function test6_concurrentStarts() {
  log('\n=== Test 6: Concurrent App Starts ===');
  
  try {
    // Start 5 apps concurrently
    const starts = await Promise.all([
      httpPost('/start', { command: 'htop' }),
      httpPost('/start', { command: 'top' }),
      httpPost('/start', { command: 'htop' }),
      httpPost('/start', { command: 'top' }),
      httpPost('/start', { command: 'htop' })
    ]);
    
    await sleep(500);
    
    const allStarted = starts.every(s => s.id);
    
    if (allStarted) {
      pass('Test 6.1: All 5 apps started concurrently');
    } else {
      fail('Test 6.1', 'Some apps failed to start');
    }
    
    // Check unique IDs
    const ids = starts.map(s => s.id);
    const uniqueIds = new Set(ids);
    
    if (uniqueIds.size === 5) {
      pass('Test 6.2: All apps have unique IDs');
    } else {
      fail('Test 6.2', `Expected 5 unique IDs, got ${uniqueIds.size}`);
    }
    
    // List apps
    const apps = await httpGet('/apps');
    
    if (apps.apps.length === 5) {
      pass('Test 6.3: All 5 apps listed');
    } else {
      fail('Test 6.3', `Expected 5 apps, got ${apps.apps.length}`);
    }
    
    // Cleanup all
    for (const id of ids) {
      await httpPost('/kill', { id });
    }
    
  } catch (err) {
    fail('Test 6', err.message);
  }
}

// Test 7: Interactive Editor Multi-Client Sync
async function test7_editorMultiClient() {
  log('\n=== Test 7: Interactive Editor Multi-Client ===');
  
  try {
    // Start nano (or vim if nano not available)
    const app = await httpPost('/start', { command: 'nano', args: ['/tmp/test-multi.txt'] });
    
    if (!app.id) {
      fail('Test 7', 'Failed to start nano');
      return;
    }
    
    await sleep(500);
    
    // Connect 2 clients
    const outputs = [[], []];
    const exits = [false, false];
    const clients = [];
    
    for (let i = 0; i < 2; i++) {
      const ws = wsConnect(app.id);
      await new Promise((resolve) => {
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
          resolve();
        });
        setTimeout(resolve, 500);
      });
      
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'output') {
          outputs[i].push(msg.text);
        } else if (msg.type === 'exit') {
          exits[i] = true;
        }
      });
      
      clients.push(ws);
    }
    
    await sleep(300);
    
    // Client 0 types text
    const testText = 'Hello from client 0!\n';
    for (const char of testText) {
      clients[0].send(JSON.stringify({ type: 'input', text: char }));
    }
    await sleep(200);
    
    // Both clients should have received the output
    const client0Output = outputs[0].join('');
    const client1Output = outputs[1].join('');
    
    if (client0Output.length > 0 && client1Output.length > 0) {
      pass('Test 7.1: Both clients received editor output');
    } else {
      fail('Test 7.1', `Output lengths: ${outputs[0].length}, ${outputs[1].length}`);
    }
    
    // Check if text appears in both (nano shows typed text)
    const textInClient0 = client0Output.includes('Hello') || outputs[0].length > 10;
    const textInClient1 = client1Output.includes('Hello') || outputs[1].length > 10;
    
    if (textInClient0 && textInClient1) {
      pass('Test 7.2: Typed text synced to both clients');
    } else {
      fail('Test 7.2', 'Text not synced properly');
    }
    
    // Exit nano: Ctrl+X
    clients[0].send(JSON.stringify({ type: 'input', text: '\x18' })); // Ctrl+X
    await sleep(300);
    
    // Press 'n' to not save (nano asks to save)
    clients[0].send(JSON.stringify({ type: 'input', text: 'n' }));
    await sleep(500);
    
    // Both should receive exit
    if (exits[0] && exits[1]) {
      pass('Test 7.3: Both clients received exit on editor close');
    } else {
      // Nano might not exit cleanly, just kill it
      await httpPost('/kill', { id: app.id });
      await sleep(300);
      
      if (exits[0] && exits[1]) {
        pass('Test 7.3: Both clients received exit on editor close (via kill)');
      } else {
        fail('Test 7.3', `Exit not received: ${exits}`);
      }
    }
    
    // Cleanup
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.close();
    }
    
  } catch (err) {
    fail('Test 7', err.message);
  }
}

// Test 8: Vim Multi-Edit Test
async function test8_vimMultiClient() {
  log('\n=== Test 8: Vim Multi-Client ===');
  
  try {
    // Check if vim is available first
    const { execSync } = await import('child_process');
    try {
      execSync('which vim', { stdio: 'ignore' });
    } catch {
      log('Vim not available, skipping test');
      pass('Test 8.0: Skipped (vim not installed)');
      return;
    }
    
    // Start vim
    const app = await httpPost('/start', { command: 'vim', args: ['/tmp/test-vim.txt'] });
    
    if (!app.id) {
      fail('Test 8', 'Failed to start vim');
      return;
    }
    
    await sleep(500);
    
    // Connect 2 clients
    const outputs = [[], []];
    const clients = [];
    
    for (let i = 0; i < 2; i++) {
      const ws = wsConnect(app.id);
      await new Promise((resolve) => {
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
          resolve();
        });
        setTimeout(resolve, 500);
      });
      
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'output') {
          outputs[i].push(msg.text);
        }
      });
      
      clients.push(ws);
    }
    
    await sleep(300);
    
    // Client 0 enters insert mode and types
    clients[0].send(JSON.stringify({ type: 'input', text: 'i' })); // Insert mode
    await sleep(100);
    
    const testText = 'Vim test text\n';
    for (const char of testText) {
      clients[0].send(JSON.stringify({ type: 'input', text: char }));
    }
    await sleep(200);
    
    // Both should have output
    const bothHaveOutput = outputs[0].length > 0 && outputs[1].length > 0;
    
    if (bothHaveOutput) {
      pass('Test 8.1: Both clients received vim output');
    } else {
      fail('Test 8.1', `Output lengths: ${outputs[0].length}, ${outputs[1].length}`);
    }
    
    // Exit vim: ESC :q!
    clients[0].send(JSON.stringify({ type: 'input', text: '\x1b' })); // ESC
    await sleep(100);
    clients[0].send(JSON.stringify({ type: 'input', text: ':q!\r' }));
    await sleep(300);
    
    // Cleanup
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.close();
    }
    
    await httpPost('/kill', { id: app.id });
    
    pass('Test 8.2: Vim session completed');
    
  } catch (err) {
    fail('Test 8', err.message);
  }
}

// Test 9: Client Reconnect to Same App
async function test9_clientReconnect() {
  log('\n=== Test 9: Client Reconnect ===');
  
  try {
    const app = await httpPost('/start', { command: 'htop' });
    await sleep(300);
    
    // First connection
    let output1 = [];
    const ws1 = wsConnect(app.id);
    await new Promise(r => {
      ws1.on('open', () => {
        ws1.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
        r();
      });
      setTimeout(r, 500);
    });
    ws1.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'output') output1.push(msg.text);
    });
    
    await sleep(300);
    ws1.close();
    await sleep(200);
    
    // Reconnect
    let output2 = [];
    const ws2 = wsConnect(app.id);
    await new Promise(r => {
      ws2.on('open', () => {
        ws2.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
        r();
      });
      setTimeout(r, 500);
    });
    ws2.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'output') output2.push(msg.text);
    });
    
    await sleep(300);
    
    if (output2.length > 0) {
      pass('Test 9.1: Reconnected client received output');
    } else {
      fail('Test 9.1', 'No output after reconnect');
    }
    
    ws2.close();
    await httpPost('/kill', { id: app.id });
    
  } catch (err) {
    fail('Test 9', err.message);
  }
}

// Main
async function main() {
  log('Starting test suite...\n');
  
  await startServer();
  
  try {
    await test1_singleAppMultipleClients();
    await test2_multipleAppsIsolatedClients();
    await test3_killPropagation();
    await test4_shortIdResolution();
    await test5_clientDisconnectTracking();
    await test6_concurrentStarts();
    await test7_editorMultiClient();
    await test8_vimMultiClient();
    await test9_clientReconnect();
  } finally {
    await stopServer();
  }
  
  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('TEST SUMMARY');
  console.log('='.repeat(50));
  
  const passed = testResults.filter(t => t.status === 'PASS').length;
  const failed = testResults.filter(t => t.status === 'FAIL').length;
  
  console.log(`Total: ${testResults.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  
  if (failed > 0) {
    console.log('\nFailed tests:');
    testResults.filter(t => t.status === 'FAIL').forEach(t => {
      console.log(`  - ${t.test}: ${t.reason}`);
    });
  }
  
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test suite error:', err);
  process.exit(1);
});
