/* import-puzzles.js — mines verified mate-in-1/2/3 puzzles from a list of
   bare FEN positions (global CANDIDATES, e.g. sampled from the yacpdb-based
   432k-chess-puzzles collection; White to move and mate is implied).
   Every emitted puzzle is verified with the exact quiet-move mate solver.
   Run with:
     jsc chess-engine.js <candidates.js> import-puzzles.js > puzzles-data.js */
(function () {
  'use strict';
  const E = ChessEngine;
  const TARGET = { 1: 60, 2: 120, 3: 20 };
  const TIME_LIMIT_MS = 420000;
  const found = { 1: [], 2: [], 3: [] };
  const seen = new Set();
  const t0 = Date.now();

  function pieceCount(board) {
    let n = 0;
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      if (board[sq]) n++;
    }
    return n;
  }
  const uci = m => E.sqToAlg(m.from) + E.sqToAlg(m.to) + (m.promotion ? m.promotion.toLowerCase() : '');
  const done = () => found[1].length >= TARGET[1] && found[2].length >= TARGET[2] && found[3].length >= TARGET[3];

  // Count quiet-mate first moves, stopping at 2 (uniqueness check only).
  function keyMoves(st, plies, cap) {
    const out = [];
    for (const m of E.legalMoves(st)) {
      if (E.forcesMate(st, m, plies, true)) {
        out.push(m);
        if (out.length >= cap) break;
      }
    }
    return out;
  }

  let scanned = 0;
  for (const fen of CANDIDATES) {
    if (done() || Date.now() - t0 > TIME_LIMIT_MS) break;
    scanned++;
    const key = fen + ' w - -';
    if (seen.has(key)) continue;

    const st = E.loadFEN(key);
    // Illegal if the side not on move is already in check.
    const bk = E.findKing(st.board, 'b');
    if (bk < 0 || E.attacked(st.board, bk, 'w')) continue;
    if (!E.legalMoves(st).length) continue;
    const pc = pieceCount(st.board);

    const m1 = E.mateMoves(st, 1, true);
    if (m1.length) {
      if (found[1].length < TARGET[1]) {
        found[1].push({ fen: key, mateIn: 1, rating: 400 + pc * 15, best: uci(m1[0]) });
        seen.add(key);
      }
      continue;
    }
    // Cheap alpha-beta prefilter before the expensive exact solve.
    if (found[2].length < TARGET[2] && E.evaluatePosition(st, 3) >= 99000) {
      const mm = keyMoves(st, 3, 2);
      if (mm.length === 1) {
        found[2].push({ fen: key, mateIn: 2, rating: 900 + pc * 15, best: uci(mm[0]) });
        seen.add(key);
        continue;
      }
    }
    if (found[3].length < TARGET[3] && pc <= 12 && E.evaluatePosition(st, 5) >= 99000
      && !keyMoves(st, 3, 1).length) {
      // Composition keys are unique by convention; verifying uniqueness at
      // depth 5 with quiet moves is too slow, so store the first key found.
      const mm = E.mateMoves(st, 5, true, true);
      if (mm.length) {
        found[3].push({ fen: key, mateIn: 3, rating: 1400 + pc * 12, best: uci(mm[0]) });
        seen.add(key);
      }
    }
  }

  const all = found[1].concat(found[2], found[3]);
  print('/* puzzles-data.js — ' + all.length + ' engine-verified puzzles mined from the');
  print('   432k-chess-puzzles collection (github.com/rebeccaloran/432k-chess-puzzles,');
  print('   positions from yacpdb.org). ' + found[1].length + ' mate-in-1, ' + found[2].length + ' mate-in-2, '
    + found[3].length + ' mate-in-3; ' + scanned + ' candidates scanned.');
  print('   Regenerate with: jsc chess-engine.js <candidates.js> import-puzzles.js > puzzles-data.js */');
  print('const PUZZLES = ' + JSON.stringify(all) + ';');
})();
