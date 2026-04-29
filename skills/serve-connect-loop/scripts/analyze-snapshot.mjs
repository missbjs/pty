#!/usr/bin/env node
// ANALYZE: Analyze a TUI snapshot file and report issues
// Usage: node analyze-snapshot.mjs <snapshot.json>

import { readFileSync } from 'fs';
import { argv, exit } from 'node:process';

const file = argv[2];

if (!file) {
  console.error('Usage: node analyze-snapshot.mjs <snapshot.json>');
  exit(1);
}

try {
  const content = readFileSync(file, 'utf8');
  const snapshot = JSON.parse(content);
  
  console.log('TUI Snapshot Analysis');
  console.log('='.repeat(60));
  console.log(`Timestamp: ${new Date(snapshot.timestamp).toLocaleString()}`);
  console.log(`Iteration: ${snapshot.iteration || 'N/A'}`);
  console.log(`Dimensions: ${snapshot.dimensions?.cols || '?'}x${snapshot.dimensions?.rows || '?'}`);
  console.log('');
  
  if (snapshot.issues && snapshot.issues.length > 0) {
    console.log(`Issues Found: ${snapshot.issues.length}`);
    console.log('-'.repeat(60));
    snapshot.issues.forEach((issue, i) => {
      console.log(`  ${i + 1}. ${issue}`);
    });
    console.log('');
  } else {
    console.log('No issues detected ✓');
    console.log('');
  }
  
  // Show screen preview
  const snap = snapshot.snapshot;
  const text = snap?.visibleText || snap?.text || '';
  const lines = text.split('\n');
  
  console.log('Screen Preview (first 20 rows):');
  console.log('-'.repeat(60));
  lines.slice(0, 20).forEach((line, i) => {
    const visible = line.replace(/\x1b\[[0-9;]*m/g, '');
    console.log(`${i.toString().padStart(2)}: ${visible}`);
  });
  
  // Statistics
  console.log('');
  console.log('Statistics:');
  console.log(`  Total rows: ${lines.length}`);
  console.log(`  Non-empty rows: ${lines.filter(l => l.replace(/\x1b\[[0-9;]*m/g, '').trim().length > 0).length}`);
  console.log(`  Total characters: ${text.replace(/\x1b\[[0-9;]*m/g, '').length}`);
  
  const hasBorders = text.includes('┌') || text.includes('│');
  const hasColors = /\x1b\[\d+m/.test(text);
  console.log(`  Has borders: ${hasBorders ? 'Yes ✓' : 'No ✗'}`);
  console.log(`  Has colors: ${hasColors ? 'Yes ✓' : 'No ✗'}`);
  
  // Check for common patterns
  console.log('');
  console.log('Pattern Detection:');
  
  const errorPattern = /\[error\]|Error:|ERR!|ERROR/i;
  if (errorPattern.test(text)) {
    console.log('  ⚠ Error messages detected');
  }
  
  const warningPattern = /\[warn\]|Warning:|WARN|WARNING/i;
  if (warningPattern.test(text)) {
    console.log('  ⚠ Warning messages detected');
  }
  
  const loadingPattern = /Loading|loading|spinner|thinking|processing/i;
  if (loadingPattern.test(text)) {
    console.log('  ℹ Loading/processing indicator present');
  }
  
  console.log('');
  
  // Provide fix suggestions
  if (snapshot.issues && snapshot.issues.length > 0) {
    console.log('Suggested Fixes:');
    console.log('-'.repeat(60));
    
    for (const issue of snapshot.issues) {
      if (issue.startsWith('LINE_OVERFLOW')) {
        console.log(`
For LINE_OVERFLOW:
  1. Check panel width calculations in source
  2. Width math: panel = terminal - sidebar - borders
  3. Look for Ink Text without wrap="truncate"
  4. Check Screen.ts renderLine for width bugs
        `.trim());
      }
      
      if (issue.startsWith('FLICKER')) {
        console.log(`
For FLICKER:
  1. Check for unnecessary state updates
  2. Look for setInterval firing at idle
  3. Gate spinners on actual activity
  4. Check snapshot hashing (deduplication)
        `.trim());
      }
      
      if (issue.startsWith('MISSING_CHROME')) {
        console.log(`
For MISSING_CHROME:
  1. Check component render functions
  2. Verify state/props are correct
  3. Look for conditional rendering skipping borders
  4. Check Ink Box borderStyle, borderColor props
        `.trim());
      }
      
      if (issue.startsWith('ERROR_TEXT')) {
        console.log(`
For ERROR_TEXT:
  1. Read actual error message from snapshot
  2. Check stack trace for source file/line
  3. Look for unhandled promise rejections
  4. Verify PTY process spawning
        `.trim());
      }
    }
  }
  
} catch (err) {
  console.error(`Error: ${err.message}`);
  exit(1);
}
