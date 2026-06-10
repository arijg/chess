/* app.js — board UI, clocks, move list, drag & drop, history navigation,
   post-game analysis, premoves, and game flow. */
(function () {
  'use strict';

  const E = ChessEngine;
  const VALUES = { P: 1, N: 3, B: 3, R: 5, Q: 9 };
  const pieceClass = p => 'pc-' + E.colorOf(p) + E.typeOf(p);
  const uciOfMove = m => E.sqToAlg(m.from) + E.sqToAlg(m.to) + (m.promotion ? m.promotion.toLowerCase() : '');
  const fullFen = s => E.fenKey(s) + ' ' + s.halfmove + ' ' + s.fullmove;

  // Difficulty tiers backed by the lazy-loaded Stockfish WASM engine.
  // Internal Elo sits above the label's vibe because the engine's UCI_Elo
  // scale is anchored to engine pools, which run below online human
  // ratings; thinking time also scales up the ladder, as the calibration
  // assumes a real time control.
  const SF_LEVELS = {
    sfcasual: { label: 'Casual (Stockfish)', elo: 1500, movetime: 500 },
    sfclub: { label: 'Club (Stockfish)', elo: 2000, movetime: 1000 },
    sfexpert: { label: 'Expert (Stockfish)', elo: 2400, movetime: 1500 },
    sfmaster: { label: 'Master (Stockfish)', elo: 2900, movetime: 2000 },
    sfmax: { label: 'Maximum (Stockfish)', movetime: 2500 },
  };

  const $ = id => document.getElementById(id);
  const boardEl = $('board');
  const promoEl = $('promo');
  const promoBox = $('promo-box');
  const gameoverEl = $('gameover');

  let states, moveLog, fenCounts, currentLegal;
  let selected = null, gameOver = null, aiThinking = false, pending = null;
  let hint = null; // {from, to, stage: 1|2} — engine suggestion for the side to move
  let viewPly = null; // null = live; otherwise index into states[] being viewed
  let premove = null, premoveSel = null; // queued move for the human while the AI thinks
  let analysis = null; // { evals[], anns[], best{}, progress, complete }
  let explore = null; // analysis-board variation: { basePly, states[], log: [{m, san}] }
  let flipped = false;
  let gen = 0; // generation counter: invalidates queued work after new game/undo
  const settings = { mode: 'two', human: 'w', depth: '2', minutes: 10, autoQueen: false };
  let clocks = null, clockTimer = null, lastTick = 0;
  let squareEls = [];

  const cur = () => states[states.length - 1];
  const isLive = () => viewPly === null;
  const viewState = () => isLive() ? cur() : states[viewPly];
  const activeState = () => explore ? explore.states[explore.states.length - 1] : viewState();
  const isHumanTurn = () => settings.mode === 'two' || cur().turn === settings.human;
  const isAITurn = () => settings.mode === 'ai' && cur().turn !== settings.human && !gameOver;

  /* ---------------- Game lifecycle ---------------- */

  function newGame(opts) {
    const handoff = opts && Array.isArray(opts.moves) ? opts : null; // also called from click handlers
    gen++;
    states = [E.initialState()];
    moveLog = [];
    fenCounts = new Map([[E.fenKey(states[0]), 1]]);
    currentLegal = E.legalMoves(cur());
    selected = null; gameOver = null; pending = null; aiThinking = false; hint = null;
    viewPly = null; premove = null; premoveSel = null; analysis = null; explore = null;
    if (handoff) {
      // Replay an opening line handed over from the openings page.
      for (const u of handoff.moves) {
        const m = currentLegal.find(x => uciOfMove(x) === u);
        if (!m) break;
        const san = E.san(cur(), m);
        const next = E.makeMove(cur(), m);
        states.push(next);
        moveLog.push({ m, san });
        const key = E.fenKey(next);
        fenCounts.set(key, (fenCounts.get(key) || 0) + 1);
        currentLegal = E.legalMoves(next);
      }
      settings.human = cur().turn; // the player continues from the book position
      $('playas').value = settings.human;
    }
    flipped = settings.mode === 'ai' && settings.human === 'b';
    promoEl.hidden = true;
    gameoverEl.hidden = true;
    $('resign').textContent = 'Resign';

    clocks = settings.minutes > 0
      ? { w: settings.minutes * 60000, b: settings.minutes * 60000 }
      : null;
    if (clockTimer) clearInterval(clockTimer);
    if (clocks) {
      lastTick = performance.now();
      clockTimer = setInterval(tickClock, 100);
    }

    buildBoard();
    renderAll();
    updateEval();
    updateLines();
    if (isAITurn()) scheduleAI();
  }

  function tickClock() {
    const now = performance.now();
    const dt = now - lastTick;
    lastTick = now;
    if (!clocks || gameOver || moveLog.length === 0) { renderClocks(); return; }
    const t = cur().turn;
    clocks[t] -= dt;
    if (clocks[t] <= 0) {
      clocks[t] = 0;
      gameOver = { over: true, result: t === 'w' ? '0-1' : '1-0', reason: 'timeout' };
      sound('end');
      renderAll();
      showGameOver();
    }
    renderClocks();
  }

  function applyMove(m, animate) {
    const st = cur();
    const san = E.san(st, m);
    const next = E.makeMove(st, m);
    states.push(next);
    moveLog.push({ m, san });
    const key = E.fenKey(next);
    fenCounts.set(key, (fenCounts.get(key) || 0) + 1);
    currentLegal = E.legalMoves(next);
    selected = null; pending = null; hint = null;
    promoEl.hidden = true;

    const status = E.gameStatus(next, fenCounts);
    if (status.over) gameOver = status;

    if (gameOver) sound('end');
    else if (E.inCheck(next)) sound('check');
    else if (m.captured) sound('capture');
    else sound('move');

    renderAll();
    updateEval();
    if (animate && isLive()) animateMove(m, false);
    if (gameOver) { showGameOver(); return; }
    if (isAITurn()) scheduleAI();
    else if (premove && isHumanTurn()) {
      const myGen = gen;
      setTimeout(() => { if (myGen === gen) executePremove(); }, 150);
    }
  }

  function scheduleAI() {
    aiThinking = true;
    renderStatus();
    const myGen = gen;
    const sf = SF_LEVELS[settings.depth];
    if (sf) {
      Stockfish.go({ moves: moveLog.map(x => uciOfMove(x.m)) }, { elo: sf.elo, movetime: sf.movetime })
        .then(r => {
          if (myGen !== gen) return;
          aiThinking = false;
          const m = r.best ? currentLegal.find(x => uciOfMove(x) === r.best) : null;
          if (m && !gameOver) applyMove(m, true);
          else renderStatus();
        })
        .catch(() => {
          if (myGen !== gen) return; // engine unavailable: local fallback
          aiThinking = false;
          const m = E.bestMove(cur(), 3);
          if (m && !gameOver) applyMove(m, true);
          else renderStatus();
        });
      return;
    }
    setTimeout(() => {
      if (myGen !== gen) return; // game was reset/undone while waiting
      const m = E.bestMove(cur(), +settings.depth);
      aiThinking = false;
      if (m && !gameOver) applyMove(m, true);
      else renderStatus();
    }, 350);
  }

  function executePremove() {
    if (!premove || gameOver || aiThinking || !isHumanTurn()) return;
    const cands = currentLegal.filter(m => m.from === premove.from && m.to === premove.to);
    premove = null;
    if (!cands.length) { renderBoard(); return; } // no longer legal: cancelled
    applyMove(cands.find(x => x.promotion === 'Q') || cands[0], true);
  }

  function undo() {
    if (aiThinking || pending || !moveLog.length) return;
    gen++;
    let n = settings.mode === 'ai' && cur().turn === settings.human ? 2 : 1;
    n = Math.min(n, moveLog.length);
    for (let i = 0; i < n; i++) {
      const st = states.pop();
      const key = E.fenKey(st);
      const c = fenCounts.get(key) || 0;
      if (c > 1) fenCounts.set(key, c - 1); else fenCounts.delete(key);
      moveLog.pop();
    }
    gameOver = null;
    selected = null;
    hint = null;
    viewPly = null; premove = null; premoveSel = null; analysis = null; explore = null;
    gameoverEl.hidden = true;
    currentLegal = E.legalMoves(cur());
    // If we undid past a flag fall, give that side a little time back.
    if (clocks && clocks[cur().turn] <= 0) clocks[cur().turn] = 15000;
    renderAll();
    updateEval();
    updateLines();
    if (isAITurn()) scheduleAI();
  }

  /* ---------------- History navigation ---------------- */

  function setView(p) {
    if (explore) { explore = null; selected = null; }
    const target = (p === null || p >= states.length - 1) ? null : Math.max(0, p);
    if (target === viewPly) { renderBoard(); renderStatus(); updateLines(); return; }
    const prevIdx = isLive() ? states.length - 1 : viewPly;
    viewPly = target;
    selected = null; hint = null;
    renderBoard();
    renderMoves();
    renderStatus();
    renderGraph();
    updateEval();
    updateLines();
    const newIdx = isLive() ? states.length - 1 : viewPly;
    if (newIdx === prevIdx + 1) animateMove(moveLog[newIdx - 1].m, false);
    else if (newIdx === prevIdx - 1) animateMove(moveLog[newIdx].m, true);
  }

  const navRel = d => setView((isLive() ? states.length - 1 : viewPly) + d);

  window.addEventListener('keydown', e => {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.key === 'ArrowLeft') {
      if (explore) exploreBack(); else navRel(-1);
      e.preventDefault();
    } else if (e.key === 'ArrowRight') {
      if (!explore) navRel(1);
      e.preventDefault();
    } else if (e.key === 'ArrowUp') { setView(0); e.preventDefault(); }
    else if (e.key === 'ArrowDown') { setView(null); e.preventDefault(); }
    else if (e.key === 'Escape') {
      if (explore) exitExplore();
      else if (premove || premoveSel !== null) { premove = null; premoveSel = null; renderBoard(); }
    }
  });

  /* ---------------- Post-game analysis ---------------- */

  function startAnalysis() {
    gameoverEl.hidden = true;
    if (analysis && analysis.complete) return;
    analysis = {
      evals: new Array(states.length).fill(null),
      lines: new Array(states.length).fill(null), // top-3 engine lines per position
      anns: new Array(moveLog.length).fill(null),
      best: {}, bestUci: {}, gap: {}, progress: 0, complete: false,
      engine: 'Stockfish',
    };
    const myGen = gen;
    renderGraph();
    renderStatus();
    Stockfish.init().then(
      () => sfAnalyzeStep(myGen),
      () => { analysis.engine = 'built-in engine'; localAnalyzeStep(myGen); }
    );
  }

  function sfAnalyzeStep(myGen) {
    if (myGen !== gen || !analysis) return;
    const i = analysis.progress;
    if (i >= states.length) { finishAnalysis(); return; }
    const st = states[i];
    if (!E.legalMoves(st).length) { // terminal position: nothing to search
      analysis.evals[i] = E.evaluatePosition(st, 1);
      analysis.progress++;
      renderGraph();
      renderStatus();
      sfAnalyzeStep(myGen);
      return;
    }
    Stockfish.go({ fen: fullFen(st) }, { depth: 12, multiPV: 3 }).then(r => {
      if (myGen !== gen || !analysis) return;
      let cp = 0;
      if (r.score) {
        cp = r.score.type === 'mate'
          ? (r.score.value > 0 ? 1 : -1) * 100000
          : r.score.value;
        if (st.turn === 'b') cp = -cp; // UCI scores are from the side to move
      }
      analysis.evals[i] = cp;
      if (r.lines && r.lines.length) analysis.lines[i] = r.lines;
      if (r.best && i < moveLog.length) {
        analysis.bestUci[i] = r.best;
        // Gap between the best and second-best move (mover's perspective):
        // a huge gap means the best move was the only good one.
        const toCp = ln => ln.type === 'mate' ? (ln.value > 0 ? 1 : -1) * 10000 : ln.value;
        analysis.gap[i] = r.lines && r.lines.length >= 2
          ? Math.max(0, toCp(r.lines[0]) - toCp(r.lines[1]))
          : 0;
      }
      if (!explore && i === (isLive() ? states.length - 1 : viewPly)) updateLines();
      analysis.progress++;
      renderGraph();
      renderStatus();
      sfAnalyzeStep(myGen);
    }, () => {
      if (myGen !== gen || !analysis) return;
      analysis.engine = 'built-in engine';
      localAnalyzeStep(myGen);
    });
  }

  function localAnalyzeStep(myGen) {
    if (myGen !== gen || !analysis) return;
    const i = analysis.progress;
    if (i >= states.length) { finishAnalysis(); return; }
    if (analysis.evals[i] === null) analysis.evals[i] = E.evaluatePosition(states[i], 2);
    if (i < moveLog.length && !analysis.bestUci[i]) {
      const tops = E.topMoves(states[i], 2, 2);
      if (tops.length) {
        analysis.bestUci[i] = uciOfMove(tops[0].m);
        analysis.gap[i] = tops.length > 1 ? Math.max(0, tops[0].score - tops[1].score) : 0;
      }
    }
    analysis.progress++;
    renderGraph();
    renderStatus();
    setTimeout(() => localAnalyzeStep(myGen), 0);
  }

  function finishAnalysis() {
    const clamp = v => Math.max(-1500, Math.min(1500, v));
    for (let j = 0; j < moveLog.length; j++) {
      // Played the engine's top move: Best (★), or Great (!) when it was
      // the only good move (the runner-up loses 250+ centipawns).
      if (analysis.bestUci[j] && uciOfMove(moveLog[j].m) === analysis.bestUci[j]) {
        analysis.anns[j] = (analysis.gap[j] || 0) >= 250 && E.legalMoves(states[j]).length > 1
          ? '!' : '★';
        continue;
      }
      const before = clamp(analysis.evals[j]);
      const after = clamp(analysis.evals[j + 1]);
      const drop = j % 2 === 0 ? before - after : after - before; // from the mover's view
      analysis.anns[j] = drop >= 250 ? '??' : drop >= 120 ? '?' : drop >= 60 ? '?!' : null;
      if (analysis.anns[j] === '??' || analysis.anns[j] === '?') {
        const u = analysis.bestUci[j];
        let bm = u ? E.legalMoves(states[j]).find(x => uciOfMove(x) === u) : null;
        if (!bm) bm = E.bestMove(states[j], 2);
        if (bm) analysis.best[j] = E.san(states[j], bm);
      }
    }
    analysis.complete = true;
    renderMoves();
    renderGraph();
    renderStatus();
    updateLines();
  }

  function renderGraph() {
    const wrap = $('eval-graph-wrap');
    if (!analysis) { wrap.hidden = true; return; }
    wrap.hidden = false;
    const W = 300, H = 64, n = states.length;
    const clamp = v => Math.max(-600, Math.min(600, v));
    let path = '';
    analysis.evals.forEach((v, i) => {
      if (v === null) return;
      const x = n > 1 ? (i / (n - 1)) * W : 0;
      const y = H / 2 - (clamp(v) / 600) * (H / 2 - 3);
      path += (path ? ' L ' : 'M ') + x.toFixed(1) + ' ' + y.toFixed(1);
    });
    const idx = isLive() ? states.length - 1 : viewPly;
    const mx = n > 1 ? (idx / (n - 1)) * W : 0;
    $('eval-graph').innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">'
      + '<line x1="0" y1="' + H / 2 + '" x2="' + W + '" y2="' + H / 2 + '" stroke="#4a4843"/>'
      + (path ? '<path d="' + path + '" fill="none" stroke="#81b64c" stroke-width="1.5"/>' : '')
      + '<line x1="' + mx.toFixed(1) + '" y1="0" x2="' + mx.toFixed(1) + '" y2="' + H + '" stroke="#ffffff66"/>'
      + '</svg>';
  }

  /* ---------------- Engine lines panel (top continuations) ---------------- */

  const FIGS = {
    w: { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘' },
    b: { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞' },
  };
  const figurine = (san, color) => san.replace(/[KQRBN]/g, ch => FIGS[color][ch]);

  function fmtLineEval(cpWhite, mate) {
    if (mate !== null) return (mate > 0 ? '+M' : '−M') + Math.abs(mate);
    return (cpWhite >= 0 ? '+' : '−') + Math.abs(cpWhite / 100).toFixed(2);
  }

  // Numbered figurine SAN for a UCI line starting from `st0`.
  function lineToSan(st0, pv, maxPlies) {
    let s = st0;
    const parts = [];
    for (let i = 0; i < Math.min(pv.length, maxPlies); i++) {
      const m = E.legalMoves(s).find(x => uciOfMove(x) === pv[i]);
      if (!m) break;
      const prefix = s.turn === 'w' ? s.fullmove + '. ' : (i === 0 ? s.fullmove + '… ' : '');
      parts.push(prefix + figurine(E.san(s, m), s.turn));
      s = E.makeMove(s, m);
    }
    return parts.join(' ');
  }

  function updateLines() {
    const panel = $('engine-lines');
    if (!gameOver) { panel.hidden = true; return; }
    panel.hidden = false;
    const stA = activeState();
    const seq = ++updateLines.seq;
    if (!E.legalMoves(stA).length) {
      panel.innerHTML = '<div class="line-row line-loading">'
        + (E.inCheck(stA) ? 'Checkmate' : 'Stalemate')
        + ' — step back (←) for lines.</div>';
      return;
    }
    // Analysis already computed lines for this position: show them instantly.
    if (!explore) {
      const idx = isLive() ? states.length - 1 : viewPly;
      if (analysis && analysis.lines && analysis.lines[idx] && analysis.lines[idx].length) {
        renderLines(stA, analysis.lines[idx]);
        return;
      }
    }
    panel.innerHTML = '<div class="line-row line-loading">Engine lines…</div>';
    Stockfish.go({ fen: fullFen(stA) }, { depth: 13, multiPV: 3 }).then(r => {
      if (seq !== updateLines.seq) return;
      renderLines(stA, r.lines && r.lines.length ? r.lines : (r.score ? [r.score] : []));
    }, () => {
      if (seq !== updateLines.seq) return;
      // Stockfish unavailable: shallow top-3 from the built-in engine.
      const lines = E.topMoves(stA, 2, 3).map(t => {
        const pv = [uciOfMove(t.m)];
        let s2 = E.makeMove(stA, t.m);
        for (let k = 0; k < 3; k++) {
          const bm = E.bestMove(s2, 2);
          if (!bm) break;
          pv.push(uciOfMove(bm));
          s2 = E.makeMove(s2, bm);
        }
        return { type: 'cp', value: t.score, pv };
      });
      renderLines(stA, lines);
    });
  }
  updateLines.seq = 0;

  function renderLines(stA, lines) {
    const panel = $('engine-lines');
    if (!lines.length) { panel.innerHTML = '<div class="line-row line-loading">No line found.</div>'; return; }
    panel.innerHTML = '';
    for (const ln of lines) {
      const sign = stA.turn === 'b' ? -1 : 1; // UCI scores are side-to-move
      const mate = ln.type === 'mate' ? sign * ln.value : null;
      const cpWhite = ln.type === 'cp' ? sign * ln.value : (mate > 0 ? 10000 : -10000);
      const row = document.createElement('div');
      row.className = 'line-row';
      const badge = document.createElement('span');
      badge.className = 'line-eval' + (cpWhite < 0 ? ' black-better' : '');
      badge.textContent = fmtLineEval(ln.type === 'cp' ? cpWhite : 0, mate);
      const movesSpan = document.createElement('span');
      movesSpan.className = 'line-moves';
      movesSpan.textContent = lineToSan(stA, ln.pv, 10);
      row.appendChild(badge);
      row.appendChild(movesSpan);
      if (ln.pv.length) {
        row.addEventListener('click', () => {
          const m = E.legalMoves(activeState()).find(x => uciOfMove(x) === ln.pv[0]);
          if (m) exploreMove(m, false);
        });
      }
      panel.appendChild(row);
    }
  }

  $('explore-exit').addEventListener('click', exitExplore);

  $('eval-graph-wrap').addEventListener('click', e => {
    if (!analysis || states.length < 2) return;
    const r = e.currentTarget.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    setView(Math.round(frac * (states.length - 1)));
  });

  /* ---------------- Board DOM ---------------- */

  function buildBoard() {
    boardEl.innerHTML = '';
    squareEls = [];
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const file = flipped ? 7 - col : col;
        const rank = flipped ? row : 7 - row;
        const sq = rank * 16 + file;
        const d = document.createElement('div');
        d.className = ((file + rank) % 2 === 0) ? 'square dark' : 'square light';
        d.dataset.sq = sq;
        d.dataset.base = d.className;
        if (col === 0) {
          const c = document.createElement('span');
          c.className = 'coord rank';
          c.textContent = rank + 1;
          d.appendChild(c);
        }
        if (row === 7) {
          const c = document.createElement('span');
          c.className = 'coord file';
          c.textContent = E.FILES[file];
          d.appendChild(c);
        }
        boardEl.appendChild(d);
        squareEls.push(d);
      }
    }
  }

  const squareEl = sq => boardEl.querySelector('.square[data-sq="' + sq + '"]');

  function renderBoard() {
    const st = activeState();
    const live = isLive() && !explore;
    let last = null;
    if (explore) {
      last = explore.log.length ? explore.log[explore.log.length - 1].m : null;
    } else {
      const lastIdx = isLive() ? moveLog.length - 1 : viewPly - 1;
      last = lastIdx >= 0 ? moveLog[lastIdx].m : null;
    }
    const checkSq = E.inCheck(st) ? E.findKing(st.board, st.turn) : -1;
    // Once the game is over the board becomes a free analysis board.
    const legalHere = gameOver ? E.legalMoves(st) : currentLegal;
    const targets = selected !== null && (live || gameOver) ? legalHere.filter(m => m.from === selected) : [];
    const myColor = settings.mode === 'two' ? st.turn : settings.human;

    for (const el of squareEls) {
      const sq = +el.dataset.sq;
      const p = st.board[sq];
      el.className = el.dataset.base;

      let span = el.querySelector('.piece');
      if (p) {
        if (!span) {
          span = document.createElement('span');
          el.appendChild(span);
        }
        span.className = 'piece ' + pieceClass(p);
      } else if (span) span.remove();

      if (last && (sq === last.from || sq === last.to)) el.classList.add('hl');
      if (live && sq === selected) el.classList.add('hl');
      if (sq === checkSq) el.classList.add('in-check');
      if (live && hint && (sq === hint.from || (hint.stage === 2 && sq === hint.to))) el.classList.add('hint-mark');
      if (live && premove && (sq === premove.from || sq === premove.to)) el.classList.add('premove');
      if (live && premoveSel === sq) el.classList.add('premove');
      const t = targets.find(m => m.to === sq);
      if (t) el.classList.add(t.captured ? 'capture-hint' : 'move-hint');
      if (p && (gameOver
        ? E.colorOf(p) === st.turn
        : live && ((E.colorOf(p) === st.turn && isHumanTurn() && !aiThinking)
          || (settings.mode === 'ai' && E.colorOf(p) === myColor && !isHumanTurn())))) {
        el.classList.add('grabbable');
      }
    }
  }

  /* ---------------- Move animation (FLIP) ---------------- */

  function flipAnimate(pieceSq, fromSq) {
    const toEl = squareEl(pieceSq), fromEl = squareEl(fromSq);
    const piece = toEl && toEl.querySelector('.piece');
    if (!piece || !fromEl) return;
    const a = fromEl.getBoundingClientRect(), b = toEl.getBoundingClientRect();
    const dx = a.left - b.left, dy = a.top - b.top;
    if (!dx && !dy) return;
    piece.style.transition = 'none';
    piece.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    requestAnimationFrame(() => {
      piece.style.transition = 'transform .15s ease';
      piece.style.transform = '';
      setTimeout(() => { piece.style.transition = ''; }, 220);
    });
  }

  function animateMove(m, reverse) {
    if (reverse) flipAnimate(m.from, m.to);
    else flipAnimate(m.to, m.from);
    if (m.flags === 'ck') {
      if (reverse) flipAnimate(m.to + 1, m.to - 1);
      else flipAnimate(m.to - 1, m.to + 1);
    }
    if (m.flags === 'cq') {
      if (reverse) flipAnimate(m.to - 2, m.to + 1);
      else flipAnimate(m.to + 1, m.to - 2);
    }
  }

  /* ---------------- Analysis-board exploration (after game over) ---------------- */

  function exploreMove(m, viaDrag) {
    if (!explore) {
      explore = { basePly: isLive() ? states.length - 1 : viewPly, states: [activeState()], log: [] };
    }
    const st0 = explore.states[explore.states.length - 1];
    const san = E.san(st0, m);
    explore.states.push(E.makeMove(st0, m));
    explore.log.push({ m, san });
    selected = null; pending = null;
    promoEl.hidden = true;
    sound(m.captured ? 'capture' : 'move');
    renderBoard();
    if (!viaDrag) animateMove(m, false);
    renderStatus();
    updateEval();
    updateLines();
  }

  function exploreTo(from, to, viaDrag) {
    const candidates = E.legalMoves(activeState()).filter(m => m.from === from && m.to === to);
    if (!candidates.length) return;
    if (candidates[0].promotion) {
      pending = { candidates, explore: true };
      showPromotion(to);
    } else {
      exploreMove(candidates[0], viaDrag);
    }
  }

  function exploreBack() {
    if (!explore) return;
    explore.states.pop();
    const undone = explore.log.pop();
    if (!explore.log.length) explore = null;
    selected = null;
    renderBoard();
    if (undone) animateMove(undone.m, true);
    renderStatus();
    updateEval();
    updateLines();
  }

  function exitExplore() {
    if (!explore) return;
    explore = null;
    selected = null;
    renderBoard();
    renderStatus();
    updateEval();
    updateLines();
  }

  /* ---------------- Input: click + drag + premove ---------------- */

  boardEl.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (pending) return;
    if (gameOver) {
      // Free analysis board: play out lines for either side.
      const sqEl = e.target.closest('.square');
      if (!sqEl) return;
      const sq = +sqEl.dataset.sq;
      const st = activeState();
      if (selected !== null && E.legalMoves(st).some(m => m.from === selected && m.to === sq)) {
        exploreTo(selected, sq, false);
        return;
      }
      const p = st.board[sq];
      if (p && E.colorOf(p) === st.turn) {
        const reclick = selected === sq;
        selected = sq;
        renderBoard();
        startDrag(e, sq, reclick, 'explore');
      } else if (selected !== null) {
        selected = null;
        renderBoard();
      }
      return;
    }
    if (!isLive()) { setView(null); return; }
    const sqEl = e.target.closest('.square');
    if (!sqEl) return;
    const sq = +sqEl.dataset.sq;
    const st = cur();

    if (isHumanTurn() && !aiThinking) {
      if (selected !== null && currentLegal.some(m => m.from === selected && m.to === sq)) {
        moveTo(selected, sq, false);
        return;
      }
      const p = st.board[sq];
      if (p && E.colorOf(p) === st.turn) {
        const reclick = selected === sq;
        selected = sq;
        renderBoard();
        startDrag(e, sq, reclick, false);
      } else if (selected !== null) {
        selected = null;
        renderBoard();
      }
    } else if (settings.mode === 'ai') {
      // Opponent is moving: queue a premove.
      const p = st.board[sq];
      if (premove && (sq === premove.from || sq === premove.to)) {
        premove = null; premoveSel = null;
        renderBoard();
        return;
      }
      if (premoveSel !== null && sq !== premoveSel) {
        premove = { from: premoveSel, to: sq };
        premoveSel = null;
        renderBoard();
        return;
      }
      if (p && E.colorOf(p) === settings.human) {
        premoveSel = sq;
        renderBoard();
        startDrag(e, sq, false, 'premove');
      } else if (premoveSel !== null || premove) {
        premoveSel = null; premove = null;
        renderBoard();
      }
    }
  });

  boardEl.addEventListener('contextmenu', e => {
    if (premove || premoveSel !== null) {
      e.preventDefault();
      premove = null; premoveSel = null;
      renderBoard();
    }
  });

  function startDrag(e, from, reclick, kind) {
    const pieceEl = squareEl(from)?.querySelector('.piece');
    if (!pieceEl) return;
    const rect = pieceEl.getBoundingClientRect();
    const ghost = pieceEl.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.style.width = rect.width + 'px';
    ghost.style.height = rect.height + 'px';
    document.body.appendChild(ghost);
    pieceEl.classList.add('dragging-src');

    let moved = false;
    const startX = e.clientX, startY = e.clientY;
    const place = ev => {
      ghost.style.left = ev.clientX + 'px';
      ghost.style.top = ev.clientY + 'px';
      if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 5) moved = true;
    };
    place(e);

    const cleanup = () => {
      ghost.remove();
      pieceEl.classList.remove('dragging-src');
      window.removeEventListener('pointermove', place);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
    const onUp = ev => {
      cleanup();
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const target = el && el.closest('.square');
      if (target) {
        const to = +target.dataset.sq;
        if (kind === 'premove') {
          if (to !== from) {
            premove = { from, to };
            premoveSel = null;
          }
          renderBoard();
          return;
        }
        if (kind === 'explore') {
          if (to !== from && E.legalMoves(activeState()).some(m => m.from === from && m.to === to)) {
            exploreTo(from, to, true);
            return;
          }
          if (to === from && reclick && !moved) selected = null;
          renderBoard();
          return;
        }
        if (to !== from && currentLegal.some(m => m.from === from && m.to === to)) {
          moveTo(from, to, true);
          return;
        }
        if (to === from && reclick && !moved) {
          selected = null;
        }
      }
      renderBoard();
    };
    const onCancel = () => { cleanup(); renderBoard(); };

    window.addEventListener('pointermove', place);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }

  function moveTo(from, to, viaDrag) {
    const candidates = currentLegal.filter(m => m.from === from && m.to === to);
    if (!candidates.length) return;
    if (candidates[0].promotion) {
      if (settings.autoQueen) {
        applyMove(candidates.find(x => x.promotion === 'Q'), !viaDrag);
        return;
      }
      pending = { candidates };
      showPromotion(to);
    } else {
      applyMove(candidates[0], !viaDrag);
    }
  }

  /* ---------------- Promotion picker ---------------- */

  function showPromotion(to) {
    const color = activeState().turn;
    promoBox.innerHTML = '';
    for (const t of ['Q', 'N', 'R', 'B']) {
      const b = document.createElement('button');
      b.innerHTML = '<div class="promo-piece pc-' + color + t + '"></div>';
      b.addEventListener('click', ev => {
        ev.stopPropagation();
        const cand = pending.candidates.find(x => x.promotion === t);
        if (pending.explore) exploreMove(cand, false);
        else applyMove(cand, true);
      });
      promoBox.appendChild(b);
    }
    const file = to & 15, rank = to >> 4;
    const col = flipped ? 7 - file : file;
    const atTop = flipped ? rank === 0 : rank === 7;
    promoBox.style.left = col * 12.5 + '%';
    promoBox.style.top = atTop ? '0' : 'auto';
    promoBox.style.bottom = atTop ? 'auto' : '0';
    promoEl.hidden = false;
  }

  promoEl.addEventListener('click', () => {
    pending = null;
    selected = null;
    promoEl.hidden = true;
    renderBoard();
  });

  /* ---------------- Rendering: panel, players, clocks ---------------- */

  function renderAll() {
    renderBoard();
    renderPlayers();
    renderClocks();
    renderStatus();
    renderMoves();
    renderGraph();
    renderEvalBar(lastEval);
  }

  /* ---------------- Evaluation bar ---------------- */

  let lastEval = 0;

  // Recompute the position score off the click path so the move renders first.
  function updateEval() {
    const seq = ++updateEval.seq;
    if (!explore) {
      const idx = isLive() ? states.length - 1 : viewPly;
      if (analysis && analysis.evals[idx] != null) { renderEvalBar(analysis.evals[idx]); return; }
      if (gameOver && isLive()) { renderEvalBar(lastEval); return; }
    }
    const stv = activeState();
    setTimeout(() => {
      if (seq !== updateEval.seq) return;
      renderEvalBar(E.evaluatePosition(stv, 2));
    }, 20);
  }
  updateEval.seq = 0;

  function renderEvalBar(cp) {
    lastEval = cp;
    const bar = $('evalbar');
    const fill = $('eval-white');
    const label = $('eval-label');
    bar.classList.toggle('flipped', flipped);

    let frac, text;
    const pinResult = gameOver && isLive() && !explore;
    if (pinResult && gameOver.result === '1-0') { frac = 1; text = '1-0'; }
    else if (pinResult && gameOver.result === '0-1') { frac = 0; text = '0-1'; }
    else if (pinResult) { frac = 0.5; text = '½'; }
    else if (cp > 90000) { frac = 0.98; text = 'M'; }
    else if (cp < -90000) { frac = 0.02; text = 'M'; }
    else {
      // Logistic curve: +300cp ≈ 73% of the bar, like chess.com's squashing.
      frac = 1 / (1 + Math.exp(-cp / 300));
      frac = Math.min(0.95, Math.max(0.05, frac));
      text = Math.abs(cp / 100).toFixed(1);
    }
    fill.style.height = (frac * 100) + '%';

    const whiteLeads = frac >= 0.5;
    const atBottom = whiteLeads === !flipped; // label sits at the leading side's end
    label.style.top = atBottom ? 'auto' : '3px';
    label.style.bottom = atBottom ? '3px' : 'auto';
    label.style.color = whiteLeads ? '#57544f' : '#e8e6e3';
    label.textContent = text;
  }

  function playerName(color) {
    if (settings.mode === 'ai') {
      if (color === settings.human) return 'You';
      const sf = SF_LEVELS[settings.depth];
      return sf ? sf.label : 'Computer (' + ({ 1: 'Easy', 2: 'Medium', 3: 'Hard' })[settings.depth] + ')';
    }
    return color === 'w' ? 'White' : 'Black';
  }

  function capturedBy(color) {
    const out = [];
    moveLog.forEach((e, i) => {
      const mover = i % 2 === 0 ? 'w' : 'b';
      if (mover === color && e.m.captured) out.push(e.m.captured);
    });
    return out.sort((a, b) => VALUES[E.typeOf(b)] - VALUES[E.typeOf(a)]);
  }

  function renderPlayers() {
    const bottom = flipped ? 'b' : 'w';
    const top = flipped ? 'w' : 'b';
    $('name-bottom').textContent = playerName(bottom);
    $('name-top').textContent = playerName(top);

    const capB = capturedBy(bottom), capT = capturedBy(top);
    const pts = c => c.reduce((s, p) => s + VALUES[E.typeOf(p)], 0);
    const diff = pts(capB) - pts(capT);
    // Same piece types huddle together; a gap separates different types.
    const html = (pieces, adv) => {
      const groups = [];
      for (const p of pieces) {
        const cls = pieceClass(p);
        if (groups.length && groups[groups.length - 1].cls === cls) groups[groups.length - 1].n++;
        else groups.push({ cls, n: 1 });
      }
      return groups.map(g => '<span class="cap-group">'
        + ('<span class="cap-piece ' + g.cls + '"></span>').repeat(g.n) + '</span>').join('')
        + (adv > 0 ? '<span class="adv">+' + adv + '</span>' : '');
    };
    $('cap-bottom').innerHTML = html(capB, diff);
    $('cap-top').innerHTML = html(capT, -diff);
  }

  function fmtClock(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function renderClocks() {
    const bottom = flipped ? 'b' : 'w';
    const top = flipped ? 'w' : 'b';
    for (const [id, color] of [['clock-bottom', bottom], ['clock-top', top]]) {
      const el = $(id);
      if (!clocks) { el.style.display = 'none'; continue; }
      el.style.display = '';
      el.textContent = fmtClock(clocks[color]);
      el.classList.toggle('active', !gameOver && moveLog.length > 0 && cur().turn === color);
      el.classList.toggle('low', clocks[color] < 30000);
    }
  }

  function resultText(go) {
    const winner = go.result === '1-0' ? 'White' : go.result === '0-1' ? 'Black' : null;
    switch (go.reason) {
      case 'checkmate': return ['Checkmate', winner + ' wins'];
      case 'timeout': return ['Time’s up', winner + ' wins on time'];
      case 'resignation': return ['Resignation', winner + ' wins'];
      case 'stalemate': return ['Draw', 'Stalemate'];
      case 'insufficient material': return ['Draw', 'Insufficient material'];
      case 'fifty-move rule': return ['Draw', '50-move rule'];
      case 'threefold repetition': return ['Draw', 'Threefold repetition'];
      default: return ['Game over', go.result];
    }
  }

  function annLabel(a) {
    return a === '??' ? 'Blunder'
      : a === '?' ? 'Mistake'
      : a === '?!' ? 'Inaccuracy'
      : a === '!' ? 'Great move — the only good one'
      : 'Best move';
  }

  function renderStatus() {
    const el = $('status');
    $('hint').hidden = !!gameOver;
    $('resign').hidden = !!gameOver;
    $('analyze').hidden = !gameOver;
    $('explore-exit').hidden = !explore;
    if (explore) {
      const st0 = explore.states[0];
      const sans = explore.log.map(x => x.san);
      const shown = sans.length > 6 ? '… ' + sans.slice(-6).join(' ') : sans.join(' ');
      el.textContent = 'Variation: ' + st0.fullmove + (st0.turn === 'w' ? '. ' : '… ') + shown;
      return;
    }
    if (analysis && !analysis.complete) {
      el.textContent = 'Analyzing with ' + analysis.engine + '… ' + analysis.progress + '/' + states.length;
      return;
    }
    if (!isLive()) {
      if (viewPly === 0) { el.textContent = 'Start position (→ to step forward)'; return; }
      const j = viewPly - 1;
      let s = (Math.floor(j / 2) + 1) + (j % 2 === 0 ? '. ' : '… ') + moveLog[j].san;
      if (analysis && analysis.complete && analysis.anns[j]) {
        s += ' — ' + annLabel(analysis.anns[j]);
        if (analysis.best[j]) s += ' · better: ' + analysis.best[j];
      }
      el.textContent = s;
      return;
    }
    if (gameOver) {
      const [a, b] = resultText(gameOver);
      el.textContent = a + ' — ' + b;
    } else if (aiThinking) {
      const sf = SF_LEVELS[settings.depth];
      el.textContent = (sf && !Stockfish.isReady() ? 'Loading Stockfish…' : 'Computer is thinking…')
        + (premove ? ' (premove set)' : '');
    } else {
      el.textContent = (cur().turn === 'w' ? 'White' : 'Black') + ' to move'
        + (E.inCheck(cur()) ? ' — check!' : '');
    }
  }

  function renderMoves() {
    const el = $('moves');
    el.innerHTML = '';
    const viewedMoveIdx = isLive() ? moveLog.length - 1 : viewPly - 1;
    for (let i = 0; i < moveLog.length; i += 2) {
      const row = document.createElement('div');
      row.className = 'move-row';
      const num = document.createElement('span');
      num.className = 'move-num';
      num.textContent = (i / 2 + 1) + '.';
      row.appendChild(num);
      for (const j of [i, i + 1]) {
        const s = document.createElement('span');
        s.className = 'move-san' + (j === viewedMoveIdx ? ' current' : '');
        if (moveLog[j]) {
          const ann = analysis && analysis.complete ? analysis.anns[j] : null;
          s.textContent = moveLog[j].san + (ann || '');
          s.dataset.ply = j + 1;
          if (ann === '??') s.classList.add('ann-blunder');
          else if (ann === '?') s.classList.add('ann-mistake');
          else if (ann === '?!') s.classList.add('ann-inacc');
          else if (ann === '!') s.classList.add('ann-great');
          else if (ann === '★') s.classList.add('ann-best');
        }
        row.appendChild(s);
      }
      el.appendChild(row);
    }
    if (gameOver) {
      const r = document.createElement('div');
      r.className = 'move-result';
      r.textContent = gameOver.result;
      el.appendChild(r);
    }
    if (isLive()) el.scrollTop = el.scrollHeight;
  }

  $('moves').addEventListener('click', e => {
    const span = e.target.closest('.move-san');
    if (span && span.dataset.ply) setView(+span.dataset.ply);
  });

  function showGameOver() {
    const [title, sub] = resultText(gameOver);
    $('go-title').textContent = title;
    $('go-sub').textContent = sub;
    gameoverEl.hidden = false;
    updateLines();
  }

  /* ---------------- Sounds (WebAudio, no assets) ---------------- */

  function sound(kind) {
    try {
      sound.ctx = sound.ctx || new (window.AudioContext || window.webkitAudioContext)();
      const ctx = sound.ctx;
      if (ctx.state === 'suspended') ctx.resume();
      const tone = (freq, at, dur, type, vol) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = type || 'triangle';
        o.frequency.value = freq;
        g.gain.setValueAtTime(vol || 0.12, ctx.currentTime + at);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + at + dur);
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + at);
        o.stop(ctx.currentTime + at + dur + 0.05);
      };
      if (kind === 'move') tone(540, 0, 0.09);
      else if (kind === 'capture') tone(330, 0, 0.1, 'square', 0.09);
      else if (kind === 'check') { tone(660, 0, 0.09); tone(880, 0.1, 0.12); }
      else if (kind === 'end') { tone(523, 0, 0.18); tone(659, 0.12, 0.18); tone(784, 0.24, 0.3); }
    } catch (_) { /* audio unavailable */ }
  }

  /* ---------------- Controls ---------------- */

  $('mode').addEventListener('change', e => {
    settings.mode = e.target.value;
    $('playas-wrap').hidden = settings.mode !== 'ai';
    $('diff-wrap').hidden = settings.mode !== 'ai';
    newGame();
  });
  $('playas').addEventListener('change', e => {
    settings.human = e.target.value;
    newGame();
  });
  $('diff').addEventListener('change', e => {
    settings.depth = e.target.value;
    // Warm the engine while the player makes their move.
    if (SF_LEVELS[settings.depth]) Stockfish.init().catch(() => {});
    renderPlayers();
  });
  $('time').addEventListener('change', e => {
    settings.minutes = +e.target.value;
    newGame();
  });
  $('autoqueen').addEventListener('change', e => {
    settings.autoQueen = e.target.value === '1';
  });
  $('new').addEventListener('click', newGame);
  $('go-new').addEventListener('click', newGame);
  $('go-close').addEventListener('click', () => { gameoverEl.hidden = true; });
  $('go-analyze').addEventListener('click', startAnalysis);
  $('analyze').addEventListener('click', startAnalysis);
  $('flip').addEventListener('click', () => {
    flipped = !flipped;
    buildBoard();
    renderAll();
  });
  $('undo').addEventListener('click', undo);
  // Two-step resign: the first press arms the button for a few seconds.
  let resignArmed = 0;
  $('resign').addEventListener('click', () => {
    if (gameOver || !moveLog.length) return;
    const now = performance.now();
    if (now - resignArmed > 3000) {
      resignArmed = now;
      $('resign').textContent = 'Sure?';
      setTimeout(() => {
        if (performance.now() - resignArmed >= 3000) $('resign').textContent = 'Resign';
      }, 3200);
      return;
    }
    resignArmed = 0;
    $('resign').textContent = 'Resign';
    const loser = settings.mode === 'ai' ? settings.human : cur().turn;
    gameOver = { over: true, result: loser === 'w' ? '0-1' : '1-0', reason: 'resignation' };
    premove = null; premoveSel = null; selected = null; hint = null;
    sound('end');
    renderAll();
    updateEval();
    showGameOver();
  });
  $('hint').addEventListener('click', () => {
    if (gameOver || aiThinking || pending || !isHumanTurn() || !isLive()) return;
    if (!hint) {
      const m = E.bestMove(cur(), 3);
      if (!m) return;
      hint = { from: m.from, to: m.to, stage: 1 };
    } else if (hint.stage === 1) {
      hint.stage = 2;
    }
    renderBoard();
  });
  $('nav-start').addEventListener('click', () => setView(0));
  $('nav-back').addEventListener('click', () => navRel(-1));
  $('nav-fwd').addEventListener('click', () => navRel(1));
  $('nav-end').addEventListener('click', () => setView(null));

  // A "play vs Stockfish from here" handoff from the openings page.
  let handoff = null;
  try {
    const h = JSON.parse(localStorage.getItem('chess-handoff') || 'null');
    localStorage.removeItem('chess-handoff');
    if (h && Array.isArray(h.moves) && Date.now() - h.t < 60000) handoff = h;
  } catch (_) { /* ignore */ }
  if (handoff) {
    settings.mode = 'ai';
    if (!SF_LEVELS[settings.depth]) settings.depth = 'sfclub';
    $('mode').value = 'ai';
    $('diff').value = settings.depth;
    $('playas-wrap').hidden = false;
    $('diff-wrap').hidden = false;
    Stockfish.init().catch(() => {});
  }
  newGame(handoff);
})();
