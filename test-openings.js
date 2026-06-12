/* test-openings.js — re-validates every opening line move-by-move.
   Run with: jsc chess-engine.js openings-data.js test-openings.js */
(function () {
  'use strict';
  const E = typeof ChessEngine !== 'undefined' ? ChessEngine : require('./chess-engine.js');
  const out = typeof print !== 'undefined' ? print : console.log;

  let failed = 0;
  for (const o of OPENINGS) {
    let st = E.initialState();
    for (const u of o.uci.split(' ')) {
      const from = E.algToSq(u.slice(0, 2));
      const to = E.algToSq(u.slice(2, 4));
      const promo = u[4] ? u[4].toUpperCase() : null;
      const m = E.legalMoves(st).find(x => x.from === from && x.to === to && (x.promotion || null) === promo);
      if (!m) {
        failed++;
        out('FAIL ' + o.eco + ' ' + o.name + ': illegal move ' + u);
        break;
      }
      st = E.makeMove(st, m);
    }
  }
  out('Verified ' + OPENINGS.length + ' openings');
  out(failed === 0 ? 'ALL OPENINGS VALID' : failed + ' OPENING(S) INVALID');
})();
