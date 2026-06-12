/* online-core.js — the move/turn/validation state machine for online play,
   with no DOM and no sockets so it can be unit-tested headless (CI) and
   reused by online.js in the browser. Each peer runs its own instance and
   validates every move with the shared engine, so an illegal or
   out-of-turn message from the wire is rejected rather than trusted. */
(function (global) {
  'use strict';

  const E = typeof ChessEngine !== 'undefined' ? ChessEngine : require('./chess-engine.js');
  const uciOf = m => E.sqToAlg(m.from) + E.sqToAlg(m.to) + (m.promotion ? m.promotion.toLowerCase() : '');

  function OnlineGame(myColor) {
    this.myColor = myColor;          // 'w' | 'b'
    this.state = E.initialState();
    this.moveLog = [];               // { uci, san }
    this.fenCounts = new Map([[E.fenKey(this.state), 1]]);
    this.gameOver = null;            // { result, reason } once finished
  }

  OnlineGame.prototype.turn = function () { return this.state.turn; };
  OnlineGame.prototype.myTurn = function () {
    return !this.gameOver && this.state.turn === this.myColor;
  };

  OnlineGame.prototype._matchLegal = function (uci) {
    const from = E.algToSq(uci.slice(0, 2));
    const to = E.algToSq(uci.slice(2, 4));
    const promo = uci[4] ? uci[4].toUpperCase() : null;
    return E.legalMoves(this.state).find(m =>
      m.from === from && m.to === to && (m.promotion || null) === promo) || null;
  };

  OnlineGame.prototype._advance = function (m) {
    const san = E.san(this.state, m);
    this.state = E.makeMove(this.state, m);
    this.moveLog.push({ uci: uciOf(m), san });
    const key = E.fenKey(this.state);
    this.fenCounts.set(key, (this.fenCounts.get(key) || 0) + 1);
    const status = E.gameStatus(this.state, this.fenCounts);
    if (status.over) this.gameOver = status;
    return { ok: true, san, move: m, gameOver: this.gameOver };
  };

  // A move the local player is trying to make.
  OnlineGame.prototype.tryLocalMove = function (uci) {
    if (this.gameOver) return { ok: false, reason: 'game over' };
    if (this.state.turn !== this.myColor) return { ok: false, reason: 'not your turn' };
    const m = this._matchLegal(uci);
    if (!m) return { ok: false, reason: 'illegal move' };
    return this._advance(m);
  };

  // A move received from the opponent over the wire.
  OnlineGame.prototype.applyRemoteMove = function (uci) {
    if (this.gameOver) return { ok: false, reason: 'game over' };
    if (this.state.turn === this.myColor) return { ok: false, reason: 'not opponent turn' };
    const m = this._matchLegal(uci);
    if (!m) return { ok: false, reason: 'illegal move' };
    return this._advance(m);
  };

  // color is the color that resigned / lost.
  OnlineGame.prototype.resign = function (color) {
    if (this.gameOver) return this.gameOver;
    this.gameOver = { over: true, result: color === 'w' ? '0-1' : '1-0', reason: 'resignation' };
    return this.gameOver;
  };

  OnlineGame.prototype.drawAgreed = function () {
    if (this.gameOver) return this.gameOver;
    this.gameOver = { over: true, result: '½-½', reason: 'agreement' };
    return this.gameOver;
  };

  OnlineGame.uciOf = uciOf;

  if (typeof module !== 'undefined' && module.exports) module.exports = OnlineGame;
  else global.OnlineGame = OnlineGame;
})(typeof globalThis !== 'undefined' ? globalThis : this);
