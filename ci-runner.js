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
];

for (const f of FILES) {
  console.log('\n=== ' + f + ' ===');
  vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f });
}

const bad = lines.filter(l => /FAIL|INVALID/.test(l));
if (bad.length) {
  console.error('\nCI: ' + bad.length + ' failure line(s) detected');
  process.exit(1);
}
console.log('\nCI: all suites passed');
