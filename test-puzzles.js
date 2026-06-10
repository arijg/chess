/* test-puzzles.js — re-verifies every puzzle with the exact quiet-move solver.
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
    const problems = [];

    const best = E.legalMoves(st).find(m => uci(m) === p.best);
    if (!best) problems.push('stored best move is not legal');
    else if (!E.forcesMate(st, best, plies, true)) problems.push('stored best move does not force mate');
    // Uniqueness is checked for mate-in-2 only: the quiet-move solve at
    // 5 plies is too slow to run over the whole set.
    if (p.mateIn === 2) {
      let keys = 0;
      for (const m of E.legalMoves(st)) {
        if (E.forcesMate(st, m, plies, true) && ++keys > 1) break;
      }
      if (keys !== 1) problems.push('solution not unique (' + keys + ' keys)');
    }
    if (p.mateIn > 1 && E.mateMoves(st, plies - 2, true, true).length) problems.push('faster mate exists');

    if (problems.length) {
      failed++;
      out('FAIL mate-in-' + p.mateIn + ' ' + p.fen + ' : ' + problems.join('; '));
    }
  }
  out('Verified ' + PUZZLES.length + ' puzzles (' + Object.keys(counts).sort().map(k => counts[k] + ' M' + k).join(', ') + ')');
  out(failed === 0 ? 'ALL PUZZLES VALID' : failed + ' PUZZLE(S) INVALID');
})();
