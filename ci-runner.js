/* ci-runner.js — runs every test suite in Node for CI.
   Usage: node ci-runner.js
   Exits non-zero if any suite reports a failure. */
'use strict';
const fs = require('fs');
const vm = require('vm');

const lines = [];
const ctx = vm.createContext({
  console,
  print: s => {
    lines.push(String(s));
    console.log(s);
  },
});

const FILES = [
  'chess-engine.js',
  'test-perft.js',
  'puzzles-data.js',
  'test-puzzles.js',
  'openings-data.js',
  'test-openings.js',
  'endgames-data.js',
  'test-endgames.js',
];

for (const f of FILES) {
  console.log('\n=== ' + f + ' ===');
  vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f });
}

// Every file the service worker precaches must exist, or offline breaks.
console.log('\n=== sw.js precache ===');
const sw = fs.readFileSync('sw.js', 'utf8');
const precache = [...sw.matchAll(/'([^']+)'/g)].map(m => m[1])
  .filter(p => p.includes('.') && !p.startsWith('chess-v'));
let missing = 0;
for (const p of precache) {
  if (!fs.existsSync(p)) {
    missing++;
    ctx.print('FAIL precache entry missing on disk: ' + p);
  }
}
ctx.print('Checked ' + precache.length + ' precache entries');
ctx.print(missing === 0 ? 'ALL PRECACHE FILES PRESENT' : missing + ' PRECACHE FILE(S) MISSING');

const bad = lines.filter(l => /FAIL|INVALID/.test(l));
if (bad.length) {
  console.error('\nCI: ' + bad.length + ' failure line(s) detected');
  process.exit(1);
}
console.log('\nCI: all suites passed');
