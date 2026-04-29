#!/usr/bin/env node
// SERVE: Wrapper script to start pty.ts in serve mode
// Usage: node serve-tui.mjs <command> [args...] [--port=3000] [--cols=120] [--rows=40]

import { spawn } from 'child_process';
import { argv, env, exit } from 'node:process';

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

// Extract pty.ts flags
const port = flag('port', '3000');
const cols = flag('cols', '120');
const rows = flag('rows', '40');

// Get command (everything before first -- or all args)
const dashIndex = args.indexOf('--');
const cmdArgs = dashIndex === -1 ? args : args.slice(0, dashIndex);
const ptyFlags = dashIndex === -1 ? [] : args.slice(dashIndex + 1);

if (cmdArgs.length === 0) {
  console.error('Usage: node serve-tui.mjs <command> [args...] [-- --serve --port=3000]');
  exit(1);
}

const cmd = cmdArgs[0];
const cmdRest = cmdArgs.slice(1);

console.log(`[serve] Starting: ${cmd} ${cmdRest.join(' ')}`);
console.log(`[serve] Port: ${port}, Dims: ${cols}x${rows}`);

// Run pty.ts with serve mode
const ptyProcess = spawn('pnpm', [
  'dev',
  cmd,
  ...cmdRest,
  '--',
  '--serve',
  `--port=${port}`,
  `--cols=${cols}`,
  `--rows=${rows}`,
  ...ptyFlags
], {
  stdio: 'inherit',
  env: { ...env, FORCE_COLOR: '1' }
});

ptyProcess.on('error', (err) => {
  console.error(`[serve] Failed to start: ${err.message}`);
  exit(1);
});

ptyProcess.on('exit', (code) => {
  console.log(`[serve] PTY server exited with code ${code}`);
  exit(code ?? 0);
});

// Forward signals
process.on('SIGINT', () => ptyProcess.kill('SIGINT'));
process.on('SIGTERM', () => ptyProcess.kill('SIGTERM'));

console.log(`\n[serve] TUI will be available at:`);
console.log(`  HTTP:    http://127.0.0.1:${port}`);
console.log(`  WS:      ws://127.0.0.1:${port}`);
console.log(`  Snapshot: http://127.0.0.1:${port}/snapshot?color=true`);
console.log(`\n[serve] Press Ctrl+C to stop\n`);
