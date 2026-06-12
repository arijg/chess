/* test-endgames.js — validates every endgame drill position: the FEN must
   parse to a legal position (one king each, the side not on move not in
   check — this exact bug shipped twice during development), the side to
   move must match the drill's player, and the position must be playable.
   Run with: jsc chess-engine.js endgames-data.js test-endgames.js */
(function () {
  'use strict';
  const E = typeof ChessEngine !== 'undefined' ? ChessEngine : require('./chess-engine.js');
  const DRILLS = typeof ENDGAME_DRILLS !== 'undefined' ? ENDGAME_DRILLS : require('./endgames-data.js');
  const out = typeof print !== 'undefined' ? print : console.log;

  let failed = 0;
  const ids = new Set();
  for (const d of DRILLS) {
    const problems = [];
    if (!d.id || ids.has(d.id)) problems.push('missing or duplicate id');
    ids.add(d.id);
    if (d.goal !== 'win' && d.goal !== 'draw') problems.push('bad goal "' + d.goal + '"');
    if (d.side !== 'w' && d.side !== 'b') problems.push('bad side "' + d.side + '"');
    if (!d.tip) problems.push('missing tip');

    const st = E.loadFEN(d.fen);
    const wk = E.findKing(st.board, 'w');
    const bk = E.findKing(st.board, 'b');
    if (wk < 0 || bk < 0) problems.push('missing a king');
    if ((d.fen.match(/K/g) || []).length !== 1 || (d.fen.match(/k/g) || []).length !== 1) {
      problems.push('not exactly one king per side');
    }
    if (st.turn !== d.side) problems.push('side to move (' + st.turn + ') is not the drill side (' + d.side + ')');
    if (wk >= 0 && bk >= 0) {
      const idleKing = st.turn === 'w' ? bk : wk;
      const idleColor = st.turn === 'w' ? 'b' : 'w';
      if (E.attacked(st.board, idleKing, idleColor === 'b' ? 'w' : 'b')) {
        problems.push('illegal: the side not on move is in check');
      }
      if (!E.legalMoves(st).length) problems.push('no legal moves at the start');
    }

    if (problems.length) {
      failed++;
      out('FAIL ' + d.id + ': ' + problems.join('; '));
    }
  }
  out('Verified ' + DRILLS.length + ' endgame drills');
  out(failed === 0 ? 'ALL DRILLS VALID' : failed + ' DRILL(S) INVALID');
})();
