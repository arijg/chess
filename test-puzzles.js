/* test-puzzles.js — re-verifies every generated puzzle with the exact solver.
   Run with: jsc chess-engine.js puzzles-data.js test-puzzles.js */
(function () {
  'use strict';
  const E = typeof ChessEngine !== 'undefined' ? ChessEngine : require('./chess-engine.js');
  const out = typeof print !== 'undefined' ? print : console.log;
  const uci = m => E.sqToAlg(m.from) + E.sqToAlg(m.to) + (m.promotion ? m.promotion.toLowerCase() : '');

  let failed = 0;
  const counts = {};
  for (const p of PUZZLES) {
    counts[p.mateIn] = (counts[p.mateIn] || 0) + 1;
    const st = E.loadFEN(p.fen);
    const plies = p.mateIn * 2 - 1;
    const mm = E.mateMoves(st, plies);
    const problems = [];
    if (!mm.length) problems.push('no mate found');
    if (p.mateIn > 1 && mm.length > 1) problems.push('solution not unique');
    if (!mm.some(m => uci(m) === p.best)) problems.push('stored best move not a solution');
    if (p.mateIn > 1 && E.mateMoves(st, plies - 2, true).length) problems.push('faster mate exists');
    if (problems.length) {
      failed++;
      out('FAIL mate-in-' + p.mateIn + ' ' + p.fen + ' : ' + problems.join('; '));
    }
  }
  out('Verified ' + PUZZLES.length + ' puzzles (' + Object.keys(counts).sort().map(k => counts[k] + ' M' + k).join(', ') + ')');
  out(failed === 0 ? 'ALL PUZZLES VALID' : failed + ' PUZZLE(S) INVALID');
})();
