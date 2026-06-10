/* test-puzzles.js — re-verifies every Lichess-format puzzle: each move of
   the solution line must be legal, lines must alternate from the FEN's side
   to move, and mate-themed puzzles must end in checkmate.
   Run with: jsc chess-engine.js puzzles-data.js test-puzzles.js */
(function () {
  'use strict';
  const E = typeof ChessEngine !== 'undefined' ? ChessEngine : require('./chess-engine.js');
  const out = typeof print !== 'undefined' ? print : console.log;

  function findUci(state, u) {
    const from = E.algToSq(u.slice(0, 2));
    const to = E.algToSq(u.slice(2, 4));
    const promo = u[4] ? u[4].toUpperCase() : null;
    return E.legalMoves(state).find(m => m.from === from && m.to === to && (m.promotion || null) === promo);
  }

  let failed = 0;
  const buckets = {};
  for (const p of PUZZLES) {
    const b = p.rating < 950 ? '<950' : p.rating < 1700 ? '950-1700' : '1700+';
    buckets[b] = (buckets[b] || 0) + 1;
    const problems = [];
    if (p.line.length < 2) problems.push('line too short');
    if (p.line.length % 2 !== 0) problems.push('line should end on a solver move');
    let st = E.loadFEN(p.fen);
    for (const u of p.line) {
      const m = findUci(st, u);
      if (!m) { problems.push('illegal move ' + u); break; }
      st = E.makeMove(st, m);
    }
    if (!problems.length && p.themes.some(t => /^mateIn\d$/.test(t) || t === 'mate')) {
      if (!(E.legalMoves(st).length === 0 && E.inCheck(st))) problems.push('mate theme but no mate at line end');
    }
    if (typeof p.rating !== 'number' || p.rating < 300 || p.rating > 3500) problems.push('bad rating');
    if (problems.length) {
      failed++;
      out('FAIL ' + p.id + ' (' + p.rating + '): ' + problems.join('; '));
    }
  }
  out('Verified ' + PUZZLES.length + ' puzzles | difficulty: ' + JSON.stringify(buckets));
  out(failed === 0 ? 'ALL PUZZLES VALID' : failed + ' PUZZLE(S) INVALID');
})();
