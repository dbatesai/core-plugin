#!/usr/bin/env node
// Test stand-in for CORE_HARNESS_REASONER: reads the escalation prompt on stdin,
// prints {"picks": [...]} from FAKE_REASONER_PICKS (comma-separated ids).
// FAKE_REASONER_LOG, when set, receives the prompt so a test can assert on it.
import { writeFileSync } from 'node:fs';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  if (process.env.FAKE_REASONER_LOG) writeFileSync(process.env.FAKE_REASONER_LOG, input);
  const picks = (process.env.FAKE_REASONER_PICKS || '').split(',').map(s => s.trim()).filter(Boolean);
  process.stdout.write(JSON.stringify({ picks }) + '\n');
});
