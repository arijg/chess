/* chess-engine.js — complete chess rules engine on a 0x88 board, plus a small
   alpha-beta AI. Runs in the browser (window.ChessEngine) and in Node/jsc. */
(function (global) {
  'use strict';

  const FILES = 'abcdefgh';
  const KNIGHT_OFFSETS = [18, 33, 31, 14, -18, -33, -31, -14];
  const BISHOP_DIRS = [17, 15, -17, -15];
  const ROOK_DIRS = [16, 1, -16, -1];
  const ALL_DIRS = [17, 16, 15, 1, -1, -15, -16, -17];

  const onBoard = sq => (sq & 0x88) === 0;
  const colorOf = p => (p >= 'A' && p <= 'Z') ? 'w' : 'b';
  const typeOf = p => p.toUpperCase();
  const sqToAlg = sq => FILES[sq & 15] + ((sq >> 4) + 1);
  const algToSq = a => (a.charCodeAt(1) - 49) * 16 + (a.charCodeAt(0) - 97);

  function initialState() {
    const board = new Array(128).fill(null);
    const back = 'RNBQKBNR';
    for (let f = 0; f < 8; f++) {
      board[f] = back[f];
      board[16 + f] = 'P';
      board[96 + f] = 'p';
      board[112 + f] = back[f].toLowerCase();
    }
    return {
      board, turn: 'w',
      castling: { K: true, Q: true, k: true, q: true },
      ep: -1, halfmove: 0, fullmove: 1,
    };
  }

  function loadFEN(fen) {
    const [pos, turn, castle, ep, half, full] = fen.trim().split(/\s+/);
    const board = new Array(128).fill(null);
    let rank = 7, file = 0;
    for (const ch of pos) {
      if (ch === '/') { rank--; file = 0; }
      else if (ch >= '1' && ch <= '8') file += +ch;
      else { board[rank * 16 + file] = ch; file++; }
    }
    return {
      board, turn: turn || 'w',
      castling: {
        K: !!castle && castle.includes('K'), Q: !!castle && castle.includes('Q'),
        k: !!castle && castle.includes('k'), q: !!castle && castle.includes('q'),
      },
      ep: ep && ep !== '-' ? algToSq(ep) : -1,
      halfmove: +half || 0, fullmove: +full || 1,
    };
  }

  function findKing(board, color) {
    const k = color === 'w' ? 'K' : 'k';
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      if (board[sq] === k) return sq;
    }
    return -1;
  }

  // Is square `sq` attacked by side `by`?
  function attacked(board, sq, by) {
    if (by === 'w') {
      for (const d of [-15, -17]) {
        const s = sq + d;
        if (onBoard(s) && board[s] === 'P') return true;
      }
    } else {
      for (const d of [15, 17]) {
        const s = sq + d;
        if (onBoard(s) && board[s] === 'p') return true;
      }
    }
    for (const d of KNIGHT_OFFSETS) {
      const s = sq + d;
      if (onBoard(s)) {
        const p = board[s];
        if (p && colorOf(p) === by && typeOf(p) === 'N') return true;
      }
    }
    for (const d of ALL_DIRS) {
      const s = sq + d;
      if (onBoard(s)) {
        const p = board[s];
        if (p && colorOf(p) === by && typeOf(p) === 'K') return true;
      }
    }
    for (const d of BISHOP_DIRS) {
      let s = sq + d;
      while (onBoard(s)) {
        const p = board[s];
        if (p) {
          if (colorOf(p) === by && (typeOf(p) === 'B' || typeOf(p) === 'Q')) return true;
          break;
        }
        s += d;
      }
    }
    for (const d of ROOK_DIRS) {
      let s = sq + d;
      while (onBoard(s)) {
        const p = board[s];
        if (p) {
          if (colorOf(p) === by && (typeOf(p) === 'R' || typeOf(p) === 'Q')) return true;
          break;
        }
        s += d;
      }
    }
    return false;
  }

  function pseudoMoves(state) {
    const { board, turn } = state;
    const moves = [];
    const add = (from, to, opts = {}) => moves.push({
      from, to,
      captured: opts.captured !== undefined ? opts.captured : (board[to] || null),
      promotion: opts.promotion || null,
      flags: opts.flags || null,
    });
    const addPawn = (from, to, opts = {}) => {
      const promoRank = turn === 'w' ? 7 : 0;
      if ((to >> 4) === promoRank) {
        for (const p of ['Q', 'R', 'B', 'N']) add(from, to, { ...opts, promotion: p });
      } else add(from, to, opts);
    };

    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = board[sq];
      if (!p || colorOf(p) !== turn) continue;
      const t = typeOf(p);

      if (t === 'P') {
        const fwd = turn === 'w' ? 16 : -16;
        const one = sq + fwd;
        if (onBoard(one) && !board[one]) {
          addPawn(sq, one);
          const startRank = turn === 'w' ? 1 : 6;
          if ((sq >> 4) === startRank && !board[sq + 2 * fwd]) {
            add(sq, sq + 2 * fwd, { flags: 'd' });
          }
        }
        for (const d of [fwd - 1, fwd + 1]) {
          const to = sq + d;
          if (!onBoard(to)) continue;
          if (board[to] && colorOf(board[to]) !== turn) addPawn(sq, to);
          else if (to === state.ep) add(sq, to, { flags: 'e', captured: turn === 'w' ? 'p' : 'P' });
        }
      } else if (t === 'N' || t === 'K') {
        for (const d of (t === 'N' ? KNIGHT_OFFSETS : ALL_DIRS)) {
          const to = sq + d;
          if (onBoard(to) && (!board[to] || colorOf(board[to]) !== turn)) add(sq, to);
        }
      } else {
        const dirs = t === 'B' ? BISHOP_DIRS : t === 'R' ? ROOK_DIRS : ALL_DIRS;
        for (const d of dirs) {
          let to = sq + d;
          while (onBoard(to)) {
            if (!board[to]) add(sq, to);
            else {
              if (colorOf(board[to]) !== turn) add(sq, to);
              break;
            }
            to += d;
          }
        }
      }
    }

    // Castling
    const opp = turn === 'w' ? 'b' : 'w';
    const base = turn === 'w' ? 0 : 112;
    const K = turn === 'w' ? 'K' : 'k';
    const R = turn === 'w' ? 'R' : 'r';
    const canK = turn === 'w' ? state.castling.K : state.castling.k;
    const canQ = turn === 'w' ? state.castling.Q : state.castling.q;
    if (canK && board[base + 4] === K && !board[base + 5] && !board[base + 6] && board[base + 7] === R
      && !attacked(board, base + 4, opp) && !attacked(board, base + 5, opp) && !attacked(board, base + 6, opp)) {
      add(base + 4, base + 6, { flags: 'ck' });
    }
    if (canQ && board[base + 4] === K && !board[base + 3] && !board[base + 2] && !board[base + 1] && board[base] === R
      && !attacked(board, base + 4, opp) && !attacked(board, base + 3, opp) && !attacked(board, base + 2, opp)) {
      add(base + 4, base + 2, { flags: 'cq' });
    }
    return moves;
  }

  function makeMove(state, m) {
    const board = state.board.slice();
    const castling = { ...state.castling };
    const turn = state.turn;
    let ep = -1;
    let halfmove = state.halfmove + 1;
    const piece = board[m.from];

    board[m.from] = null;
    board[m.to] = m.promotion
      ? (turn === 'w' ? m.promotion : m.promotion.toLowerCase())
      : piece;

    if (m.flags === 'e') board[m.to + (turn === 'w' ? -16 : 16)] = null;
    if (m.flags === 'd') ep = m.from + (turn === 'w' ? 16 : -16);
    if (typeOf(piece) === 'P' || m.captured) halfmove = 0;

    if (typeOf(piece) === 'K') {
      if (turn === 'w') { castling.K = false; castling.Q = false; }
      else { castling.k = false; castling.q = false; }
      if (m.flags === 'ck') { board[m.to - 1] = board[m.to + 1]; board[m.to + 1] = null; }
      if (m.flags === 'cq') { board[m.to + 1] = board[m.to - 2]; board[m.to - 2] = null; }
    }
    // A rook moving from, or anything landing on, a rook home square kills that right.
    if (m.from === 7 || m.to === 7) castling.K = false;
    if (m.from === 0 || m.to === 0) castling.Q = false;
    if (m.from === 119 || m.to === 119) castling.k = false;
    if (m.from === 112 || m.to === 112) castling.q = false;

    return {
      board,
      turn: turn === 'w' ? 'b' : 'w',
      castling, ep, halfmove,
      fullmove: state.fullmove + (turn === 'b' ? 1 : 0),
    };
  }

  function legalMoves(state) {
    return pseudoMoves(state).filter(m => {
      const next = makeMove(state, m);
      const k = findKing(next.board, state.turn);
      return !attacked(next.board, k, next.turn);
    });
  }

  function inCheck(state) {
    const k = findKing(state.board, state.turn);
    return attacked(state.board, k, state.turn === 'w' ? 'b' : 'w');
  }

  function fenKey(state) {
    let s = '';
    for (let r = 7; r >= 0; r--) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = state.board[r * 16 + f];
        if (!p) empty++;
        else {
          if (empty) { s += empty; empty = 0; }
          s += p;
        }
      }
      if (empty) s += empty;
      if (r) s += '/';
    }
    const c = (state.castling.K ? 'K' : '') + (state.castling.Q ? 'Q' : '')
      + (state.castling.k ? 'k' : '') + (state.castling.q ? 'q' : '');
    return s + ' ' + state.turn + ' ' + (c || '-') + ' ' + (state.ep >= 0 ? sqToAlg(state.ep) : '-');
  }

  function insufficientMaterial(board) {
    const minors = [];
    const bishopSquareColors = new Set();
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = board[sq];
      if (!p) continue;
      const t = typeOf(p);
      if (t === 'P' || t === 'R' || t === 'Q') return false;
      if (t === 'K') continue;
      minors.push(t);
      if (t === 'B') bishopSquareColors.add(((sq >> 4) + (sq & 15)) & 1);
    }
    if (minors.length <= 1) return true; // K vs K, or K+minor vs K
    return minors.every(t => t === 'B') && bishopSquareColors.size === 1;
  }

  function gameStatus(state, fenCounts) {
    const moves = legalMoves(state);
    if (!moves.length) {
      if (inCheck(state)) {
        return { over: true, result: state.turn === 'w' ? '0-1' : '1-0', reason: 'checkmate' };
      }
      return { over: true, result: '½-½', reason: 'stalemate' };
    }
    if (insufficientMaterial(state.board)) return { over: true, result: '½-½', reason: 'insufficient material' };
    if (state.halfmove >= 100) return { over: true, result: '½-½', reason: 'fifty-move rule' };
    if (fenCounts && (fenCounts.get(fenKey(state)) || 0) >= 3) {
      return { over: true, result: '½-½', reason: 'threefold repetition' };
    }
    return { over: false };
  }

  function san(state, m) {
    const piece = state.board[m.from];
    const t = typeOf(piece);
    let s;
    if (m.flags === 'ck') s = 'O-O';
    else if (m.flags === 'cq') s = 'O-O-O';
    else if (t === 'P') {
      s = m.captured ? FILES[m.from & 15] + 'x' : '';
      s += sqToAlg(m.to);
      if (m.promotion) s += '=' + m.promotion;
    } else {
      s = t;
      const others = legalMoves(state).filter(x =>
        x.to === m.to && x.from !== m.from && typeOf(state.board[x.from]) === t);
      if (others.length) {
        const sameFile = others.some(x => (x.from & 15) === (m.from & 15));
        const sameRank = others.some(x => (x.from >> 4) === (m.from >> 4));
        if (!sameFile) s += FILES[m.from & 15];
        else if (!sameRank) s += String((m.from >> 4) + 1);
        else s += sqToAlg(m.from);
      }
      if (m.captured) s += 'x';
      s += sqToAlg(m.to);
    }
    const next = makeMove(state, m);
    if (inCheck(next)) s += legalMoves(next).length ? '+' : '#';
    return s;
  }

  function perft(state, depth) {
    if (depth === 0) return 1;
    let nodes = 0;
    for (const m of legalMoves(state)) nodes += perft(makeMove(state, m), depth - 1);
    return nodes;
  }

  /* ---------------- Simple AI: negamax + alpha-beta + piece-square tables ---------------- */

  const VALUES = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 20000 };
  // Tables from white's perspective, index 0 = a8 ... 63 = h1.
  const PST = {
    P: [
      0, 0, 0, 0, 0, 0, 0, 0,
      50, 50, 50, 50, 50, 50, 50, 50,
      10, 10, 20, 30, 30, 20, 10, 10,
      5, 5, 10, 25, 25, 10, 5, 5,
      0, 0, 0, 20, 20, 0, 0, 0,
      5, -5, -10, 0, 0, -10, -5, 5,
      5, 10, 10, -20, -20, 10, 10, 5,
      0, 0, 0, 0, 0, 0, 0, 0],
    N: [
      -50, -40, -30, -30, -30, -30, -40, -50,
      -40, -20, 0, 0, 0, 0, -20, -40,
      -30, 0, 10, 15, 15, 10, 0, -30,
      -30, 5, 15, 20, 20, 15, 5, -30,
      -30, 0, 15, 20, 20, 15, 0, -30,
      -30, 5, 10, 15, 15, 10, 5, -30,
      -40, -20, 0, 5, 5, 0, -20, -40,
      -50, -40, -30, -30, -30, -30, -40, -50],
    B: [
      -20, -10, -10, -10, -10, -10, -10, -20,
      -10, 0, 0, 0, 0, 0, 0, -10,
      -10, 0, 5, 10, 10, 5, 0, -10,
      -10, 5, 5, 10, 10, 5, 5, -10,
      -10, 0, 10, 10, 10, 10, 0, -10,
      -10, 10, 10, 10, 10, 10, 10, -10,
      -10, 5, 0, 0, 0, 0, 5, -10,
      -20, -10, -10, -10, -10, -10, -10, -20],
    R: [
      0, 0, 0, 0, 0, 0, 0, 0,
      5, 10, 10, 10, 10, 10, 10, 5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      0, 0, 0, 5, 5, 0, 0, 0],
    Q: [
      -20, -10, -10, -5, -5, -10, -10, -20,
      -10, 0, 0, 0, 0, 0, 0, -10,
      -10, 0, 5, 5, 5, 5, 0, -10,
      -5, 0, 5, 5, 5, 5, 0, -5,
      0, 0, 5, 5, 5, 5, 0, -5,
      -10, 5, 5, 5, 5, 5, 0, -10,
      -10, 0, 5, 0, 0, 0, 0, -10,
      -20, -10, -10, -5, -5, -10, -10, -20],
    K: [
      -30, -40, -40, -50, -50, -40, -40, -30,
      -30, -40, -40, -50, -50, -40, -40, -30,
      -30, -40, -40, -50, -50, -40, -40, -30,
      -30, -40, -40, -50, -50, -40, -40, -30,
      -20, -30, -30, -40, -40, -30, -30, -20,
      -10, -20, -20, -20, -20, -20, -20, -10,
      20, 20, 0, 0, 0, 0, 20, 20,
      20, 30, 10, 0, 0, 10, 30, 20],
  };

  function evaluate(state) {
    let score = 0;
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = state.board[sq];
      if (!p) continue;
      const c = colorOf(p);
      const t = typeOf(p);
      const f = sq & 15, r = sq >> 4;
      const idx = c === 'w' ? (7 - r) * 8 + f : r * 8 + f;
      const v = VALUES[t] + PST[t][idx];
      score += c === 'w' ? v : -v;
    }
    return state.turn === 'w' ? score : -score;
  }

  function orderMoves(state, moves) {
    const score = m =>
      (m.captured ? VALUES[typeOf(m.captured)] * 10 - VALUES[typeOf(state.board[m.from])] : 0)
      + (m.promotion ? VALUES[m.promotion] : 0);
    return moves.slice().sort((a, b) => score(b) - score(a));
  }

  function search(state, depth, alpha, beta) {
    const moves = legalMoves(state);
    if (!moves.length) return inCheck(state) ? -(100000 + depth) : 0;
    if (state.halfmove >= 100) return 0;
    if (depth <= 0) return evaluate(state);
    for (const m of orderMoves(state, moves)) {
      const s = -search(makeMove(state, m), depth - 1, -beta, -alpha);
      if (s >= beta) return beta;
      if (s > alpha) alpha = s;
    }
    return alpha;
  }

  function bestMove(state, depth = 2) {
    const moves = legalMoves(state);
    if (!moves.length) return null;
    const scored = orderMoves(state, moves).map(m => ({
      m, score: -search(makeMove(state, m), depth - 1, -Infinity, Infinity),
    }));
    const best = Math.max(...scored.map(x => x.score));
    const jitter = depth <= 1 ? 30 : depth === 2 ? 15 : 0;
    const pool = scored.filter(x => x.score >= best - jitter);
    return pool[Math.floor(Math.random() * pool.length)].m;
  }

  const ChessEngine = {
    FILES, initialState, loadFEN, legalMoves, makeMove, inCheck, gameStatus,
    san, fenKey, perft, bestMove, insufficientMaterial,
    sqToAlg, algToSq, colorOf, typeOf, findKing, attacked,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = ChessEngine;
  else global.ChessEngine = ChessEngine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
