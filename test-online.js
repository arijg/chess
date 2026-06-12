/* test-online.js — verifies the online game state machine: turn-gating,
   move validation on both ends, illegal/out-of-turn rejection, two synced
   peers reaching the same position, and game-over via mate and resignation.
   Run with: jsc chess-engine.js online-core.js test-online.js */
(function () {
  'use strict';
  const OG = typeof globalThis.OnlineGame !== 'undefined' ? globalThis.OnlineGame : require('./online-core.js');
  const out = typeof print !== 'undefined' ? print : console.log;
  let failed = 0;
  const ok = (cond, msg) => { if (!cond) { failed++; out('FAIL ' + msg); } };

  // Two peers, one White, one Black, both starting from the initial position.
  const white = new OG('w');
  const black = new OG('b');

  ok(white.myTurn() === true, 'white moves first');
  ok(black.myTurn() === false, 'black waits first');

  // Black cannot move out of turn, and a nonsense move is rejected.
  ok(black.tryLocalMove('e7e5').ok === false, 'black blocked out of turn');
  ok(white.tryLocalMove('e2e9').ok === false, 'illegal target rejected');

  // Play a full game into Fool's mate, mirrored across both peers.
  const line = ['f2f3', 'e7e5', 'g2g4', 'd8h4'];
  for (let i = 0; i < line.length; i++) {
    const mover = i % 2 === 0 ? white : black;
    const watcher = i % 2 === 0 ? black : white;
    const r = mover.tryLocalMove(line[i]);
    ok(r.ok, 'local move ' + line[i] + ' accepted');
    const r2 = watcher.applyRemoteMove(line[i]);
    ok(r2.ok, 'remote move ' + line[i] + ' applied');
  }

  ok(white.gameOver && white.gameOver.reason === 'checkmate', 'white sees checkmate');
  ok(black.gameOver && black.gameOver.reason === 'checkmate', 'black sees checkmate');
  ok(white.gameOver.result === '0-1', 'result is 0-1 (black mates)');
  ok(white.fenKeyMatch === undefined, 'sanity');
  ok(white.state.turn === black.state.turn, 'peers agree on side to move');
  ok(white.moveLog.length === 4 && black.moveLog.length === 4, 'both logged 4 moves');
  ok(white.moveLog[3].san === 'Qh4#', 'final move SAN is Qh4#');

  // Moves after game over are rejected.
  ok(white.tryLocalMove('e1f2').ok === false, 'no moves after mate');

  // Resignation.
  const g = new OG('w');
  g.tryLocalMove('e2e4');
  const res = g.resign('w');
  ok(res.result === '0-1' && res.reason === 'resignation', 'white resignation -> 0-1');

  // Draw by agreement.
  const d = new OG('w');
  ok(d.drawAgreed().result === '½-½', 'draw agreement -> 1/2');

  out('Ran online state-machine checks');
  out(failed === 0 ? 'ALL ONLINE TESTS PASSED' : failed + ' ONLINE TEST(S) FAILED');
})();
