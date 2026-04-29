#!/usr/bin/env node
// CONNECT: AI Agent observer - connects to served PTY and analyzes screen state
// Usage: node connect-observer.mjs [ws://localhost:3000] [--tick=1000] [--analyze]

import WebSocket from 'ws';
import { argv, stdout, exit } from 'node:process';
import { writeFileSync, existsSync, readFileSync } from 'fs';

const args = argv.slice(2);

function flag(name, fallback) {
  const i = args.findIndex(a => a.startsWith(`--${name}=`));
  if (i === -1) {
    const j = args.indexOf(`--${name}`);
    if (j !== -1 && args[j + 1]) return args[j + 1];
    return fallback;
  }
  return args[i].split('=')[1] ?? fallback;
}

const url = args[0] || 'ws://localhost:3000';
const tickMs = parseInt(flag('tick', '1000'), 10);
const analyze = args.includes('--analyze');
const outputFile = flag('output', '.tui-snapshot.json');

console.log(`[connect] Connecting to ${url}`);
console.log(`[connect] Tick: ${tickMs}ms, Analyze: ${analyze}`);

const ws = new WebSocket(url);

let buffer = '';
let previousSnapshot = null;
let snapshotCount = 0;
let flickerCount = 0;

ws.on('open', () => {
  console.log('[connect] Connected!');
  console.log('[connect] Starting snapshot loop...\n');
  
  // Send resize with our dimensions
  ws.send(JSON.stringify({
    type: 'resize',
    cols: 120,
    rows: 40
  }));
  
  // Start snapshot loop
  setInterval(() => {
    captureAndAnalyze();
  }, tickMs);
});

ws.on('message', (data) => {
  const text = data.toString();
  
  try {
    const msg = JSON.parse(text);
    
    if (msg.type === 'output') {
      buffer += msg.text;
    } else if (msg.type === 'exit') {
      console.log(`\n[connect] PTY exited with code ${msg.exitCode}`);
      exit(msg.exitCode);
    }
  } catch {
    // Not JSON, treat as raw output
    buffer += text;
  }
});

ws.on('error', (err) => {
  console.error(`[connect] Error: ${err.message}`);
  console.log('[connect] Make sure the TUI server is running with --serve');
  exit(1);
});

ws.on('close', () => {
  console.log('[connect] Connection closed');
  exit(0);
});

async function captureAndAnalyze() {
  try {
    // Fetch snapshot from HTTP API
    const res = await fetch(new URL('/snapshot?color=true', url).toString());
    
    if (!res.ok) {
      console.error(`[connect] Failed to fetch snapshot: ${res.status}`);
      return;
    }
    
    const snapshot = await res.json();
    snapshotCount++;
    
    const analysis = analyzeSnapshot(snapshot, snapshotCount);
    
    if (analysis.issues.length > 0) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`[snapshot #${snapshotCount}] ISSUES DETECTED (${analysis.issues.length}):`);
      console.log(`${'='.repeat(60)}`);
      analysis.issues.forEach(i => console.log(`  ⚠ ${i}`));
      
      // Write snapshot for AI agent
      writeFileSync(outputFile, JSON.stringify({
        timestamp: Date.now(),
        iteration: snapshotCount,
        issues: analysis.issues,
        snapshot: snapshot,
        dimensions: {
          cols: snapshot.cols,
          rows: snapshot.rows
        }
      }, null, 2));
      
      console.log(`\n[connect] Snapshot written to ${outputFile}`);
    } else {
      process.stdout.write('.');
      if (snapshotCount % 60 === 0) {
        process.stdout.write(` (${snapshotCount} snapshots OK)\n`);
      }
    }
    
  } catch (err) {
    console.error(`[connect] Snapshot error: ${err.message}`);
  }
}

function analyzeSnapshot(snapshot, count) {
  const issues = [];
  const text = snapshot.visibleText || '';
  const lines = text.split('\n');
  const cols = snapshot.cols || 120;
  
  // 1. Dimension/overflow issues
  lines.forEach((line, i) => {
    const visible = stripAnsi(line);
    const width = [...visible].length;
    if (width > cols) {
      issues.push(`LINE_OVERFLOW: Row ${i} is ${width} cols (max ${cols})`);
    }
    if (width < cols - 2 && visible.trim().length > cols * 0.8) {
      issues.push(`TRUNCATION: Row ${i} may be truncated at ${width} cols`);
    }
  });
  
  // 2. Missing UI chrome (borders)
  const hasBorders = text.includes('┌') || text.includes('┐') || 
                     text.includes('└') || text.includes('┘') ||
                     text.includes('│') || text.includes('─');
  if (!hasBorders && text.trim().length > 100) {
    issues.push('MISSING_CHROME: No border characters detected');
  }
  
  // 3. Flicker detection (compare with previous)
  if (previousSnapshot) {
    const prevLines = (previousSnapshot.visibleText || '').split('\n');
    let changedRows = 0;
    
    for (let i = 0; i < Math.min(lines.length, prevLines.length); i++) {
      if (stripAnsi(lines[i]) !== stripAnsi(prevLines[i])) {
        changedRows++;
      }
    }
    
    // Small number of rows changing continuously = flicker
    if (changedRows > 0 && changedRows < 10) {
      flickerCount++;
      if (flickerCount > 3) {
        issues.push(`FLICKER: ${changedRows} rows changing for ${flickerCount} ticks`);
      }
    } else {
      flickerCount = 0;
    }
  }
  
  // 4. Error patterns
  if (text.includes('[error]') || text.includes('Error:') || text.includes('ERR!') || text.includes('ERROR')) {
    issues.push('ERROR_TEXT: Error message detected in output');
  }
  
  // 5. Color/SGR balance
  lines.forEach((line, i) => {
    const colorCodes = (line.match(/\x1b\[\d+[;]*\d*m/g) || []).length;
    const resets = (line.match(/\x1b\[0m/g) || []).length;
    if (colorCodes > resets * 3) {
      issues.push(`UNBALANCED_SGR: Row ${i} has ${colorCodes} codes, ${resets} resets`);
    }
  });
  
  previousSnapshot = { visibleText: text };
  return { issues };
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// Graceful exit
process.on('SIGINT', () => {
  console.log('\n[connect] Disconnecting...');
  ws.close();
  exit(0);
});
