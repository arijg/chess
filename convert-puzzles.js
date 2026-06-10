/* convert-puzzles.js — validates Lichess-format puzzles (global RAW) against
   the engine and emits puzzles-data.js. Lichess convention: FEN is the
   position BEFORE the opponent's setup move; line[0] is that setup move and
   the solver answers line[1], line[3], ... Every move of every line must be
   legal, and mate-themed puzzles must end in checkmate.
   Run with: jsc chess-engine.js <sample.js> convert-puzzles.js > puzzles-data.js */
(function () {
  'use strict';
  const E = ChessEngine;

  function findUci(state, u) {
    const from = E.algToSq(u.slice(0, 2));
    const to = E.algToSq(u.slice(2, 4));
    const promo = u[4] ? u[4].toUpperCase() : null;
    return E.legalMoves(state).find(m => m.from === from && m.to === to && (m.promotion || null) === promo);
  }

  const out = [];
  let rejected = 0;
  for (const p of RAW) {
    let st = E.loadFEN(p.fen);
    let ok = true;
    for (const u of p.line) {
      const m = findUci(st, u);
      if (!m) { ok = false; break; }
      st = E.makeMove(st, m);
    }
    if (ok && p.themes.some(t => t.indexOf('mate') === 0 || t === 'mate')) {
      ok = E.legalMoves(st).length === 0 && E.inCheck(st);
    }
    if (ok && p.line.length < 2) ok = false;
    if (ok) out.push({ id: p.id, fen: p.fen, line: p.line, rating: p.rating, themes: p.themes });
    else rejected++;
  }

  print('/* puzzles-data.js — ' + out.length + ' puzzles sampled from the Lichess puzzle');
  print('   database (database.lichess.org, CC0). Each has a Glicko-2 difficulty');
  print('   rating, the full solution line, and theme tags; every line was');
  print('   re-validated move-by-move with the engine (' + rejected + ' rejected).');
  print('   Regenerate with: jsc chess-engine.js <sample.js> convert-puzzles.js > puzzles-data.js */');
  print('const PUZZLES = ' + JSON.stringify(out) + ';');
})();
