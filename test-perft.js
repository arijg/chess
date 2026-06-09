/* test-perft.js — verifies move generation against known perft node counts.
   Run with: jsc chess-engine.js test-perft.js   (or node, loading both files) */
(function () {
  'use strict';
  const E = typeof ChessEngine !== 'undefined' ? ChessEngine : require('./chess-engine.js');
  const out = typeof print !== 'undefined' ? print : console.log;

  const cases = [
    ['startpos', E.initialState(), [20, 400, 8902, 197281]],
    ['kiwipete', E.loadFEN('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'), [48, 2039, 97862]],
    ['pos3', E.loadFEN('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1'), [14, 191, 2812, 43238]],
    ['pos4', E.loadFEN('r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1'), [6, 264, 9467]],
    ['pos5', E.loadFEN('rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8'), [44, 1486, 62379]],
  ];

  let failed = 0;
  for (const [name, state, expected] of cases) {
    expected.forEach((want, i) => {
      const got = E.perft(state, i + 1);
      const ok = got === want;
      if (!ok) failed++;
      out((ok ? 'PASS' : 'FAIL') + ' ' + name + ' depth ' + (i + 1) + ': got ' + got + ', want ' + want);
    });
  }

  // A few rule spot-checks beyond raw counts.
  const mateState = E.loadFEN('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3');
  const st = E.gameStatus(mateState);
  const fmOk = st.over && st.reason === 'checkmate' && st.result === '0-1';
  if (!fmOk) failed++;
  out((fmOk ? 'PASS' : 'FAIL') + " fool's mate detected: " + JSON.stringify(st));

  const staleState = E.loadFEN('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  const st2 = E.gameStatus(staleState);
  const stOk = st2.over && st2.reason === 'stalemate';
  if (!stOk) failed++;
  out((stOk ? 'PASS' : 'FAIL') + ' stalemate detected: ' + JSON.stringify(st2));

  const start = E.initialState();
  const e4 = E.legalMoves(start).find(m => E.sqToAlg(m.from) === 'e2' && E.sqToAlg(m.to) === 'e4');
  const sanOk = E.san(start, e4) === 'e4';
  if (!sanOk) failed++;
  out((sanOk ? 'PASS' : 'FAIL') + ' SAN for e2-e4: ' + E.san(start, e4));

  out(failed === 0 ? 'ALL TESTS PASSED' : failed + ' TEST(S) FAILED');
})();
