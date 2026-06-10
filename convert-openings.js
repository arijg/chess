/* convert-openings.js — converts the lichess-org/chess-openings dataset
   (global RAW: [eco, name, pgn] rows) into openings-data.js with UCI move
   lists. Each PGN line is parsed by matching tokens against the engine's
   own generated SAN, which validates every opening move-by-move.
   Run with: jsc chess-engine.js <openings-raw.js> convert-openings.js > openings-data.js */
(function () {
  'use strict';
  const E = ChessEngine;
  const uci = m => E.sqToAlg(m.from) + E.sqToAlg(m.to) + (m.promotion ? m.promotion.toLowerCase() : '');
  const strip = s => s.replace(/[+#]$/, '');

  const out = [];
  let rejected = 0;
  for (const [eco, name, pgn] of RAW) {
    const tokens = pgn.split(/\s+/).filter(t => t && !/^\d+\.+$/.test(t));
    let st = E.initialState();
    const moves = [];
    let ok = true;
    for (const tok of tokens) {
      const legal = E.legalMoves(st);
      let m = legal.find(x => E.san(st, x) === tok);
      if (!m) m = legal.find(x => strip(E.san(st, x)) === strip(tok));
      if (!m) { ok = false; break; }
      moves.push(uci(m));
      st = E.makeMove(st, m);
    }
    if (ok && moves.length) out.push({ eco, name, uci: moves.join(' ') });
    else rejected++;
  }

  print('/* openings-data.js — ' + out.length + ' named chess openings from');
  print('   lichess-org/chess-openings (CC0). Every line engine-validated');
  print('   move-by-move (' + rejected + ' rejected). Regenerate with:');
  print('   jsc chess-engine.js <openings-raw.js> convert-openings.js > openings-data.js */');
  print('const OPENINGS = ' + JSON.stringify(out) + ';');
})();
